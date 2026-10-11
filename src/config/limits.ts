/**
 * Single source of truth for every product limit.
 *
 * The app imports these values, and the build-time prerender script reads them
 * too (Node strips the types), so all user-facing copy, the FAQ, the SEO pages
 * and `llms.txt` stay in sync with the real limits.
 */

/** Maximum duration of a prepared video segment, in seconds. */
export const MAX_VIDEO_SECONDS = 600
/** Largest accepted source video, in megabytes. */
export const MAX_VIDEO_MB = 500
/** Largest source file accepted for local processing, in megabytes. */
export const MAX_FILE_HARD_MB = 4096
/** Longest audio sent in a single transcription request, in seconds. */
export const MAX_AUDIO_CHUNK_SECONDS = 120
/** Overlap between transcription chunks so no word is lost at a boundary. */
export const AUDIO_CHUNK_OVERLAP_SECONDS = 1

/** Soft warning threshold: longer clips get a memory/time notice. */
export const LONG_VIDEO_WARNING_SECONDS = 300
/** `navigator.deviceMemory` at or below this gets a "use 720p" hint. */
export const LOW_MEMORY_DEVICE_GB = 4
/** Resolution recommended for long clips or low-memory devices. */
export const RECOMMENDED_LONG_EXPORT_RESOLUTION = '720p' as const

/**
 * Server-side transcription quota, counted in AUDIO SECONDS (not requests).
 * These mirror the defaults in `public/api/config.example.php`.
 */
export const AUDIO_SECONDS_PER_HOUR = 1800
export const AUDIO_SECONDS_PER_DAY = 5400
export const AUDIO_SECONDS_GLOBAL_PER_HOUR = 7200
export const AUDIO_SECONDS_GLOBAL_PER_DAY = 28800

/** Provider (Groq free tier) reference ceilings, for documentation only. */
export const PROVIDER_AUDIO_SECONDS_PER_HOUR = 7200
export const PROVIDER_AUDIO_SECONDS_PER_DAY = 28800

export const MAX_VIDEO_MINUTES = MAX_VIDEO_SECONDS / 60
export const VIDEO_LIMIT_LABEL = `${MAX_VIDEO_MINUTES} minutes`
export const SIZE_LIMIT_LABEL = `${MAX_VIDEO_MB} MB`
export const CHUNK_LIMIT_LABEL = `${MAX_AUDIO_CHUNK_SECONDS} seconds`

/** "2:05" style clock for messages. */
export function formatClock(seconds: number) {
  const safe = Math.max(0, Math.round(seconds))
  return `${Math.floor(safe / 60)}:${String(safe % 60).padStart(2, '0')}`
}

/**
 * Rough offline-export estimate in seconds. Encoding speed depends on hardware,
 * so this is intentionally conservative and used only for a soft hint.
 */
export function estimateExportSeconds(durationSeconds: number, resolution: string) {
  const basisPointsPerSecond = resolution === '1080p' ? 11 : resolution === '720p' ? 5.5 : 3
  return Math.max(3, Math.round(durationSeconds * basisPointsPerSecond * 0.35))
}
