import { type Word } from './chunker'
import { AUDIO_CHUNK_OVERLAP_SECONDS, MAX_AUDIO_CHUNK_SECONDS } from '../config/limits'

/**
 * Chunked transcription.
 *
 * A 10-minute 16 kHz mono WAV is about 19 MB, which is larger than the 10 MB
 * the server accepts per request, so the audio is split into chunks of at most
 * {@link MAX_AUDIO_CHUNK_SECONDS} seconds. Each cut lands on the quietest point
 * near the boundary and neighbours overlap by {@link AUDIO_CHUNK_OVERLAP_SECONDS}
 * so no word is lost. The chunks are sent one at a time and the word timings are
 * merged back into a single, gap-free list.
 */

export type TranscriptionChunk = {
  index: number
  /** Absolute start time of this chunk, in seconds. */
  start: number
  /** Absolute end time of this chunk, in seconds (includes the overlap). */
  end: number
  blob: Blob
}

/** Languages users can choose for transcription (plus Auto). Keep the codes in
 * sync with the whitelist in `public/api/transcribe.php`. */
export type TranscriptionLanguageOption = { code: string; label: string }

export const transcriptionLanguageOptions: TranscriptionLanguageOption[] = [
  { code: 'ur', label: 'Urdu' },
  { code: 'ar', label: 'Arabic' },
  { code: 'en', label: 'English' },
  { code: 'hi', label: 'Hindi' },
  { code: 'fa', label: 'Persian' },
  { code: 'tr', label: 'Turkish' },
  { code: 'es', label: 'Spanish' },
  { code: 'fr', label: 'French' },
]

/** Groq's verbose_json `language` field is the full English language name. */
const languageNameToCode: Record<string, string> = {
  english: 'en',
  urdu: 'ur',
  arabic: 'ar',
  hindi: 'hi',
  persian: 'fa',
  turkish: 'tr',
  spanish: 'es',
  french: 'fr',
  hebrew: 'he',
}

/** Map a verbose_json language name to a code, or null when unrecognised. */
function languageCodeFromName(name: unknown): string | null {
  if (typeof name !== 'string') return null
  return languageNameToCode[name.trim().toLowerCase()] ?? null
}

export function languageLabelFor(code: string | null): string | null {
  if (!code) return null
  const option = transcriptionLanguageOptions.find((item) => item.code === code)
  if (option) return option.label
  if (code === 'he') return 'Hebrew'
  return null
}

export function isRtlLanguage(code: string | null): boolean {
  return code === 'ar' || code === 'ur' || code === 'fa' || code === 'he'
}

type ParsedWav = {
  pcm: Float32Array
  sampleRate: number
}

/** Read a 16-bit PCM WAV of any channel count into mono floats. */
function parseWav(bytes: Uint8Array): ParsedWav {
  if (bytes.length < 44 || String.fromCharCode(...bytes.subarray(0, 4)) !== 'RIFF' || String.fromCharCode(...bytes.subarray(8, 12)) !== 'WAVE') {
    throw new Error('The extracted audio is not a valid WAV file.')
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let offset = 12
  let formatOffset = -1
  let dataOffset = -1
  let dataSize = 0
  while (offset + 8 <= bytes.length) {
    const chunkId = String.fromCharCode(...bytes.subarray(offset, offset + 4))
    const chunkSize = view.getUint32(offset + 4, true)
    const chunkStart = offset + 8
    if (chunkStart + chunkSize > bytes.length) break
    if (chunkId === 'fmt ') {
      formatOffset = chunkStart
    } else if (chunkId === 'data') {
      dataOffset = chunkStart
      dataSize = chunkSize
      break
    }
    offset = chunkStart + chunkSize + (chunkSize % 2)
  }
  if (formatOffset < 0 || dataOffset < 0) throw new Error('The extracted WAV is missing its format or sample data.')
  const audioFormat = view.getUint16(formatOffset, true)
  const channels = view.getUint16(formatOffset + 2, true)
  const sampleRate = view.getUint32(formatOffset + 4, true)
  const bitsPerSample = view.getUint16(formatOffset + 14, true)
  if (audioFormat !== 1 || channels < 1 || sampleRate < 1 || bitsPerSample !== 16) {
    throw new Error('The extracted audio has an unsupported format for transcription.')
  }
  const frames = Math.floor(Math.min(dataSize, bytes.length - dataOffset) / (channels * 2))
  const pcm = new Float32Array(frames)
  for (let frame = 0; frame < frames; frame++) {
    let sum = 0
    for (let channel = 0; channel < channels; channel++) {
      sum += view.getInt16(dataOffset + (frame * channels + channel) * 2, true) / 0x8000
    }
    pcm[frame] = sum / channels
  }
  return { pcm, sampleRate }
}

function encodeMono16Wav(samples: Float32Array, sampleRate: number): Blob {
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
  data.setUint32(24, sampleRate, true)
  data.setUint32(28, sampleRate * 2, true)
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

/** Quietest point near `latest` (seconds), searching back up to `windowSeconds`. */
function findQuietCut(pcm: Float32Array, sampleRate: number, latest: number, windowSeconds = 3) {
  const center = Math.min(pcm.length, Math.round(latest * sampleRate))
  const span = Math.min(Math.round(windowSeconds * sampleRate), center)
  const start = Math.max(0, center - span)
  const windowFrames = Math.max(1, Math.round(0.03 * sampleRate))
  let best = center
  let bestEnergy = Number.POSITIVE_INFINITY
  for (let offset = start; offset + windowFrames <= center; offset += windowFrames) {
    let sum = 0
    for (let i = offset; i < offset + windowFrames; i++) sum += pcm[i] * pcm[i]
    if (sum < bestEnergy) {
      bestEnergy = sum
      best = offset + Math.round(windowFrames / 2)
    }
  }
  return best / sampleRate
}

/** Split a whole-clip WAV into transcription chunks. */
export async function splitTranscriptionChunks(wav: Blob): Promise<TranscriptionChunk[]> {
  const { pcm, sampleRate } = parseWav(new Uint8Array(await wav.arrayBuffer()))
  const totalSeconds = pcm.length / sampleRate
  if (totalSeconds <= 0) throw new Error('The extracted audio is empty.')

  const chunks: TranscriptionChunk[] = []
  let cursor = 0
  let index = 0
  for (;;) {
    const hardEnd = Math.min(cursor + MAX_AUDIO_CHUNK_SECONDS, totalSeconds)
    const isLast = hardEnd >= totalSeconds - 0.001
    const cut = isLast || hardEnd < 3
      ? hardEnd
      : Math.max(cursor + 1, Math.min(hardEnd, findQuietCut(pcm, sampleRate, hardEnd)))
    const chunkEnd = Math.min(cut + AUDIO_CHUNK_OVERLAP_SECONDS, totalSeconds)
    const startSample = Math.floor(cursor * sampleRate)
    const endSample = Math.min(pcm.length, Math.ceil(chunkEnd * sampleRate))
    chunks.push({
      index,
      start: cursor,
      end: chunkEnd,
      blob: encodeMono16Wav(pcm.subarray(startSample, endSample), sampleRate),
    })
    index += 1
    if (cut >= totalSeconds - 0.001) break
    cursor = cut
  }
  return chunks
}

export type TranscribeError = Error & { retryAfterSeconds?: number; status?: number; retryable?: boolean }

async function readError(response: Response): Promise<TranscribeError> {
  let message = 'Transcription failed.'
  let retryAfterSeconds: number | undefined
  try {
    const data = await response.json() as { error?: unknown; retryAfterSeconds?: unknown }
    if (typeof data.error === 'string' && data.error) message = data.error
    if (typeof data.retryAfterSeconds === 'number' && data.retryAfterSeconds > 0) retryAfterSeconds = data.retryAfterSeconds
  } catch {
    // Non-JSON error body; keep the default message.
  }
  const error = new Error(message) as TranscribeError
  error.retryAfterSeconds = retryAfterSeconds
  error.status = response.status
  return error
}

const MAX_RETRIES = 3
const RETRY_BASE_DELAY_MS = 1000
const MAX_RETRY_AFTER_SECONDS = 90

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError'
}

function wait(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('Transcription cancelled.', 'AbortError'))
      return
    }
    const onAbort = () => {
      clearTimeout(timeout)
      reject(new DOMException('Transcription cancelled.', 'AbortError'))
    }
    const timeout = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * Delay before retrying, or null to give up. Retries network errors, 429 (only
 * when the server's retry-after is short enough to matter) and 502/503. Never
 * retries 400/403/413/415 or an aborted request.
 */
function retryDelayMs(error: unknown, attempt: number): number | null {
  const err = error as TranscribeError
  if (err.retryable === true) return RETRY_BASE_DELAY_MS * 2 ** attempt
  const status = err.status ?? 0
  if (status === 502 || status === 503) return RETRY_BASE_DELAY_MS * 2 ** attempt
  if (status === 429) {
    const retryAfter = err.retryAfterSeconds
    if (typeof retryAfter === 'number' && retryAfter > 0 && retryAfter <= MAX_RETRY_AFTER_SECONDS) {
      return retryAfter * 1000
    }
    return null
  }
  return null
}

/** Result of transcribing one chunk: its words plus the language Groq reported. */
export type ChunkTranscriptionResult = { words: Word[]; language: string | null }

/** Send one chunk and return its words in absolute (whole-clip) time. */
async function transcribeChunkOnce(chunk: TranscriptionChunk, language?: string, signal?: AbortSignal): Promise<ChunkTranscriptionResult> {
  const formData = new FormData()
  formData.append('file', chunk.blob, 'audio.wav')
  if (language && language !== 'auto') {
    formData.append('language', language)
  }
  if (import.meta.env.DEV) {
    formData.append('model', 'whisper-large-v3-turbo')
    formData.append('response_format', 'verbose_json')
    formData.append('timestamp_granularities[]', 'word')
  }

  const endpoint = new URL(`${import.meta.env.BASE_URL}api/transcribe.php`, window.location.href)
  let response: Response
  try {
    response = await fetch(endpoint, { method: 'POST', body: formData, signal })
  } catch (error) {
    if (signal?.aborted || isAbortError(error)) {
      throw new DOMException('Transcription cancelled.', 'AbortError')
    }
    const networkError = new Error('Could not reach the transcription service. Check your connection and try again.') as TranscribeError
    networkError.retryable = true
    throw networkError
  }
  if (!response.ok) throw await readError(response)

  const data = await response.json() as { words?: unknown; language?: unknown }
  const detectedLanguage = languageCodeFromName(data.language)
  const words = Array.isArray(data.words)
    ? data.words.filter((word): word is Word => !!word
      && typeof word === 'object'
      && typeof (word as Word).word === 'string'
      && Number.isFinite((word as Word).start)
      && Number.isFinite((word as Word).end))
    : []
  return {
    words: words.map((word) => ({
      word: word.word,
      start: word.start + chunk.start,
      end: word.end + chunk.start,
    })),
    language: detectedLanguage,
  }
}

/** Send one chunk with up to {@link MAX_RETRIES} retries for transient failures. */
export async function transcribeChunk(chunk: TranscriptionChunk, language?: string, signal?: AbortSignal): Promise<ChunkTranscriptionResult> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await transcribeChunkOnce(chunk, language, signal)
    } catch (error) {
      if (signal?.aborted || isAbortError(error)) throw error
      if (attempt >= MAX_RETRIES) throw error
      const delay = retryDelayMs(error, attempt)
      if (delay === null) throw error
      await wait(delay, signal)
    }
  }
}

function normalizeWord(word: string) {
  return word.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '')
}

/**
 * Merge per-chunk words into one ordered list, dropping the duplicates that
 * live in the overlap between neighbouring chunks.
 */
export function mergeChunkWords(chunks: TranscriptionChunk[], perChunk: Word[][]): Word[] {
  const accepted: Word[] = []
  chunks.forEach((chunk, index) => {
    const words = (perChunk[index] ?? []).slice().sort((a, b) => a.start - b.start)
    for (const word of words) {
      if (!word.word.trim()) continue
      const normalized = normalizeWord(word.word)
      let duplicate = false
      // Chunks arrive in order, so any duplicate is among the most recent words.
      for (let back = accepted.length - 1; back >= Math.max(0, accepted.length - 40); back--) {
        const candidate = accepted[back]
        if (candidate.start < word.start - 1.5) break
        if (normalizeWord(candidate.word) === normalized && Math.abs(candidate.start - word.start) < 0.6) {
          duplicate = true
          break
        }
      }
      if (duplicate) continue
      accepted.push(word)
    }
    void chunk
  })
  return accepted.sort((a, b) => a.start - b.start)
}

/** Single-request transcription, kept for callers that already send one chunk. */
export async function transcribeAudio(wavBlob: Blob, signal?: AbortSignal): Promise<Word[]> {
  const chunks = await splitTranscriptionChunks(wavBlob)
  const perChunk: Word[][] = []
  for (const chunk of chunks) perChunk.push((await transcribeChunk(chunk, undefined, signal)).words)
  return mergeChunkWords(chunks, perChunk)
}
