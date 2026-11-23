/** 「听见重音」对照样例实测：读 .planning/2026-11-22-hear-stress/audio/ 的
 *  WAV + 真实识别 transcripts.json，逐条跑 analyzeSegmentTone，
 *  记录实际标记词/依据/留空原因 → results.json。
 *  这些是 TTS+信号处理合成对照，验证算法链路，不代表真人重音效果。 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { analyzeSegmentTone } from '../src/lib/toneAnalysis.ts'

const DIR = join(process.cwd(), '.planning', '2026-11-22-hear-stress', 'audio')

function readWav16k(path: string): Float32Array {
  const buf = readFileSync(path)
  if (buf.toString('ascii', 0, 4) !== 'RIFF') throw new Error('not RIFF')
  let off = 12
  let sr = 0
  let bits = 0
  let channels = 0
  let dataStart = -1
  let dataLen = 0
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4)
    const size = buf.readUInt32LE(off + 4)
    if (id === 'fmt ') {
      channels = buf.readUInt16LE(off + 10)
      sr = buf.readUInt32LE(off + 12)
      bits = buf.readUInt16LE(off + 22)
    } else if (id === 'data') {
      dataStart = off + 8
      dataLen = size
    }
    off += 8 + size + (size % 2)
  }
  if (sr !== 16000 || bits !== 16 || channels !== 1 || dataStart < 0) {
    throw new Error(`expect 16k mono PCM16, got sr=${sr} bits=${bits} ch=${channels}`)
  }
  const n = Math.floor(dataLen / 2)
  const out = new Float32Array(n)
  for (let i = 0; i < n; i++) out[i] = buf.readInt16LE(dataStart + i * 2) / 32768
  return out
}

interface Meta {
  sentence: string
  variant: string
  target: string | null
  targetRange?: [number, number]
}

async function main() {
  const meta = JSON.parse(readFileSync(join(DIR, 'meta.json'), 'utf-8')) as Record<string, Meta>
  const transcripts = JSON.parse(readFileSync(join(DIR, 'transcripts.json'), 'utf-8')) as Record<
    string,
    { text: string; emotion: string | null; segments: { text: string; tokens?: string[]; timestamps?: [number, number][] }[] }
  >
  const results: unknown[] = []
  for (const [fname, m] of Object.entries(meta)) {
    const pcm = readWav16k(join(DIR, fname))
    const tr = transcripts[fname]
    const seg = tr.segments[0]
    const out = await analyzeSegmentTone({
      text: seg.text,
      prevTexts: [],
      pcm16k: pcm,
      cutReason: 'pause',
      emotion: tr.emotion,
      tokens: seg.tokens ?? null,
      timestamps: seg.timestamps ?? null,
    })
    const s = out.sentences[0]
    const expected = m.targetRange ? seg.text.slice(m.targetRange[0], m.targetRange[1]) : null
    const mark = s?.stress ?? null
    results.push({
      clip: fname,
      sentence: m.sentence,
      variant: m.variant,
      recognizedText: seg.text,
      intendedTarget: m.target,
      expectedWordInTranscript: expected,
      actualMark: mark ? { word: mark.word, start: mark.start, end: mark.end, evidence: mark.evidence } : null,
      matchTarget: mark != null && expected != null ? mark.word === expected : null,
      stressNullReason: s?.detail.stressNullReason ?? null,
      measurement: s?.detail.stress ?? null,
      tone: out.tone ?? null,
    })
  }
  writeFileSync(join(DIR, 'results.json'), JSON.stringify(results, null, 1), 'utf-8')
  for (const r of results as { clip: string; actualMark: { word: string; evidence: string } | null; stressNullReason: string | null; matchTarget: boolean | null }[]) {
    const mark = r.actualMark ? `${r.actualMark.word} | ${r.actualMark.evidence}` : `(empty: ${r.stressNullReason})`
    console.log(`${r.clip.padEnd(28)} ${r.matchTarget === null ? '-' : r.matchTarget ? 'HIT' : 'MISS'}  ${mark}`)
  }
  console.log('results.json saved')
}

main()