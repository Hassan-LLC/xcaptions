import { AudioLines } from 'lucide-react'
import type { SilenceRange, SilenceSettings } from '../lib/silence'
import { formatSilenceTime } from '../lib/silence'

type SilenceControlsProps = {
  duration: number
  trimRange: { start: number; end: number }
  canDetect: boolean
  settings: SilenceSettings
  onSettingsChange: (patch: Partial<SilenceSettings>) => void
  state: 'idle' | 'detecting' | 'done' | 'error'
  error: string
  silences: SilenceRange[]
  removedRanges: { start: number; end: number }[]
  editedDuration: number
  noiseFloorDb: number | null
  onDetect: () => void
  onToggle: (id: string, selected: boolean) => void
  onToggleAll: (selected: boolean) => void
  onCutSelected: () => void
  onUndoCuts: () => void
  disabled?: boolean
}

function segmentStyle(start: number, end: number, duration: number, trimStart: number, trimEnd: number) {
  if (duration <= 0 || end <= trimStart || start >= trimEnd) return null
  const left = Math.max(start, trimStart)
  const right = Math.min(end, trimEnd)
  return {
    left: `${left / duration * 100}%`,
    width: `${Math.max(0, (right - left) / duration * 100)}%`,
  }
}

export default function SilenceControls({
  duration,
  trimRange,
  canDetect,
  settings,
  onSettingsChange,
  state,
  error,
  silences,
  removedRanges,
  editedDuration,
  noiseFloorDb,
  onDetect,
  onToggle,
  onToggleAll,
  onCutSelected,
  onUndoCuts,
  disabled = false,
}: SilenceControlsProps) {
  const totalSilence = silences.reduce((total, silence) => total + Math.max(0, silence.end - silence.start), 0)
  const trimmedDuration = Math.max(0, trimRange.end - trimRange.start)
  const selectedCount = silences.filter((silence) => silence.selected).length
  const hasCuts = removedRanges.length > 0
  const busy = disabled || state === 'detecting'

  return (
    <section className="silence-controls" aria-label="Remove silences">
      <div className="silence-heading">
        <span className="silence-heading-icon"><AudioLines size={15} /></span>
        <div>
          <span className="eyebrow">SILENCE</span>
          <strong>Remove silences</strong>
          <small>Detect pauses, then cut them from video, audio and subtitles.</small>
        </div>
      </div>

      <div className="silence-settings" role="group" aria-label="Silence detection settings">
        <label>
          <span>Min. silence <small>sec</small></span>
          <input
            aria-label="Minimum silence length in seconds"
            type="number"
            min="0.2"
            max="5"
            step="0.1"
            value={settings.minSilence}
            disabled={busy}
            onChange={(event) => onSettingsChange({ minSilence: Math.max(0.1, Number(event.currentTarget.value) || 0.5) })}
          />
        </label>
        <label>
          <span>Loudness <small>dB</small></span>
          <input
            aria-label="Loudness threshold in decibels"
            type="number"
            min="-80"
            max="0"
            step="1"
            value={settings.thresholdDb ?? Math.round(noiseFloorDb ?? -40)}
            disabled={busy || settings.thresholdDb === null}
            onChange={(event) => onSettingsChange({ thresholdDb: Math.max(-80, Math.min(0, Number(event.currentTarget.value) || -40)) })}
          />
        </label>
        <label className="silence-padding">
          <span>Padding <small>sec</small></span>
          <input
            aria-label="Padding kept around speech in seconds"
            type="number"
            min="0"
            max="1"
            step="0.05"
            value={settings.padding}
            disabled={busy}
            onChange={(event) => onSettingsChange({ padding: Math.max(0, Math.min(1, Number(event.currentTarget.value) || 0)) })}
          />
        </label>
        <label className="silence-auto-toggle">
          <input type="checkbox" checked={settings.thresholdDb === null} disabled={busy} onChange={(event) => onSettingsChange({ thresholdDb: event.currentTarget.checked ? null : -40 })} />
          Auto threshold
        </label>
      </div>

      <div className="silence-actions">
        <button type="button" className="button button-subtle silence-detect" disabled={busy || !canDetect} onClick={onDetect}>
          {state === 'detecting' ? 'Detecting…' : 'Detect'}
        </button>
        {noiseFloorDb != null && settings.thresholdDb === null && state === 'done' && (
          <span className="silence-noise-floor">noise floor {Math.round(noiseFloorDb)} dB</span>
        )}
        {state === 'done' && silences.length > 0 && (
          <>
            <button type="button" className="text-button" onClick={() => onToggleAll(selectedCount !== silences.length)} disabled={busy}>
              {selectedCount === silences.length ? 'Deselect all' : 'Select all'}
            </button>
            <button type="button" className="button button-primary" onClick={onCutSelected} disabled={busy || selectedCount === 0}>
              Cut selected ({selectedCount})
            </button>
          </>
        )}
        {hasCuts && <button type="button" className="text-button" onClick={onUndoCuts} disabled={busy}>Undo cuts</button>}
      </div>

      {state === 'done' && silences.length > 0 && (
        <div className="silence-summary" role="status">
          <span>{silences.length} pauses · {formatSilenceTime(totalSilence)} detected</span>
          <span>{formatSilenceTime(trimmedDuration)} in range · {formatSilenceTime(editedDuration)} after cuts</span>
        </div>
      )}

      {(state === 'detecting' || state === 'done') && (
        <div className={`silence-track ${state === 'detecting' ? 'is-detecting' : ''}`} aria-hidden="true">
          {silences.map((silence) => {
            const style = segmentStyle(silence.start, silence.end, duration, trimRange.start, trimRange.end)
            if (!style) return null
            const isCut = removedRanges.some((range) => silence.start >= range.start - 0.02 && silence.end <= range.end + 0.02)
            return <span key={silence.id} className={`silence-track-segment ${silence.selected ? 'is-selected' : ''} ${isCut ? 'is-cut' : ''}`} style={style} data-silence-id={silence.id} data-selected={silence.selected} />
          })}
        </div>
      )}

      {state === 'done' && silences.length > 0 && (
        <ul className="silence-range-list" aria-label="Detected pauses">
          {silences.map((silence) => {
            const isCut = removedRanges.some((range) => silence.start >= range.start - 0.02 && silence.end <= range.end + 0.02)
            return (
              <li key={silence.id} className={isCut ? 'is-cut' : ''}>
                <label>
                  <input
                    type="checkbox"
                    checked={silence.selected}
                    disabled={busy || isCut}
                    onChange={(event) => onToggle(silence.id, event.currentTarget.checked)}
                  />
                  <span>{formatSilenceTime(silence.start)}–{formatSilenceTime(silence.end)}</span>
                  {isCut && <small>Cut</small>}
                </label>
              </li>
            )
          })}
        </ul>
      )}

      {state === 'detecting' && <p className="silence-progress" role="status">Finding pauses in speech and audio…</p>}
      {state === 'error' && <p className="silence-error" role="alert">{error}</p>}

      {state === 'done' && silences.length === 0 && (
        <p className="silence-empty" role="status">No silences found. Try lowering the minimum silence length, reducing the loudness threshold, or trimming to a wider range.</p>
      )}
    </section>
  )
}