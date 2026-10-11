import workerURL from '@ffmpeg/ffmpeg/worker?url'
import type { FFmpeg, FFFSType } from '@ffmpeg/ffmpeg'
import { MAX_VIDEO_SECONDS } from '../config/limits'

export type AudioExtractionProgress = {
  phase: 'fallback' | 'audio'
  progress: number
  message: string
}

// The whole transcription audio for one clip, at 16 kHz mono 16-bit (32,000 bytes/s).
const MAX_TRANSCRIPTION_AUDIO_BYTES = MAX_VIDEO_SECONDS * 32000 + 44
// Files larger than this cannot be buffered for the browser's decodeAudioData
// without an out-of-memory error, so audio is extracted straight from the file.
const LARGE_FILE_BYTES = 100 * 1024 * 1024
const audioHandler = 'soun'
const WEBM_AUDIO_TRACK_TYPE = 2
let ffmpegPromise: Promise<{ ffmpeg: FFmpeg; mountType: FFFSType }> | undefined

type Mp4Box = { type: string; start: number; end: number; headerSize: number }
type EbmlElement = { id: number; dataStart: number; end: number }

function findMp4Box(bytes: Uint8Array, offset: number, end: number): Mp4Box | null {
  if (offset + 8 > end) return null
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let size = view.getUint32(offset)
  const type = String.fromCharCode(bytes[offset + 4], bytes[offset + 5], bytes[offset + 6], bytes[offset + 7])
  let headerSize = 8
  if (size === 1) {
    if (offset + 16 > end) return null
    const largeSize = view.getBigUint64(offset + 8)
    if (largeSize > BigInt(Number.MAX_SAFE_INTEGER)) return null
    size = Number(largeSize)
    headerSize = 16
  } else if (size === 0) {
    size = end - offset
  }
  if (size < headerSize || offset + size > end) return null
  return { type, start: offset, end: offset + size, headerSize }
}

function mp4BoxChildren(bytes: Uint8Array, start: number, end: number) {
  const boxes: Mp4Box[] = []
  for (let offset = start; offset < end;) {
    const box = findMp4Box(bytes, offset, end)
    if (!box) break
    boxes.push(box)
    offset = box.end
  }
  return boxes
}

function mp4HasAudioTrack(bytes: Uint8Array, moov: Mp4Box) {
  for (const trak of mp4BoxChildren(bytes, moov.start + moov.headerSize, moov.end).filter((box) => box.type === 'trak')) {
    const mdia = mp4BoxChildren(bytes, trak.start + trak.headerSize, trak.end).find((box) => box.type === 'mdia')
    if (!mdia) continue
    const hdlr = mp4BoxChildren(bytes, mdia.start + mdia.headerSize, mdia.end).find((box) => box.type === 'hdlr')
    if (!hdlr) continue
    const handlerOffset = hdlr.start + hdlr.headerSize + 8
    if (
      handlerOffset + 4 <= hdlr.end &&
      String.fromCharCode(...bytes.subarray(handlerOffset, handlerOffset + 4)) === audioHandler
    ) return true
  }
  return false
}

function readEbmlVint(bytes: Uint8Array, offset: number, keepMarker: boolean) {
  if (offset >= bytes.length || bytes[offset] === 0) return null
  let width = 1
  let marker = 0x80
  while (!(bytes[offset] & marker) && width <= 8) {
    width++
    marker >>= 1
  }
  if (width > 8 || offset + width > bytes.length) return null
  let value = keepMarker ? bytes[offset] : bytes[offset] & (marker - 1)
  for (let i = 1; i < width; i++) value = value * 256 + bytes[offset + i]
  return { width, value, unknown: !keepMarker && value === 2 ** (7 * width) - 1 }
}

function readEbmlElement(bytes: Uint8Array, offset: number, limit: number): EbmlElement | null {
  const id = readEbmlVint(bytes, offset, true)
  if (!id) return null
  const size = readEbmlVint(bytes, offset + id.width, false)
  if (!size) return null
  const dataStart = offset + id.width + size.width
  const end = size.unknown ? limit : dataStart + size.value
  if (end > limit || end < dataStart) return null
  return { id: id.value, dataStart, end }
}

function webmTracksHaveAudio(bytes: Uint8Array, tracks: EbmlElement) {
  let entry = tracks.dataStart
  while (entry < tracks.end) {
    const track = readEbmlElement(bytes, entry, tracks.end)
    if (!track) return false
    if (track.id === 0xae) {
      let field = track.dataStart
      while (field < track.end) {
        const element = readEbmlElement(bytes, field, track.end)
        if (!element) break
        if (element.id === 0x83) {
          let value = 0
          for (let i = element.dataStart; i < element.end; i++) value = value * 256 + bytes[i]
          if (value === WEBM_AUDIO_TRACK_TYPE) return true
          break
        }
        field = element.end
      }
    }
    entry = track.end
  }
  return false
}

async function hasMp4AudioTrack(file: Blob) {
  let offset = 0
  while (offset + 8 <= file.size) {
    const header = new Uint8Array(await file.slice(offset, offset + 16).arrayBuffer())
    const box = findMp4Box(header, 0, file.size - offset)
    if (!box) return null
    if (box.type === 'moov') {
      const bytes = new Uint8Array(await file.slice(offset, offset + box.end).arrayBuffer())
      const root = { ...box, start: 0 }
      return mp4HasAudioTrack(bytes, root)
    }
    offset += box.end
  }
  return null
}

async function hasWebmAudioTrack(file: Blob) {
  const prefix = new Uint8Array(await file.slice(0, Math.min(file.size, 4 * 1024 * 1024)).arrayBuffer())
  let offset = 0
  while (offset < prefix.length) {
    const element = readEbmlElement(prefix, offset, prefix.length)
    if (!element) return null
    if (element.id === 0x1654ae6b) return webmTracksHaveAudio(prefix, element)
    offset = element.end
  }
  return null
}

async function validateAudioTrack(file: Blob, filename: string) {
  const mime = file.type.toLowerCase()
  const name = filename.toLowerCase()
  const hasMp4Container = mime.includes('mp4') || mime.includes('quicktime') || /\.(mp4|mov|m4v)$/u.test(name)
  const hasWebmContainer = mime.includes('webm') || name.endsWith('.webm')
  const detected = hasMp4Container
    ? await hasMp4AudioTrack(file)
    : hasWebmContainer
      ? await hasWebmAudioTrack(file)
      : null
  if (detected === false) throw new Error('This video has no audio.')
  return detected
}

/** Normalise a rejected value into an Error. The ffmpeg worker posts `e.toString()`
 *  (a plain string), which would otherwise surface as a generic failure message. */
function toError(error: unknown, fallback = 'Processing failed.'): Error {
  if (error instanceof Error) return error
  if (typeof error === 'string' && error.trim() !== '') return new Error(error)
  return new Error(fallback)
}

async function loadFfmpeg() {
  if (!ffmpegPromise) {
    ffmpegPromise = (async () => {
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
      })
      return { ffmpeg, mountType: FFFSType.WORKERFS }
    })().catch((error: unknown) => {
      ffmpegPromise = undefined
      throw toError(error, 'FFmpeg could not start.')
    })
  }
  return ffmpegPromise
}

function audioContextConstructor() {
  const constructor = window.AudioContext
  if (!constructor) throw new Error('AudioContext is unavailable in this browser.')
  return constructor
}

function writeWav(samples: Float32Array) {
  const data = new DataView(new ArrayBuffer(44 + samples.length * 2))
  const writeString = (offset: number, value: string) => {
    for (let index = 0; index < value.length; index++) data.setUint8(offset + index, value.charCodeAt(index))
  }
  writeString(0, 'RIFF')
  data.setUint32(4, 36 + samples.length * 2, true)
  writeString(8, 'WAVE')
  writeString(12, 'fmt ')
  data.setUint32(16, 16, true)
  data.setUint16(20, 1, true)
  data.setUint16(22, 1, true)
  data.setUint32(24, 16000, true)
  data.setUint32(28, 32000, true)
  data.setUint16(32, 2, true)
  data.setUint16(34, 16, true)
  writeString(36, 'data')
  data.setUint32(40, samples.length * 2, true)
  for (let index = 0; index < samples.length; index++) {
    const sample = Math.max(-1, Math.min(1, samples[index]))
    data.setInt16(44 + index * 2, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true)
  }
  return new Blob([data], { type: 'audio/wav' })
}

function validateWav(wav: Blob, duration: number) {
  if (wav.size <= 44 || wav.size > MAX_TRANSCRIPTION_AUDIO_BYTES) {
    throw new Error(`The extracted audio is ${wav.size > MAX_TRANSCRIPTION_AUDIO_BYTES ? 'unexpectedly large' : 'empty'}.`)
  }
  const wavDuration = duration > 0 ? duration : (wav.size - 44) / 32000
  if (wavDuration > MAX_VIDEO_SECONDS) {
    throw new Error(`This video is longer than ${MAX_VIDEO_SECONDS / 60} minutes. Choose a shorter clip.`)
  }
  return wav
}

function readVideoMetadata(file: Blob) {
  return new Promise<{ duration: number; hasAudioTrack: boolean | undefined }>((resolve, reject) => {
    const video = document.createElement('video')
    const objectUrl = URL.createObjectURL(file)
    const timeout = window.setTimeout(() => finish(new Error('Could not read the video duration. Try a shorter or re-encoded video.')), 15000)
    const tracks = () => (video as HTMLVideoElement & { audioTracks?: { length: number } }).audioTracks
    const cleanup = () => {
      window.clearTimeout(timeout)
      video.removeEventListener('loadedmetadata', onMetadata)
      video.removeEventListener('error', onError)
      video.removeAttribute('src')
      URL.revokeObjectURL(objectUrl)
    }
    const finish = (error?: Error) => {
      const duration = video.duration
      const audioTracks = tracks()
      cleanup()
      if (error) reject(error)
      else resolve({ duration, hasAudioTrack: audioTracks ? audioTracks.length > 0 : undefined })
    }
    const onMetadata = () => {
      if (!Number.isFinite(video.duration)) {
        finish(new Error('Could not read the video duration. Try a shorter or re-encoded video.'))
      } else {
        finish()
      }
    }
    const onError = () => finish(new Error('Could not read the video duration. Try a shorter or re-encoded video.'))
    video.preload = 'metadata'
    video.addEventListener('loadedmetadata', onMetadata)
    video.addEventListener('error', onError)
    video.src = objectUrl
  })
}

async function decodeWithAudioContext(file: Blob, duration: number) {
  const AudioContextConstructor = audioContextConstructor()
  const audioContext = new AudioContextConstructor()
  try {
    const decoded = await audioContext.decodeAudioData(await file.arrayBuffer())
    // Guard against the browser decoder silently truncating long audio (some
    // builds stop after ~20s). If the decoded duration is well short of the
    // known video duration, fall through to the ffmpeg path.
    if (duration > 0) {
      const threshold = Math.max(2, duration * 0.05)
      if (decoded.duration < duration - threshold) {
        throw new Error('The browser decoder truncated the audio; using the ffmpeg decoder instead.')
      }
    }
    const sampleCount = Math.ceil(decoded.duration * 16000)
    const offlineContext = new OfflineAudioContext(1, sampleCount, 16000)
    const source = offlineContext.createBufferSource()
    source.buffer = decoded
    source.connect(offlineContext.destination)
    source.start()
    const rendered = await offlineContext.startRendering()
    return validateWav(writeWav(rendered.getChannelData(0)), duration || decoded.duration)
  } finally {
    await audioContext.close().catch(() => undefined)
  }
}

async function extractWavWithFfmpeg(
  file: Blob,
  filename: string,
  duration: number,
  phase: 'audio' | 'fallback',
  onProgress?: (progress: AudioExtractionProgress) => void,
) {
  const { ffmpeg, mountType } = await loadFfmpeg()
  const inputName = `audio-input${filename.match(/\.[a-z0-9]+$/iu)?.[0] ?? '.mp4'}`
  const outputName = 'subtitle-audio.wav'
  const mountPoint = '/audio-input'
  const message = phase === 'audio' ? 'Extracting audio…' : 'Converting audio with the compatibility decoder…'
  let mounted = false
  const reportProgress = ({ progress }: { progress: number }) => {
    onProgress?.({
      phase,
      progress: Math.max(0, Math.min(100, Math.round(progress * 100))),
      message,
    })
  }
  ffmpeg.on('progress', reportProgress)
  try {
    onProgress?.({ phase, progress: 1, message })
    await ffmpeg.createDir(mountPoint)
    await ffmpeg.mount(mountType, { files: [new File([file], inputName, { type: file.type || 'video/mp4' })] }, mountPoint)
    mounted = true
    const result = await ffmpeg.exec([
      '-i', `${mountPoint}/${inputName}`,
      '-t', String(MAX_VIDEO_SECONDS),
      '-vn',
      '-ac', '1',
      '-ar', '16000',
      '-c:a', 'pcm_s16le',
      outputName,
    ])
    if (result !== 0) throw new Error('FFmpeg could not decode this video’s audio stream.')
    const output = await ffmpeg.readFile(outputName)
    if (typeof output === 'string' || output.byteLength <= 44) throw new Error('This video has no audio.')
    return validateWav(new Blob([output], { type: 'audio/wav' }), duration)
  } catch (error) {
    throw toError(error, 'FFmpeg could not extract audio.')
  } finally {
    ffmpeg.off('progress', reportProgress)
    if (mounted) {
      await ffmpeg.unmount(mountPoint).catch(() => undefined)
      await ffmpeg.deleteDir(mountPoint).catch(() => undefined)
    }
    await ffmpeg.deleteFile(outputName).catch(() => undefined)
  }
}

function writeDecodedWav(buffer: AudioBuffer) {
  const channels = buffer.numberOfChannels
  const bytesPerSample = 2
  const blockAlign = channels * bytesPerSample
  const dataSize = buffer.length * blockAlign
  const data = new DataView(new ArrayBuffer(44 + dataSize))
  const writeString = (offset: number, value: string) => {
    for (let index = 0; index < value.length; index++) data.setUint8(offset + index, value.charCodeAt(index))
  }
  writeString(0, 'RIFF')
  data.setUint32(4, 36 + dataSize, true)
  writeString(8, 'WAVE')
  writeString(12, 'fmt ')
  data.setUint32(16, 16, true)
  data.setUint16(20, 1, true)
  data.setUint16(22, channels, true)
  data.setUint32(24, buffer.sampleRate, true)
  data.setUint32(28, buffer.sampleRate * blockAlign, true)
  data.setUint16(32, blockAlign, true)
  data.setUint16(34, 16, true)
  writeString(36, 'data')
  data.setUint32(40, dataSize, true)
  const channelData = Array.from({ length: channels }, (_, channel) => buffer.getChannelData(channel))
  for (let frame = 0; frame < buffer.length; frame++) {
    for (let channel = 0; channel < channels; channel++) {
      const sample = Math.max(-1, Math.min(1, channelData[channel][frame]))
      data.setInt16(44 + frame * blockAlign + channel * bytesPerSample, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true)
    }
  }
  return new Blob([data], { type: 'audio/wav' })
}

async function decodeOriginalQuality(file: Blob) {
  const audioContext = new (audioContextConstructor())()
  try {
    return writeDecodedWav(await audioContext.decodeAudioData(await file.arrayBuffer()))
  } finally {
    await audioContext.close().catch(() => undefined)
  }
}

export async function trimOriginalQualityWav(wav: Blob, start: number, end: number) {
  if (!(end > start)) throw new Error('Choose a trim range longer than zero seconds.')
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
  const blockAlign = view.getUint16(formatOffset + 12, true)
  const bitsPerSample = view.getUint16(formatOffset + 14, true)
  if (audioFormat !== 1 || channels < 1 || sampleRate < 1 || bitsPerSample !== 16 || blockAlign !== channels * 2 || formatSize !== 16) {
    throw new Error('The original-quality WAV uses an unsupported sample format.')
  }

  const totalFrames = Math.floor(Math.min(dataSize, bytes.length - dataOffset) / blockAlign)
  const firstFrame = Math.max(0, Math.min(totalFrames, Math.round(start * sampleRate)))
  const lastFrame = Math.max(firstFrame, Math.min(totalFrames, Math.round(end * sampleRate)))
  if (lastFrame - firstFrame < 1) throw new Error('The selected range contains no audio samples.')
  const trimDataSize = (lastFrame - firstFrame) * blockAlign
  const trimmed = new Uint8Array(44 + trimDataSize)
  trimmed.set([0x52, 0x49, 0x46, 0x46], 0)
  trimmed.set([0x57, 0x41, 0x56, 0x45], 8)
  trimmed.set(bytes.subarray(formatOffset - 8, formatOffset + formatSize), 12)
  trimmed.set(bytes.subarray(dataOffset - 8, dataOffset), 36)
  trimmed.set(bytes.subarray(dataOffset + firstFrame * blockAlign, dataOffset + lastFrame * blockAlign), 44)
  const trimmedView = new DataView(trimmed.buffer)
  trimmedView.setUint32(4, 36 + trimDataSize, true)
  trimmedView.setUint32(40, trimDataSize, true)
  return new Blob([trimmed], { type: 'audio/wav' })
}
/**
 * Join the kept ranges of a trimmed WAV back to back. The input is the WAV of
 * the whole trim range; `keepRanges` are the kept source-time ranges inside it.
 * A short (≈8 ms) fade-out/fade-in is applied at every join so the output is
 * click-free, and the output length equals the exact sum of the kept ranges.
 */
export async function cutWavByKeepRanges(
  wav: Blob,
  keepRanges: { start: number; end: number }[],
  trimStart: number,
) {
  if (!keepRanges.length) return wav
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
  const blockAlign = view.getUint16(formatOffset + 12, true)
  const bitsPerSample = view.getUint16(formatOffset + 14, true)
  if (audioFormat !== 1 || channels < 1 || sampleRate < 1 || bitsPerSample !== 16 || blockAlign !== channels * 2 || formatSize !== 16) {
    throw new Error('The original-quality WAV uses an unsupported sample format.')
  }

  const totalFrames = Math.floor(Math.min(dataSize, bytes.length - dataOffset) / blockAlign)
  let blocks: { first: number; last: number }[] = []
  for (const range of keepRanges) {
    const first = Math.max(0, Math.min(totalFrames, Math.round((range.start - trimStart) * sampleRate)))
    const last = Math.max(first, Math.min(totalFrames, Math.round((range.end - trimStart) * sampleRate)))
    if (last - first > 0) blocks.push({ first, last })
  }
  if (!blocks.length) throw new Error('The selected edit contains no audio samples.')

  const crossfadeFrames = Math.max(1, Math.round(sampleRate * 0.008))
  const outputFrames = blocks.reduce((total, block) => total + (block.last - block.first), 0)
  const output = new Int16Array(outputFrames * channels)
  let writeFrame = 0
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i]
    const blockFrames = block.last - block.first
    const fadeIn = i > 0 ? Math.min(crossfadeFrames, Math.max(1, Math.floor(blockFrames / 3))) : 0
    const fadeOut = i < blocks.length - 1 ? Math.min(crossfadeFrames, Math.max(1, Math.floor(blockFrames / 3))) : 0
    for (let frame = 0; frame < blockFrames; frame++) {
      let gain = 1
      if (fadeIn > 0 && frame < fadeIn) gain = (frame + 1) / (fadeIn + 1)
      else if (fadeOut > 0 && frame >= blockFrames - fadeOut) gain = (blockFrames - frame) / (fadeOut + 1)
      if (gain >= 1) {
        output.set(
          bytes.subarray(dataOffset + (block.first + frame) * blockAlign, dataOffset + (block.first + frame + 1) * blockAlign),
          writeFrame * channels,
        )
      } else {
        for (let channel = 0; channel < channels; channel++) {
          const sample = view.getInt16(dataOffset + (block.first + frame) * blockAlign + channel * 2, true)
          output[writeFrame * channels + channel] = Math.round(sample * gain)
        }
      }
      writeFrame++
    }
  }

  const outBytes = new Uint8Array(44 + outputFrames * blockAlign)
  outBytes.set([0x52, 0x49, 0x46, 0x46], 0)
  outBytes.set([0x57, 0x41, 0x56, 0x45], 8)
  outBytes.set(bytes.subarray(formatOffset - 8, formatOffset + formatSize), 12)
  outBytes.set(bytes.subarray(dataOffset - 8, dataOffset), 36)
  const outView = new DataView(outBytes.buffer)
  const outputDataSize = outputFrames * blockAlign
  outView.setUint32(4, 36 + outputDataSize, true)
  outView.setUint32(40, outputDataSize, true)
  // Int16Array data is little-endian already; copy the samples directly.
  outBytes.set(new Uint8Array(output.buffer.slice(output.byteOffset, output.byteOffset + output.byteLength)), 44)
  return new Blob([outBytes], { type: 'audio/wav' })
}

export async function extractOriginalQualityWav(
  file: File | Blob,
  onProgress?: (progress: AudioExtractionProgress) => void,
  knownDuration = 0,
) {
  const filename = file instanceof File ? file.name : 'video.mp4'
  let duration = knownDuration
  if (duration > MAX_VIDEO_SECONDS) throw new Error(`This video is longer than ${MAX_VIDEO_SECONDS / 60} minutes. Choose a shorter clip.`)
  const detectedAudioTrack = await validateAudioTrack(file, filename)
  if (detectedAudioTrack === null || duration <= 0) {
    const metadata = await readVideoMetadata(file)
    if (metadata.hasAudioTrack === false) {
      throw new Error('This video has no audio.')
    }
    if (detectedAudioTrack === null && metadata.hasAudioTrack === undefined) {
      throw new Error('Unable to inspect this video’s audio tracks. Try an MP4 or WebM with AAC audio.')
    }
    if (duration <= 0) duration = metadata.duration
  }
  if (duration > MAX_VIDEO_SECONDS) throw new Error(`This video is longer than ${MAX_VIDEO_SECONDS / 60} minutes. Choose a shorter clip.`)

  onProgress?.({ phase: 'audio', progress: 0, message: 'Preparing full-quality WAV download…' })
  try {
    const { ffmpeg } = await loadFfmpeg()
    const { fetchFile } = await import('@ffmpeg/util')
    const inputName = `audio-input${filename.match(/\.[a-z0-9]+$/iu)?.[0] ?? '.mp4'}`
    const outputName = 'original-quality-audio.wav'
    const reportProgress = ({ progress }: { progress: number }) => onProgress?.({
      phase: 'audio',
      progress: Math.max(0, Math.min(100, Math.round(progress * 100))),
      message: 'Extracting original-rate audio…',
    })
    ffmpeg.on('progress', reportProgress)
    try {
      await ffmpeg.writeFile(inputName, await fetchFile(file))
      const result = await ffmpeg.exec(['-i', inputName, '-vn', '-c:a', 'pcm_s16le', outputName])
      if (result !== 0) throw new Error('FFmpeg could not extract the original audio.')
      const output = await ffmpeg.readFile(outputName)
      if (typeof output === 'string' || output.byteLength <= 44) throw new Error('FFmpeg returned an empty WAV result.')
      onProgress?.({ phase: 'audio', progress: 100, message: 'WAV audio is ready.' })
      return new Blob([output], { type: 'audio/wav' })
    } finally {
      ffmpeg.off('progress', reportProgress)
      await Promise.all([
        ffmpeg.deleteFile(inputName).catch(() => undefined),
        ffmpeg.deleteFile(outputName).catch(() => undefined),
      ])
    }
  } catch (ffmpegError) {
    console.warn('FFmpeg could not extract a full-quality WAV; trying browser audio decoding.', ffmpegError)
    onProgress?.({ phase: 'audio', progress: 20, message: 'Trying the browser audio decoder…' })
    try {
      const wav = await decodeOriginalQuality(file)
      if (wav.size <= 44) throw new Error('The decoded audio is empty.')
      onProgress?.({ phase: 'audio', progress: 100, message: 'WAV audio is ready.' })
      return wav
    } catch (decodeError) {
      console.error('Could not extract downloadable audio with either decoder.', { ffmpegError, decodeError })
      if (decodeError instanceof Error && decodeError.message.includes('no audio')) throw decodeError
      throw new Error('Could not extract audio. Try a shorter video or re-encode it with AAC audio.')
    }
  }
}

export async function muxVideoWithWav(
  video: Blob,
  audioWav: Blob,
  extension: 'mp4' | 'webm',
  signal: AbortSignal,
  onProgress?: (progress: number) => void,
  duration?: number,
) {
  const { ffmpeg } = await loadFfmpeg()
  if (signal.aborted) throw new DOMException('Export cancelled.', 'AbortError')
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`
  const videoName = `export-video-${suffix}.${extension}`
  const audioName = `export-audio-${suffix}.wav`
  const outputName = `subtitled-video.${extension}`
  const reportProgress = ({ progress }: { progress: number }) => {
    onProgress?.(Math.max(0, Math.min(1, progress)))
  }
  const abort = () => {
    ffmpeg.terminate()
    ffmpegPromise = undefined
  }
  ffmpeg.on('progress', reportProgress)
  signal.addEventListener('abort', abort, { once: true })
  try {
    await ffmpeg.writeFile(videoName, await (await import('@ffmpeg/util')).fetchFile(video))
    await ffmpeg.writeFile(audioName, await (await import('@ffmpeg/util')).fetchFile(audioWav))
    if (signal.aborted) throw new DOMException('Export cancelled.', 'AbortError')
    const audioCodec = extension === 'mp4' ? 'aac' : 'libopus'
    const args = [
      '-i', videoName,
      '-i', audioName,
      ...(duration === undefined ? [] : ['-t', duration.toFixed(6)]),
      '-map', '0:v:0',
      '-map', '1:a:0',
      '-c:v', 'copy',
      '-c:a', audioCodec,
      '-b:a', '192k',
    ]
    if (extension === 'mp4') args.push('-movflags', '+faststart')
    args.push(outputName)
    const result = await ffmpeg.exec(args)
    if (signal.aborted) throw new DOMException('Export cancelled.', 'AbortError')
    if (result !== 0) throw new Error('The local muxer could not combine the video and source audio.')
    const output = await ffmpeg.readFile(outputName)
    if (typeof output === 'string' || output.byteLength === 0) {
      throw new Error('The local muxer produced an empty video.')
    }
    return new Blob([output], { type: extension === 'mp4' ? 'video/mp4' : 'video/webm' })
  } catch (error) {
    if (signal.aborted || (error instanceof DOMException && error.name === 'AbortError')) {
      throw new DOMException('Export cancelled.', 'AbortError')
    }
    throw error
  } finally {
    ffmpeg.off('progress', reportProgress)
    signal.removeEventListener('abort', abort)
    if (!signal.aborted && ffmpeg.loaded) {
      await Promise.all([
        ffmpeg.deleteFile(videoName).catch(() => undefined),
        ffmpeg.deleteFile(audioName).catch(() => undefined),
        ffmpeg.deleteFile(outputName).catch(() => undefined),
      ])
    }
  }
}

function getFile(file: File | Blob | string) {
  if (typeof file !== 'string') return Promise.resolve(file)
  return fetch(file).then((response) => {
    if (!response.ok) throw new Error(`Could not read the selected video (HTTP ${response.status}).`)
    return response.blob()
  })
}

export async function extractWav(
  file: File | Blob | string,
  onProgress?: (progress: AudioExtractionProgress) => void,
  knownDuration = 0,
): Promise<Blob> {
  const blob = await getFile(file)
  const filename = typeof file === 'string' ? 'video.mp4' : file instanceof File ? file.name : 'video.mp4'
  let duration = knownDuration
  if (duration > MAX_VIDEO_SECONDS) throw new Error(`This video is longer than ${MAX_VIDEO_SECONDS / 60} minutes. Choose a shorter clip.`)
  const detectedAudioTrack = await validateAudioTrack(blob, filename)
  if (detectedAudioTrack === null || duration <= 0) {
    const metadata = await readVideoMetadata(blob)
    if (detectedAudioTrack === null && metadata.hasAudioTrack === false) {
      throw new Error('This video has no audio.')
    }
    if (detectedAudioTrack === null && metadata.hasAudioTrack === undefined) {
      throw new Error('Unable to inspect this video’s audio tracks. Try an MP4 or WebM with AAC audio.')
    }
    if (duration <= 0) duration = metadata.duration
  }
  if (duration > MAX_VIDEO_SECONDS) throw new Error(`This video is longer than ${MAX_VIDEO_SECONDS / 60} minutes. Choose a shorter clip.`)

  // Large videos cannot be buffered for the browser's decodeAudioData without
  // an out-of-memory error, so extract the audio straight from the file with
  // ffmpeg.wasm. The file is mounted (never read whole into memory).
  if (blob.size > LARGE_FILE_BYTES) {
    onProgress?.({ phase: 'audio', progress: 0, message: 'Extracting audio…' })
    return extractWavWithFfmpeg(blob, filename, duration, 'audio', onProgress)
  }

  let primaryError: unknown
  try {
    return await decodeWithAudioContext(blob, duration)
  } catch (error) {
    primaryError = error
    console.warn('AudioContext could not decode this video; trying the compatibility decoder.', error)
  }

  try {
    onProgress?.({ phase: 'fallback', progress: 0, message: 'Audio decoder failed; starting compatibility fallback…' })
    return await extractWavWithFfmpeg(blob, filename, duration, 'fallback', onProgress)
  } catch (fallbackError) {
    const error = toError(fallbackError, 'Audio extraction failed.')
    console.error('Could not extract transcription audio with either decoder.', { primaryError, fallbackError: error })
    throw error
  }
}
