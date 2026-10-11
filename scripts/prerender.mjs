import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { absoluteUrl, loadSiteConfig } from './site-config.mjs'
import { contentPages, renderFooter, renderHeader, TOOL_PATH } from '../src/content/pages.mjs'
import { MAX_AUDIO_CHUNK_SECONDS, MAX_FILE_HARD_MB, MAX_VIDEO_MB, MAX_VIDEO_MINUTES } from '../src/config/limits.ts'

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const distDir = join(projectRoot, 'dist')

const config = loadSiteConfig(projectRoot)
const buildDate = new Date().toISOString().slice(0, 10)

const escapeHtml = (value) => String(value)
  .replaceAll('&', '&amp;')
  .replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;')

const jsonLdScript = (data) => `<script type="application/ld+json">${JSON.stringify(data).replaceAll('<', '\\u003c')}</script>`

function analyticsScript(gaInitSrc) {
  const gaId = config.gaId
  if (!gaId) return ''
  const id = escapeHtml(gaId)
  return `<script async src="https://www.googletagmanager.com/gtag/js?id=${id}"></script>
  <script src="${escapeHtml(gaInitSrc)}" data-ga-id="${id}" defer></script>`
}

/** Build the shared `<head>` for a content page. */
function renderHead(ctx, view) {
  const canonical = view.noCanonical ? null : ctx.url(view.path)
  const image = ctx.asset('social-preview.png')
  const hreflang = view.noAlternates
    ? ''
    : ctx.alternates(view)
      .map((alt) => `  <link rel="alternate" hreflang="${alt.lang}" href="${escapeHtml(alt.url)}">`)
      .join('\n')
  const jsonLd = (view.jsonLd ?? []).map((entry) => `  ${jsonLdScript(entry)}`).join('\n')
  const robots = view.robots ?? 'index, follow, max-image-preview:large'
  const canonicalTag = canonical ? `\n  <link rel="canonical" href="${escapeHtml(canonical)}">` : ''
  const ogUrlTag = canonical ? `\n  <meta property="og:url" content="${escapeHtml(canonical)}">` : ''
  const homeAssets = view.path === '/'
    ? `  <link rel="stylesheet" href="${ctx.prefix}home.css">\n  <script src="${ctx.prefix}home.js" defer></script>`
    : ''

  return `<meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(view.title)}</title>
  <meta name="description" content="${escapeHtml(view.description)}">
  <meta name="robots" content="${robots}">${canonicalTag}
  <meta name="theme-color" content="#111210">
  <link rel="icon" href="${ctx.prefix}favicon.ico" sizes="any">
  <link rel="icon" href="${ctx.prefix}favicon.svg" type="image/svg+xml">
  <link rel="apple-touch-icon" href="${ctx.prefix}apple-touch-icon.png">
  <link rel="manifest" href="${ctx.prefix}manifest.webmanifest">
  <link rel="stylesheet" href="${ctx.prefix}site.css">
${homeAssets}
${hreflang}
  <meta property="og:type" content="website">
  <meta property="og:site_name" content="${escapeHtml(config.siteName)}">
  <meta property="og:title" content="${escapeHtml(view.title)}">
  <meta property="og:description" content="${escapeHtml(view.description)}">${ogUrlTag}
  <meta property="og:image" content="${escapeHtml(image)}">
  <meta property="og:image:width" content="1200">
  <meta property="og:image:height" content="630">
  <meta property="og:locale" content="en">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="${escapeHtml(view.title)}">
  <meta name="twitter:description" content="${escapeHtml(view.description)}">
  <meta name="twitter:image" content="${escapeHtml(image)}">
${jsonLd}`
}

function renderDocument(ctx, view, headHtml, bodyHtml) {
  return `<!doctype html>
<html lang="${view.lang}">
<head>
  ${headHtml}
</head>
<body>
  <a class="skip-link" href="#main">Skip to content</a>
  ${renderHeader(ctx, view.activeId)}
  <main id="main">
    <div class="wrap">
${bodyHtml}
    </div>
  </main>
  ${renderFooter(ctx)}
  ${analyticsScript(ctx.prefix + 'ga-init.js')}
</body>
</html>
`
}

function breadcrumbsHtml(ctx, page) {
  if (!page.breadcrumb) return ''
  return `      <nav class="breadcrumbs" aria-label="Breadcrumb"><ol><li><a href="${ctx.link('/')}">Home</a></li><li aria-current="page">${escapeHtml(page.breadcrumb)}</li></ol></nav>\n`
}

function breadcrumbJsonLd(ctx, page) {
  if (!page.breadcrumb) return []
  return [{
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'Home', item: ctx.url('/') },
      { '@type': 'ListItem', position: 2, name: page.breadcrumb, item: ctx.url(page.path) },
    ],
  }]
}

function makeContext(page) {
  const prefix = page.depth === 0 ? './' : '../'.repeat(page.depth)
  return {
    siteUrl: config.siteUrl,
    siteName: config.siteName,
    contactEmail: config.contactEmail,
    operator: config.operator,
    analyticsEnabled: Boolean(config.gaId),
    limits: { videoMinutes: MAX_VIDEO_MINUTES, maxVideoMb: MAX_VIDEO_MB, maxFileHardMb: MAX_FILE_HARD_MB, chunkSeconds: MAX_AUDIO_CHUNK_SECONDS },
    year: new Date().getFullYear(),
    prefix,
    link: (path) => prefix + String(path).replace(/^\//u, ''),
    url: (path) => absoluteUrl(config.siteUrl, path),
    asset: (name) => absoluteUrl(config.siteUrl, name),
    alternates: (view) => {
      const siblings = contentPages.filter((item) => item.translationKey === view.translationKey && item.path)
      const langs = siblings.length ? siblings : [{ lang: view.lang, path: view.path }]
      const list = langs.map((item) => ({ lang: item.lang, url: absoluteUrl(config.siteUrl, item.path) }))
      const fallback = list.find((item) => item.lang === 'en') ?? list[0]
      return [...list, { lang: 'x-default', url: fallback.url }]
    },
  }
}

/* -------------------------------------------------------------------------- */

if (!existsSync(distDir)) {
  throw new Error('The dist folder is missing. Run `vite build` before the prerender step.')
}

// 1. Turn the Vite-built tool shell into dist/app.html and remove the temporary head tags.
const builtShellPath = join(distDir, 'index.html')
if (!existsSync(builtShellPath)) {
  throw new Error('dist/index.html is missing. Did the Vite build run?')
}
const toolTitle = 'XCaptions Editor — Add Subtitles to a Video'
const toolDescription = 'Open XCaptions to add word-timed subtitles to a short video, edit and style captions, translate them, and export SRT, VTT or a captioned video in your browser.'
let shell = readFileSync(builtShellPath, 'utf8')
shell = shell.replace(/<title>[\s\S]*?<\/title>/u, `<title>${escapeHtml(toolTitle)}</title>`)
shell = shell.replace(/<meta\s+name="description"[^>]*>/iu, '')
const toolHead = `  <meta name="description" content="${escapeHtml(toolDescription)}">
  <meta name="robots" content="index, follow">
  <link rel="canonical" href="${escapeHtml(absoluteUrl(config.siteUrl, TOOL_PATH))}">
  <link rel="icon" href="./favicon.ico" sizes="any">
  <link rel="icon" href="./favicon.svg" type="image/svg+xml">
  <link rel="apple-touch-icon" href="./apple-touch-icon.png">
  <link rel="manifest" href="./manifest.webmanifest">
  <meta property="og:type" content="website">
  <meta property="og:site_name" content="${escapeHtml(config.siteName)}">
  <meta property="og:title" content="${escapeHtml(toolTitle)}">
  <meta property="og:description" content="${escapeHtml(toolDescription)}">
  <meta property="og:url" content="${escapeHtml(absoluteUrl(config.siteUrl, TOOL_PATH))}">
  <meta property="og:image" content="${escapeHtml(absoluteUrl(config.siteUrl, 'social-preview.png'))}">
  <meta property="og:image:width" content="1200">
  <meta property="og:image:height" content="630">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="${escapeHtml(toolTitle)}">
  <meta name="twitter:description" content="${escapeHtml(toolDescription)}">
  <meta name="twitter:image" content="${escapeHtml(absoluteUrl(config.siteUrl, 'social-preview.png'))}">
  ${jsonLdScript({
    '@type': 'WebPage',
    name: toolTitle,
    url: absoluteUrl(config.siteUrl, TOOL_PATH),
    description: toolDescription,
    inLanguage: 'en',
    isPartOf: { '@type': 'WebSite', url: absoluteUrl(config.siteUrl, '/'), name: config.siteName },
  })}
`
shell = shell.replace('</head>', `${toolHead}${analyticsScript('./ga-init.js')}\n</head>`)
// The editor lives at /app (rewritten to app.html by .htaccess); the home page
// replaces the built dist/index.html in step 2 below.
writeFileSync(join(distDir, 'app.html'), shell)

// 2. Render every content page to a real HTML file.
const rendered = []
for (const page of contentPages) {
  const ctx = makeContext(page)
  const { body, jsonLd } = page.build(ctx)
  const view = {
    path: page.path,
    lang: page.lang,
    translationKey: page.translationKey,
    activeId: page.id,
    breadcrumb: page.breadcrumb,
    title: page.title,
    description: page.description,
    jsonLd: [...(jsonLd ?? []), ...breadcrumbJsonLd(ctx, page)],
  }
  const head = renderHead(ctx, view)
  const bodyHtml = `${breadcrumbsHtml(ctx, page)}${body}`
  const html = renderDocument(ctx, view, head, bodyHtml)

  const outPath = page.depth === 0
    ? join(distDir, 'index.html')
    : join(distDir, page.path.replace(/^\/|\/$/gu, ''), 'index.html')
  mkdirSync(dirname(outPath), { recursive: true })
  writeFileSync(outPath, html)
  rendered.push(page.path)
}

// 3. Custom 404 page (served by Apache's ErrorDocument). It is requested at an
// arbitrary URL, so it uses absolute URLs and is never indexed.
{
  const notFound = {
    id: '404',
    path: '/404',
    depth: 1,
    lang: 'en',
    translationKey: '404',
    title: 'Page not found — XCaptions',
    description: 'The page you asked for does not exist. Use the links to reach the subtitle editor, the how it works guide or the FAQ.',
  }
  const base = makeContext(notFound)
  const ctx = {
    ...base,
    prefix: absoluteUrl(config.siteUrl, '/'),
    link: (path) => absoluteUrl(config.siteUrl, path),
  }
  const view = { ...notFound, activeId: '', robots: 'noindex, follow', jsonLd: [], noCanonical: true, noAlternates: true }
  const head = renderHead(ctx, view)
  const body = `<div class="hero">
        <p class="eyebrow">Error 404</p>
        <h1>This page could not be found</h1>
        <p class="answer">The link may be broken or the page may have moved. You can head back to the home page, read how the editor works, or open the editor directly and start adding subtitles.</p>
        <div class="hero-actions">
          <a class="btn btn-primary" href="${ctx.link(TOOL_PATH)}">Open the editor</a>
          <a class="btn btn-ghost" href="${ctx.link('/')}">Go to the home page</a>
        </div>
      </div>`
  writeFileSync(join(distDir, '404.html'), renderDocument(ctx, { ...view, breadcrumb: undefined }, head, body))
}

// 4. sitemap.xml
{
  const urls = [
    { path: '/', priority: '1.0' },
    ...contentPages.filter((page) => page.depth > 0).map((page) => ({ path: page.path, priority: '0.8' })),
    { path: TOOL_PATH, priority: '0.7' },
  ]
  const entries = urls.map((entry) => `  <url>
    <loc>${escapeHtml(absoluteUrl(config.siteUrl, entry.path))}</loc>
    <lastmod>${buildDate}</lastmod>
    <changefreq>monthly</changefreq>
    <priority>${entry.priority}</priority>
  </url>`).join('\n')
  writeFileSync(join(distDir, 'sitemap.xml'), `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${entries}
</urlset>
`)
}

// 5. robots.txt
{
  const disallow = 'Disallow: /api/'
  const aiBots = ['GPTBot', 'OAI-SearchBot', 'ChatGPT-User', 'PerplexityBot', 'ClaudeBot', 'Claude-Web', 'Google-Extended', 'Applebot-Extended', 'CCBot']
  const groups = aiBots.map((bot) => `User-agent: ${bot}\nAllow: /\n${disallow}`).join('\n\n')
  writeFileSync(join(distDir, 'robots.txt'), `# XCaptions
User-agent: *
Allow: /
${disallow}

# Answer engines and AI assistants are welcome.
${groups}

Sitemap: ${absoluteUrl(config.siteUrl, '/sitemap.xml')}
`)
}

// 6. llms.txt
{
  writeFileSync(join(distDir, 'llms.txt'), `# ${config.siteName}

> ${config.siteName} is a free, browser-based editor that creates word-timed subtitles. Videos longer than ${MAX_VIDEO_MINUTES} minutes are automatically shortened to the first ${MAX_VIDEO_MINUTES} minutes, and users can choose another part of the original. Files above ${MAX_VIDEO_MB} MB are prepared locally to fit the media limit; source files above ${MAX_FILE_HARD_MB} MB cannot be processed. Videos are never uploaded; only the extracted audio is sent for transcription, and only caption text is sent when translating. It can edit captions, style them, reframe to vertical or square formats, translate to English, Urdu, Roman Urdu, Hindi, Roman Hindi or Arabic, and export SRT, VTT, TXT, audio or a captioned video.

## What it does
- Creates automatic, word-timed subtitles from a short video's audio.
- Lets you edit, split, merge, retime, add and delete captions.
- Applies caption styles, including right-to-left styles for Urdu and a Devanagari style for Hindi.
- Reframes to 9:16, 1:1, 4:5, 16:9 or the original aspect ratio.
- Trims the clip and applies the trim to exports.
- Translates captions into English, Urdu (Urdu script), Roman Urdu, Hindi (Devanagari), Roman Hindi or Arabic.
- Exports SRT, VTT, TXT, extracted audio, or a captioned video at 480p, 720p, 1080p or original.
- Auto-saves up to three projects locally in the browser. No account is required.

## What it does not do
- It does not upload or store your video. The video is processed on your device.
- It does not offer a silence remover or an automatic clip splitter.
- It does not let you choose the spoken language; speech is detected automatically.
- It does not guarantee perfect accuracy. Captions and translations should be reviewed.
- It has no live collaboration, no cloud storage and no paid plan.

## Main pages
- [Home](${absoluteUrl(config.siteUrl, '/')}): what the editor does and how to start.
- [Urdu subtitle generator](${absoluteUrl(config.siteUrl, '/urdu-subtitle-generator/')}): Urdu and Roman Urdu subtitles.
- [Automatic subtitles for videos](${absoluteUrl(config.siteUrl, '/auto-subtitles-for-videos/')}): English, Hindi and Arabic.
- [Free CapCut alternative](${absoluteUrl(config.siteUrl, '/free-capcut-alternative-for-subtitles/')}): auto subtitles without CapCut.
- [Best free Urdu subtitle generator](${absoluteUrl(config.siteUrl, '/best-free-urdu-subtitle-generator/')}): Urdu and Roman Urdu captions.
- [XCaptions vs CapCut](${absoluteUrl(config.siteUrl, '/xcaptions-vs-capcut/')}): how the two compare for auto captions.
- [How it works](${absoluteUrl(config.siteUrl, '/how-it-works/')}): the end-to-end process.
- [FAQ](${absoluteUrl(config.siteUrl, '/faq/')}): limits, privacy, languages and export.
- [Privacy](${absoluteUrl(config.siteUrl, '/privacy/')}) and [Terms](${absoluteUrl(config.siteUrl, '/terms/')}).

## Editor
- [Open the editor](${absoluteUrl(config.siteUrl, TOOL_PATH)})

## Contact
${config.contactEmail}
`)
}

// 7. manifest.webmanifest
{
  writeFileSync(join(distDir, 'manifest.webmanifest'), `${JSON.stringify({
    name: `${config.siteName} — subtitle editor`,
    short_name: config.siteName,
    description: 'Create word-timed subtitles for short videos in your browser.',
    start_url: './app',
    scope: './',
    display: 'standalone',
    background_color: '#111210',
    theme_color: '#111210',
    icons: [
      { src: './icon-192.png', sizes: '192x192', type: 'image/png' },
      { src: './icon-512.png', sizes: '512x512', type: 'image/png' },
      { src: './maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
      { src: './favicon.svg', sizes: 'any', type: 'image/svg+xml' },
    ],
  }, null, 2)}\n`)
}

console.log(`[prerender] ${rendered.length} pages + 404 = ${rendered.concat('/404').join(', ')}`)
console.log(`[prerender] SITE_URL = ${config.siteUrl}`)
console.log(`[prerender] analytics = ${config.gaId ? 'ga4' : 'disabled'}`)
