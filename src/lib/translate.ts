export const translationTargets = {
  en: 'English',
  ur: 'Urdu in Urdu script',
  'roman-ur': 'natural Roman Urdu using common conversational spelling',
  hi: 'Hindi in Devanagari',
  'roman-hi': 'Hindi written in the Latin alphabet',
  ar: 'Arabic script',
} as const

export type TranslationTarget = keyof typeof translationTargets

const BATCH_SIZE = 40

export async function translateCaptions(
  lines: string[],
  target: TranslationTarget,
  onProgress: (batch: number, total: number) => void,
) {
  const endpoint = new URL(`${import.meta.env.BASE_URL}api/translate.php`, window.location.href)
  const translated: string[] = []
  const batches = Math.ceil(lines.length / BATCH_SIZE)

  for (let index = 0; index < batches; index += 1) {
    const batch = lines.slice(index * BATCH_SIZE, (index + 1) * BATCH_SIZE)
    onProgress(index + 1, batches)
    let response: Response
    try {
      response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lines: batch, target }),
      })
    } catch {
      throw new Error('Could not reach the translation service. Check your connection and try again.')
    }

    let result: { translations?: unknown; error?: unknown }
    try {
      result = await response.json() as { translations?: unknown; error?: unknown }
    } catch {
      throw new Error('The translation service returned an invalid response. Please try again.')
    }
    if (!response.ok) {
      throw new Error(typeof result.error === 'string'
        ? result.error
        : response.status === 429
          ? 'The translation limit has been reached. Please wait and try again.'
          : 'Translation failed. Please try again.')
    }
    if (!Array.isArray(result.translations)
      || result.translations.length !== batch.length
      || !result.translations.every((text) => typeof text === 'string')) {
      throw new Error('The translation service returned an unexpected number of captions. Please retry.')
    }
    translated.push(...result.translations)
  }

  return translated
}
