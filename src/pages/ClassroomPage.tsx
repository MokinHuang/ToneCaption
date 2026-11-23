import { useEffect, useRef, useState } from 'react'
import type { CSSProperties, ChangeEvent } from 'react'
import { CaptionList } from '../components/CaptionList'
import type {
  CaptionSegment,
  ClassroomSession,
  LiveSegment,
  MicPhase,
  TranscribeResult,
} from '../types'
import { checkTranscribeService, emotionLabel, eventLabel, transcribeFile } from '../lib/transcribe'
import { pitchReasonLabel } from '../lib/toneAnalysis.ts'
import { MicLiveSession, isPunctuationOnly } from '../lib/liveMic'

interface ClassroomPageProps {
  session: ClassroomSession
  onBackHome: () => void
}

const FONT_SIZES = [16, 18, 20, 22, 24, 26, 28]

const SUPPRESS_LABEL: Record<string, string> = {
  quoted: '引号内',
  'reported-speech': '转述',
  'embedded-question': '嵌入式疑问',
  rhetorical: '反问',
  'action-request': '动作请求',
}
const DEFAULT_FONT_INDEX = 2

type RecState =
  | { status: 'idle'; result: null; error: null }
  | { status: 'loading'; result: null; error: null }
  | { status: 'success'; result: TranscribeResult; error: null }
  | { status: 'error'; result: null; error: string }

export function ClassroomPage({ session, onBackHome }: ClassroomPageProps) {
  const [fontIndex, setFontIndex] = useState(DEFAULT_FONT_INDEX)
  const [showTone, setShowTone] = useState(true)
  const [currentVisible, setCurrentVisible] = useState(true)
  const [view, setView] = useState<'example' | 'recording' | 'live'>('example')
  const [file, setFile] = useState<File | null>(null)
  const [rec, setRec] = useState<RecState>({ status: 'idle', result: null, error: null })
  const [service, setService] = useState<'checking' | 'ready' | 'unavailable'>('checking')
  const [micPhase, setMicPhase] = useState<MicPhase>('idle')
  const [micError, setMicError] = useState<string | null>(null)
  const [liveSegs, setLiveSegs] = useState<LiveSegment[]>([])
  const micRef = useRef<MicLiveSession | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLOListElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  const liveCaptionSegs: CaptionSegment[] = liveSegs.map((s) => {
    const parts =
      s.toneSentences && s.toneSentences.length > 1
        ? s.toneSentences.map((p) => ({
            text: p.text,
            tone: p.tone,
            evidence: p.evidence,
            cue: p.toneCue,
          }))
        : undefined
    return {
      id: `live-${s.seq}`,
      text: s.text,
      pending: s.status === 'pending',
      error: s.error,
      tone: parts ? undefined : s.tone,
      evidence: parts ? undefined : s.evidence,
      cue: parts ? undefined : s.toneCue,
      parts,
    }
  })
  const lastDone = [...liveSegs].reverse().find((s) => s.status === 'done')
  const liveCurrentId = lastDone ? `live-${lastDone.seq}` : undefined
  const doneWithMetrics = liveSegs.filter((s) => s.status === 'done' && s.metrics)
  const analyzedSegs = liveSegs.filter((s) => s.toneDetail)
  const activeCurrentId =
    view === 'example' ? session.currentId : view === 'live' ? liveCurrentId : undefined

  const scrollToCurrent = (smooth: boolean) => {
    if (!activeCurrentId) return
    const el = listRef.current?.querySelector(`#caption-${activeCurrentId}`)
    el?.scrollIntoView({ behavior: smooth ? 'smooth' : 'auto', block: 'center' })
  }

  useEffect(() => {
    if (!activeCurrentId) return
    const target = listRef.current?.querySelector(`#caption-${activeCurrentId}`)
    const container = scrollRef.current
    if (target && container) {
      const c = container.getBoundingClientRect()
      const t = target.getBoundingClientRect()
      if (t.bottom > c.bottom || t.top < c.top) {
        target.scrollIntoView({ behavior: 'auto', block: 'center' })
      }
    }
    if (!target || typeof IntersectionObserver === 'undefined') return
    const observer = new IntersectionObserver(
      ([entry]) => setCurrentVisible(entry.isIntersecting),
      { root: scrollRef.current, threshold: 0.4 },
    )
    observer.observe(target)
    return () => observer.disconnect()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.id, activeCurrentId, view])

  useEffect(() => () => micRef.current?.dispose(), [])

  const probeService = async () => {
    setService('checking')
    setService((await checkTranscribeService()) ? 'ready' : 'unavailable')
  }

  useEffect(() => {
    if (view === 'recording' || view === 'live') void probeService()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view])

  const startMic = async () => {
    if (micPhase === 'requesting' || micPhase === 'recording' || micPhase === 'stopping') return
    setView('live')
    setMicError(null)
    setLiveSegs([])
    micRef.current?.dispose()
    setService('checking')
    const ok = await checkTranscribeService()
    setService(ok ? 'ready' : 'unavailable')
    if (!ok) {
      setMicPhase('idle')
      return
    }
    const mic = new MicLiveSession({
      onSegments: (segs) => {
        if (micRef.current === mic) setLiveSegs(segs)
      },
      onPhase: (phase, error) => {
        if (micRef.current !== mic) return
        setMicPhase(phase)
        if (error) setMicError(error)
      },
    })
    micRef.current = mic
    try {
      await mic.start()
    } catch (err) {
      if (micRef.current !== mic) return
      mic.dispose()
      setMicPhase('failed')
      setMicError(err instanceof Error ? err.message : '无法启动麦克风，原因未知')
    }
  }

  const stopMic = () => {
    micRef.current?.stop()
  }

  const onPickFile = (e: ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0] ?? null
    setFile(f)
    setRec({ status: 'idle', result: null, error: null })
    e.target.value = ''
  }

  const runTranscribe = async () => {
    if (!file || rec.status === 'loading') return
    setRec({ status: 'loading', result: null, error: null })
    try {
      const result = await transcribeFile(file)
      setRec({ status: 'success', result, error: null })
    } catch (err) {
      setRec({
        status: 'error',
        result: null,
        error: err instanceof Error ? err.message : '识别失败，原因未知',
      })
    }
  }

  const fontSize = FONT_SIZES[fontIndex]
  const recSegments: CaptionSegment[] =
    rec.status === 'success'
      ? rec.result.segments
          .filter((s) => !isPunctuationOnly(s.text))
          .map((s, i) => ({ id: `r${i + 1}`, text: s.text }))
      : []
  const recCurrentId = recSegments.length
    ? recSegments[recSegments.length - 1].id
    : undefined

  return (
    <div className="classroom">
      <header className="status-bar">
        <div className="status-bar-row">
          <button type="button" className="btn-back" onClick={onBackHome}>
            <svg width="14" height="14" viewBox="0 0 20 20" aria-hidden="true">
              <path
                d="M12 4l-6 6 6 6"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
            首页
          </button>
          <span className="status-title">{session.title}</span>
        </div>
        <div className="status-sub">
          <span className="pill pill-preview">
            {view === 'example'
              ? '示例预览'
              : view === 'recording'
                ? '本次录音识别'
                : '课堂收音'}
          </span>
          {view === 'live' && micPhase === 'recording' ? (
            <span className="pill pill-live">
              <span className="dot" aria-hidden="true" />
              收音中
            </span>
          ) : view === 'live' && micPhase === 'requesting' ? (
            <span className="pill pill-warn">
              <span className="dot" aria-hidden="true" />
              请求权限
            </span>
          ) : view === 'live' && micPhase === 'stopping' ? (
            <span className="pill pill-warn">
              <span className="dot" aria-hidden="true" />
              正在收尾
            </span>
          ) : view === 'live' && micPhase === 'failed' ? (
            <span className="pill pill-danger">
              <span className="dot" aria-hidden="true" />
              收音失败
            </span>
          ) : (
            <span className="pill pill-idle">
              <span className="dot" aria-hidden="true" />
              未收音
            </span>
          )}
          {view === 'example' && (
            <span className="status-scene">{session.scene}</span>
          )}
        </div>
        <div className="mode-switch" role="tablist" aria-label="字幕来源">
          <button
            type="button"
            role="tab"
            aria-selected={view === 'example'}
            className={view === 'example' ? 'active' : ''}
            onClick={() => setView('example')}
          >
            示例预览
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={view === 'recording'}
            className={view === 'recording' ? 'active' : ''}
            onClick={() => setView('recording')}
          >
            本次录音识别
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={view === 'live'}
            className={view === 'live' ? 'active' : ''}
            onClick={() => setView('live')}
          >
            课堂收音
          </button>
        </div>
      </header>

      <div
        className="caption-scroll"
        ref={scrollRef}
        style={{ '--caption-size': `${fontSize}px` } as CSSProperties}
      >
        {view === 'example' ? (
          <>
            <CaptionList
              ref={listRef}
              segments={session.segments}
              currentId={session.currentId}
              showTone={showTone}
            />
            {!currentVisible && (
              <button
                type="button"
                className="jump-current"
                onClick={() => scrollToCurrent(true)}
              >
                ↓ 回到当前句
              </button>
            )}
          </>
        ) : view === 'live' ? (
          <>
            <section className="upload-panel" aria-label="课堂麦克风收音">
              <div className="upload-head">
                <span>课堂麦克风收音</span>
                <span className="rec-badge">SenseVoiceSmall</span>
              </div>
              {service === 'checking' && (
                <div className="service-notice checking" role="status">
                  正在检测识别服务…
                </div>
              )}
              {service === 'unavailable' && (
                <div className="service-notice" role="alert">
                  <p>识别服务暂时无法连接，无法开始收音。请稍后重试。</p>
                  <button
                    type="button"
                    className="btn-recheck"
                    onClick={() => void probeService()}
                  >
                    重新检测
                  </button>
                </div>
              )}
              {micPhase === 'idle' && service === 'ready' && !micError && (
                <p className="rec-hint">
                  点击下方「开始收音」并允许麦克风。自然停顿约 0.7
                  秒自动成句，连续讲话最长 15 秒强制分段；停止时提交最后一段并释放麦克风。
                </p>
              )}
              {micPhase === 'requesting' && (
                <div className="rec-status loading" role="status">
                  <span className="spinner" aria-hidden="true" />
                  正在请求麦克风权限…
                </div>
              )}
              {micPhase === 'recording' && (
                <div className="rec-status live" role="status">
                  <span className="live-dot" aria-hidden="true" />
                  收音中：停顿自动分句，结果按说话顺序显示，只显示最新真实识别结果。
                </div>
              )}
              {micPhase === 'stopping' && (
                <div className="rec-status loading" role="status">
                  <span className="spinner" aria-hidden="true" />
                  已停止采集并释放麦克风，正在识别最后一段…语气提示可能稍后补充。
                </div>
              )}
              {micPhase === 'stopped' && (
                <p className="rec-hint">
                  本次收音已结束，麦克风已释放。点「开始收音」开启新会话，旧会话结果不会混入。
                </p>
              )}
              {micError && (
                <div className="rec-status error" role="alert">
                  {micError}
                </div>
              )}
            </section>

            {liveSegs.length > 0 && (
              <section className="rec-result" aria-label="课堂收音字幕">
                <CaptionList
                  ref={listRef}
                  segments={liveCaptionSegs}
                  currentId={liveCurrentId}
                  showTone={showTone}
                />
                {doneWithMetrics.length > 0 && (
                  <details className="raw-details latency-details">
                    <summary>
                      延迟统计（{doneWithMetrics.length} 段 · 末帧→显示含等停顿/排队/上传/推理）
                    </summary>
                    <table className="latency-table">
                      <thead>
                        <tr>
                          <th>句</th>
                          <th>音频时长</th>
                          <th>末帧→正文</th>
                          <th>正文→提示</th>
                          <th>等停顿</th>
                          <th>排队</th>
                          <th>上传+推理</th>
                        </tr>
                      </thead>
                      <tbody>
                        {doneWithMetrics.map((s) => (
                          <tr key={s.seq}>
                            <td>{s.seq}</td>
                            <td>{s.audioSeconds.toFixed(1)}s</td>
                            <td>{(s.metrics!.latencyMs / 1000).toFixed(2)}s</td>
                            <td>
                              {s.metrics!.toneLatencyMs != null
                                ? `${(s.metrics!.toneLatencyMs / 1000).toFixed(2)}s`
                                : '—'}
                            </td>
                            <td>{(s.metrics!.waitMs / 1000).toFixed(2)}s</td>
                            <td>{(s.metrics!.queueMs / 1000).toFixed(2)}s</td>
                            <td>{(s.metrics!.uploadMs / 1000).toFixed(2)}s</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    <p className="aux-note">
                      「末帧→正文」从本段最后一个有效语音帧算起，包含等待停顿、上传、排队和推理；「正文→提示」从正文显示到语气提示显示，仅给出提示的段记录。若前者持续超过句间间隔，说明当前
                      CPU 推理跟不上讲话速度。
                    </p>
                  </details>
                )}
                {showTone && analyzedSegs.length > 0 && (
                  <details className="raw-details">
                    <summary>语气分析记录（{analyzedSegs.length} 段 · 本地规则，含留空原因）</summary>
                    <table className="latency-table tone-record-table">
                      <thead>
                        <tr>
                          <th>句</th>
                          <th>文本线索</th>
                          <th>句末音高</th>
                          <th>声学情感</th>
                          <th>结论</th>
                        </tr>
                      </thead>
                      <tbody>
                        {analyzedSegs.map((s) => {
                          const d = s.toneDetail!
                          return (
                            <tr key={s.seq}>
                              <td>{s.seq}</td>
                              <td>
                                {d.suppressedBy
                                  ? `${SUPPRESS_LABEL[d.suppressedBy] ?? d.suppressedBy}（已抑制）`
                                  : d.textPattern
                                    ? `${d.textPattern}「${d.textExcerpt}」`
                                    : '无命中'}
                              </td>
                              <td>
                                {d.pitch
                                  ? `+${d.pitch.riseSemitones}半音 · ${d.pitch.spanMs}ms · 基线${d.pitch.baselineHz}Hz`
                                  : pitchReasonLabel(d.pitchNullReason) || '—'}
                              </td>
                              <td>{emotionLabel(d.emotion) || '—'}</td>
                              <td>{d.reason}</td>
                            </tr>
                          )
                        })}
                      </tbody>
                    </table>
                    <p className="aux-note">
                      语气提示由本地可解释规则推断：文本证据摘录转写原词，音高证据来自本段真实音频；SenseVoice
                      声学情感只作记录。证据不足或属引用/转述时只保留字幕。
                    </p>
                  </details>
                )}
              </section>
            )}
            {!currentVisible && liveCurrentId && (
              <button
                type="button"
                className="jump-current"
                onClick={() => scrollToCurrent(true)}
              >
                ↓ 回到当前句
              </button>
            )}
          </>
        ) : (
          <>
            <section className="upload-panel" aria-label="录音识别">
              <div className="upload-head">
                <span>识别一段中文录音</span>
                <span className="rec-badge">SenseVoiceSmall</span>
              </div>
              {service === 'checking' && (
                <div className="service-notice checking" role="status">
                  正在检测识别服务…
                </div>
              )}
              {service === 'unavailable' && (
                <div className="service-notice" role="alert">
                  <p>识别服务暂时无法连接，无法识别录音。请稍后重试。</p>
                  <button
                    type="button"
                    className="btn-recheck"
                    onClick={() => void probeService()}
                  >
                    重新检测
                  </button>
                </div>
              )}
              <div className="file-row">
                <button
                  type="button"
                  className="btn-choose"
                  onClick={() => inputRef.current?.click()}
                >
                  选择 WAV 录音
                </button>
                <span className="file-name">
                  {file ? file.name : '未选择文件（建议 5–20 秒中文 .wav）'}
                </span>
                <input
                  ref={inputRef}
                  type="file"
                  accept=".wav,audio/wav,audio/x-wav"
                  className="sr-only"
                  onChange={onPickFile}
                  aria-label="选择 WAV 录音文件"
                />
              </div>
              <button
                type="button"
                className="btn-transcribe"
                disabled={!file || rec.status === 'loading' || service !== 'ready'}
                onClick={runTranscribe}
              >
                {rec.status === 'loading' ? '识别中…' : '识别录音'}
              </button>
              {rec.status === 'loading' && (
                <div className="rec-status loading" role="status">
                  <span className="spinner" aria-hidden="true" />
                  正在识别，模型推理约需数秒…
                </div>
              )}
              {rec.status === 'error' && (
                <div className="rec-status error" role="alert">
                  {rec.error}
                </div>
              )}
              {rec.status === 'idle' && (
                <p className="rec-hint">
                  选择录音后点击「识别录音」，查看 SenseVoiceSmall
                  的真实转写。识别失败会给出具体原因，不会回退为示例字幕。
                </p>
              )}
            </section>

            {rec.status === 'success' && (
              <section className="rec-result" aria-label="本次录音识别结果">
                <div className="rec-meta">
                  <span>{file?.name}</span>
                  <span>{rec.result.duration_s}s</span>
                  <span>{rec.result.device}</span>
                  {rec.result.language && <span>{rec.result.language}</span>}
                </div>
                <CaptionList
                  segments={recSegments}
                  currentId={recCurrentId}
                  showTone={false}
                />
                <div className="aux-row">
                  {emotionLabel(rec.result.emotion) && (
                    <span className="chip-aux emotion">
                      声学情感 · {emotionLabel(rec.result.emotion)}
                    </span>
                  )}
                  {rec.result.events.map((e) => (
                    <span key={e} className="chip-aux event">
                      事件 · {eventLabel(e)}
                    </span>
                  ))}
                  {!rec.result.emotion && rec.result.events.length === 0 && (
                    <span className="aux-none">模型未给出情感或声音事件</span>
                  )}
                </div>
                <p className="aux-note">
                  声学情感只描述声音的情绪色彩，不等于句式语气：平静读出的疑问句通常也是中性。带依据的语气提示已在「课堂收音」页签接入（本地规则）。
                </p>
                <details className="raw-details">
                  <summary>查看模型原始输出</summary>
                  <pre>{rec.result.raw.join('\n')}</pre>
                </details>
              </section>
            )}
          </>
        )}
      </div>

      <footer className="action-bar">
        <div className="action-tools">
          <div className="font-stepper" role="group" aria-label="字幕字号">
            <button
              type="button"
              className="fs-small"
              aria-label="减小字号"
              disabled={fontIndex === 0}
              onClick={() => setFontIndex((i) => Math.max(0, i - 1))}
            >
              A−
            </button>
            <span className="fs-value" aria-live="polite">{fontSize}px</span>
            <button
              type="button"
              className="fs-large"
              aria-label="增大字号"
              disabled={fontIndex === FONT_SIZES.length - 1}
              onClick={() => setFontIndex((i) => Math.min(FONT_SIZES.length - 1, i + 1))}
            >
              A＋
            </button>
          </div>
          <button
            type="button"
            className="tone-toggle"
            aria-pressed={showTone}
            onClick={() => setShowTone((v) => !v)}
          >
            语气提示
            <span className="switch" aria-hidden="true" />
          </button>
        </div>
        <button
          type="button"
          className={`btn-mic${micPhase === 'recording' ? ' is-live' : ''}`}
          disabled={micPhase === 'requesting' || micPhase === 'stopping'}
          onClick={micPhase === 'recording' ? stopMic : () => void startMic()}
        >
          <svg width="18" height="18" viewBox="0 0 20 20" aria-hidden="true">
            <rect x="7" y="2" width="6" height="10" rx="3" fill="currentColor" />
            <path
              d="M4.5 9.5a5.5 5.5 0 0 0 11 0M10 15v3"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
            />
          </svg>
          {micPhase === 'recording'
            ? '停止收音'
            : micPhase === 'requesting'
              ? '请求权限…'
              : micPhase === 'stopping'
                ? '正在收尾…'
                : '开始收音'}
        </button>
        <p className="action-note">
          {view === 'live'
            ? '真实识别结果 · 语气提示为本地规则推断 · 音频仅发送到识别服务 · 停止即释放麦克风'
            : view === 'recording'
              ? '上传 WAV 由 SenseVoiceSmall 识别，失败给出具体原因'
              : '示例数据 · 不采集声音'}
        </p>
      </footer>
    </div>
  )
}