import { forwardRef } from 'react'
import type { CaptionSegment } from '../types'

interface CaptionListProps {
  segments: CaptionSegment[]
  currentId?: string
  showTone?: boolean
}

function formatStart(start?: number): string | null {
  if (start == null) return null
  const m = Math.floor(start / 60)
  const s = Math.floor(start % 60)
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

function ToneBlock({ tone, cue, evidence }: { tone?: string; cue?: string; evidence?: string }) {
  if (!tone && !cue) return null
  return (
    <div className="caption-tone">
      {tone ? (
        <span className="tone-label">
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
          {tone}
        </span>
      ) : (
        <span className="tone-cue">线索 · {cue}</span>
      )}
      {tone && evidence && (
        <span className="tone-evidence">
          <span className="ev-mark" aria-hidden="true">依据</span>
          {evidence}
        </span>
      )}
    </div>
  )
}

export const CaptionList = forwardRef<HTMLOListElement, CaptionListProps>(
  function CaptionList({ segments, currentId, showTone = true }, ref) {
    return (
      <ol className="caption-list" ref={ref} aria-label="课堂字幕列表">
        {segments.map((seg, i) => {
          const isCurrent = seg.id === currentId
          const time = formatStart(seg.start)
          const showParts = seg.parts && seg.parts.length > 0 && !seg.pending && !seg.error
          return (
            <li
              key={seg.id}
              id={`caption-${seg.id}`}
              className={`caption-item ${isCurrent ? 'is-current' : 'is-past'} rise rise-${Math.min(i + 1, 5)}`}
              aria-current={isCurrent ? 'true' : undefined}
            >
              <div className="caption-meta">
                {isCurrent ? (
                  <span className="tag-current">当前句</span>
                ) : (
                  <span>第 {i + 1} 句</span>
                )}
                {time && <span aria-label={`开始于 ${time}`}>{time}</span>}
              </div>
              {showParts ? (
                seg.parts!.map((p, j) => (
                  <div className="caption-part" key={j}>
                    <p className="caption-text">{p.text}</p>
                    {showTone && <ToneBlock tone={p.tone} cue={p.cue} evidence={p.evidence} />}
                  </div>
                ))
              ) : (
                <>
                  <p
                    className={`caption-text${seg.error ? ' caption-error' : seg.pending ? ' caption-pending' : ''}`}
                  >
                    {seg.error
                      ? `识别失败：${seg.error}`
                      : seg.pending
                        ? '识别中…'
                        : seg.text || '（该段未识别出文字）'}
                  </p>
                  {showTone && <ToneBlock tone={seg.tone} cue={seg.cue} evidence={seg.evidence} />}
                </>
              )}
            </li>
          )
        })}
      </ol>
    )
  },
)