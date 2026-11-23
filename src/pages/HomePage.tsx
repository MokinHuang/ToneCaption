import { sampleClassroomSession } from '../data/sampleClassroom'

interface HomePageProps {
  onEnterClassroom: () => void
}

function PitchContour({ variant }: { variant: 'flat' | 'rise' }) {
  const d =
    variant === 'flat'
      ? 'M4 29 C 56 26, 118 31, 178 28 S 258 30, 298 27'
      : 'M4 31 C 56 33, 118 29, 170 30 S 236 30, 260 24 C 276 19, 288 12, 298 6'
  const dotY = variant === 'flat' ? 27 : 6
  return (
    <svg
      className={`pitch pitch-${variant}`}
      viewBox="0 0 320 52"
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      <path className="contour-base" d="M4 42 H316" />
      <path className="contour" pathLength={1} d={d} />
      <circle className="end-dot" cx="298" cy={dotY} r="3.6" />
    </svg>
  )
}

function ToneChip({ children, delay }: { children: string; delay: string }) {
  return (
    <span className="chip-tone" style={{ animationDelay: delay }}>
      <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
        <path
          d="M1 8h2.2l1.6-4.5 2.4 9 2.2-6.5 1.4 2H15"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.7"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
      {children}
    </span>
  )
}

export function HomePage({ onEnterClassroom }: HomePageProps) {
  const question = sampleClassroomSession.segments[0].text
  const phrase = sampleClassroomSession.segments[1].text.replace(/？$/, '')

  return (
    <main className="home">
      <div className="home-top">
        <span className="brand-mini">
          <svg width="18" height="18" viewBox="0 0 20 20" aria-hidden="true">
            <rect x="2" y="8" width="2.4" height="4" rx="1.2" fill="#aa2b3a" />
            <rect x="6.4" y="5" width="2.4" height="10" rx="1.2" fill="#c9707c" />
            <rect x="10.8" y="2" width="2.4" height="16" rx="1.2" fill="#3e8e7e" />
            <rect x="15.2" y="6" width="2.4" height="8" rx="1.2" fill="#28314e" />
          </svg>
          字里有声
        </span>
        <span className="stage-badge">示例预览</span>
      </div>

      <section className="specimen" aria-label="课堂字幕示例：语气如何被看见">
        <div className="specimen-head">课堂 · 作业截止时间</div>
        <h2 className="specimen-title">老师是在通知还是询问？</h2>

        <div className="specimen-group">
          <h3 className="group-label">平稳说完</h3>
          <p className="group-context">
            <span className="ctx-mark">上一句</span>截止日期定好了。
          </p>
          <div className="group-line">
            <span className="specimen-text">{phrase}</span>
            <PitchContour variant="flat" />
          </div>
          <ToneChip delay="1.5s">可能在通知截止时间</ToneChip>
        </div>

        <div className="specimen-group">
          <h3 className="group-label">尾音上扬</h3>
          <p className="group-context">
            <span className="ctx-mark">上一句</span>
            {question}
          </p>
          <div className="group-line">
            <span className="specimen-text">{phrase}</span>
            <PitchContour variant="rise" />
          </div>
          <ToneChip delay="2.1s">可能在等你回应</ToneChip>
        </div>
      </section>

      <header className="home-intro">
        <div className="wordmark-wrap">
          <h1 className="wordmark">字里有声</h1>
          <svg className="wordmark-stroke" viewBox="0 0 220 14" aria-hidden="true">
            <path
              d="M4 10 C 70 13, 150 11, 212 3"
              fill="none"
              stroke="currentColor"
              strokeWidth="4.5"
              strokeLinecap="round"
            />
          </svg>
        </div>
        <p className="wordmark-latin">ToneCaption</p>
        <p className="tagline">看见老师说了什么，也看见声音里的线索。</p>
      </header>

      <div className="home-cta-zone">
        <button type="button" className="btn-primary" onClick={onEnterClassroom}>
          打开课堂字幕
        </button>
      </div>
    </main>
  )
}