import { useRef, useState } from 'react'
import { FileVideo2, Plus, Upload } from 'lucide-react'
import { MAX_FILE_HARD_MB, MAX_VIDEO_MB } from '../config/limits'

const MAX_FILE_BYTES = MAX_FILE_HARD_MB * 1024 * 1024
const ACCEPTED_EXTENSIONS = /\.(mp4|mov|webm|m4v|mkv)$/i

type UploaderProps = {
  file: File | null
  error: string
  onFile: (file: File) => void
  onError: (message: string) => void
  disabled?: boolean
}

function validateFile(file: File) {
  if (!file.type.startsWith('video/') && !ACCEPTED_EXTENSIONS.test(file.name)) return 'Choose an MP4, MOV, MKV, or WebM video.'
  if (file.size > MAX_FILE_BYTES) return `This file is larger than the ${MAX_FILE_HARD_MB} MB processing limit. Please choose a shorter or smaller video.`
  if (file.size === 0) return 'This video file is empty. Choose another file.'
  return ''
}

function formatSize(bytes: number) {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export default function Uploader({ file, error, onFile, onError, disabled = false }: UploaderProps) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [dragging, setDragging] = useState(false)

  const accept = (picked?: File) => {
    if (!picked) return
    const issue = validateFile(picked)
    if (issue) {
      onError(issue)
      return
    }
    onError('')
    onFile(picked)
  }

  return (
    <div className="uploader-wrap">
      <button
        className={`upload-tile ${dragging ? 'is-dragging' : ''}`}
        disabled={disabled}
        onClick={() => inputRef.current?.click()}
        onDragOver={(event) => { event.preventDefault(); setDragging(true) }}
        onDragLeave={() => setDragging(false)}
        onDrop={(event) => { event.preventDefault(); setDragging(false); accept(event.dataTransfer.files[0]) }}
        aria-label={file ? `Replace video, current file ${file.name}` : 'Choose a video to upload'}
      >
        <span className="upload-icon">{file ? <FileVideo2 size={19} /> : <Upload size={19} />}</span>
        <span className="upload-copy">
          <strong>{file?.name ?? 'Import a video'}</strong>
          <small>{file ? `${formatSize(file.size)} · stored on this device` : `MP4, MOV, MKV, WebM · clips over ${MAX_VIDEO_MB} MB are prepared locally`}</small>
        </span>
        <Plus size={16} className="upload-chevron" />
      </button>
      <input ref={inputRef} className="visually-hidden" type="file" accept="video/mp4,video/quicktime,video/webm,video/x-matroska,.mp4,.mov,.webm,.m4v,.mkv" aria-hidden="true" tabIndex={-1} onChange={(event) => { accept(event.currentTarget.files?.[0]); event.currentTarget.value = '' }} disabled={disabled} />
      {error && <div className="error-message" role="alert">{error}</div>}
    </div>
  )
}