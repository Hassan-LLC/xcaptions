import { Muxer, StreamTarget } from 'mp4-muxer'
import type { SubtitleLine } from './chunker'
import { cutWavByKeepRanges, extractOriginalQualityWav, muxVideoWithWav, trimOriginalQualityWav } from './audio'
import { loadSubtitleFont, renderFrame, subtitleFontWeight } from './renderer'
import { defaultReframe, outputDimensions, type AspectRatioId, type ReframeState } from './reframe'
import { editedTotalDuration, keptBefore, nextKeptTime, sourceTimeForEdited, type KeepRange } from './silence'
import { extractRangeWav } from './videoPreparation'
import type { SubtitleStyleOverrides, SubtitleTemplate } from '../templates/types'

export type ExportResolution = '480p' | '720p' | '1080p' | 'original'

/**
 * Export speed/memory trade-off. `fast` raises queue limits for maximum
 * throughput, `low` keeps queues small so weak devices do not run out of
 * memory, and `balanced` sits in between.
 */
export type ExportSpeed = 'fast' | 'balanced' | 'low'

export type VideoExportProgress = {
  progress: number
  elapsed: number
  remaining: number
  outputWidth: number
  outputHeight: number
  message?: string
}

export type VideoExportOptions = {
  video: HTMLVideoElement
  lines: SubtitleLine[]
  template: SubtitleTemplate
  overrides: SubtitleStyleOverrides
  reframe: ReframeState
  file: File
  resolution: ExportResolution
  trimStart: number
  trimEnd: number
  /** Extract audio directly from this source-time interval for soft-limited originals. */
  audioRange?: { start: number; end: number }
  /** Source-time ranges to keep inside the trim; empty means the whole trim. */
  keepRanges?: KeepRange[]
  signal: AbortSignal
  onProgress: (progress: VideoExportProgress) => void
  /** When set, the muxed MP4 is streamed to this writable instead of buffered. */
  writable?: ExportWritable
  /** Speed/memory trade-off. Defaults to `balanced`. */
  speed?: ExportSpeed
}

/** Minimal shape of a FileSystemWritableFileStream, so we do not depend on DOM typings. */
export interface ExportWritable {
  write(data: { type: 'write'; position: number; data: Uint8Array }): Promise<void>
  close(): Promise<void>
  abort(): Promise<void>
}

export type VideoExportResult = {
  blob?: Blob
  /** True when the file was written directly to a user-chosen destination. */
  streamed?: boolean
  extension: 'mp4' | 'webm'
  outputWidth: number
  outputHeight: number
  /** Whether the encoder was configured with a hardware preference. */
  hardware?: boolean
  /** The H.264 codec string that was negotiated. */
  codec?: string
}

type RecorderType = {
  mimeType: string
  extension: 'mp4' | 'webm'
  bitsPerSecond: number
}

export function getExportDimensions(
  videoWidth: number,
  videoHeight: number,
  resolution: ExportResolution,
  ratio: AspectRatioId = 'original',
) {
  return outputDimensions(videoWidth, videoHeight, resolution, ratio)
}

function activeLineAt(lines: SubtitleLine[], time: number) {
  return lines.find((line) => time >= line.start && time <= line.end)
}

function drawVideoFrame(
  context: CanvasRenderingContext2D,
  video: HTMLVideoElement,
  lines: SubtitleLine[],
  template: SubtitleTemplate,
  overrides: SubtitleStyleOverrides,
  reframe: ReframeState,
  captionTime = keptBefore(video.currentTime, [{ start: 0, end: Number.MAX_SAFE_INTEGER }], 0),
) {
  const active = activeLineAt(lines, captionTime)
  renderFrame(context, video, template, captionTime, active?.text ?? '', overrides, active?.words, reframe)
}

function secondsRemaining(elapsed: number, progress: number) {
  if (progress <= 0 || progress >= 1) return 0
  const estimatedTotal = elapsed / progress
  return Math.max(0, estimatedTotal - elapsed)
}

function seekVideo(video: HTMLVideoElement, time: number) {
  if (Math.abs(video.currentTime - time) <= 0.01) return Promise.resolve()
  return new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      video.removeEventListener('seeked', onSeeked)
      video.removeEventListener('error', onError)
    }
    const onSeeked = () => {
      cleanup()
      resolve()
    }
    const onError = () => {
      cleanup()
      reject(new Error('The video could not seek to the requested export time.'))
    }
    video.addEventListener('seeked', onSeeked, { once: true })
    video.addEventListener('error', onError, { once: true })
    video.currentTime = time
  })
}

function videoBitrate(resolution: ExportResolution) {
  if (resolution === '1080p') return 8_000_000
  if (resolution === '720p') return 4_000_000
  if (resolution === '480p') return 2_000_000
  return 6_000_000
}

async function getWebCodecsConfigs(width: number, height: number, resolution: ExportResolution, sampleRate: number, channels: number) {
  if (typeof VideoEncoder === 'undefined' || typeof AudioEncoder === 'undefined' || typeof AudioData === 'undefined' || typeof VideoFrame === 'undefined') {
    return null
  }
  const bitrate = videoBitrate(resolution)
  // Baseline / main / high profile candidates so 1080p sources still encode on
  // devices that only support a lower H.264 profile.
  const codecCandidates = width * height > 1280 * 720
    ? ['avc1.420028', 'avc1.4D4028', 'avc1.640028']
    : ['avc1.42001f', 'avc1.4D401F', 'avc1.64001F']
  let videoConfig: VideoEncoderConfig | undefined
  let usedHardware = false
  let usedCodec = ''
  const hardwareChoices: HardwareAcceleration[] = ['prefer-hardware', 'prefer-software']
  for (const hardwareAcceleration of hardwareChoices) {
    for (const codec of codecCandidates) {
      const candidate: VideoEncoderConfig = {
        codec,
        width,
        height,
        bitrate,
        framerate: 30,
        avc: { format: 'avc' },
        hardwareAcceleration,
      }
      try {
        const result = await VideoEncoder.isConfigSupported(candidate)
        if (result.supported) {
          videoConfig = result.config
          usedHardware = hardwareAcceleration === 'prefer-hardware'
          usedCodec = codec
          break
        }
      } catch {
        continue
      }
    }
    if (videoConfig) break
  }
  if (!videoConfig) return null
  const audioCandidate: AudioEncoderConfig = {
    codec: 'mp4a.40.2',
    sampleRate,
    numberOfChannels: channels,
    bitrate: 192_000,
  }
  try {
    const audioResult = await AudioEncoder.isConfigSupported(audioCandidate)
    return audioResult.supported && audioResult.config
      ? { video: videoConfig, audio: audioResult.config, hardware: usedHardware, codec: usedCodec }
      : null
  } catch {
    return null
  }
}

async function decodeWav(wav: Blob, sampleRate: number) {
  const Context = window.AudioContext
  if (!Context) throw new Error('Audio export needs Web Audio support. Try a current desktop browser.')
  const context = new Context({ latencyHint: 'playback', sampleRate })
  try {
    const buffer = await context.decodeAudioData(await wav.arrayBuffer())
    if (buffer.sampleRate !== sampleRate) {
      throw new Error(`Decoded audio rate (${buffer.sampleRate} Hz) does not match the source (${sampleRate} Hz).`)
    }
    return buffer
  } finally {
    await context.close()
  }
}

async function encodeAudioTrack(
  muxer: Muxer<StreamTarget>,
  audio: AudioBuffer,
  config: AudioEncoderConfig,
  signal: AbortSignal,
) {
  let encoderError: Error | undefined
  const encoder = new AudioEncoder({
    output: (chunk, metadata) => muxer.addAudioChunk(chunk, metadata),
    error: (error) => { encoderError = error },
  })
  try {
    encoder.configure(config)
    const framesPerChunk = 4096
    const channels = Array.from({ length: audio.numberOfChannels }, (_, index) => audio.getChannelData(index))
    for (let offset = 0; offset < audio.length; offset += framesPerChunk) {
      if (signal.aborted) throw new DOMException('Export cancelled.', 'AbortError')
      if (encoderError) throw encoderError
      const frameCount = Math.min(framesPerChunk, audio.length - offset)
      const planar = new Float32Array(frameCount * audio.numberOfChannels)
      for (let channel = 0; channel < channels.length; channel++) {
        planar.set(channels[channel].subarray(offset, offset + frameCount), channel * frameCount)
      }
      const data = new AudioData({
        format: 'f32-planar',
        sampleRate: audio.sampleRate,
        numberOfFrames: frameCount,
        numberOfChannels: audio.numberOfChannels,
        timestamp: Math.round(offset / audio.sampleRate * 1_000_000),
        data: planar,
      })
      encoder.encode(data)
      data.close()
      if (encoder.encodeQueueSize > 32) await encoder.flush()
    }
    await encoder.flush()
    if (encoderError) throw encoderError
  } finally {
    if (encoder.state !== 'closed') encoder.close()
  }
}

async function exportWithWebCodecs(
  options: VideoExportOptions,
  canvas: HTMLCanvasElement,
  context: CanvasRenderingContext2D,
  wav: Blob,
  sourceAudioSampleRate: number,
  configs: { video: VideoEncoderConfig; audio: AudioEncoderConfig; hardware: boolean; codec: string },
  outputWidth: number,
  outputHeight: number,
  mode: 'offline' | 'playback' = 'offline',
  speed: ExportSpeed = 'balanced',
): Promise<VideoExportResult> {
  const { video, lines, template, overrides, signal, onProgress, trimStart, trimEnd } = options
  const reframe = options.reframe ?? defaultReframe
  const keepRanges = options.keepRanges?.length ? options.keepRanges : [{ start: trimStart, end: trimEnd }]
  const audio = await decodeWav(wav, sourceAudioSampleRate)
  const selectedDuration = editedTotalDuration(keepRanges)
  const FPS = 30
  const frameTotal = Math.max(1, Math.ceil(selectedDuration * FPS))
  // Backpressure: bound the encoder queue so memory stays predictable. `fast`
  // allows a deeper queue for higher throughput, `low` keeps it tiny for phones.
  const encoderQueueTarget = speed === 'fast' ? 6 : speed === 'low' ? 2 : 4
  const encoderQueueLimit = speed === 'fast' ? 12 : speed === 'low' ? 4 : 8

  // Stream the muxed file to a user-chosen destination when a writable is given,
  // otherwise collect ordered chunks and build one Blob (lower peak memory than
  // a single growing buffer).
  const chunks: Uint8Array[] = []
  let writable = options.writable
  let streamQueue: Promise<void> = Promise.resolve()
  let streamError: Error | undefined
  const target = new StreamTarget({
    chunked: true,
    chunkSize: 1 << 20,
    onData: (data, position) => {
      const copy = data.slice()
      const activeWritable = writable
      if (activeWritable) {
        streamQueue = streamQueue.then(() => activeWritable.write({ type: 'write', position, data: copy })).catch((error: unknown) => {
          streamError = error instanceof Error ? error : new Error('Writing the exported file failed.')
        })
      } else {
        chunks.push(copy)
      }
    },
  })
  const muxer = new Muxer({
    target,
    video: { codec: 'avc', width: outputWidth, height: outputHeight, frameRate: FPS },
    audio: { codec: 'aac', sampleRate: audio.sampleRate, numberOfChannels: audio.numberOfChannels },
    fastStart: writable ? false : 'in-memory',
    firstTimestampBehavior: 'cross-track-offset',
  })
  onProgress({
    progress: 0,
    elapsed: 0,
    remaining: selectedDuration,
    outputWidth,
    outputHeight,
    message: 'Encoding clean source audio…',
  })
  await encodeAudioTrack(muxer, audio, configs.audio, signal)
  if (signal.aborted) throw new DOMException('Export cancelled.', 'AbortError')

  // Offline render: step the video by seeking each output frame instead of
  // playing it in real time, so export speed is not tied to the clip length.
  const previousTime = video.currentTime
  const wasPlaying = !video.paused
  const startedAt = performance.now()
  let lastEncodedTimestamp = -1
  let frameCount = 0
  let lastReport = 0
  let videoEncoderError: Error | undefined
  if (!video.paused) video.pause()

  const encoder = new VideoEncoder({
    output: (chunk, metadata) => muxer.addVideoChunk(chunk, metadata),
    error: (error) => { videoEncoderError = error },
  })
  try {
    encoder.configure(configs.video)
    await seekVideo(video, keepRanges[0].start)
  } catch (error) {
    if (encoder.state !== 'closed') encoder.close()
    if (writable) {
      try { await writable.abort() } catch { /* ignore */ }
      writable = undefined
    }
    throw error
  }

  const encodeFrameAt = (editedTime: number) => {
    const timestamp = Math.max(lastEncodedTimestamp + 1, Math.round(editedTime * 1_000_000))
    const frame = new VideoFrame(canvas, { timestamp, duration: Math.round(1_000_000 / FPS) })
    try {
      encoder.encode(frame, { keyFrame: frameCount % 60 === 0 })
    } finally {
      frame.close()
    }
    lastEncodedTimestamp = timestamp
    frameCount += 1
  }
  const drainEncoder = () => new Promise<void>((resolve) => {
    if (encoder.encodeQueueSize <= encoderQueueTarget) {
      resolve()
      return
    }
    let settled = false
    const finish = () => {
      if (settled) return
      settled = true
      encoder.removeEventListener('dequeue', check)
      resolve()
    }
    const check = () => { if (encoder.encodeQueueSize <= encoderQueueTarget) finish() }
    encoder.addEventListener('dequeue', check)
    // 'dequeue' avoids the timer clamping that setTimeout(0) suffers; keep a slow
    // safety poll in case the event is unavailable.
    const safety = () => { if (settled) return; if (encoder.encodeQueueSize <= encoderQueueTarget) finish(); else setTimeout(safety, 4) }
    setTimeout(safety, 4)
  })

  const renderOffline = async () => {
    for (let index = 0; index < frameTotal; index++) {
      if (signal.aborted) throw new DOMException('Export cancelled.', 'AbortError')
      if (videoEncoderError) throw videoEncoderError
      const editedTime = Math.min(selectedDuration, index / FPS)
      await seekVideo(video, sourceTimeForEdited(editedTime, keepRanges, trimStart))
      drawVideoFrame(context, video, lines, template, overrides, reframe, editedTime)
      encodeFrameAt(editedTime)
      if (encoder.encodeQueueSize > encoderQueueLimit) await drainEncoder()
      const now = performance.now()
      if (now - lastReport > 500 || index === frameTotal - 1) {
        lastReport = now
        const elapsed = (now - startedAt) / 1000
        const progress = (index + 1) / frameTotal
        onProgress({
          progress: Math.round(progress * 95),
          elapsed,
          remaining: secondsRemaining(elapsed, progress),
          outputWidth,
          outputHeight,
          message: 'Rendering video frames…',
        })
      }
    }
  }
  // Playback render: encodes one output frame per real-time frame (the previous
  // behavior). Retained only as a diagnostic comparison for export speed.
  const renderPlayback = () => new Promise<void>((resolve, reject) => {
    let frameCallbackId: number | undefined
    let rafId = 0
    let done = false
    const stop = () => {
      if (frameCallbackId !== undefined && 'cancelVideoFrameCallback' in video) {
        (video as HTMLVideoElement & { cancelVideoFrameCallback: (id: number) => void }).cancelVideoFrameCallback(frameCallbackId)
      }
      cancelAnimationFrame(rafId)
    }
    const finish = () => { if (done) return; done = true; stop(); resolve() }
    const fail = (error: unknown) => { if (done) return; done = true; stop(); reject(error instanceof Error ? error : new Error('Playback export failed.')) }
    const pump = (mediaTime?: number) => {
      if (done || signal.aborted) return
      if (videoEncoderError) return fail(videoEncoderError)
      const position = mediaTime ?? video.currentTime
      if (position >= trimEnd) return finish()
      const next = nextKeptTime(position, keepRanges)
      if (next !== null && next > position + 0.001 && Math.abs(video.currentTime - next) > 0.01) {
        void seekVideo(video, next).then(() => pump()).catch(fail)
        return
      }
      const editedTime = keptBefore(position, keepRanges, trimStart)
      drawVideoFrame(context, video, lines, template, overrides, reframe, editedTime)
      encodeFrameAt(editedTime)
      const now = performance.now()
      if (now - lastReport > 500) {
        lastReport = now
        const elapsed = (now - startedAt) / 1000
        const progress = Math.min(0.999, selectedDuration > 0 ? editedTime / selectedDuration : 0)
        onProgress({ progress: Math.round(progress * 95), elapsed, remaining: secondsRemaining(elapsed, progress), outputWidth, outputHeight, message: 'Rendering video frames…' })
      }
      const withFrameCallback = video as HTMLVideoElement & { requestVideoFrameCallback?: (callback: (now: number, metadata: { mediaTime: number }) => void) => number }
      if (withFrameCallback.requestVideoFrameCallback) {
        frameCallbackId = withFrameCallback.requestVideoFrameCallback((_now, metadata) => { if (metadata.mediaTime >= trimEnd) finish(); else pump(metadata.mediaTime) })
      } else {
        rafId = requestAnimationFrame(() => pump())
      }
    }
    signal.addEventListener('abort', () => fail(new DOMException('Export cancelled.', 'AbortError')), { once: true })
    video.addEventListener('ended', finish, { once: true })
    encodeFrameAt(0)
    pump()
    void video.play().catch(fail)
  })

  try {
    if (mode === 'playback') await renderPlayback()
    else await renderOffline()
    await encoder.flush()
    if (videoEncoderError) throw videoEncoderError
    await streamQueue
    if (streamError) throw streamError
    encoder.close()
    muxer.finalize()
    await streamQueue
    if (streamError) throw streamError
    if (writable) {
      await writable.close()
      return { streamed: true, extension: 'mp4', outputWidth, outputHeight, hardware: configs.hardware, codec: configs.codec }
    }
    const blob = new Blob(chunks, { type: 'video/mp4' })
    if (!blob.size) throw new Error('The browser produced an empty MP4 export.')
    return { blob, extension: 'mp4', outputWidth, outputHeight, hardware: configs.hardware, codec: configs.codec }
  } catch (error) {
    if (encoder.state !== 'closed') encoder.close()
    if (writable) {
      try { await writable.abort() } catch { /* ignore */ }
      writable = undefined
    }
    throw error
  } finally {
    if (encoder.state !== 'closed') encoder.close()
    if (!video.paused || wasPlaying) video.pause()
    if (Number.isFinite(previousTime)) video.currentTime = previousTime
  }
}

function getSupportedVideoRecorder(): RecorderType {
  if (typeof MediaRecorder === 'undefined') {
    throw new Error('Video export is not supported in this browser. Try the latest desktop Chrome or Edge.')
  }
  if (typeof HTMLCanvasElement.prototype.captureStream !== 'function') {
    throw new Error('This browser cannot capture canvas video. Try the latest desktop Chrome or Edge.')
  }
  const options: RecorderType[] = [
    { mimeType: 'video/mp4', extension: 'mp4', bitsPerSecond: 14_000_000 },
    { mimeType: 'video/webm;codecs=vp9', extension: 'webm', bitsPerSecond: 10_000_000 },
    { mimeType: 'video/webm', extension: 'webm', bitsPerSecond: 8_000_000 },
  ]
  const supported = options.find((option) => MediaRecorder.isTypeSupported(option.mimeType))
  if (!supported) throw new Error('This browser does not support MP4 or WebM recording. Try the latest Chrome, Edge, or Safari.')
  return supported
}

async function recordVideoOnly(
  options: VideoExportOptions,
  canvas: HTMLCanvasElement,
  context: CanvasRenderingContext2D,
  supported: RecorderType,
  outputWidth: number,
  outputHeight: number,
) {
  const { video, lines, template, overrides, signal, onProgress, trimStart, trimEnd } = options
  const reframe = options.reframe ?? defaultReframe
  const keepRanges = options.keepRanges?.length ? options.keepRanges : [{ start: trimStart, end: trimEnd }]
  const selectedDuration = editedTotalDuration(keepRanges)
  const stream = canvas.captureStream(30)
  let recorder: MediaRecorder
  try {
    recorder = new MediaRecorder(stream, {
      mimeType: supported.mimeType,
      videoBitsPerSecond: supported.bitsPerSecond,
    })
  } catch (error) {
    stream.getTracks().forEach((track) => track.stop())
    if (error instanceof Error) throw error
    throw new Error('The browser could not start video recording. Try a lower resolution.')
  }

  const chunks: Blob[] = []
  const previousTime = video.currentTime
  const wasPlaying = !video.paused
  let activeElapsed = 0
  let activeSince = performance.now()
  let progressInterval = 0
  let frameCallbackId: number | undefined
  let animationFrameId = 0
  let settled = false
  let finishing = false
  let hidden = document.hidden
  let pausedForVisibility = false
  let removeListeners = () => {}
  let finishAtTrimEnd = () => {}
  let handleFailure: (error: Error) => void = () => {}

  const stopFramePump = () => {
    if (frameCallbackId !== undefined && 'cancelVideoFrameCallback' in video) {
      video.cancelVideoFrameCallback(frameCallbackId)
      frameCallbackId = undefined
    }
    cancelAnimationFrame(animationFrameId)
  }
  const pump = () => {
    if (settled || hidden || signal.aborted) return
    if (video.currentTime >= trimEnd) {
      finishAtTrimEnd()
      return
    }
    // Skip over removed ranges: jump straight into the next kept range.
    const next = nextKeptTime(video.currentTime, keepRanges)
    if (next !== null && next > video.currentTime + 0.001 && Math.abs(video.currentTime - next) > 0.01) {
      void seekVideo(video, next).then(() => pump()).catch((error: unknown) => {
        if (signal.aborted) return
        handleFailure(error instanceof Error ? error : new Error('The video could not skip a removed silence range during export.'))
      })
      return
    }
    drawVideoFrame(context, video, lines, template, overrides, reframe, keptBefore(video.currentTime, keepRanges, trimStart))
    const withFrameCallback = video as HTMLVideoElement & {
      requestVideoFrameCallback?: (callback: (now: number, metadata: { mediaTime: number }) => void) => number
    }
    if (withFrameCallback.requestVideoFrameCallback) {
      frameCallbackId = withFrameCallback.requestVideoFrameCallback((_now, metadata) => {
        if (metadata.mediaTime >= trimEnd) finishAtTrimEnd()
        else pump()
      })
    } else {
      animationFrameId = requestAnimationFrame(pump)
    }
  }

  return await new Promise<Blob>((resolve, reject) => {
    const cleanup = () => {
      stopFramePump()
      window.clearInterval(progressInterval)
      signal.removeEventListener('abort', onAbort)
      document.removeEventListener('visibilitychange', onVisibility)
      video.removeEventListener('ended', onEnded)
      video.removeEventListener('error', onVideoError)
      video.removeEventListener('timeupdate', onTrimTimeUpdate)
      removeListeners()
    }
    const fail = (error: Error) => {
      if (settled) return
      settled = true
      cleanup()
      if (recorder.state !== 'inactive') recorder.stop()
      reject(error)
    }
    handleFailure = fail
    const onAbort = () => fail(new DOMException('Export cancelled.', 'AbortError'))
    const onVideoError = () => fail(new Error('The video encountered a playback error during export.'))
    const onEnded = () => {
      if (finishing) return
      finishing = true
      stopFramePump()
      if (recorder.state !== 'inactive') recorder.stop()
    }
    const onTrimTimeUpdate = () => {
      if (video.currentTime >= trimEnd) onEnded()
    }
    finishAtTrimEnd = onEnded
    const onVisibility = () => {
      hidden = document.hidden
      if (hidden) {
        activeElapsed += (performance.now() - activeSince) / 1000
        pausedForVisibility = !video.paused
        video.pause()
        if (recorder.state === 'recording') recorder.pause()
        stopFramePump()
      } else if (pausedForVisibility && !signal.aborted) {
        activeSince = performance.now()
        pausedForVisibility = false
        if (recorder.state === 'paused') recorder.resume()
        void video.play().then(pump).catch((error: unknown) => {
          fail(error instanceof Error ? error : new Error('Could not resume the export after returning to this tab.'))
        })
      }
    }
    removeListeners = () => {
      video.removeEventListener('ended', onEnded)
      video.removeEventListener('error', onVideoError)
    }
    signal.addEventListener('abort', onAbort, { once: true })
    document.addEventListener('visibilitychange', onVisibility)
    video.addEventListener('ended', onEnded, { once: true })
    video.addEventListener('error', onVideoError, { once: true })
    video.addEventListener('timeupdate', onTrimTimeUpdate)
    recorder.addEventListener('dataavailable', (event) => {
      if (event.data.size) chunks.push(event.data)
    })
    recorder.addEventListener('error', (event) => {
      const errorEvent = event as Event & { error?: DOMException }
      fail(new Error(errorEvent.error?.name === 'QuotaExceededError'
        ? 'The browser ran out of memory during video export. Try 480p or 720p.'
        : 'The browser could not finish recording this video. Try a lower resolution.'))
    }, { once: true })
    recorder.addEventListener('stop', () => {
      if (!settled) {
        settled = true
        cleanup()
      }
      const blob = new Blob(chunks, { type: recorder.mimeType || supported.mimeType })
      if (!blob.size) reject(new Error('The browser produced an empty video export. Try another browser or resolution.'))
      else resolve(blob)
    }, { once: true })
    void seekVideo(video, trimStart).then(() => {
      if (signal.aborted) throw new DOMException('Export cancelled.', 'AbortError')
      recorder.start(1000)
      drawVideoFrame(context, video, lines, template, overrides, reframe, 0)
      pump()
      progressInterval = window.setInterval(() => {
        const progress = Math.min(1, Math.max(0, keptBefore(video.currentTime, keepRanges, trimStart) / selectedDuration))
        const elapsed = activeElapsed + (hidden ? 0 : (performance.now() - activeSince) / 1000)
        onProgress({
          progress: Math.round(progress * 95),
          elapsed,
          remaining: secondsRemaining(elapsed, progress),
          outputWidth,
          outputHeight,
          message: 'Rendering video frames…',
        })
      }, 500)
      return video.play()
    }).catch((error: unknown) => {
      fail(error instanceof Error ? error : new Error('Video playback could not start for export.'))
    })
  }).finally(() => {
    stopFramePump()
    window.clearInterval(progressInterval)
    stream.getTracks().forEach((track) => track.stop())
    if (!video.paused || wasPlaying) video.pause()
    if (Number.isFinite(previousTime)) video.currentTime = previousTime
  })
}

export async function exportVideo(options: VideoExportOptions): Promise<VideoExportResult> {
  const { video, file, lines, template, overrides, resolution, trimStart, trimEnd, signal, onProgress } = options
  const reframe = options.reframe ?? defaultReframe
  if (signal.aborted) throw new DOMException('Export cancelled.', 'AbortError')
  if (!video.videoWidth || !video.videoHeight || !Number.isFinite(video.duration) || video.duration <= 0) {
    throw new Error('Wait for the video to finish loading before exporting.')
  }
  if (!lines.some((line) => line.text.trim())) throw new Error('Add at least one non-empty caption before exporting a video.')
  if (trimStart < 0 || trimEnd > video.duration || trimEnd - trimStart < 0.5) {
    throw new Error('Choose a trim range of at least 0.5 seconds within the video.')
  }
  const keepRanges = options.keepRanges?.length ? options.keepRanges : [{ start: trimStart, end: trimEnd }]
  const selectedDuration = editedTotalDuration(keepRanges)
  const { width, height } = getExportDimensions(video.videoWidth, video.videoHeight, resolution, reframe.ratio)
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const context = canvas.getContext('2d', { alpha: false })
  if (!context) throw new Error('This browser could not create the export canvas.')
  context.imageSmoothingEnabled = true
  context.imageSmoothingQuality = 'high'
  await loadSubtitleFont(overrides.font ?? template.font, subtitleFontWeight(overrides.font ?? template.font), template.rtl)
  if (signal.aborted) throw new DOMException('Export cancelled.', 'AbortError')

  onProgress({
    progress: 0,
    elapsed: 0,
    remaining: selectedDuration,
    outputWidth: width,
    outputHeight: height,
    message: 'Preparing original-quality audio…',
  })
  const wav = options.audioRange
    ? await extractRangeWav(file, options.audioRange.start, options.audioRange.end, signal, (progress) => onProgress({
      progress: 0,
      elapsed: 0,
      remaining: selectedDuration,
      outputWidth: width,
      outputHeight: height,
      message: `Preparing selected-range audio… ${progress}%`,
    }))
    : await extractOriginalQualityWav(file, (progress) => onProgress({
      progress: 0,
      elapsed: 0,
      remaining: selectedDuration,
      outputWidth: width,
      outputHeight: height,
      message: `${progress.message} ${progress.progress}%`,
    }), video.duration)
  if (signal.aborted) throw new DOMException('Export cancelled.', 'AbortError')
  const selectedWav = options.audioRange ? wav : await trimOriginalQualityWav(wav, trimStart, trimEnd)
  const editedWav = keepRanges.length === 1
    ? selectedWav
    : await cutWavByKeepRanges(selectedWav, keepRanges, trimStart)
  const wavHeader = new DataView(await editedWav.slice(0, 44).arrayBuffer())
  const sourceAudioSampleRate = wavHeader.getUint32(24, true)
  const sourceAudioChannels = wavHeader.getUint16(22, true)
  if (sourceAudioSampleRate < 8000 || sourceAudioSampleRate > 192000) {
    throw new Error('The extracted audio has an unsupported sample rate.')
  }
  if (sourceAudioChannels < 1) throw new Error('The extracted audio has an unsupported channel layout.')
  if (signal.aborted) throw new DOMException('Export cancelled.', 'AbortError')

  const configs = await getWebCodecsConfigs(width, height, resolution, sourceAudioSampleRate, sourceAudioChannels)
  if (configs) {
    const requestedSpeed = options.speed ?? 'balanced'
    const legacyExport = typeof localStorage !== 'undefined' && localStorage.getItem('ssExportMode') === 'playback'
    const attempt = (speed: ExportSpeed) => exportWithWebCodecs(options, canvas, context, editedWav, sourceAudioSampleRate, configs, width, height, legacyExport ? 'playback' : 'offline', speed)
    const releaseWritable = async () => {
      if (options.writable) {
        try { await options.writable.abort() } catch { /* ignore */ }
        options.writable = undefined
      }
    }
    try {
      return await attempt(requestedSpeed)
    } catch (error) {
      if (signal.aborted || (error instanceof DOMException && error.name === 'AbortError')) throw error
      await releaseWritable()
      // Out-of-memory or encoder failure: retry once with a smaller queue before
      // falling back to the (slower) recorder path.
      if (requestedSpeed !== 'low') {
        console.warn('WebCodecs export hit an error; retrying once in Low memory mode.', error)
        try {
          return await attempt('low')
        } catch (retryError) {
          if (signal.aborted || (retryError instanceof DOMException && retryError.name === 'AbortError')) throw retryError
          console.warn('WebCodecs MP4 export failed; using the local FFmpeg muxer.', retryError)
          video.pause()
        }
      } else {
        console.warn('WebCodecs MP4 export failed; using the local FFmpeg muxer.', error)
        video.pause()
      }
    }
  }

  // A writable was offered but the streaming path was not used; release it.
  if (options.writable) {
    try { await options.writable.abort() } catch { /* ignore */ }
  }

  const supported = getSupportedVideoRecorder()
  const startedAt = performance.now()
  const videoOnly = await recordVideoOnly(
    options, canvas, context, supported, width, height,
  )
  if (signal.aborted) throw new DOMException('Export cancelled.', 'AbortError')
  onProgress({
    progress: 95,
    elapsed: (performance.now() - startedAt) / 1000,
    remaining: 0,
    outputWidth: width,
    outputHeight: height,
    message: 'Muxing clean original audio…',
  })
  const blob = await muxVideoWithWav(videoOnly, editedWav, supported.extension, signal, (progress) => onProgress({
    progress: 95 + Math.round(progress * 5),
    elapsed: (performance.now() - startedAt) / 1000,
    remaining: 0,
    outputWidth: width,
    outputHeight: height,
    message: 'Muxing clean original audio…',
  }), trimStart > 0 || trimEnd < video.duration || keepRanges.length !== 1 ? selectedDuration : undefined)
  return { blob, extension: supported.extension, outputWidth: width, outputHeight: height }
}
