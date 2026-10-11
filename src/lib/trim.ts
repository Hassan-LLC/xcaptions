import type { SubtitleLine } from './chunker'

export const MIN_TRIM_SECONDS = 0.5

export function clampTrimRange(start: number, end: number, duration: number) {
  const safeDuration = Math.max(0, Number.isFinite(duration) ? duration : 0)
  if (safeDuration <= MIN_TRIM_SECONDS) return { start: 0, end: safeDuration }
  const safeStart = Math.max(0, Math.min(safeDuration - MIN_TRIM_SECONDS, Number.isFinite(start) ? start : 0))
  const safeEnd = Math.max(safeStart + MIN_TRIM_SECONDS, Math.min(safeDuration, Number.isFinite(end) ? end : safeDuration))
  return { start: safeStart, end: safeEnd }
}

export function parseTrimTime(value: string) {
  const match = value.trim().match(/^(?:(\d+):)?(\d{1,2})(?:\.(\d))?$/u)
  if (!match) return null
  const minutes = match[1] ? Number(match[1]) : 0
  const seconds = Number(match[2])
  if (seconds >= 60 || !Number.isFinite(minutes)) return null
  return minutes * 60 + seconds + Number(match[3] ?? 0) / 10
}

export function formatTrimTime(value: number) {
  const tenths = Math.max(0, Math.round(value * 10))
  const minutes = Math.floor(tenths / 600)
  const seconds = Math.floor(tenths / 10) % 60
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${tenths % 10}`
}

export function trimSubtitleLines(lines: SubtitleLine[], start: number, end: number) {
  return lines.flatMap((line) => {
    const clippedStart = Math.max(line.start, start)
    const clippedEnd = Math.min(line.end, end)
    if (!line.text.trim() || clippedEnd - clippedStart < 0.2) return []
    return [{
      ...line,
      start: clippedStart - start,
      end: clippedEnd - start,
      words: line.words.flatMap((word) => {
        const wordStart = Math.max(word.start, clippedStart)
        const wordEnd = Math.min(word.end, clippedEnd)
        if (wordEnd <= wordStart) return []
        return [{ ...word, start: wordStart - start, end: wordEnd - start }]
      }),
    }]
  })
}
