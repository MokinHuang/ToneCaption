import { synthAudio, wuZiJiaoChuGao } from './synth-stress-audio.ts'
import { pitchTrack, frameNoiseFloor, voicedEndMs, PITCH_CONST } from '../src/lib/pitch.ts'
import { alignTokens, detectSentenceStress } from '../src/lib/stress.ts'
import { analyzeSegmentTone } from '../src/lib/toneAnalysis.ts'

const chars = process.argv[2] === 'multi'
  ? [
      ...wuZiJiaoChuGao(),
      { ch: '。', gapAfterMs: 250 },
      { ch: '明', amp: 0.2 }, { ch: '天', amp: 0.2 }, { ch: '带' }, { ch: '纸' }, { ch: '质' }, { ch: '版' },
      { ch: '。', gapAfterMs: 200 },
    ]
  : wuZiJiaoChuGao({ 3: { amp: 0.115, f0: 230 }, 4: { amp: 0.115, f0: 230 } })
const a = synthAudio(chars)
const anchors = alignTokens(a.text, a.tokens, a.timestamps)!
const frames = await pitchTrack(a.pcm, 16000, { hopMs: PITCH_CONST.bodyHopMs })
const noiseFloor = frameNoiseFloor(frames)
const speechEnd = voicedEndMs(frames)
const cs = anchors.flatMap((x, i) => (x && /[一-鿿]/.test(x.ch) ? [{ ...x, idx: i }] : []))
const gaps = cs.slice(1).map((c, i) => c.peak - cs[i].peak)
const medGap = gaps.sort((x, y) => x - y)[Math.floor(gaps.length / 2)]
const activeThresh = Math.max(0.008, noiseFloor * 3)
const smooth = frames.map((f, i) => {
  const near = []
  for (let k = Math.max(0, i - 1); k <= Math.min(frames.length - 1, i + 1); k++) near.push(frames[k].rms)
  near.sort((x, y) => x - y)
  return near[1]
})
const centers = cs.map((c) => {
  let best = -1, bv = -1
  for (let i = 0; i < frames.length; i++) {
    if (Math.abs(frames[i].tMs - c.peak) > medGap / 2 || frames[i].rms < activeThresh) continue
    if (smooth[i] > bv) { bv = smooth[i]; best = i }
  }
  return best >= 0 ? frames[best].tMs : c.peak
})
console.log('text:', a.text, 'medGap:', medGap, 'speechEnd:', speechEnd)
cs.forEach((c, i) => console.log(`${c.ch} peak=${c.peak} center=${centers[i]}`))
const out = await analyzeSegmentTone({
  text: a.text, prevTexts: [], pcm16k: a.pcm, cutReason: 'pause', emotion: null,
  tokens: a.tokens, timestamps: a.timestamps,
})
for (const s of out.sentences) {
  console.log('sentence:', s.text, 'stress:', JSON.stringify(s.stress), 'reason:', s.detail.stressNullReason, 'meas:', JSON.stringify(s.detail.stress))
}