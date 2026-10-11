import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'
import { Maximize, Minimize, Pause, Play, RotateCcw } from 'lucide-react'
import { hasSubtitleFont, loadSubtitleFont, renderFrame, subtitleFontWeight } from '../lib/renderer'
import { ratioValue, type ReframeState } from '../lib/reframe'
import type { SubtitleStyleOverrides, SubtitleTemplate } from '../templates/types'

import { type SubtitleLine } from '../lib/chunker'

type VideoCanvasProps = {
  src: string
  template: SubtitleTemplate
  overrides: SubtitleStyleOverrides
  reframe: ReframeState
  onPositionChange: (positionX: number, positionY: number) => void
  onCropChange: (focusX: number, focusY: number) => void
  videoRef: RefObject<HTMLVideoElement>
  currentTime: number
  duration: number
  trimStart: number
  trimEnd: number
  loopTrim: boolean
  lines?: SubtitleLine[]
  onDuration: (duration: number) => void
  onTime: (time: number) => void
  onUnsupported: (message?: string) => void
  disabled?: boolean
}

function formatTime(seconds: number) {
  const safe = Math.max(0, Math.floor(seconds || 0))
  return `${Math.floor(safe / 60).toString().padStart(2, '0')}:${(safe % 60).toString().padStart(2, '0')}`
}

function frameAspect(video: HTMLVideoElement, reframe: ReframeState) {
  return ratioValue(reframe.ratio, video.videoWidth, video.videoHeight)
}

function resizeCanvasToStage(video: HTMLVideoElement, canvas: HTMLCanvasElement, aspect: number) {
  if (!aspect || aspect <= 0 || !Number.isFinite(aspect)) return
  const stage = canvas.closest<HTMLElement>('.stage-area')
  if (!stage) return
  const maxWidth = Math.max(1, stage.clientWidth - 24)
  const maxHeight = Math.max(1, window.innerHeight * 0.65)
  // Fit the output frame inside the stage box while preserving its aspect ratio.
  let cssWidth = maxWidth
  let cssHeight = cssWidth / aspect
  if (cssHeight > maxHeight) {
    cssHeight = maxHeight
    cssWidth = cssHeight * aspect
  }
  const dpr = Math.min(2, window.devicePixelRatio || 1)
  let pixelWidth = Math.max(1, Math.round(cssWidth * dpr))
  let pixelHeight = Math.max(1, Math.round(cssHeight * dpr))
  // Keep the preview crisp but never larger than the source (or 1920) to bound memory.
  const cap = Math.min(1920, Math.max(video.videoWidth, video.videoHeight) || 1920)
  const longSide = Math.max(pixelWidth, pixelHeight)
  if (longSide > cap) {
    pixelWidth = Math.max(1, Math.round(pixelWidth * cap / longSide))
    pixelHeight = Math.max(1, Math.round(pixelHeight * cap / longSide))
  }
  // Backing store (device-pixel) and CSS size are set separately so the canvas
  // stays crisp on HiDPI displays without rendering larger than its layout box.
  if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
    canvas.width = pixelWidth
    canvas.height = pixelHeight
  }
  const cssWidthPx = `${cssWidth}px`
  const cssHeightPx = `${cssHeight}px`
  if (canvas.style.width !== cssWidthPx || canvas.style.height !== cssHeightPx) {
    canvas.style.width = cssWidthPx
    canvas.style.height = cssHeightPx
  }
}

function resizeCanvasFullscreen(video: HTMLVideoElement, canvas: HTMLCanvasElement, aspect: number) {
  if (!aspect || aspect <= 0 || !Number.isFinite(aspect)) return
  const maxWidth = window.innerWidth
  const maxHeight = window.innerHeight
  let cssWidth = maxWidth
  let cssHeight = cssWidth / aspect
  if (cssHeight > maxHeight) {
    cssHeight = maxHeight
    cssWidth = cssHeight * aspect
  }
  const dpr = Math.min(3, window.devicePixelRatio || 1)
  let pixelWidth = Math.max(1, Math.round(cssWidth * dpr))
  let pixelHeight = Math.max(1, Math.round(cssHeight * dpr))
  // Never render above the source video's real resolution.
  const vw = video.videoWidth
  const vh = video.videoHeight
  if (vw > 0 && vh > 0) {
    const capScale = Math.min(1, vw / pixelWidth, vh / pixelHeight)
    pixelWidth = Math.max(1, Math.round(pixelWidth * capScale))
    pixelHeight = Math.max(1, Math.round(pixelHeight * capScale))
  }
  if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
    canvas.width = pixelWidth
    canvas.height = pixelHeight
  }
  const cssWidthPx = `${cssWidth}px`
  const cssHeightPx = `${cssHeight}px`
  if (canvas.style.width !== cssWidthPx || canvas.style.height !== cssHeightPx) {
    canvas.style.width = cssWidthPx
    canvas.style.height = cssHeightPx
  }
}

function drawSafeArea(context: CanvasRenderingContext2D) {
  const { width, height } = context.canvas
  const portrait = height > width * 1.02
  const top = portrait ? 0.1 : 0.06
  const side = portrait ? 0.07 : 0.05
  const bottom = portrait ? 0.14 : 0.06
  const x = width * side
  const y = height * top
  const safeWidth = width - x * 2
  const safeHeight = height - y - height * bottom
  const dash = Math.max(4, width * 0.014)
  context.save()
  context.setTransform(1, 0, 0, 1, 0, 0)
  context.fillStyle = 'rgba(6,8,6,0.34)'
  context.fillRect(0, 0, width, y)
  context.fillRect(0, y + safeHeight, width, height - y - safeHeight)
  context.fillRect(0, y, x, safeHeight)
  context.fillRect(x + safeWidth, y, width - x - safeWidth, safeHeight)
  context.setLineDash([dash, dash])
  context.lineWidth = Math.max(1.5, width * 0.004)
  context.strokeStyle = 'rgba(214,250,139,0.92)'
  context.strokeRect(x, y, safeWidth, safeHeight)
  context.setLineDash([])
  const labelSize = Math.max(10, Math.round(width * 0.026))
  if (y > labelSize * 1.6) {
    context.font = `700 ${labelSize}px system-ui, sans-serif`
    context.fillStyle = 'rgba(214,250,139,0.92)'
    context.textAlign = 'left'
    context.textBaseline = 'bottom'
    context.fillText('SOCIAL SAFE AREA', x + dash, y - dash * 0.5)
  }
  context.restore()
}

export default function VideoCanvas({ src, template, overrides, reframe, onPositionChange, onCropChange, videoRef, currentTime, duration, trimStart, trimEnd, loopTrim, lines = [], onDuration, onTime, onUnsupported, disabled = false }: VideoCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [isPlaying, setIsPlaying] = useState(false)
  const [renderError, setRenderError] = useState('')
  const templateRef = useRef(template)
  const linesRef = useRef(lines)
  const overridesRef = useRef(overrides)
  const reframeRef = useRef(reframe)
  const positionChangeRef = useRef(onPositionChange)
  const cropChangeRef = useRef(onCropChange)
  const onTimeRef = useRef(onTime)
  const onDurationRef = useRef(onDuration)
  const onUnsupportedRef = useRef(onUnsupported)
  const trimRangeRef = useRef({ start: trimStart, end: trimEnd, loop: loopTrim })
  const disabledRef = useRef(disabled)
  const wrapperRef = useRef<HTMLDivElement>(null)
  const fullscreenRef = useRef(false)
  const dragMovedRef = useRef(false)
  const [isFullscreen, setIsFullscreen] = useState(false)
  const [controlsVisible, setControlsVisible] = useState(true)

  const supportsFullscreen = typeof Element !== 'undefined' && (
    typeof Element.prototype.requestFullscreen === 'function'
    || typeof (Element.prototype as Element & { webkitRequestFullscreen?: unknown }).webkitRequestFullscreen === 'function'
  )

  const toggleFullscreen = useCallback(() => {
    const wrapper = wrapperRef.current
    if (!wrapper) return
    const doc = document as Document & { webkitFullscreenElement?: Element; webkitExitFullscreen?: () => void }
    const active = Boolean(document.fullscreenElement || doc.webkitFullscreenElement)
    if (active) {
      if (document.exitFullscreen) void document.exitFullscreen().catch(() => {})
      else if (doc.webkitExitFullscreen) doc.webkitExitFullscreen()
    } else {
      const target = wrapper as HTMLDivElement & { webkitRequestFullscreen?: () => void }
      if (wrapper.requestFullscreen) void wrapper.requestFullscreen().catch(() => {})
      else if (target.webkitRequestFullscreen) target.webkitRequestFullscreen()
    }
  }, [])

  useEffect(() => { templateRef.current = template }, [template])
  useEffect(() => { linesRef.current = lines }, [lines])
  useEffect(() => { overridesRef.current = overrides }, [overrides])
  useEffect(() => { reframeRef.current = reframe }, [reframe])
  useEffect(() => { positionChangeRef.current = onPositionChange }, [onPositionChange])
  useEffect(() => { cropChangeRef.current = onCropChange }, [onCropChange])
  useEffect(() => { onTimeRef.current = onTime }, [onTime])
  useEffect(() => { onDurationRef.current = onDuration }, [onDuration])
  useEffect(() => { onUnsupportedRef.current = onUnsupported }, [onUnsupported])
  useEffect(() => { trimRangeRef.current = { start: trimStart, end: trimEnd, loop: loopTrim } }, [trimStart, trimEnd, loopTrim])
  useEffect(() => { disabledRef.current = disabled }, [disabled])

  useEffect(() => {
    const video = videoRef.current
    const canvas = canvasRef.current
    const context = canvas?.getContext('2d')
    if (!video || !canvas || !context) return
    let frame = 0
    let lastTimeUpdate = 0
    let failed = false
    let disposed = false
    let pendingFont = ''
    const activeCaption = () => {
      const currentLines = linesRef.current
      if (currentLines.length === 0) return { text: undefined as string | undefined, words: [] as SubtitleLine['words'] }
      const activeLine = currentLines.find((line) => video.currentTime >= line.start && video.currentTime <= line.end)
      return { text: activeLine?.text ?? '', words: activeLine?.words ?? [] }
    }
    const draw = () => {
      if (failed || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA || canvas.width < 1 || canvas.height < 1) return
      const currentTemplate = templateRef.current
      const currentOverrides = overridesRef.current
      const font = currentOverrides.font ?? currentTemplate.font
      const weight = subtitleFontWeight(font)
      const fontKey = `${weight} "${font}"`
      if (!hasSubtitleFont(font, weight)) {
        if (pendingFont !== fontKey) {
          pendingFont = fontKey
          void loadSubtitleFont(font, weight, currentTemplate.rtl).then(() => {
            if (disposed) return
            pendingFont = ''
            draw()
          }).catch((error: unknown) => {
            if (disposed) return
            pendingFont = ''
            const message = `Could not load the ${font} subtitle font.`
            console.error(message, error)
            setRenderError(message)
          })
        }
        return
      }
      try {
        const caption = activeCaption()
        renderFrame(context, video, currentTemplate, video.currentTime, caption.text, currentOverrides, caption.words, reframeRef.current)
        if (reframeRef.current.socialSafeArea) drawSafeArea(context)
        setRenderError('')
      } catch (error) {
        failed = true
        cancelAnimationFrame(frame)
        console.error('Could not render the video preview.', error)
        setRenderError('The video loaded, but its preview could not be rendered.')
      }
    }

    const drawWhilePlaying = (now: number) => {
      draw()
      if (failed) return
      if (now - lastTimeUpdate > 100) {
        onTimeRef.current(video.currentTime)
        lastTimeUpdate = now
      }
      frame = requestAnimationFrame(drawWhilePlaying)
    }
    const startLoop = () => {
      if (!frame) frame = requestAnimationFrame(drawWhilePlaying)
    }
    const stopLoop = () => {
      cancelAnimationFrame(frame)
      frame = 0
    }
    const resizeCanvas = () => {
      const previousWidth = canvas.width
      const previousHeight = canvas.height
      const aspect = frameAspect(video, reframeRef.current)
      if (fullscreenRef.current) resizeCanvasFullscreen(video, canvas, aspect)
      else resizeCanvasToStage(video, canvas, aspect)
      if (canvas.width !== previousWidth || canvas.height !== previousHeight) draw()
    }
    const onFullscreenChange = () => {
      const active = Boolean(document.fullscreenElement || (document as Document & { webkitFullscreenElement?: Element }).webkitFullscreenElement)
      fullscreenRef.current = active
      setIsFullscreen(active)
      resizeCanvas()
    }
    const stage = canvas.closest<HTMLElement>('.stage-area')
    const resizeObserver = stage && typeof ResizeObserver !== 'undefined' ? new ResizeObserver(resizeCanvas) : null
    if (stage) resizeObserver?.observe(stage)
    window.addEventListener('resize', resizeCanvas)
    window.addEventListener('orientationchange', resizeCanvas)
    document.addEventListener('fullscreenchange', onFullscreenChange)
    document.addEventListener('webkitfullscreenchange', onFullscreenChange)

    video.addEventListener('loadeddata', draw)
    video.addEventListener('canplay', draw)
    video.addEventListener('seeked', draw)
    video.addEventListener('timeupdate', draw)
    video.addEventListener('play', startLoop)
    video.addEventListener('pause', stopLoop)
    if (!video.paused) startLoop()
    return () => {
      disposed = true
      stopLoop()
      resizeObserver?.disconnect()
      window.removeEventListener('resize', resizeCanvas)
      window.removeEventListener('orientationchange', resizeCanvas)
      document.removeEventListener('fullscreenchange', onFullscreenChange)
      document.removeEventListener('webkitfullscreenchange', onFullscreenChange)
      video.removeEventListener('loadeddata', draw)
      video.removeEventListener('canplay', draw)
      video.removeEventListener('seeked', draw)
      video.removeEventListener('timeupdate', draw)
      video.removeEventListener('play', startLoop)
      video.removeEventListener('pause', stopLoop)
    }
  }, [src, videoRef])

  useEffect(() => {
    const video = videoRef.current
    const canvas = canvasRef.current
    const context = canvas?.getContext('2d')
    if (!video || !canvas || !context) return
    // Re-fit the canvas whenever the output frame shape changes.
    resizeCanvasToStage(video, canvas, frameAspect(video, reframe))
    if (!video.paused || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA || canvas.width < 1 || canvas.height < 1) return
    const font = overrides.font ?? template.font
    const fontWeight = subtitleFontWeight(font)
    let cancelled = false
    const draw = () => {
      if (cancelled) return
      try {
        const activeLine = lines.find((line) => video.currentTime >= line.start && video.currentTime <= line.end)
        renderFrame(context, video, template, video.currentTime, lines.length ? activeLine?.text ?? '' : undefined, overrides, activeLine?.words, reframe)
        if (reframe.socialSafeArea) drawSafeArea(context)
        setRenderError('')
      } catch (error) {
        console.error('Could not render the paused video preview.', error)
        setRenderError('The video loaded, but its preview could not be rendered.')
      }
    }
    if (hasSubtitleFont(font, fontWeight)) draw()
    else void loadSubtitleFont(font, fontWeight, template.rtl).then(draw).catch((error: unknown) => {
      if (cancelled) return
      console.error(`Could not load the ${font} subtitle font.`, error)
      setRenderError(`Could not load the ${font} subtitle font.`)
    })
    return () => { cancelled = true }
  }, [template, lines, overrides, reframe, videoRef])

  // Auto-hide the fullscreen controls after ~2.5s of no pointer movement.
  useEffect(() => {
    if (!isFullscreen) {
      setControlsVisible(true)
      return
    }
    setControlsVisible(true)
    const wrapper = wrapperRef.current
    if (!wrapper) return
    let hideTimer = 0
    const showControls = () => {
      setControlsVisible(true)
      window.clearTimeout(hideTimer)
      hideTimer = window.setTimeout(() => setControlsVisible(false), 2500)
    }
    wrapper.addEventListener('pointermove', showControls)
    wrapper.addEventListener('pointerdown', showControls)
    wrapper.addEventListener('touchstart', showControls)
    showControls()
    return () => {
      window.clearTimeout(hideTimer)
      wrapper.removeEventListener('pointermove', showControls)
      wrapper.removeEventListener('pointerdown', showControls)
      wrapper.removeEventListener('touchstart', showControls)
    }
  }, [isFullscreen])

  // Keyboard shortcuts (ignored while focus is inside a form control).
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || target.tagName === 'BUTTON' || target.isContentEditable)) return
      if (disabledRef.current) return
      if (event.key === 'f' || event.key === 'F') {
        event.preventDefault()
        toggleFullscreen()
      } else if (event.key === ' ') {
        event.preventDefault()
        const video = videoRef.current
        if (!video) return
        if (video.paused) {
          const { start, end } = trimRangeRef.current
          if (end > start && (video.currentTime < start || video.currentTime >= end)) video.currentTime = start
          void video.play().catch(() => setIsPlaying(false))
        } else {
          video.pause()
        }
      } else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
        event.preventDefault()
        const video = videoRef.current
        if (!video) return
        const { start, end } = trimRangeRef.current
        if (end <= start) return
        const delta = event.key === 'ArrowLeft' ? -5 : 5
        video.currentTime = Math.max(start, Math.min(end, video.currentTime + delta))
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [toggleFullscreen])

  const handleMetadata = () => {
    const video = videoRef.current
    const canvas = canvasRef.current
    if (!video || !canvas) return
    if (video.videoWidth < 1 || video.videoHeight < 1) {
      const message = 'The video metadata did not include valid frame dimensions.'
      console.error(message, { width: video.videoWidth, height: video.videoHeight })
      onUnsupportedRef.current(message)
      return
    }
    const videoDuration = Number.isFinite(video.duration) ? video.duration : 0
    resizeCanvasToStage(video, canvas, frameAspect(video, reframeRef.current))
    onDurationRef.current(videoDuration)
    video.currentTime = currentTime > 0 ? Math.min(currentTime, videoDuration) : 0.001
  }

  const handleMediaError = (event: React.SyntheticEvent<HTMLVideoElement>) => {
    const mediaError = event.currentTarget.error
    const details = mediaError?.message || ({
      1: 'loading was aborted',
      2: 'a network error occurred',
      3: 'the video could not be decoded. It may be using an unsupported codec like HEVC/H.265',
      4: 'the video format is not supported',
    } as Record<number, string>)[mediaError?.code ?? 0] || 'an unknown media error occurred'
    const message = `Video playback failed: ${details}.`
    console.error(message, mediaError ?? event.nativeEvent)
    onUnsupportedRef.current(message)
  }

  const togglePlay = async () => {
    const video = videoRef.current
    if (!video) return
    if (video.paused) {
      try {
        const { start, end } = trimRangeRef.current
        if (video.currentTime < start || video.currentTime >= end) video.currentTime = start
        await video.play()
      } catch (error) {
        setIsPlaying(false)
        console.error('Could not start video playback.', error)
        onUnsupportedRef.current('Video playback could not start. Check that the file is supported and try again.')
      }
    } else {
      video.pause()
    }
  }
  const handleTimeUpdate = (video: HTMLVideoElement) => {
    const { start, end, loop } = trimRangeRef.current
    if (!disabledRef.current && end > start) {
      if (video.currentTime < start) {
        video.currentTime = start
      } else if (video.currentTime >= end) {
        if (loop && !video.paused) {
          video.currentTime = start
        } else {
          video.currentTime = end
          video.pause()
        }
      }
    }
    onTimeRef.current(video.currentTime)
  }
  const handleEnded = () => {
    const video = videoRef.current
    const { start, loop } = trimRangeRef.current
    if (!video) return
    if (loop && !disabledRef.current) {
      video.currentTime = start
      void video.play().catch((error: unknown) => {
        console.error('Could not loop the selected video range.', error)
        onUnsupportedRef.current('Video playback could not restart at the selected trim start.')
      })
    } else {
      onTimeRef.current(video.duration)
    }
  }

  const handleCanvasPointerDown = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (disabled) return
    dragMovedRef.current = false
    event.currentTarget.setPointerCapture(event.pointerId)
  }
  const handleCanvasPointerMove = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (disabled) return
    if (!event.currentTarget.hasPointerCapture(event.pointerId)) return
    dragMovedRef.current = true
    const bounds = event.currentTarget.getBoundingClientRect()
    if (bounds.width < 1 || bounds.height < 1) return
    const fractionX = Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width))
    const fractionY = Math.max(0, Math.min(1, (event.clientY - bounds.top) / bounds.height))
    // In crop mode a drag frames the video; otherwise it repositions the captions.
    if (reframeRef.current.fit === 'fill') {
      cropChangeRef.current(fractionX, fractionY)
      return
    }
    positionChangeRef.current(
      Math.max(-0.45, Math.min(0.45, fractionX - 0.5)),
      Math.max(0.08, Math.min(0.92, fractionY)),
    )
  }
  const handleCanvasClick = () => {
    if (!isFullscreen || disabled) return
    if (dragMovedRef.current) {
      dragMovedRef.current = false
      return
    }
    void togglePlay()
  }

  return (
    <div ref={wrapperRef} className={`player-wrap ${isFullscreen ? 'is-fullscreen' : ''}`}>
      <div className="video-frame">
        <video ref={videoRef} className="video-source" src={src} playsInline preload="auto" onLoadedMetadata={handleMetadata} onError={handleMediaError} onTimeUpdate={(event) => handleTimeUpdate(event.currentTarget)} onEnded={handleEnded} onPlay={() => setIsPlaying(true)} onPause={() => setIsPlaying(false)} />
        <canvas
          ref={canvasRef}
          className={`preview-canvas ${disabled ? 'export-in-progress' : ''}`}
          aria-label={reframe.fit === 'fill'
            ? 'Video preview with captions. Drag to set the crop focus.'
            : 'Video preview with captions. Drag to reposition captions.'}
          onPointerDown={handleCanvasPointerDown}
          onPointerMove={handleCanvasPointerMove}
          onClick={handleCanvasClick}
        />
        <span className="frame-badge">LIVE PREVIEW</span>
      </div>
      {renderError && <div className="render-error" role="alert">{renderError}</div>}
      <div className={`transport ${controlsVisible ? '' : 'is-hidden'}`}>
        <button className="transport-button" title="Restart selected range" aria-label="Restart selected range" onClick={() => { if (videoRef.current) videoRef.current.currentTime = trimStart }} disabled={disabled}><RotateCcw size={15} /></button>
        <button className="play-button" onClick={togglePlay} aria-label={isPlaying ? 'Pause video' : 'Play video'} disabled={disabled}>{isPlaying ? <Pause size={16} fill="currentColor" /> : <Play size={16} fill="currentColor" />}</button>
        {supportsFullscreen && (
          <button className="transport-button" type="button" title={isFullscreen ? 'Exit fullscreen' : 'Fullscreen'} aria-label={isFullscreen ? 'Exit fullscreen' : 'Fullscreen'} onClick={toggleFullscreen} disabled={disabled}>
            {isFullscreen ? <Minimize size={16} /> : <Maximize size={16} />}
          </button>
        )}
        <span className="time-readout">{formatTime(currentTime)} <span>/</span> {formatTime(duration)}</span>
        <input
          className="scrubber"
          type="range"
          min={trimStart}
          max={Math.max(trimStart, trimEnd)}
          step="0.01"
          value={Math.max(trimStart, Math.min(currentTime, trimEnd))}
          style={{
            background: duration > 0
              ? `linear-gradient(to right, #181916 0%, #181916 ${trimStart / duration * 100}%, #879e50 ${trimStart / duration * 100}%, #879e50 ${trimEnd / duration * 100}%, #181916 ${trimEnd / duration * 100}%, #181916 100%)`
              : undefined,
          }}
          onChange={(event) => { if (videoRef.current) videoRef.current.currentTime = Number(event.target.value) }}
          aria-label="Seek video within selected trim"
          disabled={disabled}
        />
        <span className="time-readout end-time">{formatTime(duration)}</span>
      </div>
    </div>
  )
}
