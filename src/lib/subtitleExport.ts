import type { SubtitleLine } from './chunker'

export type TextExportFormat = 'paragraphs' | 'timestamps'

function timestamp(seconds: number, decimalSeparator: ',' | '.') {
  const milliseconds = Math.max(0, Math.round(seconds * 1000))
  const hours = Math.floor(milliseconds / 3_600_000)
  const minutes = Math.floor(milliseconds / 60_000) % 60
  const wholeSeconds = Math.floor(milliseconds / 1000) % 60
  const remainder = milliseconds % 1000
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(wholeSeconds).padStart(2, '0')}${decimalSeparator}${String(remainder).padStart(3, '0')}`
}

function usableLines(lines: SubtitleLine[]) {
  return lines
    .filter((line) => line.text.trim())
    .map((line) => ({
      ...line,
      start: Math.max(0, line.start),
      end: Math.max(Math.max(0, line.start), line.end),
      text: line.text.trim(),
    }))
}

export function createSrt(lines: SubtitleLine[]) {
  const body = usableLines(lines).map((line, index) =>
    `${index + 1}\r\n${timestamp(line.start, ',')} --> ${timestamp(line.end, ',')}\r\n${line.text}`,
  ).join('\r\n\r\n')
  return `\uFEFF${body}${body ? '\r\n' : ''}`
}

export function createTxtNotes(lines: SubtitleLine[], format: TextExportFormat = 'paragraphs') {
  const selectedLines = usableLines(lines)
  if (format === 'timestamps') {
    return selectedLines.map((line) => `[${timestamp(line.start, '.').slice(0, 5)}] ${line.text}`).join('\r\n')
  }
  const paragraphs: string[] = []
  let paragraph = ''
  for (const line of selectedLines) {
    paragraph = paragraph ? `${paragraph} ${line.text}` : line.text
    if (/[.!?؟۔…]["')\]]*$/u.test(line.text)) {
      paragraphs.push(paragraph)
      paragraph = ''
    }
  }
  if (paragraph) paragraphs.push(paragraph)
  return paragraphs.join('\r\n\r\n')
}

export function createVtt(lines: SubtitleLine[]) {
  const body = usableLines(lines).map((line) =>
    `${timestamp(line.start, '.')} --> ${timestamp(line.end, '.')}\r\n${line.text}`,
  ).join('\r\n\r\n')
  return `WEBVTT\r\n\r\n${body}${body ? '\r\n' : ''}`
}

export function createDownloadName(videoName: string | undefined, extension: 'srt' | 'txt' | 'vtt' | 'wav' | 'mp4' | 'webm') {
  const sourceName = videoName?.replace(/\.[^.]+$/u, '') ?? 'subtitles'
  const safeName = sourceName
    .normalize('NFKC')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/gu, '_')
    .replace(/[. ]+$/u, '')
    .trim() || 'subtitles'
  return `${safeName}.${extension}`
}

export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.style.display = 'none'
  document.body.append(anchor)
  anchor.click()
  anchor.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000)
}
