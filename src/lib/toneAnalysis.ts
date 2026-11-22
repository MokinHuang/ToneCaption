/** 语气融合：文本规则 + 句末音高 + 少量上文 → 三态输出（语气 / 仅线索 / 只留字幕）。
 *  整体 try/catch，任何异常都降级为"只留字幕"，绝不影响收音与转写。
 *  SenseVoice 声学情感仅作记录，不参与判断；说话人不明，不做跨句音量/语速比较。 */
import type { ToneAnalysisDetail } from '../types.ts'
import { matchTextTone, findPrevQuestion, isShortEchoClause } from './toneRules.ts'
import { pitchTrack, tailRise, voicedEndMs, PITCH_CONST } from './pitch.ts'
import type { TailRiseResult } from './pitch.ts'

export const TONE_LABEL = '可能在征求确认'
export const CUE_LABEL = '句末音高上扬'
const ANALYSIS_BUDGET_MS = 2000
const MIN_PITCH_SEGMENT_MS = 600

export interface ToneAnalysisInput {
  text: string
  /** 本会话已完成的最近 2 句（旧→新） */
  prevTexts: string[]
  pcm16k: Float32Array | null
  cutReason: 'pause' | 'max-length' | 'stop'
  emotion: string | null
}

export interface ToneAnalysisOutput {
  tone?: string
  evidence?: string
  toneCue?: string
  detail: ToneAnalysisDetail
}

const PITCH_REASON_ZH: Record<string, string> = {
  'forced-cut': '超长强制分段，切点不是语句末尾',
  'too-short-segment': '音频太短',
  'no-voiced-tail': '句末有效浊音不足',
  'low-confidence': '音高置信度低',
  'too-noisy': '噪声过大',
  'no-baseline': '句中基线不足',
  'short-span': '上升趋势覆盖太短',
  'insufficient-rise': '升幅不足或趋势平缓',
  'non-monotonic': '趋势震荡不清',
  'single-syllable-rise': '仅单字升调，不足以判为句末上扬',
  'end-not-elevated': '句末未高于句中基线',
  'start-elevated': '从句中低谷回升，非句末上扬',
  'octave-jump': '音高跳变异常',
  'no-audio': '无可用音频',
  'budget-exceeded': '分析超时，放弃音高',
  'empty-text': '该段未识别出文字',
  'analysis-error': '分析异常',
}

export function pitchReasonLabel(reason: string | null): string {
  if (!reason) return ''
  return PITCH_REASON_ZH[reason] ?? reason
}

async function measurePitch(
  pcm: Float32Array | null,
  cutReason: ToneAnalysisInput['cutReason'],
): Promise<TailRiseResult> {
  if (!pcm || pcm.length === 0) return { ok: false, reason: 'no-audio' }
  if (cutReason === 'max-length') return { ok: false, reason: 'forced-cut' }
  const sr = 16000
  const totalMs = (pcm.length / sr) * 1000
  if (totalMs < MIN_PITCH_SEGMENT_MS) return { ok: false, reason: 'too-short-segment' }
  const t0 = performance.now()
  // 先整段粗轨迹：段末常带静音，细尾窗必须锚定真实语音结束点而非段末
  const body = await pitchTrack(pcm, sr, { hopMs: PITCH_CONST.bodyHopMs })
  if (performance.now() - t0 > ANALYSIS_BUDGET_MS) {
    return { ok: false, reason: 'budget-exceeded' }
  }
  const speechEnd = voicedEndMs(body)
  if (speechEnd == null) return { ok: false, reason: 'no-voiced-tail' }
  const tail = await pitchTrack(pcm, sr, {
    startMs: Math.max(0, speechEnd - PITCH_CONST.tailBacktrackMs),
    endMs: Math.min(totalMs, speechEnd + 60),
    hopMs: PITCH_CONST.tailHopMs,
  })
  if (performance.now() - t0 > ANALYSIS_BUDGET_MS) {
    return { ok: false, reason: 'budget-exceeded' }
  }
  return tailRise(body, tail)
}

export async function analyzeSegmentTone(input: ToneAnalysisInput): Promise<ToneAnalysisOutput> {
  const detail: ToneAnalysisDetail = {
    textPattern: null,
    textExcerpt: null,
    suppressedBy: null,
    pitch: null,
    pitchNullReason: null,
    emotion: input.emotion,
    contextPrevQuestion: null,
    conclusion: 'none',
    reason: '',
  }
  try {
    const text = input.text ?? ''
    if (!text.trim()) {
      detail.pitchNullReason = 'empty-text'
      detail.reason = PITCH_REASON_ZH['empty-text']
      return { detail }
    }
    const tr = matchTextTone(text)
    detail.textPattern = tr.pattern
    detail.textExcerpt = tr.excerpt
    detail.suppressedBy = tr.suppressedBy

    const pr = await measurePitch(input.pcm16k, input.cutReason)
    detail.pitch = pr.ok ? pr.m : null
    detail.pitchNullReason = pr.ok ? null : pr.reason

    const ctx = findPrevQuestion(input.prevTexts)
    detail.contextPrevQuestion = ctx

    if (tr.hit) {
      detail.conclusion = 'tone'
      detail.reason = `文本命中：${tr.pattern}`
      const evidence = `说了「${tr.excerpt}」${pr.ok ? '，句末音高上扬' : ''}`
      return { tone: TONE_LABEL, evidence, detail }
    }
    if (tr.suppressedBy) {
      detail.reason =
        tr.suppressedBy === 'quoted'
          ? '确认类措辞在引号内，属引用，不提示回应'
          : '转述他人话语，不提示全班回应'
      return { detail }
    }
    if (ctx && isShortEchoClause(text) && pr.ok) {
      detail.conclusion = 'tone'
      detail.reason = '承接前句提问，且实测句末上扬'
      return {
        tone: TONE_LABEL,
        evidence: `承接前句提问「${ctx}」，句末音高上扬`,
        detail,
      }
    }
    if (pr.ok) {
      detail.conclusion = 'cue-only'
      detail.reason = '无确认类措辞，仅实测到句末上扬，保留线索不猜语气'
      return { toneCue: CUE_LABEL, detail }
    }
    detail.reason = `无确认类措辞；音高：${pitchReasonLabel(detail.pitchNullReason)}`
    return { detail }
  } catch (err) {
    detail.conclusion = 'none'
    detail.pitchNullReason = 'analysis-error'
    detail.reason = `分析异常：${err instanceof Error ? err.message : String(err)}`
    return { detail }
  }
}