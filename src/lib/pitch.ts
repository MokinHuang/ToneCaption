/** 句末音高提取（YIN-lite 自相关）与「跨音节持续上扬」判定。
 *  纯 Float32 数学，无 DOM 依赖，node 与浏览器双端可跑。
 *  设计目标：普通话单字二声（100–200ms 升调）不得单独判为句末上扬；
 *  有效浊音太短、噪声过大或趋势不清时返回 null + 原因，宁缺毋滥。 */
import type { PitchMeasurement } from '../types.ts'

export const PITCH_CONST = {
  frameMs: 40,
  tailHopMs: 10,
  bodyHopMs: 25,
  f0Min: 70,
  f0Max: 400,
  yinThreshold: 0.15,
  confVoiced: 0.65,
  confTailVoiced: 0.55,
  tailBacktrackMs: 800,
  tailGapMs: 100,
  minTailVoicedMs: 250,
  minBodyVoicedMs: 300,
  baselineGuardMs: 100,
  riseWindowMs: 350,
  minWindowFrames: 10,
  minSpanMs: 250,
  minTroughDepthSt: 1,
  anchorMs: 60,
  minRiseSt: 3,
  maxStartOffsetSt: 1.5,
  minSlopeStPerS: 8,
  minEndElevationSt: 2,
  maxDropFraction: 0.4,
  dropToleranceSt: 0.5,
  octaveJumpSt: 12,
  outlierJumpSt: 9,
  tailSnrRatio: 4,
  minRms: 0.008,
  noiseFloorRatio: 3,
} as const

export type PitchNullReason =
  | 'forced-cut'
  | 'too-short-segment'
  | 'no-voiced-tail'
  | 'low-confidence'
  | 'too-noisy'
  | 'no-baseline'
  | 'short-span'
  | 'insufficient-rise'
  | 'non-monotonic'
  | 'single-syllable-rise'
  | 'end-not-elevated'
  | 'start-elevated'
  | 'octave-jump'
  | 'no-audio'
  | 'budget-exceeded'

export interface PitchFrame {
  tMs: number
  f0: number | null
  conf: number
  rms: number
}

export type TailRiseResult =
  | { ok: true; m: PitchMeasurement }
  | { ok: false; reason: PitchNullReason }

const sleep0 = () => new Promise<void>((r) => setTimeout(r, 0))

function median(values: number[]): number {
  if (values.length === 0) return NaN
  const s = [...values].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0
  const s = [...values].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.floor(p * s.length))]
}

const st = (f0: number, ref: number) => 12 * Math.log2(f0 / ref)

/** 基频轨迹。每 ~100 帧让出主线程，避免长段阻塞渲染。 */
export async function pitchTrack(
  pcm: Float32Array,
  sampleRate: number,
  opts: { startMs?: number; endMs?: number; hopMs?: number } = {},
): Promise<PitchFrame[]> {
  const C = PITCH_CONST
  const hopMs = opts.hopMs ?? C.bodyHopMs
  const totalMs = (pcm.length / sampleRate) * 1000
  const startMs = Math.max(0, opts.startMs ?? 0)
  const endMs = Math.min(totalMs, opts.endMs ?? totalMs)
  const N = Math.round((C.frameMs / 1000) * sampleRate)
  const tauMin = Math.floor(sampleRate / C.f0Max)
  const tauMax = Math.ceil(sampleRate / C.f0Min)
  const W = N - tauMax
  const hop = Math.max(1, Math.round((hopMs / 1000) * sampleRate))
  const start = Math.round((startMs / 1000) * sampleRate)
  const end = Math.round((endMs / 1000) * sampleRate)
  const d = new Float64Array(tauMax + 1)
  const cmnd = new Float64Array(tauMax + 1)
  const frames: PitchFrame[] = []
  if (W <= 0 || N <= 0) return frames

  let count = 0
  for (let off = start; off + N <= end && off + N <= pcm.length; off += hop) {
    let sum = 0
    let sq = 0
    for (let j = 0; j < N; j++) {
      const v = pcm[off + j]
      sum += v
      sq += v * v
    }
    const mean = sum / N
    const rms = Math.sqrt(Math.max(0, sq / N - mean * mean))

    // 差函数对直流不敏感，直接用原始样本差
    for (let tau = 1; tau <= tauMax; tau++) {
      let acc = 0
      for (let j = 0; j < W; j++) {
        const diff = pcm[off + j] - pcm[off + j + tau]
        acc += diff * diff
      }
      d[tau] = acc
    }
    let runSum = 0
    cmnd[0] = 1
    for (let tau = 1; tau <= tauMax; tau++) {
      runSum += d[tau]
      cmnd[tau] = runSum > 0 ? (d[tau] * tau) / runSum : 1
    }
    let sel = -1
    for (let tau = tauMin; tau <= tauMax; tau++) {
      if (cmnd[tau] < C.yinThreshold) {
        while (tau + 1 <= tauMax && cmnd[tau + 1] < cmnd[tau]) tau++
        sel = tau
        break
      }
    }
    if (sel < 0) {
      let best = tauMin
      for (let tau = tauMin + 1; tau <= tauMax; tau++) {
        if (cmnd[tau] < cmnd[best]) best = tau
      }
      sel = best
    }
    let tauStar = sel
    if (sel > tauMin && sel < tauMax) {
      const a = cmnd[sel - 1]
      const b = cmnd[sel]
      const c = cmnd[sel + 1]
      const denom = a - 2 * b + c
      if (denom !== 0) {
        const shift = Math.max(-1, Math.min(1, (0.5 * (a - c)) / denom))
        tauStar = sel + shift
      }
    }
    const f0raw = sampleRate / tauStar
    const conf = Math.max(0, Math.min(1, 1 - cmnd[sel]))
    frames.push({
      tMs: ((off + N / 2) / sampleRate) * 1000,
      f0: f0raw >= C.f0Min && f0raw <= C.f0Max ? f0raw : null,
      conf,
      rms,
    })
    if (++count % 100 === 0) await sleep0()
  }

  // 半音域中值滤波（宽 3）+ 倍频程跳变剔除
  const smoothed = frames.map((f, i) => {
    if (f.f0 == null) return f.f0
    const near: number[] = []
    for (let k = Math.max(0, i - 1); k <= Math.min(frames.length - 1, i + 1); k++) {
      const g = frames[k].f0
      if (g != null) near.push(st(g, 1))
    }
    return Math.pow(2, median(near) / 12)
  })
  // 倍频程误检剔除：与 ±50ms 邻域中位数差 >9st 且邻域本身一致（MAD 小）→ 作废。
  // 真实语音衰减段偶发半频/倍频误检，重采样后可能连续 2–3 帧；
  // 持续交替跳变的邻域中位数不稳，不在此列，仍由下方倍频程剔除拒绝
  const half = 5
  for (let i = 0; i < frames.length; i++) {
    const b = smoothed[i]
    if (b == null) continue
    const near: number[] = []
    for (let k = Math.max(0, i - half); k <= Math.min(frames.length - 1, i + half); k++) {
      if (k !== i && smoothed[k] != null) near.push(st(smoothed[k]!, 1))
    }
    if (near.length < 4) continue
    const med = median(near)
    const mad = median(near.map((v) => Math.abs(v - med)))
    if (Math.abs(st(b, 1) - med) > C.outlierJumpSt && mad <= C.outlierJumpSt / 2) {
      smoothed[i] = null
    }
  }
  let prev: number | null = null
  for (let i = 0; i < frames.length; i++) {
    const f = smoothed[i]
    if (f != null && prev != null && Math.abs(st(f, prev)) > C.octaveJumpSt) {
      frames[i].f0 = null
    } else {
      frames[i].f0 = f
    }
    if (frames[i].f0 != null) prev = frames[i].f0
  }
  return frames
}

/** 从整段粗轨迹找真实语音结束时刻（段末常带静音，尾窗必须锚定语音而非段末）。 */
export function voicedEndMs(frames: PitchFrame[]): number | null {
  const C = PITCH_CONST
  if (frames.length === 0) return null
  const rmsAll = frames.map((f) => f.rms)
  const noiseFloor = Math.max(
    1e-6,
    Math.min(percentile(rmsAll, 0.1), 0.2 * median(rmsAll)),
  )
  let end: number | null = null
  for (const f of frames) {
    if (
      f.f0 != null &&
      f.conf >= C.confTailVoiced &&
      f.rms >= Math.max(C.minRms, noiseFloor * C.noiseFloorRatio)
    ) {
      end = f.tMs + C.frameMs / 2
    }
  }
  return end
}

function isVoiced(f: PitchFrame, noiseFloor: number, tail: boolean): boolean {
  const C = PITCH_CONST
  return (
    f.f0 != null &&
    f.conf >= (tail ? C.confTailVoiced : C.confVoiced) &&
    f.rms >= Math.max(C.minRms, noiseFloor * C.noiseFloorRatio)
  )
}

/** 句末上扬判定。body=句身粗轨迹，tail=段末 800ms 细轨迹。 */
export function tailRise(body: PitchFrame[], tail: PitchFrame[]): TailRiseResult {
  const C = PITCH_CONST
  const all = [...body, ...tail]
  if (all.length === 0) return { ok: false, reason: 'no-audio' }
  const rmsAll = all.map((f) => f.rms)
  // 噪声底取低分位；整段无静音帧时（如连续合成音）以中位数的一定比例封顶，
  // 此时主要靠自相关置信度挡噪声
  const noiseFloor = Math.max(
    1e-6,
    Math.min(percentile(rmsAll, 0.1), 0.2 * median(rmsAll)),
  )

  // 尾部连续浊音区（自相关浊音判定，允许 ≤100ms 清音间隙——真实音节声母 j/q/x/zh 等可达 70–90ms）
  const tailVoiced = tail.map((f) => isVoiced(f, noiseFloor, true))
  let last = -1
  for (let i = tail.length - 1; i >= 0; i--) {
    if (tailVoiced[i]) {
      last = i
      break
    }
  }
  if (last < 0) return { ok: false, reason: 'no-voiced-tail' }
  let first = last
  let gap = 0
  for (let i = last - 1; i >= 0; i--) {
    if (tailVoiced[i]) {
      first = i
      gap = 0
    } else {
      gap += C.tailHopMs
      if (gap > C.tailGapMs) break
    }
  }
  const region = tail.slice(first, last + 1)
  const regionVoiced = region.filter((f) => isVoiced(f, noiseFloor, true))
  const tailVoicedMs = region.length > 0 ? region[region.length - 1].tMs - region[0].tMs : 0
  if (tailVoicedMs < C.minTailVoicedMs || regionVoiced.length < 5) {
    return { ok: false, reason: 'no-voiced-tail' }
  }
  const tailStart = region[0].tMs
  const confMedian = median(regionVoiced.map((f) => f.conf))
  if (confMedian < C.confVoiced) return { ok: false, reason: 'low-confidence' }
  const rmsMedian = median(regionVoiced.map((f) => f.rms))
  if (rmsMedian / noiseFloor < C.tailSnrRatio) return { ok: false, reason: 'too-noisy' }

  // 句中基线：句身浊音 f0 中位数（排除尾部前 100ms）
  const bodyVoiced = body.filter(
    (f) => isVoiced(f, noiseFloor, false) && f.tMs < tailStart - C.baselineGuardMs,
  )
  let baselineHz: number
  if (bodyVoiced.length * C.bodyHopMs >= C.minBodyVoicedMs) {
    baselineHz = median(bodyVoiced.map((f) => f.f0!))
  } else if (tailVoicedMs >= 400) {
    // 句身不足时退回尾部区域：区域覆盖大部分语句（短答句）用整体中位数，
    // 否则用区域前 150ms——避免把句首高起点误当基线
    const head = regionVoiced.filter((f) => f.tMs <= tailStart + 150)
    if (head.length < 3) return { ok: false, reason: 'no-baseline' }
    const allF0 = regionVoiced.map((f) => f.f0!)
    const headF0 = head.map((f) => f.f0!)
    baselineHz =
      tailVoicedMs >= 600
        ? median(allF0)
        : median(headF0)
  } else {
    return { ok: false, reason: 'no-baseline' }
  }

  // 上扬窗口：尾部最后 350ms。先看整窗升幅（平读/下降在此拒绝），
  // 再从最后一个局部极小截起——之前的下滑/低洼不算上升段；
  // 单字二声（极小→末端 <250ms，跨不了音节）在截断后拒绝
  const endMs = region[region.length - 1].tMs
  const win = regionVoiced.filter((f) => f.tMs >= endMs - C.riseWindowMs)
  if (win.length < C.minWindowFrames) return { ok: false, reason: 'short-span' }
  if (win[win.length - 1].tMs - win[0].tMs < C.minSpanMs) {
    return { ok: false, reason: 'short-span' }
  }
  const full = win.map((f) => ({ t: f.tMs, st: st(f.f0!, baselineHz), conf: f.conf }))
  const f0 = full[0].t
  const f1 = full[full.length - 1].t
  const fullHead = median(full.filter((p) => p.t <= f0 + C.anchorMs).map((p) => p.st))
  const fullEnd = median(full.filter((p) => p.t >= f1 - C.anchorMs).map((p) => p.st))
  if (fullEnd - fullHead < C.minRiseSt) return { ok: false, reason: 'insufficient-rise' }

  // 取最后一个"真低谷"（之前有 ≥1st 的下滑）；上升途中的小平台不算新低谷，
  // 否则跨音节上升会被平台截断。无任何真低谷时退回最后一个局部极小
  //（平读后单字陡升的情形，仍须拒绝）
  let lastMin = 0
  let lastTrough = -1
  let priorMax = win[0].f0!
  for (let i = 1; i < win.length - 1; i++) {
    if (win[i].f0! <= win[i - 1].f0! && win[i].f0! <= win[i + 1].f0!) {
      lastMin = i
      if (st(priorMax, win[i].f0!) >= C.minTroughDepthSt) lastTrough = i
    }
    if (win[i].f0! > priorMax) priorMax = win[i].f0!
  }
  const riseWin = win.slice(lastTrough >= 0 ? lastTrough : lastMin)
  const spanMs = riseWin[riseWin.length - 1].tMs - riseWin[0].tMs
  if (riseWin.length < C.minWindowFrames || spanMs < C.minSpanMs) {
    return { ok: false, reason: 'single-syllable-rise' }
  }

  const series = riseWin.map((f) => ({ t: f.tMs, st: st(f.f0!, baselineHz), conf: f.conf }))
  const t0 = series[0].t
  const t1 = series[series.length - 1].t
  const headAnchor = median(series.filter((p) => p.t <= t0 + C.anchorMs).map((p) => p.st))
  const endAnchor = median(series.filter((p) => p.t >= t1 - C.anchorMs).map((p) => p.st))
  const rise = endAnchor - headAnchor

  for (let i = 1; i < series.length; i++) {
    if (Math.abs(series[i].st - series[i - 1].st) > C.octaveJumpSt) {
      return { ok: false, reason: 'octave-jump' }
    }
  }
  if (headAnchor > C.maxStartOffsetSt) return { ok: false, reason: 'start-elevated' }
  if (endAnchor < C.minEndElevationSt) return { ok: false, reason: 'end-not-elevated' }

  // Theil–Sen 斜率（抗离群）
  const slopes: number[] = []
  for (let i = 0; i < series.length; i++) {
    for (let j = i + 1; j < series.length; j++) {
      const dt = (series[j].t - series[i].t) / 1000
      if (dt > 0) slopes.push((series[j].st - series[i].st) / dt)
    }
  }
  if (median(slopes) < C.minSlopeStPerS) return { ok: false, reason: 'insufficient-rise' }

  let drops = 0
  for (let i = 1; i < series.length; i++) {
    if (series[i].st - series[i - 1].st < -C.dropToleranceSt) drops++
  }
  if (drops / (series.length - 1) > C.maxDropFraction) {
    return { ok: false, reason: 'non-monotonic' }
  }

  return {
    ok: true,
    m: {
      tailVoicedMs: Math.round(tailVoicedMs),
      spanMs: Math.round(spanMs),
      riseSemitones: Math.round(rise * 10) / 10,
      baselineHz: Math.round(baselineHz * 10) / 10,
      endHz: Math.round(baselineHz * Math.pow(2, endAnchor / 12) * 10) / 10,
      confidence: Math.round(median(series.map((p) => p.conf)) * 100) / 100,
    },
  }
}