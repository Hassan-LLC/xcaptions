import type { ExportResolution } from './exporter'

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value))
}

export type AspectRatioId = 'original' | '9:16' | '1:1' | '4:5' | '16:9'
export type FitMode = 'blur' | 'fill' | 'color'

export type ReframeState = {
  ratio: AspectRatioId
  fit: FitMode
  focusX: number
  focusY: number
  zoom: number
  backgroundColor: string
  socialSafeArea: boolean
}

export type AspectRatioOption = {
  id: AspectRatioId
  label: string
  ratio: number | null
  hint: string
}

export type FitModeOption = {
  id: FitMode
  label: string
  hint: string
}

export const aspectRatioOptions: AspectRatioOption[] = [
  { id: 'original', label: 'Original', ratio: null, hint: 'Source shape' },
  { id: '9:16', label: '9:16', ratio: 9 / 16, hint: 'Reels · TikTok · Shorts' },
  { id: '1:1', label: '1:1', ratio: 1, hint: 'Square' },
  { id: '4:5', label: '4:5', ratio: 4 / 5, hint: 'Feed post' },
  { id: '16:9', label: '16:9', ratio: 16 / 9, hint: 'Landscape' },
]

export const fitModeOptions: FitModeOption[] = [
  { id: 'blur', label: 'Fit + blur', hint: 'Blurred backdrop' },
  { id: 'fill', label: 'Fill (crop)', hint: 'Covers the frame' },
  { id: 'color', label: 'Fit + color', hint: 'Solid backdrop' },
]

export const defaultReframe: ReframeState = {
  ratio: 'original',
  fit: 'blur',
  focusX: 0.5,
  focusY: 0.5,
  zoom: 1,
  backgroundColor: '#0c0e0c',
  socialSafeArea: false,
}

export function clampReframe(next: ReframeState): ReframeState {
  return {
    ratio: aspectRatioOptions.some((option) => option.id === next.ratio) ? next.ratio : 'original',
    fit: fitModeOptions.some((option) => option.id === next.fit) ? next.fit : 'blur',
    focusX: clamp(next.focusX, 0, 1),
    focusY: clamp(next.focusY, 0, 1),
    zoom: clamp(next.zoom, 1, 3),
    backgroundColor: /^#[\da-f]{3,8}$/iu.test(next.backgroundColor) ? next.backgroundColor : defaultReframe.backgroundColor,
    socialSafeArea: Boolean(next.socialSafeArea),
  }
}

export function ratioValue(ratio: AspectRatioId, videoWidth: number, videoHeight: number) {
  if (ratio === 'original') {
    if (videoWidth < 1 || videoHeight < 1) return 16 / 9
    return videoWidth / videoHeight
  }
  return aspectRatioOptions.find((option) => option.id === ratio)?.ratio ?? 16 / 9
}

/**
 * True when moving from one frame shape to another changes the framing enough
 * that a crop would be disorienting, so we fall back to the Fit + blur look.
 */
export function changesFramingDrastic(fromAspect: number, toAspect: number) {
  const fromLandscape = fromAspect >= 1.15
  const toLandscape = toAspect >= 1.15
  const fromPortrait = fromAspect <= 0.87
  const toPortrait = toAspect <= 0.87
  return (fromLandscape && toPortrait) || (fromPortrait && toLandscape) || Math.abs(fromAspect - toAspect) > 0.6
}

const resolutionShortSide: Record<ExportResolution, number | null> = {
  '480p': 480,
  '720p': 720,
  '1080p': 1080,
  original: null,
}

function evenDimension(value: number) {
  return Math.max(2, Math.round(value / 2) * 2)
}

/**
 * Real output dimensions for the chosen aspect ratio and export resolution.
 * The frame's short side targets 480/720/1080 but never exceeds the source's
 * short side, so a small clip is never upscaled to a fake resolution.
 */
export function outputDimensions(
  videoWidth: number,
  videoHeight: number,
  resolution: ExportResolution,
  ratio: AspectRatioId = 'original',
) {
  if (videoWidth < 1 || videoHeight < 1) throw new Error('The video has no exportable frame dimensions.')
  const aspect = ratioValue(ratio, videoWidth, videoHeight)
  const requestedShortSide = resolutionShortSide[resolution]
  const sourceShortSide = Math.min(videoWidth, videoHeight)
  const shortSide = requestedShortSide === null ? sourceShortSide : Math.min(requestedShortSide, sourceShortSide)
  let width: number
  let height: number
  if (Math.abs(aspect - 1) <= 0.01) {
    width = shortSide
    height = shortSide
  } else if (aspect > 1) {
    height = shortSide
    width = shortSide * aspect
  } else {
    width = shortSide
    height = shortSide / aspect
  }
  return {
    width: evenDimension(width),
    height: evenDimension(height),
  }
}

export function formatOutputSize(width: number | null, height: number | null) {
  return width && height ? `${width} × ${height}` : '—'
}
