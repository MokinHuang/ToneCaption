/** 句内重音检测（「听见重音」第一版）：候选短词与邻近语音比较。
 *  相对响度是主证据；音高、音节拉长只作加强，绝不单独触发。
 *  对齐靠识别器字级时间戳（CTC 峰值锚点），禁止按字数均分音频。
 *  纯 Float32/数组数学，无 DOM 依赖，node 与浏览器双端可跑。
 *  证据弱、候选难分或噪声过大时留空（宁缺毋滥）。 */
import type { PitchFrame } from './pitch.ts'
import { PITCH_CONST } from './pitch.ts'
import type { StressMark, StressMeasurement } from '../types.ts'

export const STRESS_CONST = {
  maxWordChars: 3,
  minSentenceChars: 4,
  minRestChars: 2,
  minWordActiveMs: 80,
  minRestActiveMs: 150,
  minWordVoicedFrames: 4,
  minRestVoicedFrames: 6,
  snrRatio: 4,
  /** 仅响度即可标记的门槛（dB） */
  loudOnlyDb: 4,
  /** 响度 + 任一加强证据的门槛（dB） */
  loudCombDb: 2.5,
  /** 单字候选更严：字调干扰大，须响度 + 音高双证据 */
  singleCharDb: 3.5,
  singleCharPitchSt: 2.5,
  pitchCombSt: 2,
  durCombRatio: 1.35,
  durCombMinDiffMs: 50,
  ambiguityMarginDb: 1,
} as const

export type StressNullReason =
  | 'no-alignment'
  | 'no-audio'
  | 'too-short'
  | 'too-noisy'
  | 'no-speech'
  | 'no-candidate'
  | 'ambiguous'
  | 'incomplete-sentence'
  | 'forced-cut'
  | 'budget-exceeded'
  | 'analysis-error'

const STRESS_REASON_ZH: Record<string, string> = {
  'no-alignment': '无字级时间戳或对齐不可靠，不猜位置',
  'no-audio': '无可用音频',
  'too-short': '句内字数不足，无法比较',
  'too-noisy': '噪声过大',
  'no-speech': '有效语音不足（含纯静音）',
  'no-candidate': '证据不足，未标记',
  ambiguous: '两个候选难分，未标记',
  'incomplete-sentence': '句尾边界不完整，暂缓判断',
  'forced-cut': '超长强制分段，暂缓判断',
  'budget-exceeded': '分析超时，放弃重音',
  'analysis-error': '分析异常',
}

export function stressReasonLabel(reason: string | null): string {
  if (!reason) return ''
  return STRESS_REASON_ZH[reason] ?? reason
}

export interface CharAnchor {
  ch: string
  start: number
  end: number
  peak: number
}

const WORD_CHAR = /[一-鿿A-Za-z0-9]/

function median(values: number[]): number {
  if (values.length === 0) return NaN
  const s = [...values].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}

/** 下中位数：偶数个取偏低一侧。少数词重读时基线落在未重读多数上，
 *  两个词同时重读也不会互相稀释对比度。 */
function loMedian(values: number[]): number {
  if (values.length === 0) return NaN
  const s = [...values].sort((a, b) => a - b)
  return s[Math.floor((s.length - 1) / 2)]
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0
  const s = [...values].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.floor(p * s.length))]
}

/** 把识别器 tokens/timestamps 对齐到转写文本的每个字符位置。
 *  要求逐字精确一致（跳过空白）；任何不一致 → 整段返回 null，绝不按字数均分。 */
export function alignTokens(
  text: string,
  tokens: string[],
  timestamps: [number, number][],
): (CharAnchor | null)[] | null {
  if (tokens.length === 0 || tokens.length !== timestamps.length) return null
  const flat: CharAnchor[] = []
  for (let k = 0; k < tokens.length; k++) {
    const t = timestamps[k]
    if (
      !Array.isArray(t) || t.length < 2 ||
      !Number.isFinite(t[0]) || !Number.isFinite(t[1]) || t[1] < t[0]
    ) {
      return null
    }
    for (const ch of tokens[k]) {
      flat.push({ ch, start: t[0], end: t[1], peak: (t[0] + t[1]) / 2 })
    }
  }
  const out: (CharAnchor | null)[] = new Array(text.length).fill(null)
  let k = 0
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (/\s/.test(ch)) continue
    if (k >= flat.length || flat[k].ch !== ch) return null
    out[i] = flat[k]
    k++
  }
  if (k !== flat.length) return null
  return out
}

interface CharFeat {
  idx: number
  ch: string
  peak: number
  sumSq: number
  nActive: number
  voicedF0: number[]
}

interface Candidate {
  a: number
  b: number
  textStart: number
  textEnd: number
  loudDb: number
  pitchSt: number | null
  durRatio: number | null
  durDiffMs: number
  pitchCue: boolean
  durCue: boolean
  wordActiveMs: number
  restActiveMs: number
}

export interface StressSentenceResult {
  mark: StressMark | null
  measurement: StressMeasurement | null
  reason: StressNullReason | null
}

/** 单句重音检测。anchors 为整段逐字对齐结果；frames 为整段粗轨迹（hopMs 步长）。
 *  返回的 mark.start/end 是整段文本的字符偏移，绑定原句原文位置。 */
export function detectSentenceStress(args: {
  text: string
  start: number
  end: number
  anchors: (CharAnchor | null)[]
  frames: PitchFrame[]
  hopMs: number
  noiseFloor: number
  speechEndMs: number | null
}): StressSentenceResult {
  const C = STRESS_CONST
  const { text, start, end, anchors, frames, hopMs, noiseFloor } = args
  const fail = (reason: StressNullReason): StressSentenceResult => ({
    mark: null,
    measurement: null,
    reason,
  })
  if (frames.length === 0) return fail('no-audio')

  const chars: { idx: number; ch: string; peak: number }[] = []
  for (let i = start; i < end; i++) {
    const ch = text[i]
    if (/\s/.test(ch) || !WORD_CHAR.test(ch)) continue
    const a = anchors[i]
    if (!a) return fail('no-alignment')
    chars.push({ idx: i, ch, peak: a.peak })
  }
  if (chars.length < C.minSentenceChars) return fail('too-short')
  for (let i = 1; i < chars.length; i++) {
    if (chars[i].peak <= chars[i - 1].peak) return fail('no-alignment')
  }

  // 字窗 = 相邻峰值中点连线；只统计窗内活动帧，静音/停顿不计入响度与时长
  const gaps: number[] = []
  for (let i = 1; i < chars.length; i++) gaps.push(chars[i].peak - chars[i - 1].peak)
  const medGap = median(gaps)
  const activeThresh = Math.max(PITCH_CONST.minRms, noiseFloor * PITCH_CONST.noiseFloorRatio)
  // 句尾窗右缘：本句最后一个活动帧。CTC 锚点偏早，句尾字按 peak+半间距截断
  // 会丢掉大半音节能量；多句段不得借用后续句的语音——右界取下一字锚点
  // 与整段语音结束的较小者，再向内找最后一个活动帧
  let rightLimit = Number.POSITIVE_INFINITY
  for (let i = end; i < anchors.length; i++) {
    const a = anchors[i]
    if (a && WORD_CHAR.test(a.ch)) {
      rightLimit = Math.min(rightLimit, a.peak)
      break
    }
  }
  if (args.speechEndMs != null) rightLimit = Math.min(rightLimit, args.speechEndMs + hopMs)
  if (!Number.isFinite(rightLimit)) rightLimit = chars[chars.length - 1].peak + medGap / 2
  let lastEnd = chars[chars.length - 1].peak
  for (let i = frames.length - 1; i >= 0; i--) {
    if (frames[i].tMs > rightLimit) continue
    if (frames[i].rms >= activeThresh) {
      lastEnd = frames[i].tMs + hopMs / 2
      break
    }
  }
  const feats: CharFeat[] = chars.map((c, i) => {
    const left = i === 0 ? Math.max(0, c.peak - medGap / 2) : (chars[i - 1].peak + c.peak) / 2
    const right = i === chars.length - 1 ? lastEnd : (c.peak + chars[i + 1].peak) / 2
    let sumSq = 0
    let nActive = 0
    const voicedF0: number[] = []
    for (const f of frames) {
      if (f.tMs < left || f.tMs >= right) continue
      if (f.rms < activeThresh) continue
      sumSq += f.rms * f.rms
      nActive++
      if (f.f0 != null && f.conf >= PITCH_CONST.confTailVoiced) voicedF0.push(f.f0)
    }
    return { idx: c.idx, ch: c.ch, peak: c.peak, sumSq, nActive, voicedF0 }
  })

  const totalActive = feats.reduce((a, f) => a + f.nActive, 0)
  if (totalActive * hopMs < C.minWordActiveMs + C.minRestActiveMs) return fail('no-speech')
  const allVoiced = feats.flatMap((f) => f.voicedF0)
  if (allVoiced.length === 0) return fail('no-speech')
  const voicedRms: number[] = []
  for (const f of frames) {
    if (f.f0 != null && f.conf >= PITCH_CONST.confTailVoiced && f.rms >= activeThresh) {
      voicedRms.push(f.rms)
    }
  }
  // 噪声门用未封顶的低分位：静音/停顿帧的真实噪声底，响度对比被噪声淹没时留空
  const noiseP10 = Math.max(1e-6, percentile(frames.map((f) => f.rms), 0.1))
  if (median(voicedRms) / noiseP10 < C.snrRatio) return fail('too-noisy')

  const totalSumSq = feats.reduce((a, f) => a + f.sumSq, 0)
  // 句内 robust 基线（下中位数）：与邻近语音比较，且不被少数重读词抬高
  const charSq = feats.filter((f) => f.nActive > 0).map((f) => f.sumSq / f.nActive)
  const charDur = feats.filter((f) => f.nActive > 0).map((f) => f.nActive * hopMs)
  const charF0 = feats.filter((f) => f.voicedF0.length >= 2).map((f) => median(f.voicedF0))
  const loudBase = loMedian(charSq)
  const durBase = loMedian(charDur)
  const pitchBase = charF0.length >= 3 ? loMedian(charF0) : null
  // 候选 = 连续汉字/字母数字串内的 1–3 字滑窗（不跨标点）
  const runs: number[][] = []
  let run: number[] = []
  for (let i = 0; i < feats.length; i++) {
    if (i > 0 && feats[i].idx !== feats[i - 1].idx + 1) {
      if (run.length) runs.push(run)
      run = []
    }
    run.push(i)
  }
  if (run.length) runs.push(run)

  const candidates: Candidate[] = []
  for (const r of runs) {
    for (let a = 0; a < r.length; a++) {
      for (let b = a; b < r.length && b - a + 1 <= C.maxWordChars; b++) {
        const len = b - a + 1
        const restChars = feats.length - len
        if (restChars < C.minRestChars) continue
        let wSq = 0
        let wN = 0
        const wF0: number[] = []
        const wDur: number[] = []
        for (let k = a; k <= b; k++) {
          const f = feats[r[k]]
          wSq += f.sumSq
          wN += f.nActive
          wF0.push(...f.voicedF0)
          wDur.push(f.nActive * hopMs)
        }
        const rSq = totalSumSq - wSq
        const rN = totalActive - wN
        const wordActiveMs = wN * hopMs
        const restActiveMs = rN * hopMs
        if (wordActiveMs < C.minWordActiveMs || restActiveMs < C.minRestActiveMs) continue
        if (wSq <= 0 || rSq <= 0) continue
        const loudDb = 10 * Math.log10(wSq / wN / loudBase)
        if (loudDb < C.loudCombDb) continue
        let pitchSt: number | null = null
        if (wF0.length >= C.minWordVoicedFrames && pitchBase != null) {
          pitchSt = 12 * Math.log2(median(wF0) / pitchBase)
        }
        const wAvg = wDur.reduce((x, y) => x + y, 0) / wDur.length
        const durRatio = durBase > 0 ? wAvg / durBase : null
        const durDiffMs = wAvg - durBase
        const pitchCue = pitchSt != null && pitchSt >= C.pitchCombSt
        const durCue =
          durRatio != null && durRatio >= C.durCombRatio && durDiffMs >= C.durCombMinDiffMs
        let ok: boolean
        if (len === 1) {
          ok = loudDb >= C.singleCharDb && pitchSt != null && pitchSt >= C.singleCharPitchSt
        } else {
          ok = loudDb >= C.loudOnlyDb || pitchCue || durCue
        }
        if (!ok) continue
        candidates.push({
          a, b,
          textStart: feats[r[a]].idx,
          textEnd: feats[r[b]].idx + 1,
          loudDb, pitchSt, durRatio, durDiffMs, pitchCue, durCue, wordActiveMs, restActiveMs,
        })
      }
    }
  }
  if (candidates.length === 0) return fail('no-candidate')

  candidates.sort((x, y) => y.loudDb - x.loudDb)
  const top = candidates[0].loudDb
  const near = candidates.filter((c) => c.loudDb >= top - C.ambiguityMarginDb)
  // 难分判定：互不重叠的候选并存 → 留空；部分重叠且同长不同词 → 留空
  for (let i = 0; i < near.length; i++) {
    for (let j = i + 1; j < near.length; j++) {
      if (near[i].textEnd <= near[j].textStart || near[j].textEnd <= near[i].textStart) {
        return fail('ambiguous')
      }
    }
  }
  const minLen = Math.min(...near.map((c) => c.b - c.a + 1))
  const shortest = near.filter((c) => c.b - c.a + 1 === minLen)
  if (shortest.length > 1) return fail('ambiguous')
  const win = shortest[0]

  const word = text.slice(win.textStart, win.textEnd)
  const cues: StressMeasurement['cues'] = ['loudness']
  const bits = [`「${word}」比前后几个字更响`]
  const nums = [`+${win.loudDb.toFixed(1)}dB`]
  if (win.pitchCue && win.pitchSt != null) {
    cues.push('pitch')
    bits.push('音高也更高')
    nums.push(`+${win.pitchSt.toFixed(1)}半音`)
  }
  if (win.durCue && win.durRatio != null) {
    cues.push('duration')
    bits.push('说得更长')
    nums.push(`时长约${win.durRatio.toFixed(1)}倍`)
  }
  const mark: StressMark = {
    word,
    start: win.textStart,
    end: win.textEnd,
    evidence: `${bits.join('，')}（${nums.join('，')}）`,
  }
  const measurement: StressMeasurement = {
    loudnessDb: Math.round(win.loudDb * 10) / 10,
    pitchSt: win.pitchCue && win.pitchSt != null ? Math.round(win.pitchSt * 10) / 10 : null,
    durationRatio:
      win.durCue && win.durRatio != null ? Math.round(win.durRatio * 100) / 100 : null,
    wordActiveMs: Math.round(win.wordActiveMs),
    restActiveMs: Math.round(win.restActiveMs),
    cues,
  }
  return { mark, measurement, reason: null }
}