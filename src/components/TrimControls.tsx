import { useEffect, useState } from 'react'
import { clampTrimRange, formatTrimTime, MIN_TRIM_SECONDS, parseTrimTime } from '../lib/trim'

type TrimControlsProps = {
  start: number
  end: number
  duration: number
  currentTime: number
  disabled?: boolean
  loop: boolean
  onChange: (start: number, end: number) => void
  onLoopChange: (loop: boolean) => void
}

function formatWholeTime(time: number) {
  return `${String(Math.floor(time / 60)).padStart(2, '0')}:${String(Math.floor(time) % 60).padStart(2, '0')}`
}

export default function TrimControls({
  start,
  end,
  duration,
  currentTime,
  disabled = false,
  loop,
  onChange,
  onLoopChange,
}: TrimControlsProps) {
  const [startText, setStartText] = useState(formatTrimTime(start))
  const [endText, setEndText] = useState(formatTrimTime(end))
  const selectedDuration = Math.max(0, end - start)
  const selectedStartPercent = duration > 0 ? start / duration * 100 : 0
  const selectedEndPercent = duration > 0 ? end / duration * 100 : 100
  const seekPercent = duration > 0 ? currentTime / duration * 100 : 0

  useEffect(() => setStartText(formatTrimTime(start)), [start])
  useEffect(() => setEndText(formatTrimTime(end)), [end])

  const commitStart = () => {
    const parsed = parseTrimTime(startText)
    if (parsed === null) {
      setStartText(formatTrimTime(start))
      return
    }
    const range = clampTrimRange(Math.min(parsed, end - MIN_TRIM_SECONDS), end, duration)
    onChange(range.start, range.end)
  }

  const commitEnd = () => {
    const parsed = parseTrimTime(endText)
    if (parsed === null) {
      setEndText(formatTrimTime(end))
      return
    }
    const range = clampTrimRange(start, Math.max(parsed, start + MIN_TRIM_SECONDS), duration)
    onChange(range.start, range.end)
  }

  return (
    <section className="trim-controls" aria-label="Trim video range">
      <div className="trim-heading">
        <div>
          <span className="eyebrow">TRIM</span>
          <strong>Choose the part to download</strong>
        </div>
        <label className={`trim-loop-toggle ${loop ? 'is-on' : ''}`}>
          <input type="checkbox" checked={loop} disabled={disabled || selectedDuration <= 0} onChange={(event) => onLoopChange(event.currentTarget.checked)} />
          Loop selection
        </label>
      </div>

      <div className="trim-timeline">
        <div className="trim-track" aria-hidden="true">
          <span className="trim-track-selection" style={{ left: `${selectedStartPercent}%`, width: `${Math.max(0, selectedEndPercent - selectedStartPercent)}%` }} />
          <span className="trim-track-playhead" style={{ left: `${seekPercent}%` }} />
        </div>
        <input
          className="trim-handle trim-handle-start"
          aria-label="Trim start time"
          type="range"
          min="0"
          max={duration || 1}
          step="0.1"
          value={start}
          disabled={disabled || duration <= MIN_TRIM_SECONDS}
          onChange={(event) => onChange(Number(event.currentTarget.value), end)}
        />
        <input
          className="trim-handle trim-handle-end"
          aria-label="Trim end time"
          type="range"
          min="0"
          max={duration || 1}
          step="0.1"
          value={end}
          disabled={disabled || duration <= MIN_TRIM_SECONDS}
          onChange={(event) => onChange(start, Number(event.currentTarget.value))}
        />
      </div>
      <div className="trim-ruler" aria-hidden="true"><span>00:00</span><span>{formatWholeTime(duration / 2)}</span><span>{formatWholeTime(duration)}</span></div>

      <div className="trim-readouts">
        <label>
          <span>Start <small>mm:ss.s</small></span>
          <input
            aria-label="Precise trim start (mm:ss.s)"
            inputMode="decimal"
            value={startText}
            disabled={disabled || duration <= MIN_TRIM_SECONDS}
            onChange={(event) => setStartText(event.currentTarget.value)}
            onBlur={commitStart}
            onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur() }}
          />
        </label>
        <label>
          <span>End <small>mm:ss.s</small></span>
          <input
            aria-label="Precise trim end (mm:ss.s)"
            inputMode="decimal"
            value={endText}
            disabled={disabled || duration <= MIN_TRIM_SECONDS}
            onChange={(event) => setEndText(event.currentTarget.value)}
            onBlur={commitEnd}
            onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur() }}
          />
        </label>
      </div>
      <p className="trim-selected" aria-live="polite">
        Selected: {formatWholeTime(start)} to {formatWholeTime(end)} ({selectedDuration.toFixed(1).replace(/\.0$/u, '')} s)
      </p>
      <div className="trim-actions">
        <button type="button" className="button button-subtle" disabled={disabled || duration <= MIN_TRIM_SECONDS} onClick={() => onChange(currentTime, end)}>Set start to current time</button>
        <button type="button" className="button button-subtle" disabled={disabled || duration <= MIN_TRIM_SECONDS} onClick={() => onChange(start, currentTime)}>Set end to current time</button>
        <button type="button" className="button button-subtle trim-reset" disabled={disabled || (start === 0 && end === duration)} onClick={() => onChange(0, duration)}>Reset (full video)</button>
      </div>
    </section>
  )
}
