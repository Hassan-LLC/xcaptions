import type { SubtitleLine } from './chunker'
import type { TextExportFormat } from './subtitleExport'
import type { ExportResolution } from './exporter'
import type { ReframeState } from './reframe'
import type { SubtitleStyleOverrides } from '../templates/types'
import type { TranslationTarget } from './translate'

const DATABASE_NAME = 'subtitle-studio-projects'
const DATABASE_VERSION = 1
const PROJECTS_STORE = 'projects'
const VIDEOS_STORE = 'videos'

export type DownloadOption = 'subtitles' | 'audio' | 'video'
export type SubtitleDownloadFormat = 'srt' | 'txt' | 'vtt'

export type SavedVideoCut = {
  name: string
  duration: number
  size: number
  start: number
  keptDuration: number
  compressed: boolean
  softLimit: boolean
}

export type SavedProject = {
  id: string
  fileName: string
  fileSize: number
  fileType: string
  lastModified: number
  savedAt: number
  duration: number
  currentTime: number
  lines: SubtitleLine[]
  selectedId: string | null
  templateId: string
  styleOverrides: SubtitleStyleOverrides
  reframe?: ReframeState
  trimRange: { start: number; end: number }
  loopTrim: boolean
  applyTrimToSubtitles: boolean
  exportResolution: ExportResolution
  downloadOption: DownloadOption
  subtitleDownloadFormat: SubtitleDownloadFormat
  textExportFormat: TextExportFormat
  language: string | null
  translationTarget?: TranslationTarget
  showTranslated?: boolean
  cutFrom?: SavedVideoCut
}

export type SavedProjectSummary = Pick<
  SavedProject,
  'id' | 'fileName' | 'fileSize' | 'savedAt' | 'duration'
> & {
  captionCount: number
  cutFrom?: SavedVideoCut
  /** False when only the captions were saved (the video did not fit in storage). */
  hasVideo: boolean
}

function openDatabase() {
  if (typeof indexedDB === 'undefined') {
    return Promise.reject(new Error('Browser storage is unavailable. Auto-save is disabled.'))
  }

  return new Promise<IDBDatabase>((resolve, reject) => {
    let request: IDBOpenDBRequest
    try {
      request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION)
    } catch {
      reject(new Error('Browser storage is blocked. Auto-save is disabled.'))
      return
    }
    request.onupgradeneeded = () => {
      const database = request.result
      if (!database.objectStoreNames.contains(PROJECTS_STORE)) {
        database.createObjectStore(PROJECTS_STORE, { keyPath: 'id' })
      }
      if (!database.objectStoreNames.contains(VIDEOS_STORE)) {
        database.createObjectStore(VIDEOS_STORE)
      }
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(new Error('Could not open browser storage for auto-save.'))
    request.onblocked = () => reject(new Error('Browser storage is busy in another tab. Close other SubtitleStudio tabs and try again.'))
  })
}

function transactionComplete(transaction: IDBTransaction) {
  return new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve()
    transaction.onabort = () => reject(transaction.error ?? new Error('Browser storage could not complete the save.'))
    transaction.onerror = () => reject(transaction.error ?? new Error('Browser storage could not complete the save.'))
  })
}

function requestResult<T>(request: IDBRequest<T>) {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(new Error('Could not read browser storage.'))
  })
}

function isSavedProject(value: unknown): value is SavedProject {
  if (!value || typeof value !== 'object') return false
  const project = value as Partial<SavedProject>
  const isReframe = (reframe: unknown) => !!reframe
    && typeof reframe === 'object'
    && ['original', '9:16', '1:1', '4:5', '16:9'].includes((reframe as { ratio?: unknown }).ratio as string)
    && ['blur', 'fill', 'color'].includes((reframe as { fit?: unknown }).fit as string)
    && Number.isFinite((reframe as { focusX?: unknown }).focusX)
    && Number.isFinite((reframe as { focusY?: unknown }).focusY)
    && Number.isFinite((reframe as { zoom?: unknown }).zoom)
    && typeof (reframe as { backgroundColor?: unknown }).backgroundColor === 'string'
    && typeof (reframe as { socialSafeArea?: unknown }).socialSafeArea === 'boolean'
  const isWord = (word: unknown) => !!word
    && typeof word === 'object'
    && typeof (word as { word?: unknown }).word === 'string'
    && Number.isFinite((word as { start?: number }).start)
    && Number.isFinite((word as { end?: number }).end)
  const isLine = (line: unknown) => !!line
    && typeof line === 'object'
    && typeof (line as { id?: unknown }).id === 'string'
    && typeof (line as { text?: unknown }).text === 'string'
    && Number.isFinite((line as { start?: number }).start)
    && Number.isFinite((line as { end?: number }).end)
    && Array.isArray((line as { words?: unknown }).words)
    && (line as { words: unknown[] }).words.every(isWord)
    && ((line as { originalWords?: unknown }).originalWords === undefined
      || (Array.isArray((line as { originalWords?: unknown }).originalWords)
        && (line as { originalWords: unknown[] }).originalWords.every(isWord)))
    && ((line as { translatedWords?: unknown }).translatedWords === undefined
      || (Array.isArray((line as { translatedWords?: unknown }).translatedWords)
        && (line as { translatedWords: unknown[] }).translatedWords.every(isWord)))
    && ((line as { originalText?: unknown }).originalText === undefined
      || typeof (line as { originalText?: unknown }).originalText === 'string')
    && ((line as { translatedText?: unknown }).translatedText === undefined
      || typeof (line as { translatedText?: unknown }).translatedText === 'string')
  return typeof project.id === 'string'
    && typeof project.fileName === 'string'
    && Number.isFinite(project.fileSize)
    && typeof project.fileType === 'string'
    && typeof project.lastModified === 'number'
    && Number.isFinite(project.savedAt)
    && Number.isFinite(project.duration)
    && Number.isFinite(project.currentTime)
    && Array.isArray(project.lines)
    && project.lines.every(isLine)
    && (project.selectedId === null || typeof project.selectedId === 'string')
    && typeof project.templateId === 'string'
    && !!project.styleOverrides
    && typeof project.styleOverrides === 'object'
    && (project.reframe === undefined || isReframe(project.reframe))
    && !!project.trimRange
    && Number.isFinite(project.trimRange.start)
    && Number.isFinite(project.trimRange.end)
    && typeof project.loopTrim === 'boolean'
    && typeof project.applyTrimToSubtitles === 'boolean'
    && ['480p', '720p', '1080p', 'original'].includes(project.exportResolution ?? '')
    && ['subtitles', 'audio', 'video'].includes(project.downloadOption ?? '')
    && ['srt', 'txt', 'vtt'].includes(project.subtitleDownloadFormat ?? '')
    && ['paragraphs', 'timestamps'].includes(project.textExportFormat ?? '')
    && (project.language === null || project.language === undefined || typeof project.language === 'string')
    && (project.translationTarget === undefined
      || ['en', 'ur', 'roman-ur', 'hi', 'roman-hi', 'ar'].includes(project.translationTarget))
    && (project.showTranslated === undefined || typeof project.showTranslated === 'boolean')
    && (project.cutFrom === undefined || (!!project.cutFrom
      && typeof project.cutFrom.name === 'string'
      && Number.isFinite(project.cutFrom.duration)
      && Number.isFinite(project.cutFrom.size)
      && Number.isFinite(project.cutFrom.start)
      && Number.isFinite(project.cutFrom.keptDuration)
      && typeof project.cutFrom.compressed === 'boolean'
      && typeof project.cutFrom.softLimit === 'boolean'))
}

function summary(project: SavedProject, hasVideo: boolean): SavedProjectSummary {
  return {
    id: project.id,
    fileName: project.fileName,
    fileSize: project.fileSize,
    savedAt: project.savedAt,
    duration: project.duration,
    cutFrom: project.cutFrom,
    captionCount: project.lines.length,
    hasVideo,
  }
}

function transactionError(error: unknown) {
  if (error instanceof DOMException && error.name === 'QuotaExceededError') {
    return new Error('Browser storage is full. Delete an older saved project or make space to continue auto-saving.')
  }
  if (error instanceof DOMException && error.name === 'SecurityError') {
    return new Error('Browser storage is blocked. Auto-save is disabled in this browser session.')
  }
  return error instanceof Error ? error : new Error('Could not save this project in browser storage.')
}

export async function listSavedProjects() {
  const database = await openDatabase()
  try {
    const transaction = database.transaction([PROJECTS_STORE, VIDEOS_STORE], 'readonly')
    const complete = transactionComplete(transaction)
    const projectsRequest = requestResult<unknown[]>(transaction.objectStore(PROJECTS_STORE).getAll())
    const videoKeysRequest = requestResult<IDBValidKey[]>(transaction.objectStore(VIDEOS_STORE).getAllKeys())
    const [rawProjects, videoKeys] = await Promise.all([projectsRequest, videoKeysRequest])
    await complete
    const videoIds = new Set(videoKeys.filter((key): key is string => typeof key === 'string'))
    const valid = rawProjects.filter(isSavedProject)
    const invalidIds = rawProjects
      .filter((project): project is { id: string } => !!project && typeof project === 'object' && typeof (project as { id?: unknown }).id === 'string')
      .filter((project) => !isSavedProject(project))
      .map((project) => project.id)
    if (invalidIds.length > 0) await deleteSavedProjects(invalidIds)
    return {
      projects: valid.sort((a, b) => b.savedAt - a.savedAt).map((project) => summary(project, videoIds.has(project.id))),
      skippedCorruptProjects: invalidIds.length,
    }
  } finally {
    database.close()
  }
}

export async function getSavedProject(id: string) {
  const database = await openDatabase()
  try {
    const transaction = database.transaction([PROJECTS_STORE, VIDEOS_STORE], 'readonly')
    const complete = transactionComplete(transaction)
    const projectRequest = requestResult<unknown>(transaction.objectStore(PROJECTS_STORE).get(id))
    const videoRequest = requestResult<Blob | undefined>(transaction.objectStore(VIDEOS_STORE).get(id))
    const [rawProject, video] = await Promise.all([projectRequest, videoRequest])
    await complete
    if (!isSavedProject(rawProject)) {
      throw new Error('This saved project is incomplete or damaged and cannot be restored.')
    }
    return { project: rawProject, video: video instanceof Blob ? video : undefined }
  } finally {
    database.close()
  }
}

async function writeProject(database: IDBDatabase, project: SavedProject, video?: Blob) {
  const transaction = database.transaction([PROJECTS_STORE, VIDEOS_STORE], 'readwrite')
  const complete = transactionComplete(transaction)
  const projectsStore = transaction.objectStore(PROJECTS_STORE)
  projectsStore.getAll().onsuccess = (event) => {
    const existingProjects = (event.target as IDBRequest<unknown[]>).result
      .filter(isSavedProject)
      .filter((existing) => existing.id !== project.id)
    const keepIds = new Set(
      [...existingProjects, project]
        .sort((a, b) => b.savedAt - a.savedAt)
        .slice(0, 3)
        .map((saved) => saved.id),
    )
    for (const expired of existingProjects) {
      if (keepIds.has(expired.id)) continue
      projectsStore.delete(expired.id)
      transaction.objectStore(VIDEOS_STORE).delete(expired.id)
    }
    projectsStore.put(project)
    if (video) transaction.objectStore(VIDEOS_STORE).put(video, project.id)
  }
  await complete
}

export type SaveProjectResult = {
  /** True when the video blob was stored alongside the captions. */
  videoSaved: boolean
  /** True when the video did not fit, so only the captions/settings were saved. */
  videoSkipped: boolean
}

export async function saveProject(project: SavedProject, video?: Blob): Promise<SaveProjectResult> {
  const database = await openDatabase()
  try {
    try {
      await writeProject(database, project, video)
      return { videoSaved: Boolean(video), videoSkipped: false }
    } catch (error) {
      const quotaExceeded = error instanceof DOMException
        && (error.name === 'QuotaExceededError' || error.name === 'UnknownError')
      if (video && quotaExceeded) {
        // The video is what does not fit; keep the captions and settings.
        await writeProject(database, project, undefined)
        return { videoSaved: false, videoSkipped: true }
      }
      throw error
    }
  } catch (error) {
    throw transactionError(error)
  } finally {
    database.close()
  }
}

export async function deleteSavedProjects(ids: string[]) {
  if (ids.length === 0) return
  const database = await openDatabase()
  try {
    const transaction = database.transaction([PROJECTS_STORE, VIDEOS_STORE], 'readwrite')
    const complete = transactionComplete(transaction)
    for (const id of ids) {
      transaction.objectStore(PROJECTS_STORE).delete(id)
      transaction.objectStore(VIDEOS_STORE).delete(id)
    }
    await complete
  } finally {
    database.close()
  }
}

export async function deleteAllSavedProjects() {
  const database = await openDatabase()
  try {
    const transaction = database.transaction([PROJECTS_STORE, VIDEOS_STORE], 'readwrite')
    const complete = transactionComplete(transaction)
    transaction.objectStore(PROJECTS_STORE).clear()
    transaction.objectStore(VIDEOS_STORE).clear()
    await complete
  } finally {
    database.close()
  }
}

export function getBrowserStorageEstimate() {
  return navigator.storage?.estimate
    ? navigator.storage.estimate()
    : Promise.resolve(null)
}

export function requestPersistentStorage() {
  return navigator.storage?.persist
    ? navigator.storage.persist()
    : Promise.resolve(false)
}
