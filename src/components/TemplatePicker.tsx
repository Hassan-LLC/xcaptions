import { useEffect, useRef } from 'react'
import { Check, RotateCcw } from 'lucide-react'
import { loadTemplateFont, renderCaption } from '../lib/renderer'
import type { SubtitleStyleOverrides, SubtitleTemplate } from '../templates/types'

const fonts = [
  'Anton',
  'Bebas Neue',
  'Archivo Black',
  'Bangers',
  'Luckiest Guy',
  'Lilita One',
  'Permanent Marker',
  'Montserrat',
  'Poppins',
  'Rubik',
  'Noto Nastaliq Urdu',
  'Noto Naskh Arabic',
  'Noto Sans Devanagari',
]

const animations: SubtitleTemplate['animation'][] = [
  'pop', 'bounce', 'zoomIn', 'shake', 'fade', 'slideUp', 'wordByWord', 'typewriter', 'karaoke', 'glowPulse',
]

function inputColor(value: string) {
  if (/^#[\da-f]{6}$/iu.test(value)) return value
  const rgb = value.match(/rgba?\(\s*(\d+)[, ]+\s*(\d+)[, ]+\s*(\d+)/iu)
  if (!rgb) return '#111318'
  return `#${rgb.slice(1, 4).map((channel) => Number(channel).toString(16).padStart(2, '0')).join('')}`
}

type TemplatePickerProps = {
  templates: SubtitleTemplate[]
  selected: string
  onSelect: (template: SubtitleTemplate) => void
  overrides: SubtitleStyleOverrides
  onOverride: <K extends keyof SubtitleStyleOverrides>(key: K, value: SubtitleStyleOverrides[K]) => void
  onReset: () => void
  disabled?: boolean
}

function TemplateThumbnail({ template }: { template: SubtitleTemplate }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    let cancelled = false
    const draw = async () => {
      await loadTemplateFont(template)
      if (cancelled) return
      const canvas = canvasRef.current
      const context = canvas?.getContext('2d')
      if (!canvas || !context) return
      context.clearRect(0, 0, canvas.width, canvas.height)
      const background = context.createLinearGradient(0, 0, canvas.width, canvas.height)
      background.addColorStop(0, '#383a35')
      background.addColorStop(1, '#181a19')
      context.fillStyle = background
      context.fillRect(0, 0, canvas.width, canvas.height)
      const text = template.rtl ? 'اردو میں خوش آمدید' : template.font === 'Noto Sans Devanagari' ? 'नमस्ते दुनिया' : 'Your words'
      renderCaption(context, template, 1, text, { size: 0.36, positionY: 0.56, wordsPerLine: 3 })
    }
    void draw().catch((error: unknown) => {
      console.error(`Could not render the ${template.name} thumbnail.`, error)
    })
    return () => { cancelled = true }
  }, [template])

  return <canvas ref={canvasRef} className="template-thumb-canvas" width={260} height={84} aria-hidden="true" />
}

export default function TemplatePicker({ templates, selected, onSelect, overrides, onOverride, onReset, disabled = false }: TemplatePickerProps) {
  const current = templates.find((template) => template.id === selected) ?? templates[0]
  if (!current) return null
  const backgroundEnabled = overrides.backgroundEnabled ?? Boolean(current.background)
  const colorInput = (label: string, value: string, onChange: (value: string) => void) => (
    <label className="style-color-control">
      <span>{label}</span>
      <input type="color" value={inputColor(value)} onChange={(event) => onChange(event.currentTarget.value)} aria-label={label} disabled={disabled} />
    </label>
  )
  const rangeInput = (
    label: string,
    value: number,
    min: number,
    max: number,
    step: number,
    onChange: (value: number) => void,
    display: (value: number) => string,
  ) => (
    <label className="style-range-control">
      <span>{label}<output>{display(value)}</output></span>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(event) => onChange(Number(event.currentTarget.value))} aria-label={label} disabled={disabled} />
    </label>
  )

  return (
    <div className="style-panel-content">
      <details className="style-control-section style-accordion" open>
        <summary>Template<span>{current.name}</span></summary>
        <div className="phase-template-grid template-grid-live" role="group" aria-label="Caption templates">
          {templates.map((template) => (
            <button
              key={template.id}
              className={`phase-template-choice ${selected === template.id ? 'selected' : ''}`}
              onClick={() => onSelect(template)}
              aria-pressed={selected === template.id}
              disabled={disabled}
            >
              <span className="phase-template-preview"><TemplateThumbnail template={template} /></span>
              <span className="phase-template-label"><strong>{template.name}</strong><small>{template.font}</small></span>
              {selected === template.id && <Check size={14} className="phase-template-check" />}
            </button>
          ))}
        </div>
      </details>

      <details className="style-control-section style-accordion" open>
        <summary>Font<span>{overrides.font ?? current.font}</span></summary>
        <div className="style-section-heading">
          <div><span className="style-muted">Overrides apply over this preset</span></div>
          <button className="style-reset-button" onClick={onReset} disabled={disabled}><RotateCcw size={12} /> Reset to template</button>
        </div>
        <label className="style-select-control">
          <span>Font family</span>
          <select value={overrides.font ?? current.font} onChange={(event) => onOverride('font', event.currentTarget.value)} disabled={disabled}>
            {fonts.map((font) => <option key={font} value={font}>{font}</option>)}
          </select>
        </label>
        {rangeInput('Font size', (overrides.size ?? current.size) * 100, 3, 18, 0.5, (value) => onOverride('size', value / 100), (value) => `${value.toFixed(1)}%`)}
        {rangeInput('Letter spacing', overrides.letterSpacing ?? current.letterSpacing, -0.08, 0.2, 0.01, (value) => onOverride('letterSpacing', value), (value) => `${value.toFixed(2)}em`)}
        {rangeInput('Words per line', overrides.wordsPerLine ?? current.wordsPerLine, 1, 5, 1, (value) => onOverride('wordsPerLine', value), (value) => `${Math.round(value)}`)}
        {rangeInput('Line height', overrides.lineHeight ?? current.lineHeight, 0.8, 1.8, 0.05, (value) => onOverride('lineHeight', value), (value) => value.toFixed(2))}
      </details>

      <details className="style-control-section style-accordion">
        <summary>Position<span>Caption placement</span></summary>
        {rangeInput('Vertical position', (overrides.positionY ?? 0.82) * 100, 8, 92, 1, (value) => onOverride('positionY', value / 100), (value) => `${Math.round(value)}%`)}
        {rangeInput('Horizontal offset', (overrides.positionX ?? 0) * 100, -40, 40, 1, (value) => onOverride('positionX', value / 100), (value) => `${Math.round(value)}%`)}
      </details>

      <details className="style-control-section style-accordion">
        <summary>Colors<span>Text and effects</span></summary>
        <div className="style-color-grid">
          {colorInput('Text color', overrides.color ?? current.color, (value) => onOverride('color', value))}
          {colorInput('Highlight color', overrides.highlight ?? current.highlight, (value) => onOverride('highlight', value))}
          {colorInput('Stroke color', overrides.strokeColor ?? current.stroke.color, (value) => onOverride('strokeColor', value))}
          {colorInput('Background color', overrides.backgroundColor ?? current.background?.color ?? '#111318', (value) => onOverride('backgroundColor', value))}
        </div>
        {rangeInput('Stroke width', (overrides.strokeWidth ?? current.stroke.width) * 100, 0, 16, 0.5, (value) => onOverride('strokeWidth', value / 100), (value) => `${value.toFixed(1)}%`)}
        <div className="style-check-grid">
          <label><input type="checkbox" checked={overrides.shadowEnabled ?? true} onChange={(event) => onOverride('shadowEnabled', event.currentTarget.checked)} disabled={disabled} /><span>Shadow</span></label>
          <label><input type="checkbox" checked={backgroundEnabled} onChange={(event) => onOverride('backgroundEnabled', event.currentTarget.checked)} disabled={disabled} /><span>Background box</span></label>
          <label><input type="checkbox" checked={overrides.uppercase ?? current.uppercase} onChange={(event) => onOverride('uppercase', event.currentTarget.checked)} disabled={disabled} /><span>Uppercase</span></label>
        </div>
      </details>

      <details className="style-control-section style-accordion style-animation-section">
        <summary>Animation<span>{(overrides.animation ?? current.animation).replace(/[A-Z]/gu, (letter) => ` ${letter.toLowerCase()}`)}</span></summary>
        <label className="style-select-control">
          <span>Animation</span>
          <select value={overrides.animation ?? current.animation} onChange={(event) => onOverride('animation', event.currentTarget.value as SubtitleTemplate['animation'])} disabled={disabled}>
            {animations.map((animation) => <option key={animation} value={animation}>{animation.replace(/[A-Z]/gu, (letter) => ` ${letter.toLowerCase()}`)}</option>)}
          </select>
        </label>
      </details>
    </div>
  )
}
