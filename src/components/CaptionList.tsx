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

export const CaptionList = forwardRef<HTMLOListElement, CaptionListProps>(
  function CaptionList({ segments, currentId, showTone = true }, ref) {
    return (
      <ol className="caption-list" ref={ref} aria-label="课堂字幕列表">
        {segments.map((seg, i) => {
          const isCurrent = seg.id === currentId
          const time = formatStart(seg.start)
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
              <p
                className={`caption-text${seg.error ? ' caption-error' : seg.pending ? ' caption-pending' : ''}`}
              >
                {seg.error
                  ? `识别失败：${seg.error}`
                  : seg.pending
                    ? '识别中…'
                    : seg.text || '（该段未识别出文字）'}
              </p>
              {showTone && (seg.tone || seg.cue) && (
                <div className="caption-tone">
                  {seg.tone ? (
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
                      {seg.tone}
                    </span>
                  ) : (
                    <span className="tone-cue">线索 · {seg.cue}</span>
                  )}
                  {seg.tone && seg.evidence && (
                    <span className="tone-evidence">
                      <span className="ev-mark" aria-hidden="true">依据</span>
                      {seg.evidence}
                    </span>
                  )}
                </div>
              )}
            </li>
          )
        })}
      </ol>
    )
  },
)