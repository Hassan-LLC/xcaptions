import { Crop, Layers, Palette } from 'lucide-react'
import { aspectRatioOptions, fitModeOptions, formatOutputSize, type AspectRatioId, type FitMode, type ReframeState } from '../lib/reframe'

type ReframeControlsProps = {
  reframe: ReframeState
  onChange: (patch: Partial<ReframeState>) => void
  outputWidth: number | null
  outputHeight: number | null
  disabled?: boolean
}

const fitIcons: Record<FitMode, typeof Layers> = {
  blur: Layers,
  fill: Crop,
  color: Palette,
}

export default function ReframeControls({ reframe, onChange, outputWidth, outputHeight, disabled = false }: ReframeControlsProps) {
  const selectRatio = (ratio: AspectRatioId) => {
    if (ratio !== reframe.ratio) onChange({ ratio })
  }

  const rangeInput = (
    label: string,
    value: number,
    min: number,
    max: number,
    step: number,
    onChangeValue: (value: number) => void,
    display: (value: number) => string,
  ) => (
    <label className="style-range-control">
      <span>{label}<output>{display(value)}</output></span>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(event) => onChangeValue(Number(event.currentTarget.value))} aria-label={label} disabled={disabled} />
    </label>
  )

  return (
    <section className="reframe-controls" aria-label="Canvas and aspect ratio">
      <div className="reframe-heading">
        <div>
          <span className="eyebrow">CANVAS</span>
          <strong>Aspect ratio</strong>
        </div>
        <div className="reframe-output" aria-live="polite">
          <span>Output</span>
          <b>{formatOutputSize(outputWidth, outputHeight)}</b>
        </div>
      </div>

      <div className="ratio-pills" role="group" aria-label="Aspect ratio">
        {aspectRatioOptions.map((option) => (
          <button
            key={option.id}
            type="button"
            className={`ratio-pill ${reframe.ratio === option.id ? 'is-selected' : ''}`}
            aria-pressed={reframe.ratio === option.id}
            onClick={() => selectRatio(option.id)}
            disabled={disabled}
            title={option.hint}
          >
            <span>{option.label}</span>
            <small>{option.hint}</small>
          </button>
        ))}
      </div>

      <div className="fit-mode-row" role="group" aria-label="Fit mode">
        {fitModeOptions.map((option) => {
          const Icon = fitIcons[option.id]
          return (
            <button
              key={option.id}
              type="button"
              className={`fit-mode-pill ${reframe.fit === option.id ? 'is-selected' : ''}`}
              aria-pressed={reframe.fit === option.id}
              onClick={() => onChange({ fit: option.id })}
              disabled={disabled}
              title={option.hint}
            >
              <Icon size={14} />
              <span>{option.label}</span>
            </button>
          )
        })}
      </div>

      {reframe.fit === 'fill' && (
        <div className="reframe-detail">
          <p className="reframe-note">Drag on the preview or use the sliders to choose the crop focus.</p>
          {rangeInput('Horizontal focus', reframe.focusX * 100, 0, 100, 1, (value) => onChange({ focusX: value / 100 }), (value) => `${Math.round(value)}%`)}
          {rangeInput('Vertical focus', reframe.focusY * 100, 0, 100, 1, (value) => onChange({ focusY: value / 100 }), (value) => `${Math.round(value)}%`)}
          {rangeInput('Zoom', reframe.zoom, 1, 3, 0.01, (value) => onChange({ zoom: value }), (value) => `${value.toFixed(2)}×`)}
        </div>
      )}

      {reframe.fit === 'color' && (
        <div className="reframe-detail">
          <label className="style-color-control">
            <span>Background color</span>
            <input type="color" value={reframe.backgroundColor} onChange={(event) => onChange({ backgroundColor: event.currentTarget.value })} aria-label="Background color" disabled={disabled} />
          </label>
        </div>
      )}

      <label className={`reframe-safe-toggle ${reframe.socialSafeArea ? 'is-on' : ''}`}>
        <input type="checkbox" checked={reframe.socialSafeArea} onChange={(event) => onChange({ socialSafeArea: event.currentTarget.checked })} disabled={disabled} />
        Show social safe area (preview only)
      </label>
    </section>
  )
}
