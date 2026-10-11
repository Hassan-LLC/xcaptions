import type { Word } from './chunker'
import { defaultReframe, type ReframeState } from './reframe'
import type { SubtitleStyleOverrides, SubtitleTemplate } from '../templates/types'

const fontLoads = new Map<string, Promise<void>>()
const loadedFonts = new Set<string>()
const gradientCache = new WeakMap<CanvasRenderingContext2D, Map<string, CanvasGradient>>()
const previewCaption = 'Your words, in motion'
const safeWidthRatio = 0.9
const minFontSize = 12

type RenderWord = Word & { display: string }

function fontKey(font: string, weight: number) {
  return `${weight} "${font}"`
}

export function subtitleFontWeight(font: string) {
  if (font === 'Montserrat') return 800
  if (font === 'Poppins') return 700
  if (font === 'Rubik') return 800
  return 400
}

export function loadTemplateFont(template: SubtitleTemplate) {
  return loadSubtitleFont(template.font, subtitleFontWeight(template.font), template.rtl)
}

export function loadSubtitleFont(font: string, weight: number, rtl = false) {
  const key = fontKey(font, weight)
  const existing = fontLoads.get(key)
  if (existing) return existing
  const sample = rtl ? 'اردو العربية' : font === 'Noto Sans Devanagari' ? 'हिन्दी' : 'SubtitleStudio'
  const loading = Promise.all([
    document.fonts.load(`${weight} 48px "${font}"`, sample),
    document.fonts.ready,
  ]).then(() => {
    if (!document.fonts.check(`${weight} 48px "${font}"`, sample)) {
      throw new Error(`The ${font} subtitle font did not become available.`)
    }
    loadedFonts.add(key)
  }).catch((error: unknown) => {
    fontLoads.delete(key)
    throw error
  })
  fontLoads.set(key, loading)
  return loading
}

export function hasSubtitleFont(font: string, weight: number) {
  return loadedFonts.has(fontKey(font, weight))
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value))
}

function easeOutCubic(progress: number) {
  return 1 - Math.pow(1 - progress, 3)
}

function easeOutBack(progress: number) {
  const c1 = 1.70158
  const c3 = c1 + 1
  return 1 + c3 * Math.pow(progress - 1, 3) + c1 * Math.pow(progress - 1, 2)
}

function spring(progress: number) {
  return 1 - Math.exp(-7 * progress) * Math.cos(10 * progress)
}

function animationProgress(animation: SubtitleTemplate['animation'], elapsed: number) {
  const progress = clamp(elapsed / 0.42, 0, 1)
  if (animation === 'pop' || animation === 'zoomIn') return easeOutBack(progress)
  if (animation === 'bounce') return spring(progress)
  return easeOutCubic(progress)
}

function wordsForText(text: string, words: Word[], startTime: number, endTime: number): RenderWord[] {
  const parts = text.trim().split(/\s+/u).filter(Boolean)
  if (!parts.length) return []
  const duration = Math.max(0.01, endTime - startTime)
  return parts.map((display, index) => {
    const existing = words[index]
    const start = existing?.start ?? startTime + duration * index / parts.length
    const end = existing?.end ?? startTime + duration * (index + 1) / parts.length
    return { word: existing?.word ?? display, display, start, end }
  })
}

function textWidth(context: CanvasRenderingContext2D, word: string, letterSpacing: number) {
  return context.measureText(word).width + Math.max(0, Array.from(word).length - 1) * letterSpacing
}

function wrapWords(context: CanvasRenderingContext2D, words: RenderWord[], limit: number, wordsPerLine: number, letterSpacing: number) {
  const result: RenderWord[][] = []
  let line: RenderWord[] = []
  let lineWidth = 0
  const spaceWidth = context.measureText(' ').width + letterSpacing
  for (const word of words) {
    const width = textWidth(context, word.display, letterSpacing)
    const candidateWidth = lineWidth + (line.length ? spaceWidth : 0) + width
    if (line.length && (line.length >= wordsPerLine || candidateWidth > limit)) {
      result.push(line)
      line = []
      lineWidth = 0
    }
    lineWidth += (line.length ? spaceWidth : 0) + width
    line.push(word)
  }
  if (line.length) result.push(line)
  return result
}

function getGradient(context: CanvasRenderingContext2D, colors: string[], x: number, y: number, width: number, height: number) {
  let cache = gradientCache.get(context)
  if (!cache) {
    cache = new Map()
    gradientCache.set(context, cache)
  }
  const key = `${colors.join('|')}:${x}:${y}:${width}:${height}`
  const cached = cache.get(key)
  if (cached) return cached
  const gradient = context.createLinearGradient(x, y, x + width, y + height)
  colors.forEach((color, index) => gradient.addColorStop(index / Math.max(1, colors.length - 1), color))
  if (cache.size >= 128) cache.clear()
  cache.set(key, gradient)
  return gradient
}

function roundedRect(context: CanvasRenderingContext2D, x: number, y: number, width: number, height: number, radius: number) {
  context.beginPath()
  context.roundRect(x, y, width, height, radius)
}

function visibleWord(word: RenderWord, time: number, animation: SubtitleTemplate['animation'], rtl: boolean) {
  if (animation === 'wordByWord') {
    const progress = clamp((time - word.start) / 0.2, 0, 1)
    return { visible: progress > 0, progress, scale: 0.7 + easeOutBack(progress) * 0.3 }
  }
  if (animation === 'typewriter') {
    if (time < word.start) return { visible: false, progress: 0, scale: 1 }
    if (rtl || /[\u0600-\u08ff\ufb50-\ufdff\ufe70-\ufeff]/u.test(word.display)) {
      return { visible: true, progress: 1, scale: 1 }
    }
    const progress = clamp((time - word.start) / Math.max(0.12, Math.min(0.45, word.end - word.start)), 0, 1)
    const chars = Array.from(word.display)
    return {
      visible: progress > 0,
      progress,
      scale: 1,
      display: chars.slice(0, Math.max(1, Math.ceil(chars.length * progress))).join(''),
    }
  }
  return { visible: true, progress: 1, scale: 1 }
}

type CaptionLayout = {
  wrapped: RenderWord[][]
  actualFontSize: number
  actualLetterSpacing: number
  lineWidths: number[]
  totalHeight: number
  lineHeight: number
  centerX: number
  centerY: number
  background: { color: string; radius: number; padding: number; highlightActiveWord: boolean } | null
  fillGradient: CanvasGradient | null
}

// Text layout is expensive (many measureText calls) and identical for every frame
// a caption stays on screen, so cache it per context keyed by the resolved text
// and style. Word timings are part of the key so two lines with the same words at
// different times never share a stale layout.
const captionLayoutCache = new WeakMap<CanvasRenderingContext2D, Map<string, CaptionLayout>>()

function computeCaptionLayout(
  context: CanvasRenderingContext2D,
  template: SubtitleTemplate,
  overrides: SubtitleStyleOverrides,
  words: RenderWord[],
  font: string,
  fontWeight: number,
): CaptionLayout {
  const { width, height } = context.canvas
  const portrait = height > width * 1.02
  const safeInsets = portrait
    ? { side: 0.07, top: 0.10, bottom: 0.14 }
    : { side: 0.05, top: 0.06, bottom: 0.06 }
  const safeWidth = width * (portrait ? 0.86 : safeWidthRatio)

  const fontSize = Math.max(minFontSize, (portrait ? width : height) * (overrides.size ?? template.size))
  const letterSpacing = template.rtl ? 0 : (overrides.letterSpacing ?? template.letterSpacing) * fontSize
  const requestedWordsPerLine = overrides.wordsPerLine ?? template.wordsPerLine
  const wordsPerLine = clamp(Math.round(overrides.wordsPerLine !== undefined
    ? requestedWordsPerLine
    : portrait ? Math.min(requestedWordsPerLine, 2) : requestedWordsPerLine), 1, 5)
  const lineHeight = clamp(overrides.lineHeight ?? template.lineHeight, 0.8, 1.8)
  const background = overrides.backgroundEnabled === false
    ? null
    : template.background
      ? { ...template.background, color: overrides.backgroundColor ?? template.background.color }
      : overrides.backgroundEnabled
        ? { color: overrides.backgroundColor ?? 'rgba(12,14,12,.8)', radius: 0.16, padding: 0.24, highlightActiveWord: false }
        : null
  const backgroundPadding = background?.padding ?? 0
  const horizontalVisualPadding = backgroundPadding +
    (template.outerStroke?.width ?? 0) / 2 +
    (overrides.strokeWidth ?? template.stroke.width) / 2 +
    template.shadow.blur * 1.4
  const verticalVisualPadding = backgroundPadding * 0.45 +
    (template.outerStroke?.width ?? 0) / 2 +
    (overrides.strokeWidth ?? template.stroke.width) / 2 +
    template.shadow.blur * 1.4 +
    Math.abs(template.shadow.offsetY)

  context.save()
  context.font = `${fontWeight} ${fontSize}px "${font}"`
  if ('letterSpacing' in context) context.letterSpacing = `${letterSpacing}px`
  let wrapped = wrapWords(context, words, safeWidth, wordsPerLine, letterSpacing)
  const maxTextHeight = height * 0.32
  const maxLines = Math.max(1, Math.floor(maxTextHeight / (fontSize * lineHeight)))
  if (wrapped.length > maxLines) {
    wrapped = wrapped.slice(0, maxLines)
    const lastLine = wrapped[maxLines - 1]
    const lastWord = lastLine[lastLine.length - 1]
    lastLine[lastLine.length - 1] = { ...lastWord, display: `${lastWord.display}…` }
  }
  const maxLineWidth = Math.max(1, ...wrapped.map(line =>
    line.reduce((sum, word) => sum + textWidth(context, word.display, letterSpacing), 0) +
      Math.max(0, line.length - 1) * (context.measureText(' ').width + letterSpacing),
  ))
  const scale = Math.min(
    1,
    safeWidth / (maxLineWidth + fontSize * horizontalVisualPadding * 2),
    maxTextHeight / (fontSize * ((wrapped.length - 1) * lineHeight + 1.16 + verticalVisualPadding * 2)),
  )
  const actualFontSize = Math.max(1, fontSize * scale)
  context.font = `${fontWeight} ${actualFontSize}px "${font}"`
  const actualLetterSpacing = letterSpacing * actualFontSize / fontSize
  if ('letterSpacing' in context) context.letterSpacing = `${actualLetterSpacing}px`
  const lineWidths = wrapped.map(line =>
    line.reduce((sum, word) => sum + textWidth(context, word.display, actualLetterSpacing), 0) +
      Math.max(0, line.length - 1) * (context.measureText(' ').width + actualLetterSpacing),
  )
  const totalHeight = wrapped.length * actualFontSize * lineHeight
  const xOffset = clamp(overrides.positionX ?? 0, -0.45, 0.45) * width
  const contentWidth = Math.max(...lineWidths) + actualFontSize * horizontalVisualPadding * 2
  const halfContentWidth = Math.max(width * safeInsets.side, contentWidth / 2)
  const minCenterX = Math.min(halfContentWidth, width / 2)
  const centerX = clamp(width / 2 + xOffset, minCenterX, width - minCenterX)
  const desiredY = height * clamp(overrides.positionY ?? 0.82, 0.08, 0.92)
  const contentHeight = actualFontSize * ((wrapped.length - 1) * lineHeight + 1.16 + verticalVisualPadding * 2)
  const minCenterY = contentHeight / 2 + height * safeInsets.top
  const maxCenterY = height - contentHeight / 2 - height * safeInsets.bottom
  const centerY = minCenterY <= maxCenterY ? clamp(desiredY, minCenterY, maxCenterY) : height / 2
  const fillGradient = template.gradient ? getGradient(context, template.gradient, 0, 0, width, height) : null
  context.restore()
  return { wrapped, actualFontSize, actualLetterSpacing, lineWidths, totalHeight, lineHeight, centerX, centerY, background, fillGradient }
}

// --- color interpolation -----------------------------------------------------

let colorScratchCanvas: HTMLCanvasElement | null = null
const colorCache = new Map<string, [number, number, number, number]>()

function colorScratch() {
  if (!colorScratchCanvas && typeof document !== 'undefined') {
    colorScratchCanvas = document.createElement('canvas')
    colorScratchCanvas.width = 1
    colorScratchCanvas.height = 1
  }
  return colorScratchCanvas
}

function parseColor(color: string): [number, number, number, number] {
  const cached = colorCache.get(color)
  if (cached) return cached
  let rgba: [number, number, number, number] = [255, 255, 255, 1]
  const context = colorScratch()?.getContext('2d')
  if (context) {
    try {
      context.clearRect(0, 0, 1, 1)
      context.fillStyle = '#000000'
      context.fillStyle = color
      const normalized = String(context.fillStyle)
      const match = /rgba?\(([^)]+)\)/iu.exec(normalized)
      if (match) {
        const parts = match[1].split(',').map((value) => value.trim())
        const r = Number.parseFloat(parts[0])
        const g = Number.parseFloat(parts[1])
        const b = Number.parseFloat(parts[2])
        const a = parts[3] !== undefined ? Number.parseFloat(parts[3]) : 1
        if (Number.isFinite(r) && Number.isFinite(g) && Number.isFinite(b) && Number.isFinite(a)) {
          rgba = [r, g, b, a]
        }
      }
    } catch { /* ignore */ }
  }
  if (colorCache.size >= 256) colorCache.clear()
  colorCache.set(color, rgba)
  return rgba
}

function interpolateColor(from: string, to: string, t: number) {
  if (t <= 0) return from
  if (t >= 1) return to
  const a = parseColor(from)
  const b = parseColor(to)
  const r = Math.round(a[0] + (b[0] - a[0]) * t)
  const g = Math.round(a[1] + (b[1] - a[1]) * t)
  const bl = Math.round(a[2] + (b[2] - a[2]) * t)
  const alpha = a[3] + (b[3] - a[3]) * t
  return `rgba(${r}, ${g}, ${bl}, ${alpha})`
}

type QualityContext = CanvasRenderingContext2D & { textRendering?: string; fontKerning?: string }

function applyTextQuality(context: CanvasRenderingContext2D) {
  context.lineJoin = 'round'
  context.miterLimit = 2
  context.lineCap = 'round'
  const quality = context as QualityContext
  if ('textRendering' in quality) quality.textRendering = 'geometricPrecision'
  if ('fontKerning' in quality) quality.fontKerning = 'normal'
}

export function renderCaption(
  context: CanvasRenderingContext2D,
  template: SubtitleTemplate,
  time: number,
  text: string,
  overrides: SubtitleStyleOverrides = {},
  sourceWords: Word[] = [],
) {
  const { width, height } = context.canvas
  if (width < 1 || height < 1 || !text.trim()) return
  const font = overrides.font ?? template.font
  const fontWeight = subtitleFontWeight(font)
  if (!loadedFonts.has(fontKey(font, fontWeight))) return
  const rtl = template.rtl
  const label = overrides.uppercase ?? template.uppercase ? text.toLocaleUpperCase() : text
  const startTime = sourceWords[0]?.start ?? 0
  const endTime = sourceWords[sourceWords.length - 1]?.end ?? Math.max(2.5, time + 0.01)
  const words = wordsForText(label, sourceWords, startTime, endTime)
  if (!words.length) return

  let cache = captionLayoutCache.get(context)
  if (!cache) {
    cache = new Map()
    captionLayoutCache.set(context, cache)
  }
  const cacheKey = `${width}|${height}|${fontWeight}|${font}|${rtl ? 1 : 0}|${label}|${JSON.stringify(overrides)}|${JSON.stringify(template)}|${words.map((word) => `${word.display}:${word.start}:${word.end}`).join(',')}`
  let layout = cache.get(cacheKey)
  if (!layout) {
    layout = computeCaptionLayout(context, template, overrides, words, font, fontWeight)
    if (cache.size >= 128) cache.clear()
    cache.set(cacheKey, layout)
  }

  const animation = overrides.animation ?? template.animation
  const elapsed = Math.max(0, time - startTime)
  const progress = animationProgress(animation, elapsed)
  // Group scale is applied to the font size (glyphs are re-rasterised sharply at
  // every size) rather than via ctx.scale, so pop/zoom/bounce never blur text.
  let groupScale = 1
  if (animation === 'pop') groupScale = 0.76 + progress * 0.24
  if (animation === 'bounce') groupScale = 0.9 + Math.sin(Math.min(1, elapsed / 0.42) * Math.PI * 2) * 0.1 * (1 - Math.min(1, elapsed / 0.42))
  if (animation === 'zoomIn') groupScale = 0.65 + progress * 0.35
  let yOffset = 0
  if (animation === 'slideUp') yOffset = (1 - easeOutCubic(clamp(elapsed / 0.38, 0, 1))) * layout.actualFontSize * 0.8
  // Eased fade in/out (about 150 ms in, 100 ms out) so captions never pop harshly.
  const fadeIn = easeOutCubic(clamp(elapsed / 0.15, 0, 1))
  const fadeOut = easeOutCubic(clamp((endTime - time) / 0.1, 0, 1))
  const alpha = fadeIn * fadeOut

  const shadowEnabled = overrides.shadowEnabled ?? true
  const textColor = overrides.color ?? template.color
  const highlightColor = overrides.highlight ?? template.highlight
  const strokeColor = overrides.strokeColor ?? template.stroke.color

  const s = groupScale
  const fs = layout.actualFontSize * s
  const ls = layout.actualLetterSpacing * s
  const strokeWidth = Math.max(0, overrides.strokeWidth ?? template.stroke.width) * fs
  const outerStrokeWidth = (template.outerStroke?.width ?? 0) * fs
  const baseY = layout.centerY + yOffset - layout.totalHeight * s / 2 + fs * layout.lineHeight / 2
  const fillGradient = layout.fillGradient

  context.save()
  applyTextQuality(context)
  context.font = `${fontWeight} ${fs}px "${font}"`
  context.direction = rtl ? 'rtl' : 'ltr'
  context.textBaseline = 'middle'
  context.textAlign = 'center'
  if ('letterSpacing' in context) context.letterSpacing = `${ls}px`
  context.globalAlpha = alpha
  if (animation === 'shake') {
    const shakeProgress = clamp(elapsed / 0.5, 0, 1)
    context.translate(Math.sin(elapsed * 48) * (1 - shakeProgress) * layout.actualFontSize * 0.12, 0)
  }

  const { wrapped, lineWidths, centerX, background, lineHeight } = layout
  wrapped.forEach((line, lineIndex) => {
    const y = baseY + lineIndex * fs * lineHeight
    const lineWidth = lineWidths[lineIndex] * s
    const bounds = line.map(word => ({
      word,
      width: textWidth(context, word.display, ls),
      active: time >= word.start && time <= word.end,
    }))
    const visible = bounds.filter(item => visibleWord(item.word, time, animation, rtl).visible)
    if (!visible.length) return
    const backgroundPad = (background?.padding ?? 0) * fs
    if (background) {
      context.save()
      context.shadowColor = 'rgba(0,0,0,0.35)'
      context.shadowBlur = fs * 0.08
      context.shadowOffsetY = fs * 0.03
      context.fillStyle = background.color
      roundedRect(
        context,
        centerX - lineWidth / 2 - backgroundPad,
        y - fs * 0.58 - backgroundPad * 0.45,
        lineWidth + backgroundPad * 2,
        fs * 1.16 + backgroundPad * 0.9,
        background.radius * fs,
      )
      context.fill()
      context.restore()
    }
    let cursor = rtl ? centerX + lineWidth / 2 : centerX - lineWidth / 2
    const wordMetrics = visible.map(item => ({ ...item, anim: visibleWord(item.word, time, animation, rtl) }))
    const spaceWidth = context.measureText(' ').width + ls
    let previousBox: { x: number; width: number } | null = null
    for (const item of wordMetrics) {
      const wordScale = item.anim.scale * (animation === 'karaoke' && item.active ? 1.07 : 1)
      const wfs = fs * wordScale
      const wls = ls * wordScale
      const wordWidth = item.width
      const wordCenter = rtl ? cursor - wordWidth / 2 : cursor + wordWidth / 2
      const labelText = item.anim.display ?? item.word.display
      context.font = `${fontWeight} ${wfs}px "${font}"`
      if ('letterSpacing' in context) context.letterSpacing = `${wls}px`
      const displayedWidth = textWidth(context, labelText, wls)
      const hasHighlight = item.active && (template.wordHighlight || animation === 'karaoke')
      const wordPad = backgroundPad * wordScale
      const wordBox = {
        x: wordCenter - displayedWidth / 2 - wordPad,
        y: y - wfs * 0.58 - wordPad * 0.45,
        width: displayedWidth + wordPad * 2,
        height: wfs * 1.16 + wordPad * 0.9,
      }
      if (background?.highlightActiveWord && hasHighlight) {
        context.save()
        let boxX = wordBox.x
        let boxWidth = wordBox.width
        if (previousBox) {
          const glide = easeOutCubic(clamp((time - item.word.start) / 0.15, 0, 1))
          boxX = previousBox.x + (wordBox.x - previousBox.x) * glide
          boxWidth = previousBox.width + (wordBox.width - previousBox.width) * glide
        }
        context.shadowColor = 'rgba(0,0,0,0.28)'
        context.shadowBlur = wfs * 0.06
        context.shadowOffsetY = wfs * 0.02
        context.fillStyle = highlightColor
        roundedRect(context, boxX, wordBox.y, boxWidth, wordBox.height, background.radius * wfs)
        context.fill()
        context.restore()
      }

      // Soft outer shadow: two low-intensity layers instead of one heavy blur.
      if (shadowEnabled) {
        context.save()
        context.shadowColor = template.shadow.color
        context.fillStyle = template.shadow.color
        context.shadowBlur = wfs * template.shadow.blur
        context.shadowOffsetY = wfs * template.shadow.offsetY
        context.globalAlpha = alpha * 0.55
        context.fillText(labelText, wordCenter, y)
        context.shadowBlur = wfs * template.shadow.blur * 1.5
        context.shadowOffsetY = wfs * template.shadow.offsetY * 1.7
        context.globalAlpha = alpha * 0.35
        context.fillText(labelText, wordCenter, y)
        context.restore()
      }

      context.shadowColor = 'transparent'
      context.shadowBlur = 0
      context.shadowOffsetY = 0
      context.globalAlpha = alpha
      // Thick outer stroke (sticker / 3D), then inner stroke, then fill.
      if (template.outerStroke) {
        context.lineWidth = outerStrokeWidth * wordScale
        context.strokeStyle = template.outerStroke.color
        context.strokeText(labelText, wordCenter, y)
      }
      if (strokeWidth > 0) {
        context.lineWidth = strokeWidth * wordScale
        context.strokeStyle = strokeColor
        context.strokeText(labelText, wordCenter, y)
      }
      const gradient = template.gradient
      let fillStyle: string | CanvasGradient = gradient ? fillGradient ?? textColor : textColor
      if (hasHighlight) {
        const t = easeOutCubic(clamp(Math.min(time - item.word.start, item.word.end - time) / 0.12, 0, 1))
        fillStyle = interpolateColor(textColor, highlightColor, t)
      }
      context.fillStyle = fillStyle
      if (animation === 'glowPulse') {
        context.shadowColor = template.glow ?? highlightColor
        context.shadowBlur = wfs * (0.1 + 0.12 * (0.5 + 0.5 * Math.sin(time * 5)))
        context.shadowOffsetY = 0
      }
      context.globalAlpha = alpha * (item.anim.progress < 1 ? item.anim.progress : 1)
      context.fillText(labelText, wordCenter, y)
      previousBox = { x: wordBox.x, width: wordBox.width }
      cursor += (rtl ? -1 : 1) * (wordWidth + spaceWidth)
    }
  })
  context.restore()
}

const blurScratchCache = new Map<string, { canvas: HTMLCanvasElement; context: CanvasRenderingContext2D }>()

function supportsCanvasFilter(context: CanvasRenderingContext2D) {
  // Safari does not implement ctx.filter; probing keeps the downscale fallback in charge there.
  if (typeof context.filter !== 'string') return false
  const previous = context.filter
  context.filter = 'blur(2px)'
  const supported = context.filter === 'blur(2px)'
  context.filter = previous
  return supported
}

function getBlurScratch(width: number, height: number) {
  const key = `${width}x${height}`
  const existing = blurScratchCache.get(key)
  if (existing) return existing
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(width / 16))
  canvas.height = Math.max(1, Math.round(height / 16))
  const context = canvas.getContext('2d')
  if (!context) return null
  if (blurScratchCache.size >= 4) {
    const oldest = blurScratchCache.keys().next().value
    if (oldest !== undefined) blurScratchCache.delete(oldest)
  }
  const scratch = { canvas, context }
  blurScratchCache.set(key, scratch)
  return scratch
}

/** Draws a blurred, zoomed copy of the frame to fill the empty area behind a fitted video. */
function drawBlurBackdrop(context: CanvasRenderingContext2D, video: HTMLVideoElement, width: number, height: number) {
  const frameWidth = video.videoWidth
  const frameHeight = video.videoHeight
  const floorColor = '#0b0c09'
  context.fillStyle = floorColor
  context.fillRect(0, 0, width, height)
  const scratch = getBlurScratch(width, height)
  const coverScale = Math.max(width / frameWidth, height / frameHeight) * 1.12
  if (!scratch) {
    // No offscreen context available: cover with a sharp over-scaled copy so no gap shows.
    const drawWidth = frameWidth * coverScale
    const drawHeight = frameHeight * coverScale
    context.drawImage(video, (width - drawWidth) / 2, (height - drawHeight) / 2, drawWidth, drawHeight)
    return
  }
  const { canvas: scratchCanvas, context: scratchContext } = scratch
  const scratchWidth = scratchCanvas.width
  const scratchHeight = scratchCanvas.height
  scratchContext.setTransform(1, 0, 0, 1, 0, 0)
  scratchContext.clearRect(0, 0, scratchWidth, scratchHeight)
  scratchContext.imageSmoothingEnabled = true
  scratchContext.imageSmoothingQuality = 'low'
  const smallDrawWidth = frameWidth * coverScale
  const smallDrawHeight = frameHeight * coverScale
  scratchContext.drawImage(video, (scratchWidth - smallDrawWidth) / 2, (scratchHeight - smallDrawHeight) / 2, smallDrawWidth, smallDrawHeight)

  context.save()
  const blur = supportsCanvasFilter(context) ? Math.max(2, Math.round(height * 0.02)) : 0
  if (blur) context.filter = `blur(${blur}px)`
  context.imageSmoothingEnabled = true
  context.imageSmoothingQuality = 'high'
  const overscan = blur * 2
  context.drawImage(scratchCanvas, 0, 0, scratchWidth, scratchHeight, -overscan, -overscan, width + overscan * 2, height + overscan * 2)
  context.restore()
  context.fillStyle = 'rgba(0,0,0,0.22)'
  context.fillRect(0, 0, width, height)
}

function drawReframedVideo(context: CanvasRenderingContext2D, video: HTMLVideoElement, reframe: ReframeState) {
  const { width, height } = context.canvas
  const frameWidth = video.videoWidth
  const frameHeight = video.videoHeight
  if (frameWidth < 1 || frameHeight < 1) return
  context.imageSmoothingEnabled = true
  context.imageSmoothingQuality = 'high'
  if (reframe.fit === 'fill') {
    const scale = Math.max(width / frameWidth, height / frameHeight) * clamp(reframe.zoom, 1, 3)
    const drawWidth = frameWidth * scale
    const drawHeight = frameHeight * scale
    const overflowX = Math.max(0, drawWidth - width)
    const overflowY = Math.max(0, drawHeight - height)
    context.drawImage(video, -overflowX * clamp(reframe.focusX, 0, 1), -overflowY * clamp(reframe.focusY, 0, 1), drawWidth, drawHeight)
    return
  }
  const scale = Math.min(width / frameWidth, height / frameHeight)
  const drawWidth = frameWidth * scale
  const drawHeight = frameHeight * scale
  const covers = drawWidth >= width - 0.5 && drawHeight >= height - 0.5
  if (!covers) {
    if (reframe.fit === 'color') {
      context.fillStyle = reframe.backgroundColor || '#000000'
      context.fillRect(0, 0, width, height)
    } else {
      drawBlurBackdrop(context, video, width, height)
    }
  }
  context.drawImage(video, (width - drawWidth) / 2, (height - drawHeight) / 2, drawWidth, drawHeight)
}

export function renderFrame(
  context: CanvasRenderingContext2D,
  video: HTMLVideoElement,
  template: SubtitleTemplate,
  time: number,
  text = previewCaption,
  overrides: SubtitleStyleOverrides = {},
  words: Word[] = [],
  reframe: ReframeState = defaultReframe,
) {
  const { width, height } = context.canvas
  if (width < 1 || height < 1 || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return
  context.save()
  context.setTransform(1, 0, 0, 1, 0, 0)
  context.globalAlpha = 1
  context.globalCompositeOperation = 'source-over'
  context.filter = 'none'
  context.clearRect(0, 0, width, height)
  drawReframedVideo(context, video, reframe)
  context.restore()
  if (!text.trim()) return
  renderCaption(context, template, time, text, overrides, words)
}
