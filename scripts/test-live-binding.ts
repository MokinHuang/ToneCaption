import { test } from 'node:test'
import assert from 'node:assert/strict'
import { TONE_LABEL } from '../src/lib/toneAnalysis.ts'
import type { LiveSegment } from '../src/types.ts'

/** 语气分析串行链与转写解耦：第一条语气晚到时，第二条字幕不受阻，
 *  迟到结果只回填对应原句（entry 引用绑定），不挂到后续句子。
 *  通过 ?tone_delay 测试钩子人为延迟；node 下先 stub window 再动态导入。 */
test('语气晚到：第二句字幕按时显示，提示只补回原句', async () => {
  ;(globalThis as unknown as Record<string, unknown>).window = {
    location: { search: '?tone_delay=250' },
  }
  try {
    const { MicLiveSession } = await import('../src/lib/liveMic.ts')
    const snapshots: LiveSegment[][] = []
    const s = new MicLiveSession({
      onSegments: (segs) => snapshots.push(segs),
      onPhase: () => {},
    })
    const mk = (seq: number, text: string): LiveSegment => ({
      seq,
      status: 'done',
      text,
      audioSeconds: 2,
    })
    const e1 = mk(1, '大家能接受吗')
    const e2 = mk(2, '这周五交')
    const internal = s as unknown as {
      segments: LiveSegment[]
      analysisChain: Promise<void>
      enqueueAnalysis: (
        e: LiveSegment,
        pcm: Float32Array | null,
        emotion: string | null,
        at: number,
        cut: 'pause',
      ) => void
    }
    internal.segments.push(e1, e2)
    const t0 = performance.now()
    internal.enqueueAnalysis(e1, null, 'neutral', t0, 'pause')
    internal.enqueueAnalysis(e2, null, 'neutral', t0, 'pause')

    await new Promise((r) => setTimeout(r, 60))
    // 字幕正文早已就位，语气仍在延迟窗口内
    assert.equal(e1.text, '大家能接受吗')
    assert.equal(e2.text, '这周五交')
    assert.equal(e1.tone, undefined, '延迟窗口内第一条语气不应到达')
    assert.equal(e2.tone, undefined)

    await internal.analysisChain
    assert.equal(e1.tone, TONE_LABEL)
    assert.equal(e1.evidence, '说了「大家能接受吗」')
    assert.equal(e2.tone, undefined, '提示不得挂到第二句')
    assert.equal(e2.toneCue, undefined)
    assert.equal(e2.toneDetail?.contextPrevQuestion, '大家能接受吗')

    const last = snapshots[snapshots.length - 1]
    assert.equal(last.find((x) => x.seq === 1)?.tone, TONE_LABEL)
    assert.equal(last.find((x) => x.seq === 2)?.tone, undefined)
    s.dispose()
  } finally {
    delete (globalThis as unknown as Record<string, unknown>).window
  }
})
test('纯标点识别结果：不进历史、不占当前句、不影响下一条', async () => {
  const { MicLiveSession, isPunctuationOnly } = await import('../src/lib/liveMic.ts')
  assert.equal(isPunctuationOnly('。'), true)
  assert.equal(isPunctuationOnly('？！'), true)
  assert.equal(isPunctuationOnly('   '), true)
  assert.equal(isPunctuationOnly('大家能接受吗？'), false)
  assert.equal(isPunctuationOnly('3.14'), false)

  const texts = ['大家能接受吗？', '。', '？！', '   ', '这周五交。']
  let call = 0
  const origFetch = globalThis.fetch
  globalThis.fetch = (async () => ({
    ok: true,
    json: async () => ({
      segments: [{ text: texts[call++], emotion: 'neutral', events: [] }],
      emotion: 'neutral',
    }),
  })) as unknown as typeof fetch
  try {
    const snapshots: LiveSegment[][] = []
    const s = new MicLiveSession({
      onSegments: (segs) => snapshots.push(segs),
      onPhase: () => {},
    })
    const internal = s as unknown as {
      segments: LiveSegment[]
      queue: unknown[]
      analysisChain: Promise<void>
      pump: () => Promise<void>
    }
    texts.forEach((_, i) => {
      internal.segments.push({ seq: i + 1, status: 'pending', text: '', audioSeconds: 1 })
      internal.queue.push({
        seq: i + 1,
        wav: new Blob([new Uint8Array(44)]),
        pcm16k: null,
        cutReason: 'pause',
        audioSeconds: 1,
        lastVoicedAt: 0,
        cutAt: 0,
      })
    })
    await internal.pump()
    await internal.analysisChain

    // 纯标点段被移除，有效段保留且文本原样（含标点）
    assert.deepEqual(internal.segments.map((x) => x.seq), [1, 5])
    assert.equal(internal.segments[0].text, '大家能接受吗？')
    assert.equal(internal.segments[1].text, '这周五交。')

    // 「。」到达时当前句仍是第一条有效字幕，未被纯标点替换
    const afterDot = snapshots.find(
      (snap) =>
        snap.find((x) => x.seq === 1)?.status === 'done' && !snap.some((x) => x.seq === 2),
    )
    assert.ok(afterDot, '应有「。」被过滤后的快照')
    const doneThen = afterDot!.filter((x) => x.status === 'done')
    assert.equal(doneThen.length, 1)
    assert.equal(doneThen[0].seq, 1)

    // 最终当前句 = 最后一条有效字幕
    const lastDone = [...internal.segments].reverse().find((x) => x.status === 'done')
    assert.equal(lastDone?.seq, 5)

    // 纯标点不进上文历史；提示仍绑定原句
    assert.equal(internal.segments[1].toneDetail?.contextPrevQuestion, '大家能接受吗')
    assert.equal(internal.segments[0].tone, TONE_LABEL)
    assert.equal(internal.segments[1].tone, undefined)
    s.dispose()
  } finally {
    globalThis.fetch = origFetch
  }
})
