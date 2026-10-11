import { loadEnv } from 'vite'

export const FALLBACK_SITE_URL = 'https://example.com'

/**
 * Build-time site configuration.
 *
 * Every value comes from the environment so the real domain is never hardcoded.
 * `SITE_URL` drives canonical URLs, sitemap.xml, robots.txt, llms.txt and the
 * absolute URLs inside the JSON-LD. When it is missing we fall back to the
 * documented placeholder so a local build still works.
 */
export function loadSiteConfig(root) {
  const env = loadEnv('production', root, '')

  const rawUrl = (env.SITE_URL || process.env.SITE_URL || '').trim() || FALLBACK_SITE_URL
  const siteUrl = rawUrl.replace(/\/+$/u, '')
  const siteName = (env.SITE_NAME || process.env.SITE_NAME || 'XCaptions').trim()
  const contactEmail = (env.SITE_CONTACT_EMAIL || process.env.SITE_CONTACT_EMAIL || 'hello@example.com').trim()
  const operator = (env.SITE_OPERATOR || process.env.SITE_OPERATOR || 'the XCaptions team').trim()

  // Google Analytics 4 measurement ID. Empty = no analytics script is emitted.
  const gaId = (env.VITE_GA_ID || process.env.VITE_GA_ID || '').trim()

  return { siteUrl, siteName, contactEmail, operator, gaId }
}

/** Absolute URL for a route path (`path` may be `/`, `/faq/` or an asset path). */
export function absoluteUrl(siteUrl, path) {
  if (/^https?:\/\//iu.test(path)) return path
  const clean = path.startsWith('/') ? path : `/${path}`
  return `${siteUrl}${clean}`
}
