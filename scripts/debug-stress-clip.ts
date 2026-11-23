import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pitchTrack, frameNoiseFloor, voicedEndMs, PITCH_CONST } from '../src/lib/pitch.ts'
import { alignTokens, detectSentenceStress, STRESS_CONST } from '../src/lib/stress.ts'

const DIR = join(process.cwd(), '.planning', '2026-11-22-hear-stress', 'audio')
function readWav16k(path: string): Float32Array {
  const buf = readFileSync(path)
  let off = 12, dataStart = -1, dataLen = 0
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4)
    const size = buf.readUInt32LE(off + 4)
    if (id === 'data') { dataStart = off + 8; dataLen = size }
    off += 8 + size + (size % 2)
  }
  const n = Math.floor(dataLen / 2)
  const out = new Float32Array(n)
  for (let i = 0; i < n; i++) out[i] = buf.readInt16LE(dataStart + i * 2) / 32768
  return out
}

const fname = process.argv[2] ?? 'A_stress_chugao.wav'
const tr = JSON.parse(readFileSync(join(DIR, 'transcripts.json'), 'utf-8'))[fname]
const seg = tr.segments[0]
const pcm = readWav16k(join(DIR, fname))
const anchors = alignTokens(seg.text, seg.tokens, seg.timestamps)!
const frames = await pitchTrack(pcm, 16000, { hopMs: PITCH_CONST.bodyHopMs })
const noiseFloor = frameNoiseFloor(frames)
const speechEnd = voicedEndMs(frames)
console.log('text:', seg.text, 'totalMs:', (pcm.length / 16000) * 1000)
console.log('noiseFloor:', noiseFloor, 'speechEnd:', speechEnd)
console.log('anchors:', anchors.map((a, i) => a ? `${a.ch}@${a.peak}` : `${seg.text[i]}@-`).join(' '))
const activeThresh = Math.max(0.008, noiseFloor * 3)
console.log('activeThresh:', activeThresh)
{
  const cs = anchors.flatMap((a, i) => (a && /[一-鿿A-Za-z0-9]/.test(a.ch) ? [{ ...a, idx: i }] : []))
  const gaps = cs.slice(1).map((c, i) => c.peak - cs[i].peak)
  const medGap = gaps.sort((x, y) => x - y)[Math.floor(gaps.length / 2)]
  let rightLimit = Infinity
  for (let i = cs[cs.length - 1].idx + 1; i < anchors.length; i++) {
    const a = anchors[i]
    if (a && /[一-鿿A-Za-z0-9]/.test(a.ch)) { rightLimit = Math.min(rightLimit, a.peak); break }
  }
  if (speechEnd != null) rightLimit = Math.min(rightLimit, speechEnd + 25)
  let lastEnd = cs[cs.length - 1].peak
  for (let i = frames.length - 1; i >= 0; i--) {
    if (frames[i].tMs > rightLimit) continue
    if (frames[i].rms >= activeThresh) { lastEnd = frames[i].tMs + 12.5; break }
  }
  const feats = cs.map((c, i) => {
    const left = i === 0 ? Math.max(0, c.peak - medGap / 2) : (cs[i - 1].peak + c.peak) / 2
    const right = i === cs.length - 1 ? lastEnd : (c.peak + cs[i + 1].peak) / 2
    let sumSq = 0, nActive = 0
    for (const f of frames) {
      if (f.tMs < left || f.tMs >= right || f.rms < activeThresh) continue
      sumSq += f.rms * f.rms
      nActive++
    }
    return { ch: c.ch, left, right, meanSq: nActive ? sumSq / nActive : 0, nActive }
  })
  const sqs = feats.filter((f) => f.nActive > 0).map((f) => f.meanSq).sort((x, y) => x - y)
  const loudBase = sqs[Math.floor((sqs.length - 1) / 2)]
  for (const f of feats) {
    const db = f.meanSq > 0 ? 10 * Math.log10(f.meanSq / loudBase) : -99
    console.log(`${f.ch} win=[${f.left.toFixed(0)},${f.right.toFixed(0)}] nActive=${f.nActive} loudDb=${db.toFixed(2)}`)
  }
}
for (const f of frames) {
  const act = f.rms >= activeThresh
  console.log(`t=${f.tMs.toFixed(0)} rms=${f.rms.toFixed(4)} f0=${f.f0?.toFixed(1) ?? '-'} conf=${f.conf.toFixed(2)} ${act ? 'ACT' : ''}`)
}
const r = detectSentenceStress({
  text: seg.text, start: 0, end: seg.text.length, anchors,
  frames, hopMs: PITCH_CONST.bodyHopMs, noiseFloor, speechEndMs: speechEnd,
})
console.log('result:', JSON.stringify(r))