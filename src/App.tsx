import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { AudioLines, Check, Captions, Download, Film, Languages, X } from 'lucide-react'
import Uploader from './components/Uploader'
import VideoCanvas from './components/VideoCanvas'
import TemplatePicker from './components/TemplatePicker.tsx'
import templates from './templates/templates.json'
import type { SubtitleStyleOverrides, SubtitleTemplate } from './templates/types'
import { formatClock, LONG_VIDEO_WARNING_SECONDS, LOW_MEMORY_DEVICE_GB, MAX_FILE_HARD_MB, MAX_VIDEO_MB, MAX_VIDEO_MINUTES, MAX_VIDEO_SECONDS, RECOMMENDED_LONG_EXPORT_RESOLUTION, estimateExportSeconds } from './config/limits'
import { extractOriginalQualityWav, extractWav, trimOriginalQualityWav, type AudioExtractionProgress } from './lib/audio'
import { mergeChunkWords, splitTranscriptionChunks, transcribeChunk, type TranscriptionChunk } from './lib/transcribe'
import { setBusy } from './lib/version'
import { chunkWords, type SubtitleLine, type Word } from './lib/chunker'
import { CaptionList } from './components/CaptionList'
import { LineEditor } from './components/LineEditor'
import TrimControls from './components/TrimControls'
import ReframeControls from './components/ReframeControls'
import { createDownloadName, createSrt, createTxtNotes, createVtt, downloadBlob, type TextExportFormat } from './lib/subtitleExport'
import { exportVideo, type ExportResolution, type ExportSpeed, type ExportWritable, type VideoExportProgress } from './lib/exporter'
import { changesFramingDrastic, clampReframe, defaultReframe, outputDimensions, ratioValue, type ReframeState } from './lib/reframe'
import { clampTrimRange, trimSubtitleLines } from './lib/trim'
import { translateCaptions, translationTargets, type TranslationTarget } from './lib/translate'
import { compressVideoClip, cutVideoClip, extractRangeWav, readVideoMetadata, type VideoMetadata, type VideoPreparationProgress } from './lib/videoPreparation'
import {
  deleteAllSavedProjects,
  deleteSavedProjects,
  getBrowserStorageEstimate,
  getSavedProject,
  listSavedProjects,
  requestPersistentStorage,
  saveProject,
  type DownloadOption,
  type SavedProject,
  type SavedProjectSummary,
  type SubtitleDownloadFormat,
} from './lib/projectStore'

const templateOptions = templates as SubtitleTemplate[]

const speedOptions: { id: ExportSpeed; label: string; hint: string; factor: number }[] = [
  { id: 'fast', label: 'Fast', hint: 'Max performance, higher memory use.', factor: 0.7 },
  { id: 'balanced', label: 'Balanced', hint: 'Good speed with stable memory use.', factor: 1 },
  { id: 'low', label: 'Low memory', hint: 'Safest for phones, slightly slower.', factor: 1.3 },
]

function createProjectId() {
  return typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
}

function formatSavedTime(timestamp: number) {
  return new Date(timestamp).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
}

function formatStorageSize(bytes: number) {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`
  return `${Math.max(1, Math.round(bytes / 1024))} KB`
}

function timedWords(text: string, start: number, end: number): Word[] {
  const words = text.trim().split(/\s+/u).filter(Boolean)
  const totalWeight = words.reduce((total, word) => total + Math.max(1, Array.from(word).length), 0)
  let elapsedWeight = 0
  const duration = Math.max(0, end - start)
  return words.map((word) => {
    const wordStart = start + duration * elapsedWeight / totalWeight
    elapsedWeight += Math.max(1, Array.from(word).length)
    return {
      word,
      start: wordStart,
      end: start + duration * elapsedWeight / totalWeight,
    }
  })
}

function retimeWords(words: Word[] | undefined, oldStart: number, oldEnd: number, newStart: number, newEnd: number) {
  if (!words) return undefined
  const oldDuration = Math.max(0.001, oldEnd - oldStart)
  const newDuration = Math.max(0.001, newEnd - newStart)
  return words.map((word) => ({
    word: word.word,
    start: newStart + (word.start - oldStart) / oldDuration * newDuration,
    end: newStart + (word.end - oldStart) / oldDuration * newDuration,
  }))
}

type CutProvenance = {
  name: string
  duration: number
  size: number
  start: number
  keptDuration: number
  compressed: boolean
  softLimit: boolean
}

export default function App() {
  const videoRef = useRef<HTMLVideoElement>(null)
  const [file, setFile] = useState<File | null>(null)
  const [originalFile, setOriginalFile] = useState<File | null>(null)
  const [cutProvenance, setCutProvenance] = useState<CutProvenance | null>(null)
  const [showCutNotice, setShowCutNotice] = useState(true)
  const [isPreparingVideo, setIsPreparingVideo] = useState(false)
  const [preparationProgress, setPreparationProgress] = useState<VideoPreparationProgress | null>(null)
  const [alternateStart, setAlternateStart] = useState(0)
  const preparationAbortRef = useRef<AbortController | null>(null)
  const [videoUrl, setVideoUrl] = useState('')
  const [error, setError] = useState('')
  const [template, setTemplate] = useState<SubtitleTemplate>(templateOptions[1])
  const [styleOverrides, setStyleOverrides] = useState<SubtitleStyleOverrides>({})
  const [duration, setDuration] = useState(0)
  const [currentTime, setCurrentTime] = useState(0)
  const [trimRange, setTrimRange] = useState({ start: 0, end: 0 })
  const [loopTrim, setLoopTrim] = useState(false)
  const [applyTrimToSubtitles, setApplyTrimToSubtitles] = useState(true)
  const [downloadPanelOpen, setDownloadPanelOpen] = useState(false)
  const [downloadOption, setDownloadOption] = useState<DownloadOption>('video')
  const [subtitleDownloadFormat, setSubtitleDownloadFormat] = useState<SubtitleDownloadFormat>('srt')
  const [subtitleDownloadComplete, setSubtitleDownloadComplete] = useState(false)
  const [videoDownloadComplete, setVideoDownloadComplete] = useState(false)
  const downloadTriggerRef = useRef<HTMLButtonElement>(null)

  const [lines, setLines] = useState<SubtitleLine[]>([])
  const [translationTarget, setTranslationTarget] = useState<TranslationTarget>('roman-ur')
  const [showTranslated, setShowTranslated] = useState(false)
  const [translationState, setTranslationState] = useState<'idle' | 'translating'>('idle')
  const [translationProgress, setTranslationProgress] = useState<{ batch: number; total: number } | null>(null)
  const [translationError, setTranslationError] = useState('')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [workspaceTab, setWorkspaceTab] = useState<'captions' | 'style' | 'translate'>('captions')
  const workspaceTabRefs = useRef<Array<HTMLButtonElement | null>>([])
  const captionsScrollRef = useRef<HTMLDivElement>(null)
  const [transcribeState, setTranscribeState] = useState<'idle' | 'extracting' | 'fallback' | 'transcribing' | 'done' | 'error'>('idle')
  const [audioProgress, setAudioProgress] = useState<AudioExtractionProgress | null>(null)
  const [transcribeError, setTranscribeError] = useState('')
  const [textExportFormat, setTextExportFormat] = useState<TextExportFormat>('paragraphs')
  const [audioDownloadState, setAudioDownloadState] = useState<'idle' | 'processing' | 'done' | 'error'>('idle')
  const [audioDownloadError, setAudioDownloadError] = useState('')
  const [audioDownloadSize, setAudioDownloadSize] = useState(0)
  const [isExporting, setIsExporting] = useState(false)
  const [exportResolution, setExportResolution] = useState<ExportResolution>('720p')
  const [exportSpeed, setExportSpeed] = useState<ExportSpeed>('balanced')
  const [reframe, setReframe] = useState<ReframeState>(defaultReframe)
  const [exportProgress, setExportProgress] = useState<VideoExportProgress | null>(null)
  const [exportError, setExportError] = useState('')
  const [exportSuccess, setExportSuccess] = useState('')
  const [exportTabHidden, setExportTabHidden] = useState(false)
  const exportAbortController = useRef<AbortController | null>(null)
  const [activeProjectId, setActiveProjectId] = useState(createProjectId)
  const [savedProjects, setSavedProjects] = useState<SavedProjectSummary[]>([])
  const [resumeChoiceRequired, setResumeChoiceRequired] = useState(false)
  const [savedProjectsOpen, setSavedProjectsOpen] = useState(false)
  const [storageReady, setStorageReady] = useState(false)
  const [storageAvailable, setStorageAvailable] = useState(false)
  const [autoSaveEnabled, setAutoSaveEnabled] = useState(false)
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle')
  const [saveNotice, setSaveNotice] = useState('')
  const [lastSavedAt, setLastSavedAt] = useState<number | null>(null)
  const [storageUsage, setStorageUsage] = useState<number | null>(null)
  const [transcribeParts, setTranscribeParts] = useState<{ done: number; total: number } | null>(null)
  const [transcribeFailedPart, setTranscribeFailedPart] = useState<number | null>(null)
  const [relinkFile, setRelinkFile] = useState<{ fileName: string; fileSize: number } | null>(null)
  const activeProjectIdRef = useRef(activeProjectId)
  const currentFileRef = useRef(file)
  const autoSaveEnabledRef = useRef(autoSaveEnabled)
  const storageAvailableRef = useRef(storageAvailable)
  const latestSnapshotRef = useRef<SavedProject | null>(null)
  const savedFileRef = useRef<{ projectId: string; file: File } | null>(null)
  const saveTimerRef = useRef<number | null>(null)
  const saveQueueRef = useRef<Promise<void>>(Promise.resolve())
  const saveNowRef = useRef<() => void>(() => {})
  const transcriptionRef = useRef<{ chunks: TranscriptionChunk[]; perChunk: Word[][]; controller: AbortController; timeOffset: number } | null>(null)

  activeProjectIdRef.current = activeProjectId
  currentFileRef.current = file
  autoSaveEnabledRef.current = autoSaveEnabled
  storageAvailableRef.current = storageAvailable
  latestSnapshotRef.current = file && autoSaveEnabled && storageAvailable && !resumeChoiceRequired ? {
    id: activeProjectId,
    fileName: file.name,
    fileSize: file.size,
    fileType: file.type,
    lastModified: file.lastModified,
    savedAt: Date.now(),
    duration,
    currentTime,
    lines,
    selectedId,
    templateId: template.id,
    styleOverrides,
    reframe,
    trimRange,
    loopTrim,
    applyTrimToSubtitles,
    exportResolution,
    downloadOption,
    subtitleDownloadFormat,
    textExportFormat,
    language: null,
    translationTarget,
    showTranslated,
    cutFrom: cutProvenance ?? undefined,
  } : null

  const closeDownloadPanel = () => {
    setDownloadPanelOpen(false)
    downloadTriggerRef.current?.focus()
  }

  const toggleDownloadPanel = () => {
    if (downloadPanelOpen) {
      closeDownloadPanel()
      return
    }
    setDownloadPanelOpen(true)
  }

  useEffect(() => {
    if (!downloadPanelOpen) return
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeDownloadPanel()
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [downloadPanelOpen])

  useLayoutEffect(() => {
    if (!downloadPanelOpen) return
    document.getElementById(`download-option-${downloadOption}`)?.focus()
  }, [downloadPanelOpen])

  useEffect(() => {
    if (!file) {
      setVideoUrl(prev => {
        if (prev) URL.revokeObjectURL(prev)
        return ''
      })
      return
    }
    const objectUrl = URL.createObjectURL(file)
    setVideoUrl(prev => {
      if (prev) URL.revokeObjectURL(prev)
      return objectUrl
    })
  }, [file])

  // Pick a sensible default export speed for this device, then leave the choice
  // to the user in the export panel.
  useEffect(() => {
    const nav = navigator as Navigator & { deviceMemory?: number; userAgentData?: { mobile?: boolean } }
    const cores = navigator.hardwareConcurrency ?? 0
    const memory = nav.deviceMemory
    const lowMemory = typeof memory === 'number' && memory <= LOW_MEMORY_DEVICE_GB
    const mobile = nav.userAgentData?.mobile === true
    if (lowMemory || (cores > 0 && cores <= 2) || (mobile && lowMemory)) {
      setExportSpeed('low')
    } else if (cores >= 8 && !lowMemory) {
      setExportSpeed('fast')
    }
  }, [])

  // Tell the version checker when a refresh would interrupt work, so the
  // "New version available" toast never reloads mid-transcription or mid-export.
  useEffect(() => {
    const transcribing = transcribeState === 'extracting' || transcribeState === 'fallback' || transcribeState === 'transcribing'
    setBusy(isExporting || transcribing)
  }, [isExporting, transcribeState])

  useEffect(() => {
    let cancelled = false
    const initializeStorage = async () => {
      try {
        const result = await listSavedProjects()
        if (cancelled) return
        setSavedProjects(result.projects)
        setStorageAvailable(true)
        setStorageReady(true)
        setResumeChoiceRequired(result.projects.length > 0)
        setAutoSaveEnabled(result.projects.length === 0)
        if (result.skippedCorruptProjects > 0) {
          setSaveNotice('A damaged saved project was skipped. You can continue with a fresh project.')
        }
        try {
          const estimate = await getBrowserStorageEstimate()
          if (!cancelled && estimate?.usage !== undefined) setStorageUsage(estimate.usage)
        } catch {
          if (!cancelled) setStorageUsage(null)
        }
        void requestPersistentStorage().catch(() => false)
      } catch (storageError) {
        if (cancelled) return
        setStorageReady(true)
        setAutoSaveEnabled(true)
        setStorageAvailable(false)
        setSaveStatus('error')
        setSaveNotice(storageError instanceof Error
          ? storageError.message
          : 'Browser storage is unavailable. Auto-save is disabled.')
      }
    }
    void initializeStorage()
    return () => { cancelled = true }
  }, [])

  const refreshSavedProjects = async () => {
    const result = await listSavedProjects()
    setSavedProjects(result.projects)
    if (result.skippedCorruptProjects > 0) {
      setSaveNotice('A damaged saved project was skipped.')
    }
    try {
      const estimate = await getBrowserStorageEstimate()
      setStorageUsage(estimate?.usage ?? null)
    } catch {
      setStorageUsage(null)
    }
  }

  const saveCurrentProject = () => {
    if (!storageAvailableRef.current || !autoSaveEnabledRef.current || !latestSnapshotRef.current) return
    setSaveStatus('saving')
    saveQueueRef.current = saveQueueRef.current.catch(() => undefined).then(async () => {
      const snapshot = latestSnapshotRef.current
      const currentFile = currentFileRef.current
      if (!snapshot || !currentFile || !storageAvailableRef.current || !autoSaveEnabledRef.current) return
      const savedAt = Date.now()
      const record = { ...snapshot, savedAt }
      const needsVideo = savedFileRef.current?.projectId !== snapshot.id || savedFileRef.current.file !== currentFile
      const result = await saveProject(record, needsVideo ? currentFile : undefined)
      if (activeProjectIdRef.current === snapshot.id && currentFileRef.current === currentFile) {
        savedFileRef.current = result.videoSaved ? { projectId: snapshot.id, file: currentFile } : null
        setLastSavedAt(savedAt)
        setSaveStatus('saved')
        setSaveNotice(result.videoSkipped
          ? 'This video is too large for browser storage, so only the captions, style and trim were saved. When you restore this project you will be asked to re-select the file.'
          : '')
      }
      try {
        await refreshSavedProjects()
      } catch {
        setSaveNotice('The project was saved, but the saved-project list could not be refreshed.')
      }
    }).catch((storageError: unknown) => {
      setSaveStatus('error')
      setSaveNotice(storageError instanceof Error
        ? storageError.message
        : 'Could not save this project in browser storage.')
    })
  }
  saveNowRef.current = saveCurrentProject

  useEffect(() => {
    if (!file || !storageReady || !storageAvailable || !autoSaveEnabled) return
    if (saveTimerRef.current !== null) window.clearTimeout(saveTimerRef.current)
    saveTimerRef.current = window.setTimeout(() => saveNowRef.current(), 800)
    return () => {
      if (saveTimerRef.current !== null) {
        window.clearTimeout(saveTimerRef.current)
        saveTimerRef.current = null
      }
    }
  }, [
    file,
    activeProjectId,
    duration,
    currentTime,
    lines,
    selectedId,
    template,
    styleOverrides,
    reframe,
    trimRange,
    loopTrim,
    applyTrimToSubtitles,
    exportResolution,
    downloadOption,
    subtitleDownloadFormat,
    textExportFormat,
    translationTarget,
    showTranslated,
    storageReady,
    storageAvailable,
    autoSaveEnabled,
  ])

  useEffect(() => {
    const flushSave = () => saveNowRef.current()
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'hidden') flushSave()
    }
    window.addEventListener('pagehide', flushSave)
    document.addEventListener('visibilitychange', handleVisibilityChange)
    return () => {
      window.removeEventListener('pagehide', flushSave)
      document.removeEventListener('visibilitychange', handleVisibilityChange)
    }
  }, [])

  const startNewProject = () => {
    preparationAbortRef.current?.abort()
    preparationAbortRef.current = null
    setIsPreparingVideo(false)
    setPreparationProgress(null)
    const projectId = createProjectId()
    activeProjectIdRef.current = projectId
    autoSaveEnabledRef.current = true
    latestSnapshotRef.current = null
    savedFileRef.current = null
    setRelinkFile(null)
    transcriptionRef.current?.controller.abort()
    transcriptionRef.current = null
    setLines([])
    setSelectedId(null)
    setTranscribeState('idle')
    setTranscribeError('')
    setTranslationState('idle')
    setTranslationProgress(null)
    setTranslationError('')
    setShowTranslated(false)
    setActiveProjectId(projectId)
    setFile(null)
    setOriginalFile(null)
    setCutProvenance(null)
    setShowCutNotice(true)
    setAlternateStart(0)
    setDuration(0)
    setCurrentTime(0)
    setTrimRange({ start: 0, end: 0 })
    setLoopTrim(false)
    setApplyTrimToSubtitles(true)
    setTranslationTarget('roman-ur')
    setTemplate(templateOptions[1])
    setStyleOverrides({})
    setReframe(defaultReframe)
    setTranscribeState('idle')
    setTranscribeError('')
    setAudioProgress(null)
    setTextExportFormat('paragraphs')
    setExportResolution('720p')
    setDownloadOption('video')
    setSubtitleDownloadFormat('srt')
    setSubtitleDownloadComplete(false)
    setVideoDownloadComplete(false)
    setDownloadPanelOpen(false)
    setSavedProjectsOpen(false)
    setResumeChoiceRequired(false)
    setAutoSaveEnabled(true)
    setLastSavedAt(null)
    setSaveStatus('idle')
    setSaveNotice(storageAvailable ? '' : 'Browser storage is unavailable. Auto-save is disabled.')
  }

  const continueSavedProject = async (projectId: string) => {
    try {
      const { project, video } = await getSavedProject(projectId)
      const restoredFile = video ? new File([video], project.fileName, {
        type: project.fileType,
        lastModified: project.lastModified,
      }) : null
      activeProjectIdRef.current = project.id
      autoSaveEnabledRef.current = true
      savedFileRef.current = restoredFile ? { projectId: project.id, file: restoredFile } : null
      setActiveProjectId(project.id)
      setFile(restoredFile)
      setOriginalFile(null)
      setCutProvenance(project.cutFrom ?? null)
      setShowCutNotice(Boolean(project.cutFrom))
      setAlternateStart(project.cutFrom?.start ?? 0)
      // When the video was not saved, keep the captions/style/trim and ask for the
      // same file again (matched by name and size).
      setRelinkFile(restoredFile ? null : { fileName: project.fileName, fileSize: project.fileSize })
      setError('')
      setTemplate(templateOptions.find((item) => item.id === project.templateId) ?? templateOptions[1])
      setStyleOverrides(project.styleOverrides)
      setReframe(clampReframe(project.reframe ?? defaultReframe))
      setDuration(project.duration)
      setCurrentTime(Math.max(0, Math.min(project.currentTime, project.duration)))
      setTrimRange(clampTrimRange(project.trimRange.start, project.trimRange.end, project.duration))
      setLoopTrim(project.loopTrim)
      setApplyTrimToSubtitles(project.applyTrimToSubtitles)
      setLines(project.lines)
      setTranslationTarget(project.translationTarget ?? 'roman-ur')
      setShowTranslated(project.showTranslated ?? false)
      setTranslationState('idle')
      setTranslationProgress(null)
      setTranslationError('')
      setSelectedId(project.selectedId && project.lines.some((line) => line.id === project.selectedId)
        ? project.selectedId
        : project.lines[0]?.id ?? null)
      setExportResolution(project.exportResolution)
      setDownloadOption(project.downloadOption)
      setSubtitleDownloadFormat(project.subtitleDownloadFormat)
      setTextExportFormat(project.textExportFormat)
      setTranscribeState(project.lines.length > 0 ? 'done' : 'idle')
      setAudioProgress(null)
      setAudioDownloadState('idle')
      setAudioDownloadError('')
      setAudioDownloadSize(0)
      setSubtitleDownloadComplete(false)
      setVideoDownloadComplete(false)
      setResumeChoiceRequired(false)
      setSavedProjectsOpen(false)
      setAutoSaveEnabled(true)
      setLastSavedAt(project.savedAt)
      setSaveStatus('saved')
      setSaveNotice('')
    } catch (restoreError) {
      setSaveNotice(restoreError instanceof Error
        ? restoreError.message
        : 'This saved project could not be restored.')
      try {
        await deleteSavedProjects([projectId])
        await refreshSavedProjects()
      } catch {
        setSaveNotice('This saved project could not be restored or removed from browser storage.')
      }
      setResumeChoiceRequired(false)
      setAutoSaveEnabled(true)
    }
  }

  const removeSavedProject = async (projectId: string) => {
    try {
      await deleteSavedProjects([projectId])
      await refreshSavedProjects()
      if (projectId === activeProjectIdRef.current) {
        savedFileRef.current = null
        autoSaveEnabledRef.current = false
        latestSnapshotRef.current = null
        setAutoSaveEnabled(false)
        setSaveStatus('idle')
        setSaveNotice('Saved project deleted. Auto-save is paused until you start a new project.')
      }
      if (savedProjects.length <= 1) setResumeChoiceRequired(false)
    } catch (storageError) {
      setSaveNotice(storageError instanceof Error ? storageError.message : 'Could not delete the saved project.')
    }
  }

  const removeAllSavedProjects = async () => {
    try {
      await deleteAllSavedProjects()
      setSavedProjects([])
      setStorageUsage(0)
      setResumeChoiceRequired(false)
      setSavedProjectsOpen(false)
      if (file) {
        savedFileRef.current = null
        autoSaveEnabledRef.current = false
        latestSnapshotRef.current = null
        setAutoSaveEnabled(false)
        setSaveStatus('idle')
        setSaveNotice('Saved projects deleted. Auto-save is paused until you start a new project.')
      } else {
        setSaveNotice('All saved projects were deleted.')
      }
    } catch (storageError) {
      setSaveNotice(storageError instanceof Error ? storageError.message : 'Could not delete saved projects.')
    }
  }

  const handleDuration = (videoDuration: number) => {
    setDuration(videoDuration)
    setTrimRange((previous) => previous.end === 0 || Math.abs(previous.end - duration) < 0.1
      ? { start: 0, end: videoDuration }
      : clampTrimRange(previous.start, previous.end, videoDuration))
  }

  const updateTrimRange = (start: number, end: number) => {
    const range = clampTrimRange(start, end, duration)
    setTrimRange(range)
    const video = videoRef.current
    if (video && (video.currentTime < range.start || video.currentTime > range.end)) {
      video.currentTime = range.start
      setCurrentTime(range.start)
    }
  }

  const prepareSelectedVideo = async (picked: File, metadata: VideoMetadata, start: number, keepOriginal: boolean) => {
    const segmentDuration = Math.min(MAX_VIDEO_SECONDS, metadata.duration - start)
    const needsPreparation = metadata.duration > MAX_VIDEO_SECONDS || picked.size > MAX_VIDEO_MB * 1024 * 1024
    if (!needsPreparation) {
      setFile(picked)
      setOriginalFile(null)
      setCutProvenance(null)
      setShowCutNotice(false)
      setDuration(metadata.duration)
      setTrimRange({ start: 0, end: metadata.duration })
      setCurrentTime(0)
      return
    }

    const controller = preparationAbortRef.current ?? new AbortController()
    preparationAbortRef.current = controller
    setIsPreparingVideo(true)
    setPreparationProgress({ stage: 'cut', progress: 0 })
    const stem = picked.name.replace(/\.[^.]+$/u, '')
    try {
      const cut = await cutVideoClip(picked, start, metadata.duration, controller.signal, (progress) => setPreparationProgress({ stage: 'cut', progress }))
      if (controller.signal.aborted) return
      const applyPrepared = (blob: Blob, compressed: boolean) => {
        const trimmedFile = new File([blob], `${stem}-trimmed.mp4`, { type: 'video/mp4', lastModified: picked.lastModified })
        setFile(trimmedFile)
        setOriginalFile(keepOriginal ? picked : null)
        setDuration(cut.duration)
        setTrimRange({ start: 0, end: cut.duration })
        setCutProvenance({
          name: picked.name,
          duration: metadata.duration,
          size: picked.size,
          start,
          keptDuration: cut.duration,
          compressed,
          softLimit: false,
        })
        setShowCutNotice(true)
        setAlternateStart(start)
        setError('')
      }
      // Make the stream-copied clip available immediately so subtitles can be
      // generated while the (slow) re-encode runs in the background.
      applyPrepared(cut.blob, false)
      setCurrentTime(0)

      if (cut.blob.size > MAX_VIDEO_MB * 1024 * 1024) {
        setPreparationProgress({ stage: 'compress', progress: 0 })
        try {
          const compressedBlob = await compressVideoClip(picked, start, cut.duration, controller.signal, (progress, remaining) => setPreparationProgress({ stage: 'compress', progress, remaining }))
          if (controller.signal.aborted) return
          applyPrepared(compressedBlob, true)
        } catch (compressError) {
          if (controller.signal.aborted || (compressError instanceof DOMException && compressError.name === 'AbortError')) return
          console.warn('Could not compress the prepared video; keeping the stream-copied clip.', compressError)
          // Keep the stream-copied clip; it still works for subtitles and export.
        }
      }
    } catch (preparationError) {
      if (controller.signal.aborted || (preparationError instanceof DOMException && preparationError.name === 'AbortError')) return
      console.warn('The video could not be cut in this browser; keeping the selected range from the original.', preparationError)
      setFile(picked)
      setOriginalFile(keepOriginal ? picked : null)
      setDuration(metadata.duration)
      setTrimRange({ start, end: start + segmentDuration })
      setCurrentTime(start)
      setCutProvenance({
        name: picked.name,
        duration: metadata.duration,
        size: picked.size,
        start,
        keptDuration: segmentDuration,
        compressed: false,
        softLimit: true,
      })
      setShowCutNotice(true)
      setAlternateStart(start)
      setError('')
    } finally {
      if (preparationAbortRef.current === controller) preparationAbortRef.current = null
      setIsPreparingVideo(false)
      setPreparationProgress(null)
    }
  }

  const handleUploadedFile = async (picked: File) => {
    if (relinkFile) {
      if (picked.name === relinkFile.fileName && Math.abs(picked.size - relinkFile.fileSize) <= 1024) {
        setRelinkFile(null)
        setDuration(0)
        setFile(picked)
        setOriginalFile(null)
        setCutProvenance(null)
        setShowCutNotice(false)
        setError('')
        setCurrentTime(0)
        setSaveStatus('idle')
        setSaveNotice('')
        return
      }
      setError(`Choose the same file to relink it: ${relinkFile.fileName} (${Math.round(relinkFile.fileSize / (1024 * 1024))} MB).`)
      return
    }
    activeProjectIdRef.current = createProjectId()
    autoSaveEnabledRef.current = storageAvailable
    latestSnapshotRef.current = null
    savedFileRef.current = null
    transcriptionRef.current?.controller.abort()
    transcriptionRef.current = null
    setLines([])
    setSelectedId(null)
    setTranscribeState('idle')
    setTranscribeError('')
    setTranslationState('idle')
    setTranslationProgress(null)
    setTranslationError('')
    setShowTranslated(false)
    setTranscribeParts(null)
    setTranscribeFailedPart(null)
    setActiveProjectId(activeProjectIdRef.current)
    preparationAbortRef.current?.abort()
    preparationAbortRef.current = new AbortController()
    const controller = preparationAbortRef.current
    setFile(null)
    setOriginalFile(null)
    setCutProvenance(null)
    setShowCutNotice(false)
    setError('')
    setCurrentTime(0)
    setDuration(0)
    setAlternateStart(0)
    setTrimRange({ start: 0, end: 0 })
    setLoopTrim(false)
    setDownloadOption('video')
    setSubtitleDownloadComplete(false)
    setVideoDownloadComplete(false)
    setAudioDownloadState('idle')
    setAudioDownloadError('')
    setAudioDownloadSize(0)
    setLastSavedAt(null)
    if (storageAvailable) {
      setAutoSaveEnabled(true)
      setSaveStatus('idle')
      setSaveNotice('')
    }
    setIsPreparingVideo(true)
    setPreparationProgress(null)
    try {
      if (picked.size > MAX_FILE_HARD_MB * 1024 * 1024) {
        throw new Error(`This file is larger than the ${MAX_FILE_HARD_MB} MB processing limit. Please choose a shorter or smaller video.`)
      }
      if (picked.size === 0) throw new Error('This video file is empty. Choose another file.')
      const metadata = await readVideoMetadata(picked, controller.signal)
      if (controller.signal.aborted) return
      if (metadata.duration > MAX_VIDEO_SECONDS || picked.size > MAX_VIDEO_MB * 1024 * 1024) {
        setOriginalFile(picked)
        await prepareSelectedVideo(picked, metadata, 0, true)
      } else {
        setDuration(metadata.duration)
        setFile(picked)
        setOriginalFile(null)
      }
    } catch (metadataError) {
      if (controller.signal.aborted || (metadataError instanceof DOMException && metadataError.name === 'AbortError')) return
      console.error('Could not read the selected video.', metadataError)
      setFile(null)
      setDuration(0)
      setError(metadataError instanceof Error
        ? metadataError.message
        : 'We could not read this video. Please choose a shorter or smaller file.')
    } finally {
      if (preparationAbortRef.current === controller) preparationAbortRef.current = null
      setIsPreparingVideo(false)
      setPreparationProgress(null)
    }
  }

  const chooseDifferentSegment = async () => {
    const source = originalFile
    if (!source || !cutProvenance || isPreparingVideo || isExporting) return
    const controller = new AbortController()
    preparationAbortRef.current = controller
    setIsPreparingVideo(true)
    setPreparationProgress({ stage: 'cut', progress: 0 })
    try {
      const metadata = await readVideoMetadata(source, controller.signal)
      if (!controller.signal.aborted) {
        await prepareSelectedVideo(source, metadata, alternateStart, true)
        if (!controller.signal.aborted) {
          transcriptionRef.current?.controller.abort()
          transcriptionRef.current = null
          setLines([])
          setSelectedId(null)
          setTranslationState('idle')
          setTranslationProgress(null)
          setTranslationError('')
          setShowTranslated(false)
          setTranscribeState('idle')
          setTranscribeError('')
          setAudioProgress(null)
          setTranscribeParts(null)
          setTranscribeFailedPart(null)
        }
      }
    } catch (metadataError) {
      if (controller.signal.aborted || (metadataError instanceof DOMException && metadataError.name === 'AbortError')) return
      console.error('Could not read the original video for another trim.', metadataError)
      setError(metadataError instanceof Error ? metadataError.message : 'We could not read this video. Please choose a shorter or smaller file.')
    } finally {
      if (preparationAbortRef.current === controller) preparationAbortRef.current = null
      setIsPreparingVideo(false)
      setPreparationProgress(null)
    }
  }

  const cancelVideoPreparation = () => {
    preparationAbortRef.current?.abort()
    preparationAbortRef.current = null
    setIsPreparingVideo(false)
    setPreparationProgress(null)
  }

  const seekWithinTrim = (time: number) => {
    const clampedTime = Math.max(trimRange.start, Math.min(trimRange.end, time))
    if (videoRef.current) videoRef.current.currentTime = clampedTime
    setCurrentTime(clampedTime)
  }

  const clearProject = () => {
    if (isExporting) return
    preparationAbortRef.current?.abort()
    preparationAbortRef.current = null
    setIsPreparingVideo(false)
    setPreparationProgress(null)
    transcriptionRef.current = null
    setTranscribeParts(null)
    setTranscribeFailedPart(null)
    setRelinkFile(null)
    setFile(null)
    setOriginalFile(null)
    setCutProvenance(null)
    setShowCutNotice(true)
    setAlternateStart(0)
    setDuration(0)
    setCurrentTime(0)
    setTrimRange({ start: 0, end: 0 })
    setLoopTrim(false)
    setError('')
    setLines([])
    setSelectedId(null)
    setTranscribeState('idle')
    setAudioDownloadState('idle')
    setAudioDownloadError('')
    setAudioDownloadSize(0)
  }

  const runTranscription = async (startIndex: number) => {
    const session = transcriptionRef.current
    if (!session) return
    const { chunks, perChunk, controller, timeOffset } = session
    let current = startIndex
    try {
      for (; current < chunks.length; current++) {
        setTranscribeParts({ done: current, total: chunks.length })
        perChunk[current] = await transcribeChunk(chunks[current], controller.signal)
      }
      const merged = mergeChunkWords(chunks, perChunk)
      const newLines = chunkWords(merged.map((word) => ({
        ...word,
        start: word.start + timeOffset,
        end: word.end + timeOffset,
      })))
      setLines(newLines)
      setTranslationTarget('roman-ur')
      setShowTranslated(false)
      setTranslationError('')
      setAudioProgress(null)
      setTranscribeParts(null)
      setTranscribeFailedPart(null)
      setTranscribeState('done')
      transcriptionRef.current = null
      if (newLines.length > 0) setSelectedId(newLines[0].id)
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        transcriptionRef.current = null
        setTranscribeParts(null)
        setTranscribeFailedPart(null)
        setAudioProgress(null)
        setTranscribeState('idle')
        return
      }
      console.error(err)
      setTranscribeError(err instanceof Error ? err.message : 'Failed to transcribe')
      setAudioProgress(null)
      setTranscribeFailedPart(current < chunks.length ? current : null)
      setTranscribeParts({ done: current, total: chunks.length })
      setTranscribeState('error')
    }
  }

  const doTranscribe = async () => {
    if (!file || isExporting) return
    if (duration > MAX_VIDEO_SECONDS && !cutProvenance?.softLimit) {
      setTranscribeError(`This video is longer than ${MAX_VIDEO_SECONDS / 60} minutes. Choose a shorter clip.`)
      setTranscribeState('error')
      return
    }
    try {
      setTranscribeError('')
      setAudioProgress(null)
      setTranscribeParts(null)
      setTranscribeFailedPart(null)
      setTranscribeState('extracting')
      const wav = cutProvenance?.softLimit
        ? await extractRangeWav(file, trimRange.start, trimRange.end, undefined, (progress) => {
          setAudioProgress({ phase: 'audio', progress, message: 'Preparing the selected audio range…' })
          setTranscribeState('fallback')
        }, true)
        : await extractWav(file, (progress) => {
          setAudioProgress(progress)
          setTranscribeState('fallback')
        }, duration)
      setTranscribeState('transcribing')
      const chunks = await splitTranscriptionChunks(wav)
      transcriptionRef.current = {
        chunks,
        perChunk: new Array(chunks.length),
        controller: new AbortController(),
        timeOffset: cutProvenance?.softLimit ? trimRange.start : 0,
      }
      setTranscribeParts({ done: 0, total: chunks.length })
      await runTranscription(0)
    } catch (err: any) {
      console.error(err)
      setTranscribeError(err?.message || 'Failed to transcribe')
      setAudioProgress(null)
      setTranscribeParts(null)
      setTranscribeState('error')
    }
  }

  const retryTranscription = () => {
    if (transcribeFailedPart === null) return
    setTranscribeError('')
    setTranscribeState('transcribing')
    void runTranscription(transcribeFailedPart)
  }

  const cancelTranscription = () => {
    transcriptionRef.current?.controller.abort()
  }

  const handleLineChange = (newLine: SubtitleLine) => {
    setLines((previous) => previous.map((line) => {
      if (line.id !== newLine.id) return line
      const textWords = newLine.text.trim().split(/\s+/u).filter(Boolean)
      const oldDuration = Math.max(0.001, line.end - line.start)
      const newDuration = Math.max(0.001, newLine.end - newLine.start)
      const words: Word[] = textWords.map((word, index) => {
        if (textWords.length === line.words.length && line.words[index]) {
          const previous = line.words[index]
          return {
            word,
            start: newLine.start + (previous.start - line.start) / oldDuration * newDuration,
            end: newLine.start + (previous.end - line.start) / oldDuration * newDuration,
          }
        }
        return {
          word,
          start: newLine.start + newDuration * index / Math.max(1, textWords.length),
          end: newLine.start + newDuration * (index + 1) / Math.max(1, textWords.length),
        }
      })
      const originalWords = showTranslated
        ? retimeWords(line.originalWords, line.start, line.end, newLine.start, newLine.end)
        : words
      return {
        ...line,
        ...newLine,
        words,
        originalText: showTranslated ? line.originalText : newLine.text,
        translatedText: showTranslated ? newLine.text : undefined,
        originalWords,
        translatedWords: showTranslated ? words : undefined,
      }
    }))
  }

  const selectCaptionVersion = (translated: boolean) => {
    setLines((previous) => previous.map((line) => {
      const originalText = line.originalText ?? line.text
      const text = translated ? line.translatedText ?? originalText : originalText
      return {
        ...line,
        originalText,
        text,
        words: translated ? line.translatedWords ?? line.words : line.originalWords ?? line.words,
      }
    }))
    setShowTranslated(translated)
  }

  const changeTranslationTarget = (target: TranslationTarget) => {
    if (showTranslated) selectCaptionVersion(false)
    setTranslationTarget(target)
    setTranslationError('')
  }

  const doTranslate = async () => {
    if (lines.length === 0 || translationState === 'translating' || isExporting) return
    setTranslationState('translating')
    setTranslationError('')
    setTranslationProgress({ batch: 0, total: Math.ceil(lines.length / 40) })
    try {
      const sourceLines = lines.map((line) => line.originalText ?? line.text)
      const translated = await translateCaptions(sourceLines, translationTarget, (batch, total) => {
        setTranslationProgress({ batch, total })
      })
      setLines((previous) => previous.map((line, index) => ({
        ...line,
        originalText: line.originalText ?? sourceLines[index],
        translatedText: translated[index],
        text: translated[index],
        originalWords: line.originalWords ?? line.words,
        translatedWords: timedWords(translated[index], line.start, line.end),
        words: timedWords(translated[index], line.start, line.end),
      })))
      setShowTranslated(true)
    } catch (translationFailure) {
      setTranslationError(translationFailure instanceof Error
        ? translationFailure.message
        : 'Translation failed. Please try again.')
    } finally {
      setTranslationState('idle')
      setTranslationProgress(null)
    }
  }

  const handleDelete = (id: string) => {
    setLines(lines.filter(l => l.id !== id))
    if (selectedId === id) setSelectedId(null)
  }

  const handleAddLine = () => {
    const start = Math.max(0, Math.min(currentTime, Math.max(0, duration - 1)))
    const end = Math.min(duration || start + 2, start + 2)
    const line: SubtitleLine = {
      id: createProjectId(),
      text: '',
      start,
      end: Math.max(start + 0.1, end),
      words: [],
    }
    setLines((previous) => [...previous, line].sort((a, b) => a.start - b.start))
    setSelectedId(line.id)
  }

  const handleSplit = (id: string) => {
    const idx = lines.findIndex(l => l.id === id)
    if (idx === -1) return
    const line = lines[idx]
    const words = line.text.trim().split(/\s+/u).filter(Boolean)
    if (words.length <= 1) return
    const mid = Math.floor(words.length / 2)
    const timedWords = line.words.length === words.length
      ? line.words
      : words.map((word, index) => ({
        word,
        start: line.start + (line.end - line.start) * index / words.length,
        end: line.start + (line.end - line.start) * (index + 1) / words.length,
      }))
    const firstWords = timedWords.slice(0, mid)
    const secondWords = timedWords.slice(mid)
    const splitText = (text: string) => {
      const parts = text.trim().split(/\s+/u).filter(Boolean)
      const cut = Math.max(1, Math.min(parts.length - 1, Math.round(parts.length * mid / words.length)))
      return [parts.slice(0, cut).join(' '), parts.slice(cut).join(' ')]
    }
    const originalParts = splitText(line.originalText ?? line.text)
    const translatedParts = line.translatedText ? splitText(line.translatedText) : null
    const line1 = {
      ...line,
      id: Math.random().toString(36).substring(2, 9),
      text: words.slice(0, mid).join(' '),
      originalText: line.originalText === undefined ? undefined : originalParts[0],
      translatedText: translatedParts?.[0],
      originalWords: line.originalWords?.slice(0, Math.round(line.originalWords.length * mid / words.length)),
      translatedWords: line.translatedWords?.slice(0, Math.round(line.translatedWords.length * mid / words.length)),
      end: firstWords[firstWords.length - 1].end,
      words: firstWords,
    }
    const line2 = {
      ...line,
      id: Math.random().toString(36).substring(2, 9),
      text: words.slice(mid).join(' '),
      originalText: line.originalText === undefined ? undefined : originalParts[1],
      translatedText: translatedParts?.[1],
      originalWords: line.originalWords?.slice(Math.round(line.originalWords.length * mid / words.length)),
      translatedWords: line.translatedWords?.slice(Math.round(line.translatedWords.length * mid / words.length)),
      start: secondWords[0].start,
      words: secondWords,
    }
    
    const newLines = [...lines]
    newLines.splice(idx, 1, line1, line2)
    setLines(newLines)
    setSelectedId(line1.id)
  }

  const handleMergeUp = (id: string) => {
    const idx = lines.findIndex(l => l.id === id)
    if (idx <= 0) return
    const prev = lines[idx - 1]
    const line = lines[idx]
    const merged = {
      ...prev,
      text: prev.text + ' ' + line.text,
      originalText: prev.originalText !== undefined || line.originalText !== undefined
        ? `${prev.originalText ?? prev.text} ${line.originalText ?? line.text}`
        : undefined,
      translatedText: prev.translatedText !== undefined && line.translatedText !== undefined
        ? `${prev.translatedText} ${line.translatedText}`
        : undefined,
      originalWords: prev.originalWords && line.originalWords ? [...prev.originalWords, ...line.originalWords] : undefined,
      translatedWords: prev.translatedWords && line.translatedWords ? [...prev.translatedWords, ...line.translatedWords] : undefined,
      end: line.end,
      words: [...prev.words, ...line.words],
    }
    const newLines = [...lines]
    newLines.splice(idx - 1, 2, merged)
    setLines(newLines)
    setSelectedId(merged.id)
  }

  const handleMergeDown = (id: string) => {
    const idx = lines.findIndex(l => l.id === id)
    if (idx === -1 || idx >= lines.length - 1) return
    const line = lines[idx]
    const next = lines[idx + 1]
    const merged = {
      ...line,
      text: line.text + ' ' + next.text,
      originalText: line.originalText !== undefined || next.originalText !== undefined
        ? `${line.originalText ?? line.text} ${next.originalText ?? next.text}`
        : undefined,
      translatedText: line.translatedText !== undefined && next.translatedText !== undefined
        ? `${line.translatedText} ${next.translatedText}`
        : undefined,
      originalWords: line.originalWords && next.originalWords ? [...line.originalWords, ...next.originalWords] : undefined,
      translatedWords: line.translatedWords && next.translatedWords ? [...line.translatedWords, ...next.translatedWords] : undefined,
      end: next.end,
      words: [...line.words, ...next.words],
    }
    const newLines = [...lines]
    newLines.splice(idx, 2, merged)
    setLines(newLines)
    setSelectedId(merged.id)
  }

  const selectedLineIndex = lines.findIndex(l => l.id === selectedId)
  const selectedLine = lines[selectedLineIndex]
  const translatedRtl = showTranslated && (translationTarget === 'ur' || translationTarget === 'ar')
  const translatedFont = translationTarget === 'ur' ? 'Noto Nastaliq Urdu' : 'Noto Naskh Arabic'
  const latinFallbackFont = styleOverrides.font && !['Noto Nastaliq Urdu', 'Noto Naskh Arabic'].includes(styleOverrides.font)
    ? styleOverrides.font
    : 'Poppins'
  const renderTemplate = showTranslated
    ? {
      ...template,
      rtl: translatedRtl,
      font: translatedRtl ? translatedFont : template.rtl ? latinFallbackFont : template.font,
    }
    : template
  const renderOverrides = showTranslated
    ? { ...styleOverrides, font: renderTemplate.font }
    : styleOverrides
  const updateStyleOverride = <K extends keyof SubtitleStyleOverrides,>(key: K, value: SubtitleStyleOverrides[K]) => {
    setStyleOverrides((previous) => ({ ...previous, [key]: value }))
  }
  const updateReframe = (patch: Partial<ReframeState>) => {
    setReframe((previous) => {
      const next: ReframeState = { ...previous, ...patch }
      if (patch.ratio && patch.ratio !== previous.ratio) {
        const video = videoRef.current
        const sourceAspect = ratioValue('original', video?.videoWidth ?? 0, video?.videoHeight ?? 0)
        const targetAspect = ratioValue(patch.ratio, video?.videoWidth ?? 0, video?.videoHeight ?? 0)
        // A drastic reshape (e.g. landscape to 9:16) defaults to the Fit + blur look.
        if (changesFramingDrastic(sourceAspect, targetAspect)) next.fit = 'blur'
      }
      return clampReframe(next)
    })
  }
  const downloadSubtitles = (format: 'srt' | 'txt' | 'vtt') => {
    const exportedLines = applyTrimToSubtitles
      ? trimSubtitleLines(lines, trimRange.start, trimRange.end)
      : lines
    if (format === 'srt') {
      downloadBlob(new Blob([createSrt(exportedLines)], { type: 'application/x-subrip;charset=utf-8' }), createDownloadName(file?.name, 'srt'))
    } else if (format === 'vtt') {
      downloadBlob(new Blob([createVtt(exportedLines)], { type: 'text/vtt;charset=utf-8' }), createDownloadName(file?.name, 'vtt'))
    } else {
      downloadBlob(new Blob([createTxtNotes(exportedLines, textExportFormat)], { type: 'text/plain;charset=utf-8' }), createDownloadName(file?.name, 'txt'))
    }
    setSubtitleDownloadComplete(true)
  }
  const downloadAudio = async () => {
    if (!file || isExporting || audioDownloadState === 'processing') return
    setAudioDownloadState('processing')
    setAudioDownloadError('')
    setAudioDownloadSize(0)
    setAudioProgress({ phase: 'audio', progress: 0, message: 'Checking the audio track…' })
    try {
      const wav = cutProvenance?.softLimit
        ? await extractRangeWav(file, trimRange.start, trimRange.end, undefined, (progress) => {
          setAudioProgress({ phase: 'audio', progress, message: 'Extracting audio from the selected range…' })
        })
        : await extractOriginalQualityWav(file, setAudioProgress, duration)
      const selectedWav = cutProvenance?.softLimit
        ? wav
        : await trimOriginalQualityWav(wav, trimRange.start, trimRange.end)
      setAudioDownloadSize(selectedWav.size)
      downloadBlob(selectedWav, createDownloadName(file.name, 'wav'))
      setAudioDownloadState('done')
      setAudioProgress(null)
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Could not extract audio.'
      console.error('Could not create an audio download.', err)
      setAudioDownloadError(message)
      setAudioDownloadState('error')
      setAudioProgress(null)
    }
  }
  const startVideoExport = async () => {
    const video = videoRef.current
    const sourceFile = file
    if (!video || !sourceFile || !lines.length || isExporting) return
    const controller = new AbortController()
    exportAbortController.current = controller
    setIsExporting(true)
    setVideoDownloadComplete(false)
    const dimensions = outputDimensions(video.videoWidth, video.videoHeight, exportResolution, reframe.ratio)
    setExportProgress({
      progress: 0,
      elapsed: 0,
      remaining: duration,
      outputWidth: dimensions.width,
      outputHeight: dimensions.height,
    })
    setExportError('')
    setExportSuccess('')
    // For large exports, stream the result straight to a chosen file when the
    // File System Access API is available; otherwise buffer and download.
    let writable: ExportWritable | undefined
    let streamedName = ''
    const picker = (window as unknown as {
      showSaveFilePicker?: (options?: { suggestedName?: string; types?: { description: string; accept: Record<string, string[]> }[] }) => Promise<{ name?: string; createWritable: () => Promise<ExportWritable> }>
    }).showSaveFilePicker
    if (picker && estimatedOutputBytes > 120 * 1024 * 1024) {
      try {
        const handle = await picker({
          suggestedName: 'subtitled-video.mp4',
          types: [{ description: 'MP4 video', accept: { 'video/mp4': ['.mp4'] } }],
        })
        writable = await handle.createWritable()
        streamedName = handle.name ?? 'subtitled-video.mp4'
      } catch (pickerError) {
        if (pickerError instanceof DOMException && pickerError.name === 'AbortError') {
          exportAbortController.current = null
          setIsExporting(false)
          setExportProgress(null)
          return
        }
        writable = undefined
      }
    }

    // Keep the screen awake and warn if the tab is hidden so background
    // throttling does not silently slow the export.
    let wakeLock: { release: () => Promise<void> } | null = null
    const releaseWakeLock = async () => {
      if (wakeLock) { try { await wakeLock.release() } catch { /* ignore */ } wakeLock = null }
    }
    const onVisibility = () => setExportTabHidden(document.hidden)
    document.addEventListener('visibilitychange', onVisibility)
    setExportTabHidden(document.hidden)
    if ('wakeLock' in navigator) {
      try {
        const wakeLockApi = (navigator as Navigator & { wakeLock?: { request: (type: 'screen') => Promise<{ release: () => Promise<void> }> } }).wakeLock
        wakeLock = (await wakeLockApi?.request('screen').catch(() => null)) ?? null
      } catch { wakeLock = null }
    }

    try {
      const result = await exportVideo({
        video,
        file: sourceFile,
        lines,
        template: renderTemplate,
        overrides: renderOverrides,
        reframe,
        resolution: exportResolution,
        trimStart: trimRange.start,
        trimEnd: trimRange.end,
        audioRange: cutProvenance?.softLimit ? { start: trimRange.start, end: trimRange.end } : undefined,
        signal: controller.signal,
        onProgress: setExportProgress,
        writable,
        speed: exportSpeed,
      })
      setVideoDownloadComplete(true)
      const hardwareNote = result.hardware === true ? ' · hardware encoder' : result.hardware === false ? ' · software encoder' : ''
      if (result.streamed) {
        setExportSuccess(`Export complete: ${result.outputWidth} × ${result.outputHeight} MP4 saved${streamedName ? ` as ${streamedName}` : ''}${hardwareNote}.`)
      } else if (result.blob) {
        downloadBlob(result.blob, createDownloadName(`subtitled-video.${result.extension}`, result.extension))
        setExportSuccess(`Export complete: ${result.outputWidth} × ${result.outputHeight} ${result.extension.toUpperCase()} video downloaded${hardwareNote}.`)
      }
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        setExportSuccess('Video export cancelled.')
      } else {
        const message = err instanceof Error ? err.message : 'Video export failed.'
        console.error('Video export failed.', err)
        setExportError(message)
      }
    } finally {
      document.removeEventListener('visibilitychange', onVisibility)
      setExportTabHidden(false)
      await releaseWakeLock()
      exportAbortController.current = null
      setIsExporting(false)
      setExportProgress(null)
    }
  }
  const cancelVideoExport = () => exportAbortController.current?.abort()
  const formatRemaining = (seconds: number) => {
    const safe = Math.max(0, Math.ceil(seconds))
    return `${Math.floor(safe / 60)}:${String(safe % 60).padStart(2, '0')}`
  }
  const selectedDuration = Math.max(0, trimRange.end - trimRange.start)
  const deviceMemoryGb = typeof navigator !== 'undefined'
    ? (navigator as Navigator & { deviceMemory?: number }).deviceMemory
    : undefined
  const deviceIsLowMemory = typeof deviceMemoryGb === 'number' && deviceMemoryGb <= LOW_MEMORY_DEVICE_GB
  const estimatedSavedStorage = Math.max(
    storageUsage ?? 0,
    savedProjects.reduce((total, project) => total + project.fileSize, 0),
  )
  const outputSize = file && duration > 0 && videoRef.current?.videoWidth && videoRef.current.videoHeight
    ? outputDimensions(videoRef.current.videoWidth, videoRef.current.videoHeight, exportResolution, reframe.ratio)
    : null
  const estimatedOutputBytes = selectedDuration > 0
    ? Math.round(selectedDuration * ((exportResolution === '1080p' ? 10_000_000 : exportResolution === '720p' ? 5_000_000 : exportResolution === '480p' ? 2_500_000 : 8_000_000) + 192_000) / 8)
    : 0
  const formatFileSize = (bytes: number) => bytes >= 1024 * 1024
    ? `${(bytes / (1024 * 1024)).toFixed(1)} MB`
    : `${Math.max(1, Math.round(bytes / 1024))} KB`
  const formatExportTime = (seconds: number) =>
    `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(Math.floor(seconds) % 60).padStart(2, '0')}`
  const includedCaptionCount = applyTrimToSubtitles
    ? trimSubtitleLines(lines, trimRange.start, trimRange.end).length
    : lines.length

  return (
    <div className={`app-shell ${isExporting ? 'is-exporting' : ''}`}>
      <header className="topbar">
        <a className="brand" href="./" aria-label="XCaptions home">
          <span className="brand-mark" aria-hidden="true"><svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg" focusable="false"><rect width="64" height="64" rx="15" fill="#111210"/><rect x="9" y="27" width="46" height="10" rx="5" fill="#d1fa70" transform="rotate(45 32 32)"/><rect x="13" y="26.5" width="38" height="11" rx="5.5" fill="#ff846b" transform="rotate(-45 32 32)"/><path d="M25 23 25 41 39 32Z" fill="#111210"/></svg></span>
          <span><span className="brand-x">X</span>Captions</span>
        </a>
        <div className="topbar-center"><span className="live-dot" /> Your video stays on this device</div>
        <div className="topbar-actions">
          <span className={`autosave-status ${saveStatus === 'error' ? 'has-error' : ''}`} role="status" aria-live="polite">
            {saveStatus === 'saving'
              ? 'Saving…'
              : saveStatus === 'error'
                ? 'Auto-save unavailable'
                : resumeChoiceRequired
                  ? 'Choose a project'
                  : storageReady && !autoSaveEnabled
                    ? 'Auto-save paused'
                : lastSavedAt
                  ? `Saved · ${new Date(lastSavedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`
                  : storageReady && !storageAvailable
                    ? 'Auto-save unavailable'
                    : storageReady && storageAvailable
                    ? 'Auto-save on'
                    : 'Checking storage…'}
          </span>
          {storageAvailable && !resumeChoiceRequired && file && !autoSaveEnabled && (
            <button className="saved-projects-toggle" type="button" onClick={() => {
              activeProjectIdRef.current = createProjectId()
              setActiveProjectId(activeProjectIdRef.current)
              savedFileRef.current = null
              setAutoSaveEnabled(true)
              setSaveStatus('idle')
              setSaveNotice('')
            }}>Save this project</button>
          )}
          {storageAvailable && !resumeChoiceRequired && (
            <button className="saved-projects-toggle" type="button" aria-expanded={savedProjectsOpen} aria-controls="saved-projects-card" onClick={() => setSavedProjectsOpen((open) => !open)}>
              Saved projects · {savedProjects.length}
            </button>
          )}
          <span className="topbar-status">LOCAL PREVIEW</span>
        </div>
      </header>

      {(resumeChoiceRequired || savedProjectsOpen) && (
        <section className="saved-projects-card" id="saved-projects-card" aria-label="Saved projects">
          <div className="saved-projects-heading">
            <div>
              <span className="eyebrow">{resumeChoiceRequired ? 'SAVED ON THIS DEVICE' : 'PROJECT STORAGE'}</span>
              <h2>{resumeChoiceRequired ? 'Continue where you left off' : 'Saved projects'}</h2>
              <p>Stored only in this browser · about {formatStorageSize(estimatedSavedStorage)} used.</p>
            </div>
            {!resumeChoiceRequired && <button className="icon-button" type="button" aria-label="Close saved projects" onClick={() => setSavedProjectsOpen(false)}><X size={16} /></button>}
          </div>

          {resumeChoiceRequired && savedProjects[0] && (
            <div className="saved-resume-highlight">
              <div>
                <strong>Continue your last project: {savedProjects[0].fileName}</strong>
                <span>{formatSavedTime(savedProjects[0].savedAt)} · {savedProjects[0].captionCount} {savedProjects[0].captionCount === 1 ? 'caption' : 'captions'}{savedProjects[0].cutFrom ? ` · prepared from ${savedProjects[0].cutFrom.name}` : ''}{savedProjects[0].hasVideo ? '' : ' · video not saved'}</span>
              </div>
              <div className="saved-resume-actions">
                <button className="button button-primary" type="button" onClick={() => void continueSavedProject(savedProjects[0].id)}>Continue</button>
                <button className="button button-subtle" type="button" onClick={startNewProject}>Start new</button>
                <button className="saved-delete-button" type="button" onClick={() => void removeSavedProject(savedProjects[0].id)}>Delete</button>
              </div>
            </div>
          )}

          {savedProjects.length > (resumeChoiceRequired ? 1 : 0) && (
            <div className="saved-project-list" aria-label="Other saved projects">
              {savedProjects.slice(resumeChoiceRequired ? 1 : 0).map((project) => (
                <div className="saved-project-row" key={project.id}>
                  <span><strong>{project.fileName}</strong><small>{formatSavedTime(project.savedAt)} · {project.captionCount} captions{project.cutFrom ? ` · prepared from ${project.cutFrom.name}` : ''}</small></span>
                  <button className="saved-row-action" type="button" onClick={() => void continueSavedProject(project.id)}>Continue</button>
                  <button className="saved-row-action is-delete" type="button" onClick={() => void removeSavedProject(project.id)}>Delete</button>
                </div>
              ))}
            </div>
          )}

          {savedProjects.length === 0 && !resumeChoiceRequired && <p className="saved-empty">No saved projects on this device.</p>}
          <div className="saved-projects-footer">
            {!resumeChoiceRequired && <button className="button button-subtle" type="button" onClick={startNewProject}>Start new project</button>}
            <button className="saved-delete-all" type="button" onClick={() => void removeAllSavedProjects()} disabled={savedProjects.length === 0}>Delete saved projects</button>
          </div>
          {saveNotice && <p className="autosave-notice" role="alert">{saveNotice}</p>}
        </section>
      )}
      {saveNotice && !resumeChoiceRequired && !savedProjectsOpen && (
        <p className="autosave-notice autosave-notice-global" role="alert">{saveNotice}</p>
      )}

      <main className="workspace phase-one-workspace">
        <section className="center-panel">
          <div className="canvas-toolbar">
            <div className="breadcrumbs"><span>Workspace</span><span>/</span><strong>{file?.name ?? 'Untitled edit'}</strong></div>
            <div className="preview-state"><span className="live-dot" /> LIVE PREVIEW</div>
          </div>
          <div className={`stage-area ${videoUrl ? 'has-video' : ''}`}>
            {videoUrl ? <VideoCanvas
              src={videoUrl}
              template={renderTemplate}
              overrides={renderOverrides}
              reframe={reframe}
              onPositionChange={(positionX, positionY) => {
                setStyleOverrides((previous) => ({ ...previous, positionX, positionY }))
              }}
              onCropChange={(focusX, focusY) => updateReframe({ focusX, focusY })}
              videoRef={videoRef}
              disabled={isExporting}
              currentTime={currentTime}
              duration={duration}
              trimStart={trimRange.start}
              trimEnd={trimRange.end}
              loopTrim={loopTrim}
              lines={lines}
              onDuration={handleDuration}
              onTime={setCurrentTime}
              onUnsupported={(message) => { setFile(null); setError(message || 'This video could not be played here. Try an MP4, MOV, or WebM encoded with a browser-supported codec.') }}
            /> : <button className="empty-stage" onClick={() => document.querySelector<HTMLInputElement>('.uploader-wrap input[type=file]')?.click()} disabled={resumeChoiceRequired}>
              <span className="empty-orbit"><span className="empty-glyph"><Film size={22} /></span><span className="orbit-dot" /></span>
              <span className="empty-title">Make every word land.</span>
              <span className="empty-description">Start with a short video. Preview your captions<br className="desktop-break" /> right here, without uploading a thing.</span>
              <span className="button button-primary empty-cta">Choose a video</span>
              <span className="empty-meta">MP4 · MOV · MKV · WEBM <i /> UP TO {MAX_VIDEO_MINUTES} MINUTES</span>
            </button>}
          </div>
          {isPreparingVideo && (
            <div className="video-preparation-note" role="status" aria-live="polite">
              <div>
                <strong>{!preparationProgress
                  ? 'Reading video duration…'
                  : preparationProgress.stage === 'compress'
                    ? 'Compressing the prepared video…'
                    : `Preparing ${alternateStart > 0 ? 'the selected part' : `the first ${MAX_VIDEO_MINUTES} minutes`}…`}</strong>
                <span>{preparationProgress?.stage === 'compress'
                  ? 'Keeping the original resolution while reducing the file size. This can take a few minutes.'
                  : 'The video is processed locally and is not uploaded.'}</span>
                {preparationProgress && <progress max="100" value={preparationProgress.progress} />}
                {preparationProgress?.stage === 'compress' && preparationProgress.remaining !== undefined && (
                  <small>About {formatRemaining(preparationProgress.remaining)} remaining</small>
                )}
              </div>
              <button type="button" className="button button-subtle" onClick={cancelVideoPreparation}>Cancel</button>
            </div>
          )}
          {cutProvenance && showCutNotice && (
            <section className="video-cut-notice" role="status" aria-live="polite">
              <button type="button" className="icon-button video-cut-dismiss" aria-label="Dismiss video preparation notice" onClick={() => setShowCutNotice(false)}><X size={15} /></button>
              <strong>Your video is {formatClock(cutProvenance.duration)} long, so we kept {cutProvenance.start > 0 ? `${formatClock(cutProvenance.keptDuration)} starting at ${formatClock(cutProvenance.start)}` : `the first ${formatClock(cutProvenance.keptDuration)}`}.</strong>
              <p>
                Only this part is used for subtitles and downloads.
                {' '}The original ({formatStorageSize(cutProvenance.size)}, “{cutProvenance.name}”) stays loaded so you can choose a different part.
                {cutProvenance.compressed ? ` The kept video was compressed to fit within the ${MAX_VIDEO_MB} MB size limit.` : ''}
                {cutProvenance.softLimit ? ' The selected range is cut from the original for transcription, audio download and video export.' : ''}
              </p>
              {originalFile && cutProvenance.duration > MAX_VIDEO_SECONDS && (
                <div className="video-cut-reselect">
                  <label>
                    <span>Start time · {formatClock(alternateStart)}</span>
                    <input
                      type="range"
                      min="0"
                      max={Math.max(0, cutProvenance.duration - MAX_VIDEO_SECONDS)}
                      step="1"
                      value={Math.min(alternateStart, Math.max(0, cutProvenance.duration - MAX_VIDEO_SECONDS))}
                      disabled={isPreparingVideo || isExporting}
                      onChange={(event) => setAlternateStart(Number(event.currentTarget.value))}
                    />
                  </label>
                  <button type="button" className="button button-subtle" onClick={() => void chooseDifferentSegment()} disabled={isPreparingVideo || isExporting}>
                    Choose a different {MAX_VIDEO_MINUTES} minutes
                  </button>
                </div>
              )}
            </section>
          )}
          {file && duration > LONG_VIDEO_WARNING_SECONDS && !cutProvenance?.softLimit && (
            <p className="long-clip-note" role="status">
              Long clip ({formatRemaining(duration)}). Processing and export use more memory and take longer, especially on phones.
              {deviceIsLowMemory ? ` Your device reports limited memory, so ${RECOMMENDED_LONG_EXPORT_RESOLUTION} is recommended for export.` : ''}
            </p>
          )}
          {file && <ReframeControls
            reframe={reframe}
            onChange={updateReframe}
            outputWidth={outputSize?.width ?? null}
            outputHeight={outputSize?.height ?? null}
            disabled={isExporting}
          />}
          {file && <TrimControls
            start={trimRange.start}
            end={trimRange.end}
            duration={duration}
            currentTime={currentTime}
            disabled={isExporting || isPreparingVideo || !duration || Boolean(cutProvenance?.softLimit)}
            loop={loopTrim}
            onChange={updateTrimRange}
            onLoopChange={setLoopTrim}
          />}
          <div className="download-area">
            <button
              ref={downloadTriggerRef}
              type="button"
              className="download-launch"
              aria-expanded={downloadPanelOpen}
              aria-controls="download-panel"
              onClick={toggleDownloadPanel}
            >
              <span className="download-launch-icon"><Download size={19} /></span>
              <span className="download-launch-copy"><strong>Download</strong><small>Subtitles, audio or video</small></span>
              <span className={`download-launch-chevron ${downloadPanelOpen ? 'is-open' : ''}`} aria-hidden="true">⌄</span>
            </button>
            <div
              id="download-panel"
              className={`download-panel-collapse ${downloadPanelOpen ? 'is-open' : ''}`}
              aria-hidden={!downloadPanelOpen}
            >
              <section className="export-panel" aria-label="Downloads and export">
                <div className="export-panel-heading">
                  <div className="export-summary">
                    <span>Range {formatExportTime(trimRange.start)} to {formatExportTime(trimRange.end)} ({selectedDuration.toFixed(1).replace(/\.0$/u, '')} s)</span>
                    <span>{includedCaptionCount} {includedCaptionCount === 1 ? 'caption' : 'captions'}</span>
                  </div>
                  <button type="button" className="download-close icon-button" aria-label="Close download panel" onClick={closeDownloadPanel}><X size={16} /></button>
                </div>

                <div className="download-option-grid" role="group" aria-label="Download type">
                  <button id="download-option-subtitles" type="button" className={`download-option-tile ${downloadOption === 'subtitles' ? 'is-selected' : ''}`} aria-pressed={downloadOption === 'subtitles'} disabled={isExporting || lines.length === 0} onClick={() => setDownloadOption('subtitles')}>
                    <Captions size={18} /><span>Subtitles</span>{!lines.length && <small>Generate subtitles first</small>}
                  </button>
                  <button id="download-option-audio" type="button" className={`download-option-tile ${downloadOption === 'audio' ? 'is-selected' : ''}`} aria-pressed={downloadOption === 'audio'} disabled={isExporting} onClick={() => setDownloadOption('audio')}>
                    <AudioLines size={18} /><span>Audio</span>
                  </button>
                  <button id="download-option-video" type="button" className={`download-option-tile ${downloadOption === 'video' ? 'is-selected' : ''}`} aria-pressed={downloadOption === 'video'} disabled={isExporting} onClick={() => setDownloadOption('video')}>
                    <Film size={18} /><span>Video</span>
                  </button>
                </div>

                {downloadOption === 'subtitles' && (
                  <div className="download-option-body">
                    <div className="subtitle-format-row" role="group" aria-label="Subtitle format">
                      {(['srt', 'txt', 'vtt'] as const).map((format) => (
                        <button key={format} type="button" className={`format-pill ${subtitleDownloadFormat === format ? 'is-selected' : ''}`} aria-pressed={subtitleDownloadFormat === format} disabled={isExporting} onClick={() => { setSubtitleDownloadFormat(format); setSubtitleDownloadComplete(false) }}>
                          {format.toUpperCase()}
                        </button>
                      ))}
                    </div>
                    {subtitleDownloadFormat === 'txt' && (
                      <label className="txt-format-control">
                        <span>TXT notes</span>
                        <select value={textExportFormat} onChange={(event) => setTextExportFormat(event.currentTarget.value as TextExportFormat)} disabled={isExporting}>
                          <option value="paragraphs">Without timestamps</option>
                          <option value="timestamps">With timestamps</option>
                        </select>
                      </label>
                    )}
                    <label className="trim-subtitles-toggle">
                      <input type="checkbox" checked={applyTrimToSubtitles} onChange={(event) => setApplyTrimToSubtitles(event.currentTarget.checked)} disabled={isExporting} />
                      Apply trim to subtitles
                    </label>
                    <button className="button button-export download-action" onClick={() => downloadSubtitles(subtitleDownloadFormat)} disabled={isExporting || !lines.length}>
                      {subtitleDownloadComplete ? <Check size={16} /> : <Download size={16} />}
                      {subtitleDownloadComplete ? 'Downloaded' : `Download ${subtitleDownloadFormat.toUpperCase()}`}
                    </button>
                  </div>
                )}

                {downloadOption === 'audio' && (
                  <div className="download-option-body">
                    <p className="download-helper">WAV · uncompressed · about {selectedDuration > 0 ? formatFileSize(selectedDuration * 176_400) : '—'} for this range</p>
                    <button className="button button-export download-action" onClick={downloadAudio} disabled={!file || isExporting || audioDownloadState === 'processing'}>
                      {audioDownloadState === 'done' ? <Check size={16} /> : <Download size={16} />}
                      {audioDownloadState === 'processing' ? 'Preparing WAV…' : audioDownloadState === 'done' ? 'Downloaded' : 'Download audio'}
                    </button>
                    {audioProgress?.phase === 'audio' && (
                      <div className="export-progress" role="status">
                        <div><span>{audioProgress.message}</span><strong>{audioProgress.progress}%</strong></div>
                        <progress max="100" value={audioProgress.progress} />
                      </div>
                    )}
                    {audioDownloadSize > 0 && <p className="export-success" role="status">WAV size · {(audioDownloadSize / (1024 * 1024)).toFixed(1)} MB</p>}
                    {audioDownloadError && <p className="export-error" role="alert">{audioDownloadError}</p>}
                  </div>
                )}

                {downloadOption === 'video' && (
                  <div className="download-option-body">
                    <div className="resolution-pills" role="group" aria-label="Video resolution">
                      {(['480p', '720p', '1080p', 'original'] as const).map((resolution) => {
                        const isUnavailable = resolution === '720p' && (!videoRef.current?.videoHeight || Math.min(videoRef.current.videoWidth, videoRef.current.videoHeight) < 720)
                          || resolution === '1080p' && (!videoRef.current?.videoHeight || Math.min(videoRef.current.videoWidth, videoRef.current.videoHeight) < 1080)
                        return <button key={resolution} type="button" className={`format-pill ${exportResolution === resolution ? 'is-selected' : ''}`} aria-pressed={exportResolution === resolution} disabled={isExporting || !file || !duration || isUnavailable} onClick={() => setExportResolution(resolution)}>{resolution === 'original' ? 'Original' : resolution}</button>
                      })}
                    </div>
                    <div className="video-estimates">
                      <strong>{outputSize ? `${outputSize.width} × ${outputSize.height}` : 'Output dimensions appear after loading a video'}</strong>
                      <span>About {selectedDuration > 0 ? Math.ceil(selectedDuration * (exportResolution === '1080p' ? 5 : exportResolution === '720p' ? 2 : 1.4)) : '—'} s · ~{estimatedOutputBytes ? formatFileSize(estimatedOutputBytes) : '—'}</span>
                    </div>
                    <div className="resolution-pills" role="group" aria-label="Export speed">
                      {speedOptions.map((option) => {
                        const estimate = selectedDuration > 0
                          ? formatRemaining(Math.max(1, Math.round(estimateExportSeconds(selectedDuration, exportResolution) * option.factor)))
                          : '—'
                        return <button key={option.id} type="button" className={`format-pill ${exportSpeed === option.id ? 'is-selected' : ''}`} aria-pressed={exportSpeed === option.id} disabled={isExporting || !file || !duration} title={`${option.hint} About ${estimate} for this clip.`} onClick={() => setExportSpeed(option.id)}>{option.label}</button>
                      })}
                    </div>
                    <p className="export-time-note">
                      {speedOptions.find((option) => option.id === exportSpeed)?.hint}
                      {selectedDuration > 0 ? ` Estimated ${formatRemaining(Math.max(1, Math.round(estimateExportSeconds(selectedDuration, exportResolution) * (speedOptions.find((option) => option.id === exportSpeed)?.factor ?? 1))))} for this clip.` : ''}
                      {exportSpeed === 'low' ? ' If the encoder runs out of memory, it retries once with less memory.' : ''}
                    </p>
                    {exportResolution === '1080p' && (duration > LONG_VIDEO_WARNING_SECONDS
                      ? <p className="export-warning">1080p takes longer and uses more memory. This clip needs roughly {formatRemaining(estimateExportSeconds(selectedDuration, '1080p'))} at 1080p; {RECOMMENDED_LONG_EXPORT_RESOLUTION} is usually a better trade-off.</p>
                      : <p className="export-warning">1080p takes longer and uses more memory.{deviceIsLowMemory ? ` Your device reports limited memory, so ${RECOMMENDED_LONG_EXPORT_RESOLUTION} is recommended.` : ''}</p>)}
                    <div className="video-export-actions">
                      {!isExporting ? (
                        <button className="button button-export download-action" onClick={startVideoExport} disabled={!file || lines.length === 0 || selectedDuration < 0.5}>
                          {videoDownloadComplete ? <Check size={16} /> : <Film size={16} />}
                          {videoDownloadComplete ? 'Downloaded' : 'Export video'}
                        </button>
                      ) : (
                        <>
                          <div className="export-progress video-export-progress" role="status">
                            <div><span>{exportProgress?.message ?? `Exporting ${exportProgress?.outputWidth} × ${exportProgress?.outputHeight}`}</span><strong>{exportProgress?.progress ?? 0}%</strong></div>
                            <progress max="100" value={exportProgress?.progress ?? 0} />
                            <small>{formatRemaining(exportProgress?.remaining ?? selectedDuration)} remaining</small>
                          </div>
                          <p className="keep-tab-note">Keep this tab open and in front until export finishes.</p>
                          {exportTabHidden && <p className="export-warning">Your tab is hidden — the export may slow down. Bring it back to the front.</p>}
                          <button className="button button-cancel-export" onClick={cancelVideoExport}>Cancel</button>
                        </>
                      )}
                    </div>
                    {exportError && <p className="export-error" role="alert">{exportError}</p>}
                    {exportSuccess && !videoDownloadComplete && <p className="export-success" role="status">{exportSuccess}</p>}
                    {!file && <p className="export-empty-note">Select a video to export.</p>}
                    {file && !lines.length && <p className="export-empty-note">Generate subtitles first.</p>}
                  </div>
                )}
              </section>
            </div>
          </div>
        </section>

        <aside className="right-panel phase-style-panel">
          <section className="workspace-card" aria-label="Project workspace">
            <header className="workspace-card-header">
              <div className="workspace-card-title">
                <span className="eyebrow">{file ? 'YOUR PROJECT' : 'PROJECT'}</span>
                <strong title={file?.name ?? undefined}>{file?.name ?? 'Your edit'}</strong>
              </div>
              {file && <button className="icon-button" title="Remove video" aria-label="Remove video" onClick={clearProject} disabled={isExporting}>×</button>}
            </header>
            <div className="workspace-tabs" role="tablist" aria-label="Project tools" onKeyDown={(event) => {
              if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
              event.preventDefault()
              const order = ['captions', 'style', 'translate'] as const
              const currentIndex = order.indexOf(workspaceTab)
              const nextIndex = (currentIndex + (event.key === 'ArrowRight' ? 1 : order.length - 1)) % order.length
              setWorkspaceTab(order[nextIndex])
              workspaceTabRefs.current[nextIndex]?.focus()
            }}>
              {([
                ['captions', 'Captions'],
                ['style', 'Style'],
                ['translate', 'Translate'],
              ] as const).map(([tab, label], index) => (
                <button
                  key={tab}
                  ref={(element) => { workspaceTabRefs.current[index] = element }}
                  id={`workspace-tab-${tab}`}
                  type="button"
                  role="tab"
                  aria-selected={workspaceTab === tab}
                  aria-controls="workspace-panel"
                  tabIndex={workspaceTab === tab ? 0 : -1}
                  className={`workspace-tab ${workspaceTab === tab ? 'is-active' : ''}`}
                  onClick={() => setWorkspaceTab(tab)}
                >
                  {tab === 'translate' && <Languages size={14} />}
                  {label}
                  {tab === 'captions' && lines.length > 0 && <small>{lines.length}</small>}
                </button>
              ))}
            </div>
            <div
              id="workspace-panel"
              className="workspace-tab-content"
              ref={workspaceTab === 'captions' ? captionsScrollRef : undefined}
              role="tabpanel"
              aria-labelledby={`workspace-tab-${workspaceTab}`}
              tabIndex={0}
            >
              {workspaceTab === 'captions' && (
                <div className="workspace-tab-inner captions-tab">
                  {resumeChoiceRequired && savedProjects[0] && (
                    <div className="caption-resume-note">
                      <strong>Continue your last project</strong>
                      <span>{savedProjects[0].fileName}</span>
                      <button type="button" className="button button-primary" onClick={() => void continueSavedProject(savedProjects[0].id)}>Continue</button>
                      <button type="button" className="button button-subtle" onClick={startNewProject}>Start new</button>
                    </div>
                  )}
                  <Uploader file={file} error={error} onFile={handleUploadedFile} onError={setError} disabled={isExporting || isPreparingVideo || resumeChoiceRequired} />
                  {relinkFile && (
                    <div className="caption-resume-note">
                      <strong>Re-select the same video to continue</strong>
                      <span>{relinkFile.fileName} · {Math.round(relinkFile.fileSize / (1024 * 1024))} MB</span>
                      <span>Captions, style and trim were restored. Choose the same file again to relink it.</span>
                    </div>
                  )}
                  {!resumeChoiceRequired && file && lines.length === 0 && transcribeState !== 'done' && (
                    <div className="generate-control">
                      {transcribeState === 'error' && transcribeFailedPart !== null ? (
                        <button className="button button-generate" onClick={retryTranscription} disabled={isExporting}>
                          {`Retry part ${transcribeFailedPart + 1} of ${transcribeParts?.total ?? '?'}`}
                        </button>
                      ) : (
                        <button
                          className="button button-generate"
                          onClick={doTranscribe}
                          disabled={isExporting || transcribeState === 'extracting' || transcribeState === 'fallback' || transcribeState === 'transcribing'}
                        >
                          {transcribeState === 'idle' || transcribeState === 'error' ? 'Generate Subtitles' : 'Processing...'}
                        </button>
                      )}
                      {(transcribeState === 'extracting' || transcribeState === 'fallback' || transcribeState === 'transcribing') && (
                        <button type="button" className="text-button" onClick={cancelTranscription}>Cancel</button>
                      )}
                      {transcribeState !== 'idle' && (
                        <div className="progress-wrap">
                          <span>
                            <span>{transcribeState === 'extracting'
                              ? 'Preparing audio...'
                              : transcribeState === 'fallback'
                                ? audioProgress?.message ?? 'Converting audio...'
                                : transcribeState === 'transcribing'
                                  ? transcribeParts
                                    ? `Transcribing part ${Math.min(transcribeParts.done + 1, transcribeParts.total)} of ${transcribeParts.total}`
                                    : 'Transcribing...'
                                  : ''}</span>
                            {transcribeState === 'fallback' && <b>{audioProgress?.progress ?? 0}%</b>}
                            {transcribeState === 'transcribing' && transcribeParts && <b>{Math.round((transcribeParts.done / transcribeParts.total) * 100)}%</b>}
                          </span>
                          <div className="progress-track">
                            <span style={{width: transcribeState === 'extracting' ? '10%' : transcribeState === 'fallback' ? `${Math.max(5, audioProgress?.progress ?? 0)}%` : transcribeParts ? `${Math.max(5, Math.round((transcribeParts.done / transcribeParts.total) * 100))}%` : '90%'}} />
                          </div>
                        </div>
                      )}
                      {transcribeState === 'error' && <div className="error-message" style={{marginTop:'10px'}}>{transcribeError}</div>}
                    </div>
                  )}
                  {!resumeChoiceRequired && (
                    <CaptionList
                      lines={lines}
                      rtl={showTranslated ? translatedRtl : template.rtl}
                      fontFamily={showTranslated ? renderTemplate.font : styleOverrides.font ?? template.font}
                      selectedId={selectedId}
                      currentTime={currentTime}
                      disabled={isExporting || translationState === 'translating'}
                      scrollContainerRef={captionsScrollRef}
                      onSelect={setSelectedId}
                      onSeek={seekWithinTrim}
                      onAddLine={handleAddLine}
                      editor={selectedLine ? (
                        <LineEditor
                          line={selectedLine}
                          direction={showTranslated ? translatedRtl ? 'rtl' : 'ltr' : template.rtl ? 'rtl' : 'ltr'}
                          fontFamily={showTranslated ? renderTemplate.font : styleOverrides.font ?? template.font}
                          onChange={handleLineChange}
                          onDelete={() => handleDelete(selectedLine.id)}
                          onSplit={() => handleSplit(selectedLine.id)}
                          onMergeUp={() => handleMergeUp(selectedLine.id)}
                          onMergeDown={() => handleMergeDown(selectedLine.id)}
                          canMergeUp={selectedLineIndex > 0}
                          canMergeDown={selectedLineIndex < lines.length - 1}
                          disabled={isExporting || translationState === 'translating'}
                        />
                      ) : null}
                    />
                  )}
                  {!file && !resumeChoiceRequired && <p className="workspace-empty-note">Choose a video to start your edit.</p>}
                </div>
              )}
              {workspaceTab === 'style' && (
                <div className="workspace-tab-inner style-tab">
                  <TemplatePicker
                    templates={templateOptions}
                    selected={template.id}
                    onSelect={setTemplate}
                    overrides={styleOverrides}
                    onOverride={updateStyleOverride}
                    onReset={() => setStyleOverrides({})}
                    disabled={isExporting || resumeChoiceRequired}
                  />
                  <div className="right-footnote"><span className="privacy-shield">✓</span><span>Rendered locally at preview resolution.</span></div>
                </div>
              )}
              {workspaceTab === 'translate' && (
                <div className="workspace-tab-inner translate-tab">
                  {!lines.length
                    ? <p className="workspace-empty-note">Generate subtitles before translating.</p>
                    : (
                      <section className="translation-panel" aria-label="Translate captions">
                        <div className="translation-panel-title">
                          <span className="translation-icon"><Languages size={16} /></span>
                          <div><strong>Translate captions</strong><small>Keep the original and switch any time.</small></div>
                        </div>
                        <label className="translation-target">
                          <span>Translate to</span>
                          <select
                            value={translationTarget}
                            onChange={(event) => changeTranslationTarget(event.currentTarget.value as TranslationTarget)}
                            disabled={isExporting || translationState === 'translating'}
                          >
                            {Object.entries(translationTargets).map(([value, label]) => (
                              <option key={value} value={value}>{label}</option>
                            ))}
                          </select>
                        </label>
                        <div className="translation-version" role="group" aria-label="Caption version">
                          <button type="button" aria-pressed={!showTranslated} className={!showTranslated ? 'is-selected' : ''} onClick={() => selectCaptionVersion(false)} disabled={isExporting || translationState === 'translating'}>Original</button>
                          <button type="button" aria-pressed={showTranslated} className={showTranslated ? 'is-selected' : ''} onClick={() => selectCaptionVersion(true)} disabled={isExporting || translationState === 'translating' || !lines.some((line) => line.translatedText !== undefined)}>Translated</button>
                        </div>
                        <button className="button button-translate" type="button" onClick={doTranslate} disabled={isExporting || translationState === 'translating'}>
                          <Languages size={15} />
                          {translationState === 'translating' ? 'Translating…' : 'Translate captions'}
                        </button>
                        {translationState === 'translating' && translationProgress && (
                          <div className="translation-progress" role="status" aria-live="polite">
                            <span>Batch {translationProgress.batch} of {translationProgress.total}</span>
                            <progress max={translationProgress.total} value={translationProgress.batch} />
                          </div>
                        )}
                        {translationError && <p className="translation-error" role="alert">{translationError}</p>}
                        <p className="translation-note">Translations can contain mistakes. Please review them.</p>
                      </section>
                    )}
                </div>
              )}
            </div>
          </section>
        </aside>
      </main>

      <section className="policy-notes" aria-label="Privacy and terms">
        <article id="privacy">
          <h2>Privacy</h2>
          <p>Your project is saved only in this browser on this device. Your video stays local. Extracted audio is sent to Groq for transcription; caption text is also sent to Groq when you use Translate. XCaptions does not store either on its server.</p>
        </article>
        <article id="terms">
          <h2>Terms &amp; limits</h2>
          <p>Videos longer than {formatClock(MAX_VIDEO_SECONDS)} are automatically shortened to the first {formatClock(MAX_VIDEO_SECONDS)}; you can choose another part of the original. Files over {MAX_VIDEO_MB} MB are prepared locally to fit the size limit. Audio is sent in short chunks for transcription. Free-use limits may apply. Upload only content you own or have permission to use.</p>
        </article>
      </section>
      <footer className="app-footer">
        <span>XCAPTIONS <i /> VIDEO STAYS LOCAL · AUDIO SENT FOR TRANSCRIPTION</span>
        <nav aria-label="Legal links"><a href="#privacy">Privacy</a><a href="#terms">Terms &amp; limits</a></nav>
      </footer>
    </div>
  )
}