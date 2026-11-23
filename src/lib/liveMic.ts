import type { LiveSegment, MicPhase } from '../types'
import { transcribeFile } from './transcribe.ts'
import { analyzeSegmentTone } from './toneAnalysis.ts'

const TARGET_RATE = 16000
const PRE_ROLL_MS = 300
const END_SILENCE_MS = 700
const MAX_SEGMENT_MS = 15000
const MIN_VOICED_MS = 250
const MIN_FILE_SECONDS = 0.6

/** 测试钩子：?tone_delay=5000 人为延迟语气分析（验收迟到提示只回原句）。 */
const TONE_DELAY_MS = (() => {
  if (typeof window === 'undefined') return 0
  const v = Number(new URLSearchParams(window.location.search).get('tone_delay'))
  return Number.isFinite(v) && v > 0 ? Math.min(v, 30000) : 0
})()

type CutReason = 'pause' | 'max-length' | 'stop'

/** 去掉空白与标点/符号后为空 → 纯标点识别结果（如 SenseVoice 对短噪声段输出的「。」），不进字幕列表。 */
export function isPunctuationOnly(text: string): boolean {
  return text.replace(/[\p{P}\p{S}\s]/gu, '').length === 0
}

const WORKLET_SOURCE = `
class MicTap extends AudioWorkletProcessor {
  constructor() {
    super()
    this.buf = new Float32Array(2048)
    this.n = 0
  }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0]
    if (!ch) return true
    let off = 0
    while (off < ch.length) {
      const take = Math.min(this.buf.length - this.n, ch.length - off)
      this.buf.set(ch.subarray(off, off + take), this.n)
      this.n += take
      off += take
      if (this.n === this.buf.length) {
        this.port.postMessage(this.buf, [this.buf.buffer])
        this.buf = new Float32Array(2048)
        this.n = 0
      }
    }
    return true
  }
}
registerProcessor('mic-tap', MicTap)
`

interface ActiveSeg {
  seq: number | null
  chunks: Float32Array[]
  totalMs: number
  voicedMs: number
  silenceMs: number
  lastVoicedAt: number
}

interface QueueItem {
  seq: number
  wav: Blob
  /** 16k 浮点音频，供本地语气分析；转写成功后移交分析链，随后释放 */
  pcm16k: Float32Array | null
  cutReason: CutReason
  audioSeconds: number
  lastVoicedAt: number
  cutAt: number
}

interface MicSessionCallbacks {
  onSegments: (segments: LiveSegment[]) => void
  onPhase: (phase: MicPhase, error?: string) => void
}

function micErrorMessage(err: unknown): string {
  if (err instanceof DOMException) {
    switch (err.name) {
      case 'NotAllowedError':
      case 'SecurityError':
        return '麦克风权限被拒绝。请点击浏览器地址栏左侧的权限图标，允许麦克风后重新点「开始收音」。'
      case 'NotFoundError':
      case 'OverconstrainedError':
        return '未找到可用的麦克风设备。请连接麦克风后重试。'
      case 'NotReadableError':
        return '麦克风被其他应用占用或系统禁止访问。请关闭占用麦克风的程序后重试。'
      case 'AbortError':
        return '麦克风启动被系统中止，请重试。'
    }
  }
  return `无法启动麦克风：${err instanceof Error ? err.message : String(err)}`
}

function resampleTo16k(input: Float32Array, fromRate: number): Float32Array {
  if (fromRate === TARGET_RATE) return input
  const ratio = fromRate / TARGET_RATE
  const outLen = Math.floor(input.length / ratio)
  const out = new Float32Array(outLen)
  for (let i = 0; i < outLen; i++) {
    const pos = i * ratio
    const i0 = Math.floor(pos)
    const i1 = Math.min(i0 + 1, input.length - 1)
    const frac = pos - i0
    out[i] = input[i0] * (1 - frac) + input[i1] * frac
  }
  return out
}

function encodeWav16k(samples: Float32Array): Blob {
  const minLen = Math.ceil(MIN_FILE_SECONDS * TARGET_RATE)
  const pcm = new Int16Array(Math.max(samples.length, minLen))
  for (let i = 0; i < samples.length; i++) {
    const v = Math.max(-1, Math.min(1, samples[i]))
    pcm[i] = v < 0 ? v * 0x8000 : v * 0x7fff
  }
  const buffer = new ArrayBuffer(44 + pcm.byteLength)
  const view = new DataView(buffer)
  const writeStr = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i))
  }
  writeStr(0, 'RIFF')
  view.setUint32(4, 36 + pcm.byteLength, true)
  writeStr(8, 'WAVE')
  writeStr(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, TARGET_RATE, true)
  view.setUint32(28, TARGET_RATE * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  writeStr(36, 'data')
  view.setUint32(40, pcm.byteLength, true)
  new Int16Array(buffer, 44).set(pcm)
  return new Blob([buffer], { type: 'audio/wav' })
}

/** 一次收音会话：采集 → 停顿分句 → WAV 编码 → 顺序上传。
 *  dispose 后所有回调与迟到结果都被丢弃，保证重开不混入旧会话。 */
export class MicLiveSession {
  private cb: MicSessionCallbacks
  private disposed = false
  private captureStopped = false
  private abort = new AbortController()
  private stream: MediaStream | null = null
  private ctx: AudioContext | null = null
  private node: AudioWorkletNode | null = null
  private source: MediaStreamAudioSourceNode | null = null
  private sampleRate = TARGET_RATE

  private noiseFloor = 0.003
  private preRoll: { data: Float32Array; ms: number }[] = []
  private active: ActiveSeg | null = null
  private seqCounter = 0
  private segments: LiveSegment[] = []
  private queue: QueueItem[] = []
  private pumping = false
  /** 语气分析独立串行链：与上传队列解耦，正文先行，分析不阻塞下一段转写 */
  private analysisChain: Promise<void> = Promise.resolve()
  private delayTimers = new Set<{ t: ReturnType<typeof setTimeout>; resolve: () => void }>()

  constructor(cb: MicSessionCallbacks) {
    this.cb = cb
  }

  async start(): Promise<void> {
    this.cb.onPhase('requesting')
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error(
        '当前环境不支持麦克风访问。浏览器只在安全上下文开放麦克风：请用 http://localhost:5173 或 HTTPS 地址打开本页。',
      )
    }
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      })
    } catch (err) {
      throw new Error(micErrorMessage(err))
    }
    if (this.disposed) {
      this.releaseAudio()
      return
    }
    const track = this.stream.getAudioTracks()[0]
    if (track) {
      track.onended = () => {
        if (this.disposed || this.captureStopped) return
        this.captureStopped = true
        this.releaseAudio()
        this.cb.onPhase('failed', '麦克风中途中断：权限被撤销或设备已断开。已采集的段落仍会完成识别。')
      }
    }
    try {
      this.ctx = new AudioContext()
      await this.ctx.resume()
      const url = URL.createObjectURL(
        new Blob([WORKLET_SOURCE], { type: 'application/javascript' }),
      )
      try {
        await this.ctx.audioWorklet.addModule(url)
      } finally {
        URL.revokeObjectURL(url)
      }
      this.sampleRate = this.ctx.sampleRate
      this.source = this.ctx.createMediaStreamSource(this.stream)
      this.node = new AudioWorkletNode(this.ctx, 'mic-tap')
      this.node.port.onmessage = (e: MessageEvent<Float32Array>) => {
        if (!this.disposed && !this.captureStopped) this.processBlock(e.data)
      }
      this.source.connect(this.node)
      // 工作流节点必须接入输出图才会被拉动；输出恒为静音，不会回放麦克风
      this.node.connect(this.ctx.destination)
    } catch (err) {
      this.releaseAudio()
      throw new Error(
        `初始化音频采集失败：${err instanceof Error ? err.message : String(err)}`,
      )
    }
    if (this.disposed) {
      this.releaseAudio()
      return
    }
    this.cb.onPhase('recording')
  }

  stop(): void {
    if (this.disposed || this.captureStopped) return
    this.captureStopped = true
    if (this.active) {
      this.finalize(this.active, performance.now(), 'stop')
      this.active = null
    }
    this.releaseAudio()
    if (this.pumping || this.queue.length > 0) this.cb.onPhase('stopping')
    else this.cb.onPhase('stopped')
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.abort.abort()
    this.queue.length = 0
    for (const d of this.delayTimers) {
      clearTimeout(d.t)
      d.resolve()
    }
    this.delayTimers.clear()
    this.releaseAudio()
  }

  private releaseAudio() {
    this.node?.port.close()
    this.node?.disconnect()
    this.source?.disconnect()
    this.stream?.getTracks().forEach((t) => {
      t.onended = null
      t.stop()
    })
    void this.ctx?.close().catch(() => undefined)
    this.node = null
    this.source = null
    this.stream = null
    this.ctx = null
  }

  private processBlock(data: Float32Array) {
    const now = performance.now()
    let sum = 0
    for (let i = 0; i < data.length; i++) sum += data[i] * data[i]
    const rms = Math.sqrt(sum / data.length)
    const threshold = Math.max(0.005, this.noiseFloor * 4)
    const voiced = rms >= threshold
    if (!voiced) this.noiseFloor += (rms - this.noiseFloor) * 0.05
    const durMs = (data.length / this.sampleRate) * 1000

    // 连续讲话超过最长分段：先提交当前段，再无缝开新段（无重叠、无丢帧）
    if (this.active && this.active.totalMs + durMs > MAX_SEGMENT_MS) {
      this.finalize(this.active, now, 'max-length')
      this.active = null
      this.preRoll = []
    }

    if (!this.active) {
      if (voiced) {
        const chunks = this.preRoll.map((b) => b.data)
        const preMs = this.preRoll.reduce((a, b) => a + b.ms, 0)
        this.preRoll = []
        chunks.push(data)
        this.active = {
          seq: null,
          chunks,
          totalMs: preMs + durMs,
          voicedMs: durMs,
          silenceMs: 0,
          lastVoicedAt: now,
        }
      } else {
        this.preRoll.push({ data, ms: durMs })
        let total = this.preRoll.reduce((a, b) => a + b.ms, 0)
        while (this.preRoll.length > 1 && total - this.preRoll[0].ms >= PRE_ROLL_MS) {
          total -= this.preRoll[0].ms
          this.preRoll.shift()
        }
      }
      return
    }

    const seg = this.active
    seg.chunks.push(data)
    seg.totalMs += durMs
    if (voiced) {
      seg.voicedMs += durMs
      seg.lastVoicedAt = now
      seg.silenceMs = 0
    } else {
      seg.silenceMs += durMs
    }
    if (seg.seq == null && seg.voicedMs >= MIN_VOICED_MS) {
      seg.seq = ++this.seqCounter
      this.segments.push({
        seq: seg.seq,
        status: 'pending',
        text: '',
        audioSeconds: 0,
      })
      this.emit()
    }
    if (seg.silenceMs >= END_SILENCE_MS) {
      this.finalize(seg, now, 'pause')
      this.active = null
    }
  }

  private finalize(seg: ActiveSeg, cutAt: number, cutReason: CutReason) {
    if (seg.seq == null || seg.voicedMs < MIN_VOICED_MS) return
    let len = 0
    for (const c of seg.chunks) len += c.length
    const all = new Float32Array(len)
    let off = 0
    for (const c of seg.chunks) {
      all.set(c, off)
      off += c.length
    }
    const pcm = resampleTo16k(all, this.sampleRate)
    const wav = encodeWav16k(pcm)
    this.queue.push({
      seq: seg.seq,
      wav,
      pcm16k: pcm,
      cutReason,
      audioSeconds: seg.totalMs / 1000,
      lastVoicedAt: seg.lastVoicedAt,
      cutAt,
    })
    void this.pump()
  }

  private async pump() {
    if (this.pumping) return
    this.pumping = true
    while (this.queue.length > 0 && !this.disposed) {
      const item = this.queue.shift()!
      const entry = this.segments.find((s) => s.seq === item.seq)
      if (!entry) {
        item.pcm16k = null
        continue
      }
      const uploadStart = performance.now()
      let responseAt = 0
      let emotion: string | null = null
      try {
        const file = new File([item.wav], `live-${item.seq}.wav`, {
          type: 'audio/wav',
        })
        const result = await transcribeFile(file, this.abort.signal)
        if (this.disposed) break
        responseAt = performance.now()
        emotion = result.emotion
        entry.status = 'done'
        entry.text = result.segments.map((s) => s.text).join('')
        entry.audioSeconds = item.audioSeconds
        entry.metrics = {
          waitMs: item.cutAt - item.lastVoicedAt,
          queueMs: uploadStart - item.cutAt,
          uploadMs: responseAt - uploadStart,
          latencyMs: responseAt - item.lastVoicedAt,
        }
      } catch (err) {
        if (this.disposed || this.abort.signal.aborted) break
        entry.status = 'error'
        entry.audioSeconds = item.audioSeconds
        entry.error = err instanceof Error ? err.message : '识别失败，原因未知'
      }
      // 纯标点结果不进字幕历史、不占当前句、不做语气分析；队列照常继续
      if (entry.status === 'done' && isPunctuationOnly(entry.text)) {
        console.info(
          `[ToneCaption] 过滤纯标点识别结果 seq=${entry.seq} raw=${JSON.stringify(entry.text)}（去空白与标点后为空）`,
        )
        this.segments = this.segments.filter((s) => s.seq !== entry.seq)
        item.pcm16k = null
        this.emit()
        continue
      }
      this.emit()
      if (entry.status === 'done') {
        const pcm = item.pcm16k
        item.pcm16k = null
        this.enqueueAnalysis(entry, pcm, emotion, responseAt, item.cutReason)
      } else {
        item.pcm16k = null
      }
    }
    this.pumping = false
    if (this.captureStopped && !this.disposed) this.cb.onPhase('stopped')
  }

  private enqueueAnalysis(
    entry: LiveSegment,
    pcm: Float32Array | null,
    emotion: string | null,
    responseAt: number,
    cutReason: CutReason,
  ) {
    this.analysisChain = this.analysisChain.then(() =>
      this.runAnalysis(entry, pcm, emotion, responseAt, cutReason),
    )
  }

  private abortableSleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const d = {
        t: setTimeout(() => {
          this.delayTimers.delete(d)
          resolve()
        }, ms),
        resolve,
      }
      this.delayTimers.add(d)
    })
  }

  private async runAnalysis(
    entry: LiveSegment,
    pcm: Float32Array | null,
    emotion: string | null,
    responseAt: number,
    cutReason: CutReason,
  ) {
    try {
      if (this.disposed) return
      if (TONE_DELAY_MS > 0) await this.abortableSleep(TONE_DELAY_MS)
      if (this.disposed) return
      const prevTexts = this.segments
        .filter((s) => s.seq < entry.seq && s.status === 'done' && s.text)
        .slice(-2)
        .map((s) => s.text)
      const out = await analyzeSegmentTone({
        text: entry.text,
        prevTexts,
        pcm16k: pcm,
        cutReason,
        emotion,
      })
      if (this.disposed) return
      entry.tone = out.tone
      entry.evidence = out.evidence
      entry.toneCue = out.toneCue
      entry.toneDetail = out.detail
      if (out.sentences.length > 1) entry.toneSentences = out.sentences
      if (out.detail.conclusion !== 'none' && entry.metrics) {
        entry.metrics.toneLatencyMs = performance.now() - responseAt
      }
      this.emit()
    } catch {
      // 语气分析失败只影响该句提示，绝不影响收音与转写
    }
  }

  private emit() {
    if (this.disposed) return
    this.cb.onSegments(this.segments.map((s) => ({ ...s })))
  }
}