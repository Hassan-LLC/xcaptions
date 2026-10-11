import workerURL from '@ffmpeg/ffmpeg/worker?url'
import type { FFmpeg, FFFSType } from '@ffmpeg/ffmpeg'
import { MAX_VIDEO_MB, MAX_VIDEO_SECONDS } from '../config/limits'

export type VideoMetadata = {
  duration: number
  width: number
  height: number
}

export type VideoPreparationProgress = {
  stage: 'cut' | 'compress'
  progress: number
  remaining?: number
}

export type CutVideoResult = {
  blob: Blob
  duration: number
}

type FfmpegBundle = {
  ffmpeg: FFmpeg
  workerFs: FFFSType
}

const maxVideoBytes = MAX_VIDEO_MB * 1024 * 1024
let ffmpegBundlePromise: Promise<FfmpegBundle> | undefined

/** Normalise a rejected value into an Error. The ffmpeg worker posts `e.toString()`
 *  (a plain string), which would otherwise surface as a generic failure message. */
function toError(error: unknown, fallback = 'Processing failed.'): Error {
  if (error instanceof Error) return error
  if (typeof error === 'string' && error.trim() !== '') return new Error(error)
  return new Error(fallback)
}

export function readVideoMetadata(file: File, signal?: AbortSignal): Promise<VideoMetadata> {
  return new Promise((resolve, reject) => {
    const video = document.createElement('video')
    const objectUrl = URL.createObjectURL(file)
    const timeout = window.setTimeout(() => finish(new Error('We could not read this video. Please choose a shorter or smaller file.')), 30000)
    const cleanup = () => {
      window.clearTimeout(timeout)
      video.removeEventListener('loadedmetadata', onMetadata)
      video.removeEventListener('error', onError)
      signal?.removeEventListener('abort', onAbort)
      video.removeAttribute('src')
      video.load()
      URL.revokeObjectURL(objectUrl)
    }
    const finish = (error?: Error) => {
      const metadata = { duration: video.duration, width: video.videoWidth, height: video.videoHeight }
      cleanup()
      if (error) reject(error)
      else if (!Number.isFinite(metadata.duration) || metadata.duration <= 0 || metadata.width < 1 || metadata.height < 1) {
        reject(new Error('We could not read this video. Please choose a shorter or smaller file.'))
      } else resolve(metadata)
    }
    const onMetadata = () => finish()
    const onError = () => finish(new Error('We could not read this video. Please choose a shorter or smaller file.'))
    const onAbort = () => finish(new DOMException('Video preparation cancelled.', 'AbortError'))
    if (signal?.aborted) {
      onAbort()
      return
    }
    video.preload = 'metadata'
    video.muted = true
    video.addEventListener('loadedmetadata', onMetadata, { once: true })
    video.addEventListener('error', onError, { once: true })
    signal?.addEventListener('abort', onAbort, { once: true })
    video.src = objectUrl
  })
}

async function loadFfmpeg(signal?: AbortSignal) {
  if (!ffmpegBundlePromise) {
    ffmpegBundlePromise = (async (): Promise<FfmpegBundle> => {
      const [{ FFmpeg, FFFSType }, { toBlobURL }] = await Promise.all([
        import('@ffmpeg/ffmpeg'),
        import('@ffmpeg/util'),
      ])
      const ffmpeg = new FFmpeg()
      const coreBaseURL = new URL(`${import.meta.env.BASE_URL}ffmpeg/`, window.location.href)
      await ffmpeg.load({
        coreURL: await toBlobURL(new URL('ffmpeg-core.js', coreBaseURL).href, 'text/javascript'),
        wasmURL: await toBlobURL(new URL('ffmpeg-core.wasm', coreBaseURL).href, 'application/wasm'),
        classWorkerURL: workerURL,
      }, signal ? { signal } : undefined)
      return { ffmpeg, workerFs: FFFSType.WORKERFS }
    })().catch((error: unknown) => {
      ffmpegBundlePromise = undefined
      throw toError(error, 'FFmpeg could not start.')
    })
  }
  return ffmpegBundlePromise
}

function throwIfCancelled(signal: AbortSignal) {
  if (signal.aborted) throw new DOMException('Video preparation cancelled.', 'AbortError')
}

async function probeOutput(ffmpeg: FFmpeg, outputName: string, probeName: string) {
  const result = await ffmpeg.ffprobe([
    '-v', 'error',
    '-show_entries', 'format=duration,size',
    '-of', 'default=noprint_wrappers=1',
    outputName,
    '-o', probeName,
  ])
  if (result !== 0) throw new Error('Could not inspect the prepared video.')
  const output = await ffmpeg.readFile(probeName)
  if (typeof output === 'string') throw new Error('Could not inspect the prepared video.')
  const values = new TextDecoder().decode(output).split(/\r?\n/u)
  const duration = Number(values.find((value) => value.startsWith('duration='))?.split('=')[1])
  const size = Number(values.find((value) => value.startsWith('size='))?.split('=')[1])
  if (!Number.isFinite(duration) || !Number.isFinite(size) || duration <= 0 || size <= 0) {
    throw new Error('Could not inspect the prepared video.')
  }
  return { duration, size }
}

async function mountOriginal(ffmpeg: FFmpeg, mountType: FFFSType, file: File) {
  const mountPoint = '/original'
  const inputName = file.name.replace(/[\\/]/gu, '_') || 'original-video'
  await ffmpeg.createDir(mountPoint)
  await ffmpeg.mount(mountType, { files: [new File([file], inputName, { type: file.type })] }, mountPoint)
  return { mountPoint, inputPath: `${mountPoint}/${inputName}` }
}

export async function cutVideoClip(
  file: File,
  start: number,
  originalDuration: number,
  signal: AbortSignal,
  onProgress: (progress: number) => void,
): Promise<CutVideoResult> {
  const { ffmpeg, workerFs: mountType } = await loadFfmpeg(signal)
  throwIfCancelled(signal)
  let mounted = false
  const outputName = `prepared-${Date.now()}.mp4`
  const probeName = `prepared-${Date.now()}.txt`
  const reportProgress = ({ progress }: { progress: number }) => onProgress(Math.max(0, Math.min(100, Math.round(progress * 100))))
  const terminate = () => {
    ffmpegBundlePromise = undefined
    ffmpeg.terminate()
  }
  ffmpeg.on('progress', reportProgress)
  signal.addEventListener('abort', terminate, { once: true })
  try {
    const input = await mountOriginal(ffmpeg, mountType, file)
    mounted = true
    throwIfCancelled(signal)
    const duration = Math.min(MAX_VIDEO_SECONDS, originalDuration - start)
    if (duration < 0.5) throw new Error('Choose a part of the video that is at least half a second long.')
    const result = await ffmpeg.exec([
      '-ss', String(start),
      '-t', String(duration),
      '-i', input.inputPath,
      '-map', '0:v:0',
      '-map', '0:a?',
      '-sn',
      '-dn',
      '-c', 'copy',
      '-movflags', '+faststart',
      outputName,
    ], undefined, { signal })
    throwIfCancelled(signal)
    if (result !== 0) throw new Error('The video could not be remuxed.')
    const output = await probeOutput(ffmpeg, outputName, probeName)
    const data = await ffmpeg.readFile(outputName)
    if (typeof data === 'string' || data.byteLength === 0) throw new Error('The prepared video is empty.')
    return { blob: new Blob([data], { type: 'video/mp4' }), duration: output.duration }
  } catch (error) {
    throw toError(error, 'The video could not be prepared.')
  } finally {
    ffmpeg.off('progress', reportProgress)
    signal.removeEventListener('abort', terminate)
    if (ffmpeg.loaded && !signal.aborted) {
      if (mounted) {
        await ffmpeg.unmount('/original').catch(() => undefined)
        await ffmpeg.deleteDir('/original').catch(() => undefined)
      }
      await Promise.all([
        ffmpeg.deleteFile(outputName).catch(() => undefined),
        ffmpeg.deleteFile(probeName).catch(() => undefined),
      ])
    }
  }
}

export async function compressVideoClip(
  file: File,
  start: number,
  duration: number,
  signal: AbortSignal,
  onProgress: (progress: number, remainingSeconds?: number) => void,
): Promise<Blob> {
  const { ffmpeg, workerFs: mountType } = await loadFfmpeg(signal)
  throwIfCancelled(signal)
  let mounted = false
  const outputName = `compressed-${Date.now()}.mp4`
  const startedAt = Date.now()
  const reportProgress = ({ progress }: { progress: number }) => {
    const ratio = Math.max(0, Math.min(1, progress))
    const elapsed = (Date.now() - startedAt) / 1000
    const remaining = ratio > 0.001 ? Math.max(0, Math.round((elapsed / ratio) * (1 - ratio))) : undefined
    onProgress(Math.max(0, Math.min(100, Math.round(ratio * 100))), remaining)
  }
  const terminate = () => {
    ffmpegBundlePromise = undefined
    ffmpeg.terminate()
  }
  ffmpeg.on('progress', reportProgress)
  signal.addEventListener('abort', terminate, { once: true })
  try {
    const input = await mountOriginal(ffmpeg, mountType, file)
    mounted = true
    throwIfCancelled(signal)
    const audioRate = 128_000
    // Total bitrate that fits the clip under MAX_VIDEO_MB with a safety margin,
    // converted from bytes to bits. For a 10-minute clip this is ≈6.3 Mbps,
    // which is visually near-lossless for 1080p.
    const targetTotalRate = Math.floor(maxVideoBytes * 8 / duration * 0.9)
    const videoRate = Math.max(200_000, targetTotalRate - audioRate)
    const result = await ffmpeg.exec([
      '-ss', String(start),
      '-t', String(duration),
      '-i', input.inputPath,
      '-map', '0:v:0',
      '-map', '0:a?',
      '-sn',
      '-dn',
      '-c:v', 'libx264',
      '-preset', 'veryfast',
      '-b:v', String(videoRate),
      '-maxrate', String(videoRate),
      '-bufsize', String(videoRate * 2),
      '-c:a', 'aac',
      '-b:a', String(audioRate),
      '-movflags', '+faststart',
      outputName,
    ], undefined, { signal })
    throwIfCancelled(signal)
    if (result !== 0) throw new Error('The video could not be compressed.')
    const data = await ffmpeg.readFile(outputName)
    if (typeof data === 'string' || data.byteLength === 0) throw new Error('The prepared video is empty.')
    return new Blob([data], { type: 'video/mp4' })
  } catch (error) {
    throw toError(error, 'The video could not be compressed.')
  } finally {
    ffmpeg.off('progress', reportProgress)
    signal.removeEventListener('abort', terminate)
    if (ffmpeg.loaded && !signal.aborted) {
      if (mounted) {
        await ffmpeg.unmount('/original').catch(() => undefined)
        await ffmpeg.deleteDir('/original').catch(() => undefined)
      }
      await ffmpeg.deleteFile(outputName).catch(() => undefined)
    }
  }
}

export async function extractRangeWav(
  file: File,
  start: number,
  end: number,
  signal?: AbortSignal,
  onProgress?: (progress: number) => void,
  mono = false,
) {
  const { ffmpeg, workerFs: mountType } = await loadFfmpeg(signal)
  if (signal?.aborted) throw new DOMException('Audio extraction cancelled.', 'AbortError')
  const outputName = `audio-range-${Date.now()}.wav`
  let mounted = false
  const reportProgress = ({ progress }: { progress: number }) => onProgress?.(Math.max(0, Math.min(100, Math.round(progress * 100))))
  const terminate = () => {
    ffmpegBundlePromise = undefined
    ffmpeg.terminate()
  }
  ffmpeg.on('progress', reportProgress)
  signal?.addEventListener('abort', terminate, { once: true })
  try {
    const input = await mountOriginal(ffmpeg, mountType, file)
    mounted = true
    const result = await ffmpeg.exec([
      '-ss', String(start),
      '-t', String(end - start),
      '-i', input.inputPath,
      '-map', '0:a:0',
      '-vn',
      ...(mono ? ['-ac', '1', '-ar', '16000'] : []),
      '-c:a', 'pcm_s16le',
      outputName,
    ], undefined, signal ? { signal } : undefined)
    if (signal?.aborted) throw new DOMException('Audio extraction cancelled.', 'AbortError')
    if (result !== 0) throw new Error('This video has no usable audio track.')
    const output = await ffmpeg.readFile(outputName)
    if (typeof output === 'string' || output.byteLength <= 44) throw new Error('This video has no usable audio track.')
    return new Blob([output], { type: 'audio/wav' })
  } catch (error) {
    throw toError(error, 'FFmpeg could not extract audio.')
  } finally {
    ffmpeg.off('progress', reportProgress)
    signal?.removeEventListener('abort', terminate)
    if (ffmpeg.loaded && !signal?.aborted) {
      if (mounted) {
        await ffmpeg.unmount('/original').catch(() => undefined)
        await ffmpeg.deleteDir('/original').catch(() => undefined)
      }
      await Promise.all([
        ffmpeg.deleteFile(outputName).catch(() => undefined),
      ])
    }
  }
}
