import { useCallback, useEffect, useMemo, useRef, useState, type RefObject, type ReactNode } from 'react'
import { ArrowDown, Search } from 'lucide-react'
import type { SubtitleLine } from '../lib/chunker'

type CaptionListProps = {
  lines: SubtitleLine[]
  selectedId: string | null
  currentTime: number
  onSelect: (id: string) => void
  onSeek: (time: number) => void
  onAddLine: () => void
  editor: ReactNode
  scrollContainerRef: RefObject<HTMLDivElement>
  disabled?: boolean
  rtl?: boolean
  fontFamily?: string
}

function formatTime(seconds: number) {
  return `${Math.max(0, seconds).toFixed(2)}s`
}

export function CaptionList({
  lines,
  selectedId,
  currentTime,
  onSelect,
  onSeek,
  onAddLine,
  editor,
  scrollContainerRef,
  disabled = false,
  rtl = false,
  fontFamily,
}: CaptionListProps) {
  const [query, setQuery] = useState('')
  const [autoFollow, setAutoFollow] = useState(true)
  const rowRefs = useRef(new Map<string, HTMLButtonElement>())
  const activeLine = lines.find((line) => currentTime >= line.start && currentTime <= line.end)
  const activeId = activeLine?.id ?? selectedId
  const filteredLines = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase()
    if (!normalizedQuery) return lines
    return lines.filter((line) => line.text.toLocaleLowerCase().includes(normalizedQuery))
  }, [lines, query])

  const scrollRowToView = useCallback((id: string) => {
    const container = scrollContainerRef.current
    const row = rowRefs.current.get(id)
    if (!container || !row) return false
    const containerBounds = container.getBoundingClientRect()
    const rowBounds = row.getBoundingClientRect()
    let nextTop = container.scrollTop
    if (rowBounds.top < containerBounds.top) nextTop += rowBounds.top - containerBounds.top
    else if (rowBounds.bottom > containerBounds.bottom) nextTop += rowBounds.bottom - containerBounds.bottom
    if (nextTop !== container.scrollTop) container.scrollTo({ top: nextTop, behavior: 'smooth' })
    return true
  }, [scrollContainerRef])

  useEffect(() => {
    if (!autoFollow || !activeId) return
    if (!scrollRowToView(activeId)) return
  }, [activeId, autoFollow, scrollRowToView])

  useEffect(() => {
    const container = scrollContainerRef.current
    if (!container) return
    const handleWheel = (event: WheelEvent) => {
      if (event.deltaY !== 0) setAutoFollow(false)
    }
    const handleTouchMove = () => setAutoFollow(false)
    const handlePointerDown = (event: PointerEvent) => {
      const bounds = container.getBoundingClientRect()
      const scrollbarWidth = container.offsetWidth - container.clientWidth
      if (scrollbarWidth > 0 && event.clientX >= bounds.right - scrollbarWidth) setAutoFollow(false)
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.target === container && ['ArrowDown', 'ArrowUp', 'PageDown', 'PageUp', 'Home', 'End', ' '].includes(event.key)) {
        setAutoFollow(false)
      }
    }
    container.addEventListener('wheel', handleWheel, { passive: true })
    container.addEventListener('touchmove', handleTouchMove, { passive: true })
    container.addEventListener('pointerdown', handlePointerDown)
    container.addEventListener('keydown', handleKeyDown)
    return () => {
      container.removeEventListener('wheel', handleWheel)
      container.removeEventListener('touchmove', handleTouchMove)
      container.removeEventListener('pointerdown', handlePointerDown)
      container.removeEventListener('keydown', handleKeyDown)
    }
  }, [scrollContainerRef])

  return (
    <section className="caption-browser" aria-label="Captions">
      <div className="caption-tools">
        <label className="caption-search">
          <Search size={14} aria-hidden="true" />
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.currentTarget.value)}
            placeholder="Find text"
            aria-label="Find text in captions"
          />
        </label>
        <label className="auto-follow-toggle">
          <input type="checkbox" checked={autoFollow} onChange={(event) => setAutoFollow(event.currentTarget.checked)} />
          <span>Auto-follow</span>
        </label>
      </div>
      <div className="caption-list-summary">
        <strong>{filteredLines.length}</strong>
        <span>{filteredLines.length === 1 ? 'caption' : 'captions'}{query.trim() ? ` found · ${lines.length} total` : ''}</span>
        {!autoFollow && activeId && (
          <button type="button" className="jump-current-button" onClick={() => {
            setAutoFollow(true)
            scrollRowToView(activeId)
          }}>
            <ArrowDown size={12} /> Jump to current
          </button>
        )}
      </div>
      <div className="caption-list">
        {filteredLines.map((line) => {
          const index = lines.findIndex((item) => item.id === line.id)
          const isActive = currentTime >= line.start && currentTime <= line.end
          const isSelected = selectedId === line.id
          return (
            <div className="caption-entry" key={line.id} style={filteredLines.length > 200 ? { contentVisibility: 'auto', containIntrinsicSize: '72px' } : undefined}>
              <button
                ref={(element) => {
                  if (element) rowRefs.current.set(line.id, element)
                  else rowRefs.current.delete(line.id)
                }}
                className={`caption-row ${isSelected ? 'is-selected' : ''} ${isActive ? 'is-playing' : ''}`}
                dir={rtl ? 'rtl' : 'ltr'}
                disabled={disabled}
                onClick={() => {
                  onSelect(line.id)
                  onSeek(line.start)
                }}
              >
                <span className="caption-index">{index + 1}</span>
                <span className="caption-row-content">
                  <span style={fontFamily ? { fontFamily: `"${fontFamily}", sans-serif` } : undefined}>{line.text}</span>
                  <small>{formatTime(line.start)} <i aria-hidden="true">→</i> {formatTime(line.end)}</small>
                </span>
              </button>
              {isSelected && <div className="caption-inline-editor">{editor}</div>}
            </div>
          )
        })}
        {filteredLines.length === 0 && (
          <p className="caption-search-empty">{lines.length ? 'No captions match your search.' : 'Generate subtitles to see captions here.'}</p>
        )}
      </div>
      <footer className="caption-list-footer">
        <span>{lines.length} {lines.length === 1 ? 'line' : 'lines'}</span>
        <button type="button" className="add-caption-button" onClick={onAddLine} disabled={disabled}>+ Add line</button>
      </footer>
    </section>
  )
}
