/** 语气融合：文本规则 + 句末音高 + 少量上文 → 三态输出（语气 / 仅线索 / 只留字幕）。
 *  整体 try/catch，任何异常都降级为"只留字幕"，绝不影响收音与转写。
 *  SenseVoice 声学情感仅作记录，不参与判断；说话人不明，不做跨句音量/语速比较。 */
import type { SentenceTone, ToneAnalysisDetail } from '../types.ts'
import { matchTextTone, findPrevQuestion, splitSentences } from './toneRules.ts'
import type { ToneSuppression, TextToneMatch } from './toneRules.ts'
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
  /** 段内逐句结果（含单句段）；多句时提示按句子位置/原文范围绑定 */
  sentences: SentenceTone[]
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
  'incomplete-sentence': '句尾边界不完整，暂缓判断',
  'not-aligned': '音高测量未对齐到本句',
}

export function pitchReasonLabel(reason: string | null): string {
  if (!reason) return ''
  return PITCH_REASON_ZH[reason] ?? reason
}

const SUPPRESS_REASON: Record<ToneSuppression, string> = {
  quoted: '确认类措辞在引号内，属引用，不提示回应',
  'reported-speech': '转述他人或自己过去的话语，不提示全班回应',
  'embedded-question': '疑问嵌在「不知道/问过」等表述里，不是向听众求证',
  rhetorical: '反问句，不期待回应',
  'action-request': '动作请求（把/帮/一下类），不是征求确认',
}

async function measurePitch(pcm: Float32Array | null): Promise<TailRiseResult> {
  if (!pcm || pcm.length === 0) return { ok: false, reason: 'no-audio' }
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

/** 单句判定：文本命中→语气；被抑制→只留字幕；仅实测上扬→线索。 */
function conclude(
  tr: TextToneMatch,
  pr: TailRiseResult | null,
  detail: ToneAnalysisDetail,
): { tone?: string; evidence?: string; toneCue?: string } {
  if (tr.hit) {
    detail.conclusion = 'tone'
    detail.reason = `文本命中：${tr.pattern}`
    const evidence = `说了「${tr.excerpt}」${pr?.ok ? '，句末音高上扬' : ''}`
    return { tone: TONE_LABEL, evidence }
  }
  if (tr.suppressedBy) {
    detail.reason = SUPPRESS_REASON[tr.suppressedBy]
    return {}
  }
  // 上文提问 + 简短回答最多支持「句末音高上扬」线索：回答本身不是征求确认
  if (pr?.ok) {
    detail.conclusion = 'cue-only'
    detail.reason = '无确认类措辞，仅实测到句末上扬，保留线索不猜语气'
    return { toneCue: CUE_LABEL }
  }
  detail.reason = `无确认类措辞；音高：${pitchReasonLabel(detail.pitchNullReason)}`
  return {}
}

export async function analyzeSegmentTone(input: ToneAnalysisInput): Promise<ToneAnalysisOutput> {
  const baseDetail = (): ToneAnalysisDetail => ({
    textPattern: null,
    textExcerpt: null,
    suppressedBy: null,
    pitch: null,
    pitchNullReason: null,
    emotion: input.emotion,
    contextPrevQuestion: null,
    conclusion: 'none',
    reason: '',
  })
  try {
    const text = input.text ?? ''
    const spans = splitSentences(text)
    if (spans.length === 0) {
      const detail = baseDetail()
      detail.pitchNullReason = 'empty-text'
      detail.reason = PITCH_REASON_ZH['empty-text']
      return { detail, sentences: [] }
    }
    const multi = spans.length > 1
    const forced = input.cutReason === 'max-length'

    // 单句 + 强制切段：切点不是语句末尾，整体暂缓（文本线索仍记录）
    if (!multi && forced) {
      const detail = baseDetail()
      const tr = matchTextTone(text)
      detail.textPattern = tr.pattern
      detail.textExcerpt = tr.excerpt
      detail.suppressedBy = tr.suppressedBy
      detail.pitchNullReason = 'forced-cut'
      detail.reason = '超长强制分段，末尾小句可能未说完，暂缓语气判断'
      return { detail, sentences: [{ ...spans[0], detail }] }
    }

    // 音高整段测一次，只能对齐到"段末完整句"：自然切段且末尾无未完成残句。
    // 多句段的前句无法从句级时间戳对齐音高，一律不列为其依据。
    const last = spans[spans.length - 1]
    const pitchEligible = !forced && (!multi || last.complete)
    const pr = pitchEligible ? await measurePitch(input.pcm16k) : null
    const ctx = findPrevQuestion(input.prevTexts)

    const sentences: SentenceTone[] = []
    for (let i = 0; i < spans.length; i++) {
      const sp = spans[i]
      const detail = baseDetail()
      detail.contextPrevQuestion = ctx
      // 多句段的末尾残句（含强制切段后的未完成句）：先显示字幕，暂缓判断
      if (multi && !sp.complete) {
        detail.pitchNullReason = forced ? 'forced-cut' : 'incomplete-sentence'
        detail.reason = forced
          ? '强制切段后的未完成句，暂缓语气判断'
          : '句尾边界不完整，暂缓语气判断'
        sentences.push({ ...sp, detail })
        continue
      }
      const tr = matchTextTone(sp.text, i > 0 ? spans[i - 1].text : '')
      detail.textPattern = tr.pattern
      detail.textExcerpt = tr.excerpt
      detail.suppressedBy = tr.suppressedBy
      const attributed = i === spans.length - 1 ? pr : null
      if (attributed) {
        detail.pitch = attributed.ok ? attributed.m : null
        detail.pitchNullReason = attributed.ok ? null : attributed.reason
      } else {
        detail.pitchNullReason = forced ? 'forced-cut' : 'not-aligned'
      }
      sentences.push({ ...sp, ...conclude(tr, attributed, detail), detail })
    }
    const winner = sentences.find((s) => s.tone) ?? sentences.find((s) => s.toneCue)
    return {
      tone: winner?.tone,
      evidence: winner?.evidence,
      toneCue: winner?.toneCue,
      detail: winner?.detail ?? sentences[sentences.length - 1].detail,
      sentences,
    }
  } catch (err) {
    const detail = baseDetail()
    detail.conclusion = 'none'
    detail.pitchNullReason = 'analysis-error'
    detail.reason = `分析异常：${err instanceof Error ? err.message : String(err)}`
    return { detail, sentences: [] }
  }
}