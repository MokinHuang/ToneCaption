/** 合成音节音频助手（仅测试用）：逐字控制时长/幅度/基频，
 *  生成 16kHz PCM 与模拟识别器返回的 tokens/timestamps（CTC 峰值锚点样式）。
 *  合成音频只验证算法逻辑，不代表真人韵律。 */

export interface SynthChar {
  ch: string
  durMs?: number
  amp?: number
  f0?: number
  gapAfterMs?: number
}

const WORD_CHAR = /[一-鿿A-Za-z0-9]/
const SR = 16000

export function synthAudio(
  chars: SynthChar[],
  opts: { leadMs?: number; tailMs?: number; noise?: number } = {},
): { pcm: Float32Array; text: string; tokens: string[]; timestamps: [number, number][] } {
  const leadMs = opts.leadMs ?? 200
  const tailMs = opts.tailMs ?? 300
  const noise = opts.noise ?? 0.001
  let cursor = leadMs
  const tokens: string[] = []
  const timestamps: [number, number][] = []
  const spans: { startMs: number; durMs: number; amp: number; f0: number }[] = []
  for (const c of chars) {
    const gap = c.gapAfterMs ?? 0
    if (WORD_CHAR.test(c.ch) && (c.durMs ?? 200) > 0) {
      const durMs = c.durMs ?? 200
      spans.push({ startMs: cursor, durMs, amp: c.amp ?? 0.08, f0: c.f0 ?? 180 })
      const peak = cursor + durMs / 2
      tokens.push(c.ch)
      timestamps.push([peak - 30, peak + 30])
      cursor += durMs + gap
    } else {
      const peak = cursor + gap / 2
      tokens.push(c.ch)
      timestamps.push([peak - 30, peak + 30])
      cursor += gap
    }
  }
  const totalMs = cursor + tailMs
  const n = Math.round((totalMs / 1000) * SR)
  const pcm = new Float32Array(n)
  for (let i = 0; i < n; i++) pcm[i] = (Math.random() * 2 - 1) * noise
  for (const s of spans) {
    const start = Math.round((s.startMs / 1000) * SR)
    const len = Math.round((s.durMs / 1000) * SR)
    for (let i = 0; i < len && start + i < n; i++) {
      const t = i / SR
      const env = Math.pow(Math.sin((Math.PI * i) / len), 0.7)
      const w = 2 * Math.PI * s.f0 * t
      pcm[start + i] +=
        (s.amp * env * (Math.sin(w) + 0.5 * Math.sin(2 * w) + 0.25 * Math.sin(3 * w))) / 1.75
    }
  }
  return { pcm, text: chars.map((c) => c.ch).join(''), tokens, timestamps }
}

/** 「周五交初稿」五字：默认平读参数，逐字可覆盖。 */
export function wuZiJiaoChuGao(
  overrides: Partial<Record<number, Partial<SynthChar>>> = {},
): SynthChar[] {
  return ['周', '五', '交', '初', '稿'].map((ch, i) => ({
    ch,
    durMs: 200,
    amp: 0.08,
    f0: 180,
    ...overrides[i],
  }))
}