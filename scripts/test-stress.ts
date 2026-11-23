import { test } from 'node:test'
import assert from 'node:assert/strict'
import { alignTokens, detectSentenceStress, STRESS_CONST } from '../src/lib/stress.ts'
import { analyzeSegmentTone, TONE_LABEL } from '../src/lib/toneAnalysis.ts'
import { frameNoiseFloor, voicedEndMs, PITCH_CONST } from '../src/lib/pitch.ts'
import { pitchTrack } from '../src/lib/pitch.ts'
import { synthAudio, wuZiJiaoChuGao } from './synth-stress-audio.ts'
import type { SynthChar } from './synth-stress-audio.ts'

/** 合成音频只验证算法逻辑（响度/音高/拉长/留空），不代表真人韵律。 */

async function analyze(chars: SynthChar[], cutReason: 'pause' | 'max-length' | 'stop' = 'pause') {
  const a = synthAudio(chars)
  return analyzeSegmentTone({
    text: a.text,
    prevTexts: [],
    pcm16k: a.pcm,
    cutReason,
    emotion: null,
    tokens: a.tokens,
    timestamps: a.timestamps,
  })
}

test('alignTokens：逐字精确对齐（含标点），空白跳过', () => {
  const ts: [number, number][] = [0, 1, 2, 3, 4, 5].map((i) => [i * 200, i * 200 + 60])
  const a = alignTokens('周五交初稿。', ['周', '五', '交', '初', '稿', '。'], ts)
  assert.ok(a)
  assert.equal(a.length, 6)
  assert.equal(a[0]!.ch, '周')
  assert.equal(a[5]!.ch, '。')
  const b = alignTokens('hello 世界', ['hello', '世', '界'], [[0, 60], [100, 160], [200, 260]])
  assert.ok(b)
  assert.equal(b[5], null, '空白位置无锚点')
  assert.equal(b[6]!.ch, '世')
})

test('alignTokens：任何不一致整段返回 null，绝不按字数均分', () => {
  const ts: [number, number][] = [0, 1, 2].map((i) => [i * 200, i * 200 + 60])
  assert.equal(alignTokens('周五交', ['周', '五', '高'], ts), null, '字面不一致')
  assert.equal(alignTokens('周五交', ['周', '五'], ts.slice(0, 2)), null, '数量不足')
  assert.equal(alignTokens('周五', ['周', '五', '交'], [[0, 60], [100, 160], [200, 260]]), null, '数量多余')
  assert.equal(alignTokens('周五', ['周', '五'], [[0, 60], [300, 200]]), null, '时间倒挂')
  assert.equal(alignTokens('周五', ['周', '五'], [[0, 60]]), null, 'tokens/timestamps 不等长')
})

test('仅响度：重读「初稿」→ 标记初稿，依据只写响度', async () => {
  const out = await analyze(wuZiJiaoChuGao({ 3: { amp: 0.2 }, 4: { amp: 0.2 } }))
  const s = out.sentences[0]
  assert.ok(s.stress, '应给出重音标记')
  assert.equal(s.stress!.word, '初稿')
  assert.equal(s.stress!.start, 3)
  assert.equal(s.stress!.end, 5)
  assert.deepEqual(s.detail.stress!.cues, ['loudness'])
  assert.ok(s.stress!.evidence.includes('更响'))
  assert.ok(!s.stress!.evidence.includes('音高'), '只测到响度时不写音高')
  assert.ok(!s.stress!.evidence.includes('更长'), '只测到响度时不写时长')
  assert.equal(out.stress!.word, '初稿')
})

test('仅响度：重读「周五」→ 标记句首词，位置绑定 0..2', async () => {
  const out = await analyze(wuZiJiaoChuGao({ 0: { amp: 0.2 }, 1: { amp: 0.2 } }))
  assert.equal(out.sentences[0].stress!.word, '周五')
  assert.equal(out.sentences[0].stress!.start, 0)
  assert.equal(out.sentences[0].stress!.end, 2)
})

test('平读：整句留空（no-candidate）', async () => {
  const out = await analyze(wuZiJiaoChuGao())
  assert.equal(out.sentences[0].stress, undefined)
  assert.equal(out.sentences[0].detail.stressNullReason, 'no-candidate')
  assert.equal(out.stress, undefined)
})

test('仅音高最高不足以触发', async () => {
  const out = await analyze(wuZiJiaoChuGao({ 0: { f0: 260 }, 1: { f0: 260 } }))
  assert.equal(out.sentences[0].stress, undefined)
  assert.equal(out.sentences[0].detail.stressNullReason, 'no-candidate')
})

test('仅持续最久不足以触发', async () => {
  const out = await analyze(wuZiJiaoChuGao({ 0: { durMs: 340 }, 1: { durMs: 340 } }))
  assert.equal(out.sentences[0].stress, undefined)
  assert.equal(out.sentences[0].detail.stressNullReason, 'no-candidate')
})

test('中等响度 + 音高加强：两证据都写进依据', async () => {
  const out = await analyze(wuZiJiaoChuGao({ 3: { amp: 0.115, f0: 230 }, 4: { amp: 0.115, f0: 230 } }))
  const s = out.sentences[0]
  assert.ok(s.stress)
  assert.equal(s.stress!.word, '初稿')
  assert.deepEqual(s.detail.stress!.cues, ['loudness', 'pitch'])
  assert.ok(s.stress!.evidence.includes('音高'))
})

test('两个候选难分：留空 ambiguous', async () => {
  // 两词同重、其余字平读（须有未重读多数作基线）；五字句 4/5 同重属退化场景，
  // 无可靠基线时按 no-candidate 留空同样符合宁缺毋滥
  const out = await analyze([
    ...wuZiJiaoChuGao({ 0: { amp: 0.2 }, 1: { amp: 0.2 }, 3: { amp: 0.2 }, 4: { amp: 0.2 } }),
    { ch: '，', gapAfterMs: 250 },
    { ch: '大' }, { ch: '家' }, { ch: '记' }, { ch: '住' },
    { ch: '。', gapAfterMs: 200 },
  ])
  assert.equal(out.sentences[0].stress, undefined)
  assert.equal(out.sentences[0].detail.stressNullReason, 'ambiguous')
  const degenerate = await analyze(
    wuZiJiaoChuGao({ 0: { amp: 0.2 }, 1: { amp: 0.2 }, 3: { amp: 0.2 }, 4: { amp: 0.2 } }),
  )
  assert.equal(degenerate.sentences[0].stress, undefined, '无未重读多数时也留空')
})

test('单字候选：须响度 + 音高双证据', async () => {
  const loud = await analyze(wuZiJiaoChuGao({ 2: { amp: 0.2 } }))
  assert.equal(loud.sentences[0].stress, undefined, '单字仅响度不标记')
  const both = await analyze(wuZiJiaoChuGao({ 2: { amp: 0.2, f0: 260 } }))
  assert.equal(both.sentences[0].stress!.word, '交')
  assert.equal(both.sentences[0].stress!.start, 2)
})

test('噪声过大：留空', async () => {
  const a = synthAudio(wuZiJiaoChuGao({ 3: { amp: 0.2 }, 4: { amp: 0.2 } }), { noise: 0.15 })
  const out = await analyzeSegmentTone({
    text: a.text, prevTexts: [], pcm16k: a.pcm, cutReason: 'pause', emotion: null,
    tokens: a.tokens, timestamps: a.timestamps,
  })
  assert.equal(out.sentences[0].stress, undefined)
  assert.ok(['too-noisy', 'no-speech'].includes(out.sentences[0].detail.stressNullReason!))
})

test('纯静音：留空 no-speech，不影响主链路', async () => {
  const a = synthAudio(wuZiJiaoChuGao(), { noise: 0.00001 })
  for (let i = 0; i < a.pcm.length; i++) a.pcm[i] = 0
  const out = await analyzeSegmentTone({
    text: a.text, prevTexts: [], pcm16k: a.pcm, cutReason: 'pause', emotion: null,
    tokens: a.tokens, timestamps: a.timestamps,
  })
  assert.equal(out.sentences[0].stress, undefined)
  assert.equal(out.sentences[0].detail.stressNullReason, 'no-speech')
})

test('句内字数不足：留空 too-short', async () => {
  const out = await analyze([
    { ch: '周', amp: 0.2 }, { ch: '五', amp: 0.2 }, { ch: '交' },
  ])
  assert.equal(out.sentences[0].detail.stressNullReason, 'too-short')
})

test('对齐缺失：不做重音，语气规则不受影响', async () => {
  const a = synthAudio(wuZiJiaoChuGao({ 3: { amp: 0.2 }, 4: { amp: 0.2 } }))
  const out = await analyzeSegmentTone({
    text: a.text, prevTexts: [], pcm16k: a.pcm, cutReason: 'pause', emotion: null,
  })
  assert.equal(out.sentences[0].stress, undefined)
  assert.equal(out.sentences[0].detail.stressNullReason, 'no-alignment')
  const q = synthAudio(['大', '家', '能', '接', '受', '吗'].map((ch) => ({ ch })))
  const out2 = await analyzeSegmentTone({
    text: q.text, prevTexts: [], pcm16k: q.pcm, cutReason: 'pause', emotion: null,
  })
  assert.equal(out2.tone, TONE_LABEL, '无时间戳时语气提示照常')
  assert.equal(out2.sentences[0].detail.stressNullReason, 'no-alignment')
})

test('重复词：标记绑定第二次出现的字符位置，不落第一次', async () => {
  const chars: SynthChar[] = [
    ...wuZiJiaoChuGao(),
    { ch: '，', gapAfterMs: 250 },
    { ch: '周', amp: 0.2 }, { ch: '五', amp: 0.2 }, { ch: '交' }, { ch: '终' }, { ch: '稿' },
    { ch: '。', gapAfterMs: 200 },
  ]
  const out = await analyze(chars)
  assert.equal(out.sentences.length, 1, '逗号不分句')
  const s = out.sentences[0]
  assert.ok(s.stress)
  assert.equal(s.stress!.word, '周五')
  assert.equal(s.stress!.start, 6, '必须是第二个「周五」')
  assert.equal(s.stress!.end, 8)
  assert.equal(s.text.slice(s.stress!.start, s.stress!.end), '周五')
})

test('同段多句：重音挂对应句，前句不借用', async () => {
  const chars: SynthChar[] = [
    ...wuZiJiaoChuGao(),
    { ch: '。', gapAfterMs: 250 },
    { ch: '明', amp: 0.2 }, { ch: '天', amp: 0.2 }, { ch: '带' }, { ch: '纸' }, { ch: '质' }, { ch: '版' },
    { ch: '。', gapAfterMs: 200 },
  ]
  const out = await analyze(chars)
  assert.equal(out.sentences.length, 2)
  assert.equal(out.sentences[0].stress, undefined)
  assert.equal(out.sentences[0].detail.stressNullReason, 'no-candidate')
  assert.equal(out.sentences[1].stress!.word, '明天')
  assert.equal(out.sentences[1].stress!.start, 6)
  assert.equal(out.stress!.start, 6)
})

test('强制切段：重音暂缓', async () => {
  const out = await analyze(wuZiJiaoChuGao({ 3: { amp: 0.2 }, 4: { amp: 0.2 } }), 'max-length')
  assert.equal(out.sentences[0].stress, undefined)
  assert.equal(out.sentences[0].detail.stressNullReason, 'forced-cut')
})

test('多句末尾残句：暂缓重音', async () => {
  const chars: SynthChar[] = [
    ...wuZiJiaoChuGao(),
    { ch: '。', gapAfterMs: 250 },
    { ch: '明', amp: 0.2 }, { ch: '天', amp: 0.2 }, { ch: '带' }, { ch: '纸' }, { ch: '质' },
  ]
  const out = await analyze(chars)
  assert.equal(out.sentences.length, 2)
  assert.equal(out.sentences[1].complete, false)
  assert.equal(out.sentences[1].stress, undefined)
  assert.equal(out.sentences[1].detail.stressNullReason, 'incomplete-sentence')
})

test('detectSentenceStress：无帧 → no-audio；门槛常量为正', async () => {
  const a = synthAudio(wuZiJiaoChuGao())
  const anchors = alignTokens(a.text, a.tokens, a.timestamps)!
  const r = detectSentenceStress({
    text: a.text, start: 0, end: a.text.length, anchors,
    frames: [], hopMs: 25, noiseFloor: 0.001, speechEndMs: null,
  })
  assert.equal(r.reason, 'no-audio')
  assert.ok(STRESS_CONST.loudOnlyDb > STRESS_CONST.loudCombDb)
  const frames = await pitchTrack(a.pcm, 16000, { hopMs: PITCH_CONST.bodyHopMs })
  const r2 = detectSentenceStress({
    text: a.text, start: 0, end: a.text.length, anchors,
    frames, hopMs: PITCH_CONST.bodyHopMs, noiseFloor: frameNoiseFloor(frames),
    speechEndMs: voicedEndMs(frames),
  })
  assert.equal(r2.reason, 'no-candidate', '平读合成音直接调用也留空')
})