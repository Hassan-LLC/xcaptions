export type Word = {
  word: string
  start: number
  end: number
}

export type SubtitleLine = {
  id: string
  text: string
  start: number
  end: number
  words: Word[]
  originalText?: string
  translatedText?: string
  originalWords?: Word[]
  translatedWords?: Word[]
}

export function chunkWords(words: Word[]): SubtitleLine[] {
  const lines: SubtitleLine[] = []
  let currentWords: Word[] = []
  
  for (let i = 0; i < words.length; i++) {
    const word = words[i]
    currentWords.push(word)
    
    const isPunctuation = /[.!?]$/.test(word.word.trim())
    const nextWord = words[i + 1]
    const hasLongPause = nextWord && (nextWord.start - word.end > 0.6)
    
    const cleanText = currentWords.map(w => w.word.trim()).join(' ')
    
    const hasTooManyWords = currentWords.length >= 3
    const hasTooManyChars = cleanText.length >= 18
    
    if (isPunctuation || hasLongPause || hasTooManyWords || hasTooManyChars || i === words.length - 1) {
      lines.push({
        id: Math.random().toString(36).substring(2, 9),
        text: cleanText,
        start: currentWords[0].start,
        end: currentWords[currentWords.length - 1].end,
        words: [...currentWords]
      })
      currentWords = []
    }
  }
  
  return lines
}
