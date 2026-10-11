export type SubtitleAnimation =
  | 'pop'
  | 'bounce'
  | 'zoomIn'
  | 'shake'
  | 'fade'
  | 'slideUp'
  | 'wordByWord'
  | 'typewriter'
  | 'karaoke'
  | 'glowPulse'

export type SubtitleTemplate = {
  id: string
  name: string
  font: string
  weight: number
  size: number
  color: string
  highlight: string
  gradient: string[] | null
  stroke: { color: string; width: number }
  outerStroke: { color: string; width: number } | null
  shadow: { color: string; blur: number; offsetY: number }
  glow: string | null
  background: { color: string; radius: number; padding: number; highlightActiveWord: boolean } | null
  uppercase: boolean
  letterSpacing: number
  rtl: boolean
  animation: SubtitleAnimation
  wordHighlight: boolean
  wordsPerLine: number
  lineHeight: number
}

export type SubtitleStyleOverrides = {
  font?: string
  size?: number
  positionY?: number
  positionX?: number
  color?: string
  highlight?: string
  strokeColor?: string
  strokeWidth?: number
  shadowEnabled?: boolean
  backgroundEnabled?: boolean
  backgroundColor?: string
  uppercase?: boolean
  letterSpacing?: number
  animation?: SubtitleAnimation
  wordsPerLine?: number
  lineHeight?: number
}
