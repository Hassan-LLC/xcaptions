import { type SubtitleLine } from '../lib/chunker'

type LineEditorProps = {
  line: SubtitleLine
  onChange: (line: SubtitleLine) => void
  onDelete: () => void
  onSplit: () => void
  onMergeUp: () => void
  onMergeDown: () => void
  canMergeUp: boolean
  canMergeDown: boolean
  disabled?: boolean
  direction?: 'ltr' | 'rtl'
  fontFamily?: string
}

export function LineEditor({ line, onChange, onDelete, onSplit, onMergeUp, onMergeDown, canMergeUp, canMergeDown, disabled = false, direction = 'ltr', fontFamily }: LineEditorProps) {
  return (
    <div className="edit-section">
      <div className="control-label">
        <span>EDIT CAPTION</span>
        <div style={{display:'flex', gap:'5px'}}>
          {canMergeUp && <button className="text-button" onClick={onMergeUp} disabled={disabled}>Merge Up</button>}
          {canMergeDown && <button className="text-button" onClick={onMergeDown} disabled={disabled}>Merge Dn</button>}
          <button className="text-button" onClick={onSplit} disabled={disabled}>Split</button>
          <button className="text-button" onClick={onDelete} disabled={disabled} style={{color:'var(--coral)'}}>Delete</button>
        </div>
      </div>
      <textarea
        dir={direction}
        style={fontFamily ? { fontFamily: `"${fontFamily}", sans-serif` } : undefined}
        value={line.text}
        onChange={(e) => onChange({ ...line, text: e.target.value })}
        disabled={disabled}
      />
      <div className="time-edit">
        <label>
          <span>START</span>
          <input
            type="number"
            step="0.1"
            value={line.start}
            onChange={(e) => onChange({ ...line, start: parseFloat(e.target.value) || 0 })}
            disabled={disabled}
          />
        </label>
        <label>
          <span>END</span>
          <input
            type="number"
            step="0.1"
            value={line.end}
            onChange={(e) => onChange({ ...line, end: parseFloat(e.target.value) || 0 })}
            disabled={disabled}
          />
        </label>
      </div>
    </div>
  )
}
