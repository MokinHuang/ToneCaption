import { test } from 'node:test'
import assert from 'node:assert/strict'
import { analyzeSegmentTone, TONE_LABEL, CUE_LABEL } from '../src/lib/toneAnalysis.ts'

const SR = 16000

function synth(segs: { durMs: number; f0Start: number; f0End?: number }[]): Float32Array {
  const total = segs.reduce((a, s) => a + Math.round((s.durMs / 1000) * SR), 0)
  const out = new Float32Array(total)
  let phase = 0
  let i = 0
  for (const s of segs) {
    const n = Math.round((s.durMs / 1000) * SR)
    const h = [1, 0.5, 0.33, 0.25, 0.2]
    const norm = h.reduce((a, b) => a + b, 0)
    const f1 = s.f0End ?? s.f0Start
    for (let k = 0; k < n; k++, i++) {
      const f = s.f0Start + ((f1 - s.f0Start) * k) / Math.max(1, n - 1)
      phase += (2 * Math.PI * f) / SR
      let v = 0
      for (let q = 0; q < h.length; q++) v += (h[q] * Math.sin((q + 1) * phase)) / norm
      out[i] = 0.3 * v
    }
  }
  return out
}

const flatPcm = () => synth([{ durMs: 2000, f0Start: 180 }])
const risePcm = () =>
  synth([
    { durMs: 1650, f0Start: 180 },
    { durMs: 350, f0Start: 180, f0End: 260 },
  ])

const base = {
  prevTexts: [] as string[],
  cutReason: 'pause' as const,
  emotion: 'neutral' as string | null,
}

test('文本命中 + 无音频 → 语气成立，依据只引原词、不写上扬', async () => {
  const r = await analyzeSegmentTone({
    ...base,
    text: '改到下周一交，大家能接受吗？',
    pcm16k: null,
  })
  assert.equal(r.tone, TONE_LABEL)
  assert.equal(r.evidence, '说了「大家能接受吗」')
  assert.equal(r.detail.pitchNullReason, 'no-audio')
  assert.equal(r.detail.conclusion, 'tone')
})

test('文本命中 + 平读音频（SenseVoice 中性）→ 仍凭原词提示', async () => {
  const r = await analyzeSegmentTone({
    ...base,
    text: '改到下周一交，大家能接受吗。',
    pcm16k: flatPcm(),
  })
  assert.equal(r.tone, TONE_LABEL)
  assert.ok(!r.evidence!.includes('上扬'), '未测得上扬不得写进依据')
  assert.equal(r.detail.emotion, 'neutral')
})

test('文本命中 + 实测上扬 → 依据含两条证据', async () => {
  const r = await analyzeSegmentTone({
    ...base,
    text: '这样安排大家没问题吧',
    pcm16k: risePcm(),
  })
  assert.equal(r.tone, TONE_LABEL)
  assert.ok(r.evidence!.includes('说了「'))
  assert.ok(r.evidence!.includes('句末音高上扬'))
  assert.ok(r.detail.pitch && r.detail.pitch.riseSemitones >= 3)
})

test('转述抑制 + 上扬音频 → 只留字幕，连线索也不给', async () => {
  const r = await analyzeSegmentTone({
    ...base,
    text: '他问能不能提前',
    pcm16k: risePcm(),
  })
  assert.equal(r.tone, undefined)
  assert.equal(r.toneCue, undefined)
  assert.equal(r.detail.conclusion, 'none')
  assert.equal(r.detail.suppressedBy, 'reported-speech')
})

test('无措辞 + 仅上扬 → 只显示线索，不猜语气', async () => {
  const r = await analyzeSegmentTone({ ...base, text: '这周五交', pcm16k: risePcm() })
  assert.equal(r.tone, undefined)
  assert.equal(r.toneCue, CUE_LABEL)
  assert.equal(r.detail.conclusion, 'cue-only')
})

test('无措辞 + 平读 → 只留字幕', async () => {
  const r = await analyzeSegmentTone({ ...base, text: '这周五交', pcm16k: flatPcm() })
  assert.equal(r.tone, undefined)
  assert.equal(r.toneCue, undefined)
  assert.equal(r.detail.conclusion, 'none')
})

test('上下文承接：前句提问 + 短句 + 实测上扬 → 语气', async () => {
  const r = await analyzeSegmentTone({
    ...base,
    prevTexts: ['今天讲二叉树。', '大家觉得哪天合适？'],
    text: '这周五交',
    pcm16k: risePcm(),
  })
  assert.equal(r.tone, TONE_LABEL)
  assert.ok(r.evidence!.startsWith('承接前句提问「'))
  assert.ok(r.evidence!.includes('句末音高上扬'))
  assert.equal(r.detail.contextPrevQuestion, '大家觉得哪天合适')
})

test('上下文承接必须音高确证：平读版落空', async () => {
  const r = await analyzeSegmentTone({
    ...base,
    prevTexts: ['大家觉得哪天合适？'],
    text: '这周五交',
    pcm16k: flatPcm(),
  })
  assert.equal(r.tone, undefined)
  assert.equal(r.detail.conclusion, 'none')
})

test('上下文承接拒绝长陈述句', async () => {
  const r = await analyzeSegmentTone({
    ...base,
    prevTexts: ['大家觉得哪天合适？'],
    text: '这个实验报告改到下周一再交',
    pcm16k: risePcm(),
  })
  assert.equal(r.tone, undefined)
  assert.equal(r.toneCue, CUE_LABEL)
})

test('15s 强制分段跳过音高（forced-cut），文本规则照跑', async () => {
  const r = await analyzeSegmentTone({
    ...base,
    cutReason: 'max-length',
    text: '这周五交',
    pcm16k: risePcm(),
  })
  assert.equal(r.tone, undefined)
  assert.equal(r.toneCue, undefined)
  assert.equal(r.detail.pitchNullReason, 'forced-cut')
  const r2 = await analyzeSegmentTone({
    ...base,
    cutReason: 'max-length',
    text: '大家能接受吗',
    pcm16k: risePcm(),
  })
  assert.equal(r2.tone, TONE_LABEL)
})

test('空文本 → 只留字幕', async () => {
  const r = await analyzeSegmentTone({ ...base, text: '', pcm16k: risePcm() })
  assert.equal(r.detail.conclusion, 'none')
  assert.equal(r.detail.pitchNullReason, 'empty-text')
})

test('异常吞没：任何异常都不上抛', async () => {
  const evil = { trim: () => { throw new Error('boom') } }
  const r = await analyzeSegmentTone({ ...base, text: evil as unknown as string, pcm16k: null })
  assert.equal(r.detail.conclusion, 'none')
  assert.ok(r.detail.reason.includes('分析异常'))
})

test('声学情感只记录不判断：neutral 与 happy 结论一致', async () => {
  const a = await analyzeSegmentTone({ ...base, emotion: 'neutral', text: '这样可以吗', pcm16k: flatPcm() })
  const b = await analyzeSegmentTone({ ...base, emotion: 'happy', text: '这样可以吗', pcm16k: flatPcm() })
  assert.equal(a.detail.conclusion, b.detail.conclusion)
  assert.equal(a.evidence, b.evidence)
  assert.equal(b.detail.emotion, 'happy')
})

test('所有语气输出的证据摘录均为转写原词子串', async () => {
  const texts = ['大家能接受吗', '这样安排大家没问题吧', '能不能提前交？', '大家听懂了没有']
  for (const text of texts) {
    const r = await analyzeSegmentTone({ ...base, text, pcm16k: null })
    assert.equal(r.tone, TONE_LABEL)
    const m = r.evidence!.match(/说了「(.+?)」/)
    assert.ok(m && text.includes(m[1]), `摘录不在原文: ${r.evidence}`)
  }
})