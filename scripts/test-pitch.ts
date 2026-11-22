import { test } from 'node:test'
import assert from 'node:assert/strict'
import { pitchTrack, tailRise, PITCH_CONST } from '../src/lib/pitch.ts'

const SR = 16000

interface ToneSeg {
  durMs: number
  f0Start: number
  f0End?: number
  amp?: number
  harmonics?: number[]
}

/** 相位连续的谐波堆叠音（近似元音），f0 可线性滑变。 */
function synth(segs: ToneSeg[]): Float32Array {
  const total = segs.reduce((a, s) => a + Math.round((s.durMs / 1000) * SR), 0)
  const out = new Float32Array(total)
  let phase = 0
  let i = 0
  for (const s of segs) {
    const n = Math.round((s.durMs / 1000) * SR)
    const amp = s.amp ?? 0.3
    const h = s.harmonics ?? [1, 0.5, 0.33, 0.25, 0.2]
    const norm = h.reduce((a, b) => a + b, 0)
    const f1 = s.f0End ?? s.f0Start
    for (let k = 0; k < n; k++, i++) {
      const f = s.f0Start + ((f1 - s.f0Start) * k) / Math.max(1, n - 1)
      phase += (2 * Math.PI * f) / SR
      let v = 0
      for (let q = 0; q < h.length; q++) v += (h[q] * Math.sin((q + 1) * phase)) / norm
      out[i] = amp * v
    }
  }
  return out
}

function noise(durMs: number, amp = 0.2): Float32Array {
  const n = Math.round((durMs / 1000) * SR)
  const out = new Float32Array(n)
  let seed = 42
  for (let i = 0; i < n; i++) {
    seed = (seed * 1664525 + 1013904223) >>> 0
    out[i] = amp * (seed / 0xffffffff - 0.5) * 2
  }
  return out
}

async function run(pcm: Float32Array) {
  const totalMs = (pcm.length / SR) * 1000
  const tailStart = Math.max(0, totalMs - PITCH_CONST.tailBacktrackMs)
  const body = await pitchTrack(pcm, SR, { endMs: tailStart, hopMs: PITCH_CONST.bodyHopMs })
  const tail = await pitchTrack(pcm, SR, { startMs: tailStart, hopMs: PITCH_CONST.tailHopMs })
  return { result: tailRise(body, tail), body, tail }
}

const median = (a: number[]) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)]

test('基频估计精度：平读 180/220Hz 误差 <3Hz', async () => {
  for (const f of [180, 220]) {
    const { body } = await run(synth([{ durMs: 1500, f0Start: f }]))
    const voiced = body.filter((x) => x.f0 != null && x.conf >= 0.65)
    assert.ok(voiced.length > 20, '应有足够浊音帧')
    assert.ok(Math.abs(median(voiced.map((x) => x.f0!)) - f) < 3)
  }
})

test('平读 2s → 不上扬（insufficient-rise）', async () => {
  const { result } = await run(synth([{ durMs: 2000, f0Start: 180 }]))
  assert.equal(result.ok, false)
  if (!result.ok) assert.equal(result.reason, 'insufficient-rise')
})

test('末 350ms 跨音节滑升 180→260Hz → 检出上扬', async () => {
  const { result } = await run(
    synth([
      { durMs: 1650, f0Start: 180 },
      { durMs: 350, f0Start: 180, f0End: 260 },
    ]),
  )
  assert.equal(result.ok, true)
  if (result.ok) {
    assert.ok(result.m.riseSemitones >= 3)
    assert.ok(result.m.spanMs >= 250)
    assert.ok(Math.abs(result.m.baselineHz - 180) < 6)
    assert.ok(result.m.endHz > result.m.baselineHz)
    assert.ok(result.m.confidence >= 0.65)
  }
})

test('双音节阶梯滑升（180→220→260，各 175ms）→ 检出', async () => {
  const { result } = await run(
    synth([
      { durMs: 1650, f0Start: 180 },
      { durMs: 175, f0Start: 180, f0End: 220 },
      { durMs: 175, f0Start: 220, f0End: 260 },
    ]),
  )
  assert.equal(result.ok, true)
})

test('单字二声：末 160ms 陡升 → 拒绝（不得判为句末上扬）', async () => {
  const { result } = await run(
    synth([
      { durMs: 1840, f0Start: 180 },
      { durMs: 160, f0Start: 180, f0End: 300 },
    ]),
  )
  assert.equal(result.ok, false)
  if (!result.ok) {
    assert.ok(
      ['single-syllable-rise', 'insufficient-rise', 'short-span'].includes(result.reason),
      `实际原因: ${result.reason}`,
    )
  }
})

test('仅末 100ms 上扬 → 拒绝', async () => {
  const { result } = await run(
    synth([
      { durMs: 1900, f0Start: 180 },
      { durMs: 100, f0Start: 180, f0End: 300 },
    ]),
  )
  assert.equal(result.ok, false)
})

test('句末下降 260→180Hz → 拒绝', async () => {
  const { result } = await run(
    synth([
      { durMs: 1650, f0Start: 260 },
      { durMs: 350, f0Start: 260, f0End: 180 },
    ]),
  )
  assert.equal(result.ok, false)
})

test('白噪声 → 拒绝（无可靠浊音）', async () => {
  const { result } = await run(noise(2000))
  assert.equal(result.ok, false)
})

test('倍频程交替跳变 → 拒绝', async () => {
  const segs: ToneSeg[] = [{ durMs: 1650, f0Start: 180 }]
  for (let i = 0; i < 7; i++) {
    segs.push({ durMs: 50, f0Start: i % 2 ? 360 : 180 })
  }
  const { result } = await run(synth(segs))
  assert.equal(result.ok, false)
})

test('0.4s 短段 → 拒绝（基线不足）', async () => {
  const { result } = await run(synth([{ durMs: 400, f0Start: 180 }]))
  assert.equal(result.ok, false)
})

test('句末极轻声（气声 below 阈值）→ 拒绝', async () => {
  const { result } = await run(
    synth([
      { durMs: 1600, f0Start: 180 },
      { durMs: 400, f0Start: 180, f0End: 260, amp: 0.0005 },
    ]),
  )
  assert.equal(result.ok, false)
})

test('不同音色（谐波权重变化）关键例复测', async () => {
  const h = [1, 0.8, 0.2, 0.6, 0.1]
  const flat = await run(synth([{ durMs: 2000, f0Start: 150, harmonics: h }]))
  assert.equal(flat.result.ok, false)
  const rise = await run(
    synth([
      { durMs: 1650, f0Start: 150, harmonics: h },
      { durMs: 350, f0Start: 150, f0End: 220, harmonics: h },
    ]),
  )
  assert.equal(rise.result.ok, true)
})

test('空轨迹 → no-audio', () => {
  const r = tailRise([], [])
  assert.equal(r.ok, false)
  if (!r.ok) assert.equal(r.reason, 'no-audio')
})

test('15s 长段耗时预算（分块让出，node 实测）', async () => {
  const pcm = synth([
    { durMs: 14650, f0Start: 180 },
    { durMs: 350, f0Start: 180, f0End: 260 },
  ])
  const t0 = performance.now()
  const { result } = await run(pcm)
  const elapsed = performance.now() - t0
  console.log(`  15s 段音高分析耗时: ${elapsed.toFixed(0)}ms`)
  assert.ok(elapsed < 2000, `耗时 ${elapsed}ms 超预算`)
  assert.equal(result.ok, true)
})