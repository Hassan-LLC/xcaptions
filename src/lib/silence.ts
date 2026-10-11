import type { SubtitleLine } from './chunker'

export type SilenceRange = {
  id: string
  start: number
  end: number
  selected: boolean
}

export type KeepRange = {
  start: number
  end: number
}

export type SilenceSettings = {
  minSilence: number
  /** dB loudness threshold; null means "auto" (noise floor based). */
  thresholdDb: number | null
  /** Padding kept around speech on both sides, in seconds. */
  padding: number
}

export const DEFAULT_SILENCE_SETTINGS: SilenceSettings = {
  minSilence: 0.5,
  thresholdDb: -40,
  padding: 0.1,
}

/** Kept ranges shorter than this are dropped (merged away) when applying cuts. */
export const MIN_KEEP_SECONDS = 0.15
const UNION_EPSILON = 0.05

function roundTime(value: number) {
  return Math.round(value * 100) / 100
}

function createId() {
  return typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
}

export function clampToTrim(ranges: { start: number; end: number }[], trimStart: number, trimEnd: number) {
  return ranges.flatMap((range) => {
    const start = Math.max(trimStart, range.start)
    const end = Math.min(trimEnd, range.end)
    return end > start ? [{ start, end }] : []
  })
}

/** Merge overlapping or near-adjacent ranges into a sorted, disjoint list. */
export function unionRanges(ranges: { start: number; end: number }[], epsilon = UNION_EPSILON) {
  const sorted = ranges
    .map((range) => ({ start: range.start, end: range.end }))
    .filter((range) => range.end - range.start > 0.001)
    .sort((a, b) => a.start - b.start)
  const merged: { start: number; end: number }[] = []
  for (const range of sorted) {
    const last = merged[merged.length - 1]
    if (last && range.start <= last.end + epsilon) {
      last.end = Math.max(last.end, range.end)
    } else {
      merged.push({ start: range.start, end: range.end })
    }
  }
  return merged
}

/**
 * The edit decision list: the kept source-time ranges inside the trim.
 * Trim is the outer range; silence cuts are removed ranges inside it.
 * Ranges shorter than MIN_KEEP_SECONDS are dropped so the timeline never
 * contains unusably short fragments.
 */
export function computeKeepRanges(
  trimRange: { start: number; end: number },
  removedRanges: { start: number; end: number }[],
): KeepRange[] {
  const cuts = unionRanges(clampToTrim(removedRanges, trimRange.start, trimRange.end))
  let ranges: KeepRange[] = [{ start: trimRange.start, end: trimRange.end }]
  for (const cut of cuts) {
    const next: KeepRange[] = []
    for (const range of ranges) {
      if (cut.end <= range.start || cut.start >= range.end) {
        next.push(range)
        continue
      }
      const before = { start: range.start, end: Math.max(range.start, cut.start) }
      const after = { start: Math.min(range.end, cut.end), end: range.end }
      if (before.end - before.start > 0.001) next.push(before)
      if (after.end - after.start > 0.001) next.push(after)
    }
    ranges = next
  }
  ranges = ranges
    .filter((range) => range.end - range.start >= MIN_KEEP_SECONDS)
    .sort((a, b) => a.start - b.start)
  const merged: KeepRange[] = []
  for (const range of ranges) {
    const last = merged[merged.length - 1]
    if (last && range.start - last.end < 0.01) last.end = Math.max(last.end, range.end)
    else merged.push({ ...range })
  }
  // Never produce an empty timeline: when every fragment is too short, keep the
  // whole trimmed range rather than cutting everything away.
  if (merged.length === 0) merged.push({ start: trimRange.start, end: trimRange.end })
  return merged
}

/** Total kept time on screen (edited timeline length). */
export function editedTotalDuration(keepRanges: KeepRange[]) {
  return keepRanges.reduce((total, range) => total + Math.max(0, range.end - range.start), 0)
}

/** Kept duration between the trim start and source time t (0 when t falls before the trim). */
export function keptBefore(t: number, keepRanges: KeepRange[], trimStart = 0) {
  if (t <= trimStart) return 0
  let total = 0
  for (const range of keepRanges) {
    if (range.start >= t) break
    total += Math.max(0, Math.min(t, range.end) - range.start)
  }
  return total
}

/** Removed duration between the trim start and source time t. */
export function removedBefore(t: number, keepRanges: KeepRange[], trimStart = 0) {
  if (t <= trimStart) return 0
  const kept = Math.max(0, keptBefore(t, keepRanges, trimStart))
  const removed = t - trimStart - kept
  return removed > 0 ? removed : 0
}

function mapWordTimes(
  words: { word: string; start: number; end: number }[] | undefined,
  mapTime: (time: number) => number,
) {
  if (!words) return undefined
  return words.flatMap((word) => {
    const start = mapTime(word.start)
    const end = mapTime(word.end)
    return end - start < 0.002 ? [] : [{ ...word, start, end }]
  })
}

/** Remap captions and word timings from source time onto the kept timeline. */
export function remapSubtitleLines(
  lines: SubtitleLine[],
  trimRange: { start: number; end: number },
  keepRanges: KeepRange[],
  applyTrim: boolean,
): SubtitleLine[] {
  const mapTime = (time: number) => applyTrim
    ? keptBefore(time, keepRanges, trimRange.start)
    : time - removedBefore(time, keepRanges, trimRange.start)
  return lines.flatMap((line) => {
    const start = applyTrim ? Math.max(line.start, trimRange.start) : line.start
    const end = applyTrim ? Math.min(line.end, trimRange.end) : line.end
    if (!line.text.trim() || end - start < 0.2) return []
    const mappedStart = mapTime(start)
    const mappedEnd = mapTime(end)
    if (mappedEnd - mappedStart < 0.05) return []
    return [{
      ...line,
      start: mappedStart,
      end: mappedEnd,
      words: mapWordTimes(line.words, mapTime) ?? [],
      originalWords: mapWordTimes(line.originalWords, mapTime),
      translatedWords: mapWordTimes(line.translatedWords, mapTime),
    }]
  })
}

/** Silences implied by gaps between word timestamps. */
export function detectWordGapSilences(
  words: { start: number; end: number }[],
  trimRange: { start: number; end: number },
  settings: SilenceSettings,
) {
  const inside = words
    .filter((word) => word.end > trimRange.start && word.start < trimRange.end)
    .sort((a, b) => a.start - b.start)
  const ranges: { start: number; end: number }[] = []
  for (let i = 1; i < inside.length; i++) {
    const previous = inside[i - 1]
    const next = inside[i]
    const gap = next.start - previous.end
    if (gap < settings.minSilence) continue
    const start = Math.max(trimRange.start, previous.end - settings.padding)
    const end = Math.min(trimRange.end, next.start + settings.padding)
    if (end - start >= settings.minSilence) ranges.push({ start, end })
  }
  return ranges
}

/** True silence from audio energy, measured in short RMS windows. */
export function analyzeAudioSilences(
  pcm: Float32Array,
  sampleRate: number,
  trimRange: { start: number; end: number },
  settings: SilenceSettings,
) {
  const windowSeconds = 0.03
  const hopSeconds = 0.02
  const windowFrames = Math.max(1, Math.round(sampleRate * windowSeconds))
  const hopFrames = Math.max(1, Math.round(sampleRate * hopSeconds))
  const levels: number[] = []
  const windowTimes: number[] = []
  for (let offset = 0; offset + windowFrames <= pcm.length; offset += hopFrames) {
    let sum = 0
    for (let i = offset; i < offset + windowFrames; i++) sum += pcm[i] * pcm[i]
    levels.push(20 * Math.log10(Math.sqrt(sum / windowFrames) + 1e-10))
    windowTimes.push(offset / sampleRate)
  }
  if (levels.length === 0) return { ranges: [] as { start: number; end: number }[], noiseFloorDb: null }

  const sorted = [...levels].sort((a, b) => a - b)
  const noiseFloorDb = sorted[Math.min(sorted.length - 1, Math.max(0, Math.round(sorted.length * 0.25)))]
  const thresholdDb = settings.thresholdDb ?? Math.max(noiseFloorDb + 6, -120)
  let quietStart: number | null = null
  let quietEnd = 0
  let lastQuietEnd = -1
  const segments: { start: number; end: number }[] = []
  for (let i = 0; i < levels.length; i++) {
    const windowStart = windowTimes[i]
    const windowEnd = windowStart + windowSeconds
    if (levels[i] < thresholdDb) {
      if (quietStart === null) quietStart = windowStart
      quietEnd = windowEnd
      lastQuietEnd = windowEnd
    } else if (quietStart !== null && windowStart - lastQuietEnd > 0.06) {
      segments.push({ start: quietStart, end: quietEnd })
      quietStart = null
    }
  }
  if (quietStart !== null) segments.push({ start: quietStart, end: quietEnd })

  const ranges = segments.flatMap((segment) => {
    const start = Math.max(trimRange.start, segment.start - settings.padding)
    const end = Math.min(trimRange.end, segment.end + settings.padding)
    return end - start >= settings.minSilence ? [{ start, end }] : []
  })
  return { ranges, noiseFloorDb }
}

/** First kept-range start at or after source time t. */
export function nextKeptTime(t: number, keepRanges: KeepRange[]) {
  for (const range of keepRanges) {
    if (range.end <= t + 0.001) continue
    return Math.max(t, range.start)
  }
  return null
}

/** Inverse of {@link keptBefore}: map edited (output) time back to source time. */
export function sourceTimeForEdited(editedTime: number, keepRanges: KeepRange[], trimStart = 0) {
  let remaining = editedTime
  for (const range of keepRanges) {
    const length = Math.max(0, range.end - range.start)
    if (remaining <= length) return range.start + remaining
    remaining -= length
  }
  const last = keepRanges[keepRanges.length - 1]
  return last ? last.end : trimStart
}

export type SilenceDetectionResult = {
  silences: SilenceRange[]
  noiseFloorDb: number | null
}

/** Combine word-gap and audio-energy silence candidates. */
export function detectSilences(
  lines: SubtitleLine[],
  pcm: Float32Array | undefined,
  sampleRate: number,
  trimRange: { start: number; end: number },
  settings: SilenceSettings,
): SilenceDetectionResult {
  const wordCandidates = detectWordGapSilences(lines.flatMap((line) => line.words ?? []), trimRange, settings)
  const audio = pcm && pcm.length > 0 && sampleRate >= 4000
    ? analyzeAudioSilences(pcm, sampleRate, trimRange, settings)
    : { ranges: [] as { start: number; end: number }[], noiseFloorDb: null }
  const silences = unionRanges([...wordCandidates, ...audio.ranges], 0.08).map((range) => ({
    id: createId(),
    start: roundTime(range.start),
    end: roundTime(range.end),
    selected: true,
  }))
  return { silences, noiseFloorDb: audio.noiseFloorDb }
}

export function formatSilenceTime(seconds: number) {
  const totalSeconds = Math.max(0, seconds)
  const minutes = Math.floor(totalSeconds / 60)
  const remaining = totalSeconds - minutes * 60
  return `${String(minutes).padStart(2, '0')}:${remaining.toFixed(1).padStart(4, '0')}`
}

/** True when source time t falls outside every kept range. */
export function timeIsRemoved(t: number, keepRanges: KeepRange[]) {
  return !keepRanges.some((range) => range.start <= t && t < range.end)
}
/** Decode the 16-bit PCM WAV produced by the extraction pipeline into mono floats. */
export async function decodeWavPcm(wav: Blob): Promise<{ pcm: Float32Array; sampleRate: number }> {
  const bytes = new Uint8Array(await wav.arrayBuffer())
  if (bytes.length < 44 || String.fromCharCode(...bytes.subarray(0, 4)) !== 'RIFF' || String.fromCharCode(...bytes.subarray(8, 12)) !== 'WAVE') {
    throw new Error('The extracted audio is not a valid WAV file.')
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let offset = 12
  let formatOffset = -1
  let formatSize = 0
  let dataOffset = -1
  let dataSize = 0
  while (offset + 8 <= bytes.length) {
    const chunkId = String.fromCharCode(...bytes.subarray(offset, offset + 4))
    const chunkSize = view.getUint32(offset + 4, true)
    const chunkStart = offset + 8
    if (chunkStart + chunkSize > bytes.length) break
    if (chunkId === 'fmt ') {
      formatOffset = chunkStart
      formatSize = chunkSize
    } else if (chunkId === 'data') {
      dataOffset = chunkStart
      dataSize = chunkSize
      break
    }
    offset = chunkStart + chunkSize + (chunkSize % 2)
  }
  if (formatOffset < 0 || formatSize < 16 || dataOffset < 0) {
    throw new Error('The extracted WAV is missing its audio format or sample data.')
  }
  const audioFormat = view.getUint16(formatOffset, true)
  const channels = view.getUint16(formatOffset + 2, true)
  const sampleRate = view.getUint32(formatOffset + 4, true)
  const bitsPerSample = view.getUint16(formatOffset + 14, true)
  if (audioFormat !== 1 || channels < 1 || sampleRate < 1 || (bitsPerSample !== 16 && bitsPerSample !== 8 && bitsPerSample !== 32)) {
    throw new Error('The silence detector could not read the extracted audio format.')
  }
  const bytesPerSample = Math.max(1, bitsPerSample / 8)
  const totalFrames = Math.floor(Math.min(dataSize, bytes.length - dataOffset) / (channels * bytesPerSample))
  const pcm = new Float32Array(totalFrames)
  for (let frame = 0; frame < totalFrames; frame++) {
    let sum = 0
    for (let channel = 0; channel < channels; channel++) {
      const valueOffset = dataOffset + frame * channels * bytesPerSample + channel * bytesPerSample
      if (bitsPerSample === 16) {
        sum += view.getInt16(valueOffset, true) / 0x8000
      } else if (bitsPerSample === 8) {
        sum += (bytes[valueOffset] - 128) / 0x80
      } else {
        sum += view.getFloat32(valueOffset, true)
      }
    }
    pcm[frame] = sum / channels
  }
  return { pcm, sampleRate }
}