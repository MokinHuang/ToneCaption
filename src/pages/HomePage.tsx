import { sampleClassroomSession } from '../data/sampleClassroom'

interface HomePageProps {
  onEnterClassroom: () => void
}

function PitchContour() {
  return (
    <svg className="pitch" viewBox="0 0 320 52" preserveAspectRatio="none" aria-hidden="true">
      <path className="contour-base" d="M4 34 H316" />
      <path
        className="contour"
        pathLength={1}
        d="M4 32 C 44 35, 78 27, 118 30 S 186 36, 220 31 C 246 27, 268 16, 298 5"
      />
      <circle className="end-dot" cx="298" cy="5" r="3.4" />
      <text className="rise-label" x="316" y="48" textAnchor="end">
        句末上扬
      </text>
    </svg>
  )
}

export function HomePage({ onEnterClassroom }: HomePageProps) {
  const preview = sampleClassroomSession.segments[1]
  const context = sampleClassroomSession.segments[0]

  return (
    <main className="home">
      <div className="home-top">
        <span className="brand-mini">
          <svg width="18" height="18" viewBox="0 0 20 20" aria-hidden="true">
            <rect x="2" y="8" width="2.4" height="4" rx="1.2" fill="#d97757" />
            <rect x="6.4" y="5" width="2.4" height="10" rx="1.2" fill="#e8a087" />
            <rect x="10.8" y="2" width="2.4" height="16" rx="1.2" fill="#3e8e7e" />
            <rect x="15.2" y="6" width="2.4" height="8" rx="1.2" fill="#3b7dd8" />
          </svg>
          字里有声
        </span>
        <span className="stage-badge">示例预览 · 录音识别已接入</span>
      </div>

      <section className="specimen" aria-label="课堂字幕示例：语气如何被看见">
        <div className="specimen-head">
          <span>课堂 · 作业截止时间</span>
          <span className="eg">示例</span>
        </div>
        <p className="specimen-context">{context.text}</p>
        <div className="specimen-main">
          <span className="specimen-text">{preview.text}</span>
          <PitchContour />
        </div>
        <div className="specimen-tone">
          {preview.tone && (
            <span className="chip-tone">
              <svg width="13" height="13" viewBox="0 0 16 16" aria-hidden="true">
                <path
                  d="M1 8h2.2l1.6-4.5 2.4 9 2.2-6.5 1.4 2H15"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.7"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
              {preview.tone}
            </span>
          )}
          {preview.evidence && (
            <p className="chip-evidence">
              <span className="ev-mark">依据</span>
              {preview.evidence}
            </p>
          )}
        </div>
      </section>

      <header className="home-intro">
        <h1 className="wordmark">字里有声</h1>
        <p className="wordmark-latin">ToneCaption</p>
        <p className="tagline">
          用自己的手机<strong>看见老师正在说什么</strong>，也看见一句话里可能的语气和它的依据——在老师继续讲下去之前，判断自己是否该回应。
        </p>
      </header>

      <ul className="home-notes">
        <li>
          <span className="tick tick-voice" aria-hidden="true" />
          字幕持续向前，语气和依据紧跟原句，不挡阅读。
        </li>
        <li>
          <span className="tick tick-tone" aria-hidden="true" />
          证据不足时只保留文字，不猜。
        </li>
      </ul>

      <div className="home-cta-zone">
        <button type="button" className="btn-primary" onClick={onEnterClassroom}>
          进入课堂
        </button>
        <p className="home-cta-note">当前为本地示例，无需麦克风；实时收音将在第三阶段接入</p>
      </div>
    </main>
  )
}