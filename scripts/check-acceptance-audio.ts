import { readFileSync } from 'node:fs'
import { analyzeSegmentTone } from '../src/lib/toneAnalysis.ts'

function decodeWav(buf: Buffer): { pcm: Float32Array; sr: number } {
  let off = 12
  let sr = 0
  let data: Buffer | null = null
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4)
    const size = buf.readUInt32LE(off + 4)
    if (id === 'fmt ') sr = buf.readUInt32LE(off + 12)
    if (id === 'data') data = buf.subarray(off + 8, off + 8 + size)
    off += 8 + size + (size % 2)
  }
  if (!data) throw new Error('no data chunk')
  const pcm = new Float32Array(data.length / 2)
  for (let i = 0; i < pcm.length; i++) pcm[i] = data.readInt16LE(i * 2) / 0x8000
  return { pcm, sr }
}
function resample16k(input: Float32Array, from: number): Float32Array {
  if (from === 16000) return input
  const ratio = from / 16000
  const out = new Float32Array(Math.floor(input.length / ratio))
  for (let i = 0; i < out.length; i++) {
    const pos = i * ratio
    const i0 = Math.floor(pos)
    const frac = pos - i0
    out[i] = input[i0] * (1 - frac) + input[Math.min(i0 + 1, input.length - 1)] * frac
  }
  return out
}

const cases: [string, string[]][] = [
  ['s2', []],
  ['t1', []],
  ['t2', []],
  ['t3', []],
  ['t4', ['大家觉得哪天合适？']],
  ['t5', ['大家觉得哪天合适？']],
  ['t6', []],
]
for (const [file, prevTexts] of cases) {
  const buf = readFileSync(`public/test-audio/${file}.wav`)
  const form = new FormData()
  form.append('file', new Blob([buf], { type: 'audio/wav' }), `${file}.wav`)
  const res = await fetch('http://localhost:8000/api/transcribe', { method: 'POST', body: form })
  const j: any = await res.json()
  const text = (j.segments ?? []).map((s: any) => s.text).join('')
  const { pcm, sr } = decodeWav(buf)
  const out = await analyzeSegmentTone({
    text, prevTexts, pcm16k: resample16k(pcm, sr), cutReason: 'pause', emotion: j.emotion,
  })
  console.log(JSON.stringify({
    file, text, emotion: j.emotion,
    tone: out.tone ?? null, cue: out.toneCue ?? null, evidence: out.evidence ?? null,
    pitch: out.detail.pitch, pitchNull: out.detail.pitchNullReason,
    suppressed: out.detail.suppressedBy, conclusion: out.detail.conclusion,
  }))
}
