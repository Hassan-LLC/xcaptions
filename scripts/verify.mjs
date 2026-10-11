// End-to-end verification for SubtitleStudio.
//
// 1. Serves the production `dist` folder through a small server that mirrors the
//    production .htaccess routing (directory index, /app -> app.html, custom
//    404) and provides mock transcription/translation endpoints.
// 2. Checks every static page for title, description, canonical, Open Graph,
//    a single H1, valid JSON-LD and no broken internal links.
// 3. Drives headless Chrome through CDP to load each page and to smoke-test the
//    editor (upload a generated clip, generate captions from the mock API and
//    export a captioned video).
//
// Run with: npm run verify   (after npm run build)

import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import {
  copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync,
} from 'node:fs'
import { join, normalize, extname, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import net from 'node:net'

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const DIST = join(projectRoot, 'dist')
const SERVER_PORT = 5210
const CDP_PORT = 9334
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const shotsDir = join(projectRoot, '.verify', 'shots')
const downloadsDir = join(projectRoot, '.verify', 'downloads')
rmSync(downloadsDir, { recursive: true, force: true })
mkdirSync(shotsDir, { recursive: true })
mkdirSync(downloadsDir, { recursive: true })

const PERF = (() => {
  const arg = process.argv.find((value) => value.startsWith('--perf'))
  if (!arg) return null
  const value = arg.includes('=') ? arg.split('=')[1] : 'all'
  return value === 'true' ? 'all' : value
})()
const checks = []
let transcribeCalls = 0
const log = (...args) => console.log('[verify]', ...args)
const sleep = (ms) => new Promise((done) => setTimeout(done, ms))
function check(name, condition, detail) {
  checks.push({ name, pass: Boolean(condition), detail: detail ?? null })
  log(`${condition ? 'PASS' : 'FAIL'} — ${name}${detail ? ' :: ' + detail : ''}`)
  if (!condition) throw new Error(`Check failed: ${name} (${detail ?? ''})`)
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
}

/* ---------------------------------------------------------------- HTTP server */

function sendFile(res, filePath, status = 200) {
  const type = MIME[extname(filePath).toLowerCase()] ?? 'application/octet-stream'
  res.writeHead(status, { 'Content-Type': type })
  res.end(readFileSync(filePath))
}

function startServer() {
  const server = createServer((req, res) => {
    const raw = (req.url ?? '/').split('?')[0].split('#')[0]
    let pathname
    try { pathname = decodeURIComponent(raw) } catch { pathname = raw }

    if (pathname === '/api/transcribe.php') {
      let size = 0
      req.on('data', (c) => { size += c.length })
      req.on('end', () => {
        transcribeCalls += 1
        const n = transcribeCalls
        // Times are relative to the chunk; the app adds each chunk's offset.
        const words = [
          { word: `part${n}`, start: 0.2, end: 0.5 },
          { word: 'captions', start: 0.6, end: 1.0 },
          { word: `done${n}`, start: 1.1, end: 1.5 },
        ]
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ words }))
      })
      return
    }
    if (pathname === '/api/translate.php') {
      const chunks = []
      req.on('data', (c) => chunks.push(c))
      req.on('end', () => {
        let lines = []
        try { lines = JSON.parse(Buffer.concat(chunks).toString('utf8')).lines ?? [] } catch { /* ignore */ }
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ translations: lines.map((line) => `[Urdu] ${line}`) }))
      })
      return
    }

    if (pathname === '/app/') {
      res.writeHead(301, { Location: '/app' })
      res.end()
      return
    }
    if (pathname === '/app') {
      sendFile(res, join(DIST, 'app.html'))
      return
    }

    const safe = normalize(pathname).replace(/^(\.\.[/\\])+/u, '')
    let target = join(DIST, safe)
    if (!target.startsWith(DIST)) target = DIST

    if (pathname.endsWith('/')) target = join(target, 'index.html')
    if (existsSync(target) && statSync(target).isDirectory()) {
      res.writeHead(301, { Location: `${pathname}/` })
      res.end()
      return
    }
    if (!existsSync(target) || statSync(target).isDirectory()) {
      sendFile(res, join(DIST, '404.html'), 404)
      return
    }
    sendFile(res, target)
  })
  return new Promise((done) => server.listen(SERVER_PORT, '127.0.0.1', () => done(server)))
}

function waitForPort(port, timeoutMs) {
  const started = Date.now()
  return new Promise((done, fail) => {
    const attempt = () => {
      const socket = net.connect({ host: '127.0.0.1', port })
      socket.once('connect', () => { socket.destroy(); done() })
      socket.once('error', () => {
        socket.destroy()
        if (Date.now() - started > timeoutMs) fail(new Error(`Port ${port} never opened`))
        else setTimeout(attempt, 250)
      })
    }
    attempt()
  })
}

/* ---------------------------------------------------------------------- CDP */

class CDP {
  static connect(url) {
    return new Promise((done, fail) => {
      const ws = new WebSocket(url)
      ws.addEventListener('open', () => done(new CDP(ws)))
      ws.addEventListener('error', () => fail(new Error('CDP websocket error')))
    })
  }
  constructor(ws) {
    this.ws = ws
    this.id = 0
    this.pending = new Map()
    this.listeners = new Map()
    ws.addEventListener('message', (event) => {
      const message = JSON.parse(event.data)
      if (message.id !== undefined && this.pending.has(message.id)) {
        const { resolve, reject } = this.pending.get(message.id)
        this.pending.delete(message.id)
        if (message.error) reject(new Error(message.error.message))
        else resolve(message.result)
      } else if (message.method) {
        for (const handler of this.listeners.get(message.method) ?? []) handler(message.params)
      }
    })
  }
  on(method, handler) {
    const list = this.listeners.get(method) ?? []
    list.push(handler)
    this.listeners.set(method, list)
  }
  send(method, params = {}) {
    const id = ++this.id
    this.ws.send(JSON.stringify({ id, method, params }))
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }))
  }
  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true })
    if (result.exceptionDetails) throw new Error('Page exception: ' + JSON.stringify(result.exceptionDetails.exception?.description ?? result.exceptionDetails))
    return result.result.value
  }
  async screenshot(name) {
    const { data } = await this.send('Page.captureScreenshot', { format: 'png' })
    writeFileSync(join(shotsDir, name), Buffer.from(data, 'base64'))
  }
}

async function poll(cdp, expression, timeoutMs, description) {
  const started = Date.now()
  for (;;) {
    if (await cdp.evaluate(expression)) return true
    if (Date.now() - started > timeoutMs) throw new Error(`Timed out waiting for ${description}`)
    await sleep(200)
  }
}

/* --------------------------------------------------------------- HTML checks */

const PAGES = [
  { url: '/', expect: ['Organization', 'WebSite', 'SoftwareApplication'], h1: 1 },
  { url: '/urdu-subtitle-generator/', expect: ['FAQPage', 'BreadcrumbList'] },
  { url: '/auto-subtitles-for-videos/', expect: ['FAQPage', 'BreadcrumbList'] },
  { url: '/how-it-works/', expect: ['HowTo', 'BreadcrumbList'] },
  { url: '/faq/', expect: ['FAQPage', 'BreadcrumbList'] },
  { url: '/privacy/', expect: ['BreadcrumbList'] },
  { url: '/terms/', expect: ['BreadcrumbList'] },
]

const attr = (html, regex) => (html.match(regex)?.[1] ?? '').trim()

async function checkPage(page) {
  const res = await fetch(`http://127.0.0.1:${SERVER_PORT}${page.url}`)
  check(`${page.url} returns 200`, res.status === 200, String(res.status))
  const html = await res.text()

  const title = attr(html, /<title>([\s\S]*?)<\/title>/iu)
  const description = attr(html, /<meta\s+name="description"\s+content="([^"]*)"/iu)
  const canonical = attr(html, /<link\s+rel="canonical"\s+href="([^"]*)"/iu)
  const ogTitle = attr(html, /<meta\s+property="og:title"\s+content="([^"]*)"/iu)
  const ogDesc = attr(html, /<meta\s+property="og:description"\s+content="([^"]*)"/iu)
  const ogImage = attr(html, /<meta\s+property="og:image"\s+content="([^"]*)"/iu)
  const twitter = attr(html, /<meta\s+name="twitter:card"\s+content="([^"]*)"/iu)
  const lang = attr(html, /<html\s+lang="([^"]*)"/iu)
  const viewport = attr(html, /<meta\s+name="viewport"\s+content="([^"]*)"/iu)
  const h1Count = (html.match(/<h1[\s>]/giu) ?? []).length

  check(`${page.url} title present and <= 60 chars`, title.length > 0 && title.length <= 60, `${title.length}: ${title}`)
  check(`${page.url} description present and <= 155 chars`, description.length > 0 && description.length <= 155, `${description.length}`)
  check(`${page.url} has a canonical URL`, canonical.startsWith('http'), canonical)
  check(`${page.url} has Open Graph title/description/image`, Boolean(ogTitle && ogDesc && ogImage), ogImage)
  check(`${page.url} has a Twitter card and image`, twitter === 'summary_large_image', twitter)
  check(`${page.url} html lang is set`, lang.length >= 2, lang)
  check(`${page.url} has a viewport meta`, viewport.includes('width=device-width'), viewport)
  check(`${page.url} has exactly one H1`, h1Count === 1, String(h1Count))

  const ldNodes = [...html.matchAll(/<script\s+type="application\/ld\+json">([\s\S]*?)<\/script>/giu)]
  const types = new Set()
  for (const node of ldNodes) {
    let parsed
    try { parsed = JSON.parse(node[1]) } catch (error) { throw new Error(`Invalid JSON-LD on ${page.url}: ${error.message}`) }
    const list = Array.isArray(parsed) ? parsed : (parsed['@graph'] ?? [parsed])
    for (const item of list) {
      if (item['@type']) types.add(item['@type'])
    }
  }
  check(`${page.url} JSON-LD parses`, ldNodes.length >= 0)
  for (const type of page.expect ?? []) {
    check(`${page.url} JSON-LD includes ${type}`, types.has(type), [...types].join(', '))
  }
  return html
}

function internalLinks(html, pageUrl) {
  const links = new Set()
  for (const match of html.matchAll(/<a\s[^>]*href="([^"]+)"/giu)) {
    const href = match[1]
    if (href.startsWith('http') || href.startsWith('mailto:') || href.startsWith('#')) continue
    links.add(new URL(href, `http://127.0.0.1:${SERVER_PORT}${pageUrl}`).pathname)
  }
  return [...links]
}

/* ----------------------------------------------------------------------- main */

function generateVideoSource(width, height, seconds, fps = 30, fileName = 'verify.mp4', bitrate = null) {
  const frames = Math.max(1, Math.round(fps * seconds))
  const codec = width * height > 1280 * 720 ? 'avc1.420028' : 'avc1.42001f'
  const resolvedBitrate = bitrate ?? (width * height > 1280 * 720 ? 8000000 : 4000000)
  return `(async () => {
  const { Muxer, ArrayBufferTarget } = await import('/assets/mp4-muxer-verify.js')
  const width = ${width}, height = ${height}, fps = ${fps}, seconds = ${seconds}
  const frames = ${frames}
  const target = new ArrayBufferTarget()
  const muxer = new Muxer({ target, video: { codec: 'avc', width, height, frameRate: fps }, audio: { codec: 'aac', sampleRate: 48000, numberOfChannels: 1 }, fastStart: 'in-memory' })
  const videoConfig = { codec: '${codec}', width, height, bitrate: ${resolvedBitrate}, framerate: fps, avc: { format: 'avc' } }
  const vSupport = await VideoEncoder.isConfigSupported(videoConfig)
  if (!vSupport.supported) return { ok: false, stage: 'video-encode' }
  const videoEncoder = new VideoEncoder({ output: (chunk, meta) => muxer.addVideoChunk(chunk, meta), error: (e) => { throw e } })
  videoEncoder.configure(videoConfig)
  const canvas = new OffscreenCanvas(width, height)
  const ctx = canvas.getContext('2d')
  for (let i = 0; i < frames; i++) {
    const t = i / fps
    ctx.fillStyle = 'hsl(' + ((i * 5) % 360) + ' 50% 26%)'
    ctx.fillRect(0, 0, width, height)
    ctx.fillStyle = '#ffe600'
    ctx.beginPath(); ctx.arc(width / 2 + Math.sin(t * 2) * 300, height / 2, 80, 0, Math.PI * 2); ctx.fill()
    const frame = new VideoFrame(canvas, { timestamp: Math.round(i * 1e6 / fps), duration: Math.round(1e6 / fps) })
    videoEncoder.encode(frame, { keyFrame: i % 30 === 0 })
    frame.close()
  }
  await videoEncoder.flush(); videoEncoder.close()
  const audioConfig = { codec: 'mp4a.40.2', sampleRate: 48000, numberOfChannels: 1, bitrate: 96000 }
  const aSupport = await AudioEncoder.isConfigSupported(audioConfig)
  if (!aSupport.supported) return { ok: false, stage: 'audio-encode' }
  const audioEncoder = new AudioEncoder({ output: (chunk, meta) => muxer.addAudioChunk(chunk, meta), error: (e) => { throw e } })
  audioEncoder.configure(audioConfig)
  const totalSamples = 48000 * seconds
  for (let offset = 0; offset < totalSamples; offset += 4096) {
    const count = Math.min(4096, totalSamples - offset)
    const data = new Float32Array(count)
    const audioData = new AudioData({ format: 'f32-planar', sampleRate: 48000, numberOfFrames: count, numberOfChannels: 1, timestamp: Math.round(offset / 48000 * 1e6), data })
    audioEncoder.encode(audioData); audioData.close()
  }
  await audioEncoder.flush(); audioEncoder.close()
  muxer.finalize()
  const blob = new Blob([target.buffer], { type: 'video/mp4' })
  const file = new File([blob], ${JSON.stringify(fileName)}, { type: 'video/mp4', lastModified: Date.now() })
  const transfer = new DataTransfer()
  transfer.items.add(file)
  const input = document.querySelector('.uploader-wrap input[type=file]')
  if (!input) return { ok: false, stage: 'input' }
  input.files = transfer.files
  input.dispatchEvent(new Event('change', { bubbles: true }))
  return { ok: true, size: blob.size }
})()`
}

function newestDownload() {
  const files = readdirSync(downloadsDir).filter((name) => /^subtitled-video\.(mp4|webm)$/u.test(name))
  if (!files.length) return null
  return files.map((name) => ({ name, path: join(downloadsDir, name), mtime: statSync(join(downloadsDir, name)).mtimeMs })).sort((a, b) => b.mtime - a.mtime)[0]
}

async function loadClipAndCaptions(cdp, gen) {
  await cdp.send('Page.navigate', { url: `http://127.0.0.1:${SERVER_PORT}/app` })
  await poll(cdp, `document.querySelector('.uploader-wrap input[type=file]') ? true : false`, 30000, 'editor mount')
  const startNew = `[...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Start new')`
  if (await cdp.evaluate(`!!(${startNew})`)) {
    await cdp.evaluate(`(${startNew}).click()`)
    await sleep(400)
  }
  const generated = await cdp.evaluate(generateVideoSource(gen.width, gen.height, gen.seconds, gen.fps ?? 30, gen.name ?? 'verify.mp4', gen.bitrate ?? null))
  if (!generated?.ok) throw new Error('clip generation failed: ' + JSON.stringify(generated))
  await poll(cdp, `document.querySelector('.generate-control .button-generate') ? true : false`, 20000, 'generate button')
  await cdp.evaluate(`document.querySelector('.generate-control .button-generate').click()`)
  await poll(cdp, `document.querySelectorAll('.caption-row').length > 0 ? true : false`, 600000, 'captions')
  return cdp.evaluate(`document.querySelectorAll('.caption-row').length`)
}

async function timeExport(cdp, resolution, mode) {
  await cdp.evaluate(`localStorage.setItem('ssExportMode', ${JSON.stringify(mode)})`)
  await cdp.evaluate(`document.querySelector('#download-option-video').click()`)
  await sleep(300)
  await cdp.evaluate(`[...document.querySelectorAll('.resolution-pills .format-pill')].find((b) => b.textContent.trim() === ${JSON.stringify(resolution)}).click()`)
  await sleep(300)
  const t0 = Date.now()
  await cdp.evaluate(`(() => { const b = [...document.querySelectorAll('.video-export-actions button')].find((x) => x.textContent.includes('Export video') || x.textContent.includes('Downloaded')); b.click(); return true })()`)
  await poll(cdp, `document.querySelector('.export-progress') ? true : false`, 30000, 'export started')
  for (;;) {
    await sleep(400)
    const state = await cdp.evaluate(`(() => {
      if (document.querySelector('.export-error')?.textContent.trim()) return 'error'
      if (document.querySelector('.export-progress')) return 'running'
      return 'done'
    })()`)
    if (state === 'error') throw new Error('export error: ' + await cdp.evaluate(`document.querySelector('.export-error').textContent`))
    if (state === 'done') break
    if (Date.now() - t0 > 1800000) throw new Error('export timed out')
  }
  return Date.now() - t0
}

async function main() {
  if (!existsSync(join(DIST, 'index.html')) || !existsSync(join(DIST, 'app.html'))) {
    throw new Error('dist is not built. Run `npm run build` first.')
  }
  // Verification-only helper for synthesising a test clip in the page.
  mkdirSync(join(DIST, 'assets'), { recursive: true })
  copyFileSync(join(projectRoot, 'node_modules/mp4-muxer/build/mp4-muxer.mjs'), join(DIST, 'assets', 'mp4-muxer-verify.js'))

  let chrome
  let userDataDir
  const server = await startServer()
  await waitForPort(SERVER_PORT, 15000)
  log('static server up on', SERVER_PORT)

  // --- Static SEO checks -------------------------------------------------
  const pageHtml = {}
  for (const page of PAGES) pageHtml[page.url] = await checkPage(page)

  const robots = await (await fetch(`http://127.0.0.1:${SERVER_PORT}/robots.txt`)).text()
  check('robots.txt allows crawling and links the sitemap', robots.includes('Allow: /') && robots.includes('Sitemap:'), '')
  check('robots.txt disallows /api/', robots.includes('Disallow: /api/'), '')
  const sitemap = await (await fetch(`http://127.0.0.1:${SERVER_PORT}/sitemap.xml`)).text()
  check('sitemap.xml lists the pages with lastmod', sitemap.includes('<loc>') && sitemap.includes('<lastmod>'), '')
  for (const page of PAGES) {
    const loc = page.url === '/' ? '' : page.url
    check(`sitemap.xml includes ${page.url}`, sitemap.includes(`/${loc.replace(/^\//u, '')}`) || (page.url === '/' && /<loc>[^<]*\/<\/loc>/u.test(sitemap)))
  }
  const llms = await (await fetch(`http://127.0.0.1:${SERVER_PORT}/llms.txt`)).text()
  check('llms.txt describes the site and its pages', llms.startsWith('# ') && llms.includes('## Main pages') && llms.includes('does not'), '')
  const manifestRes = await fetch(`http://127.0.0.1:${SERVER_PORT}/manifest.webmanifest`)
  const manifest = await manifestRes.json()
  check('manifest has a name and icons', Boolean(manifest.name) && Array.isArray(manifest.icons) && manifest.icons.length > 0, manifestRes.headers.get('content-type') ?? '')
  const notFound = await fetch(`http://127.0.0.1:${SERVER_PORT}/definitely-not-a-page`)
  check('unknown URLs return the custom 404 with a 404 status', notFound.status === 404 && (await notFound.text()).includes('could not be found'), String(notFound.status))
  const appShell = await fetch(`http://127.0.0.1:${SERVER_PORT}/app`)
  check('/app serves the editor shell', appShell.status === 200 && (await appShell.text()).includes('id="root"'), String(appShell.status))

  // --- Internal link crawl ----------------------------------------------
  const seen = new Set()
  const toCheck = new Set()
  for (const [pageUrl, html] of Object.entries(pageHtml)) {
    for (const link of internalLinks(html, pageUrl)) toCheck.add(link)
  }
  for (const link of toCheck) {
    if (seen.has(link)) continue
    seen.add(link)
    const res = await fetch(`http://127.0.0.1:${SERVER_PORT}${link}`, { redirect: 'manual' })
    check(`internal link ${link} resolves`, res.status === 200 || res.status === 301, String(res.status))
  }

  // --- Browser rendering + tool smoke test ------------------------------
  userDataDir = mkdtempSync(join(tmpdir(), 'ss-verify-'))
  chrome = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--disable-dev-shm-usage', '--disable-background-networking', '--disable-component-update',
    '--disable-sync', '--no-service-autorun', '--log-level=3',
    `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${userDataDir}`, '--window-size=1440,1200', 'about:blank',
  ], { stdio: 'ignore' })

  let cdp
  const pageErrors = []
  try {
    await waitForPort(CDP_PORT, 30000)
    const targets = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json`)).json()
    const page = targets.find((target) => target.type === 'page')
    cdp = await CDP.connect(page.webSocketDebuggerUrl)
    await cdp.send('Page.enable')
    await cdp.send('Runtime.enable')
    await cdp.send('Log.enable')
    await cdp.send('Network.enable')
    cdp.on('Runtime.exceptionThrown', (params) => pageErrors.push(params.exceptionDetails?.exception?.description ?? 'exception'))
    cdp.on('Runtime.consoleAPICalled', (params) => {
      if (params.type !== 'error' && params.type !== 'warning') return
      const text = params.args.map((a) => a.value ?? a.description ?? '').join(' ')
      if (params.type === 'error') pageErrors.push(text)
      log(`console.${params.type}:`, text.slice(0, 160))
    })
    cdp.on('Log.entryAdded', (params) => { if (params.entry.level === 'error') pageErrors.push(params.entry.text) })
    cdp.on('Network.responseReceived', (params) => { if (params.response.status >= 400 && !params.response.url.includes('favicon')) pageErrors.push(`HTTP ${params.response.status} ${params.response.url}`) })
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false })
    await cdp.send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: downloadsDir })

    // Load each content page in a real browser and confirm it renders cleanly.
    for (const target of [{ url: '/', name: 'home' }, { url: '/faq/', name: 'faq' }, { url: '/urdu-subtitle-generator/', name: 'urdu' }]) {
      await cdp.send('Page.navigate', { url: `http://127.0.0.1:${SERVER_PORT}${target.url}` })
      await poll(cdp, `document.querySelector('h1') ? true : false`, 15000, `${target.name} render`)
      const heading = await cdp.evaluate(`document.querySelector('h1').textContent.trim()`)
      check(`browser renders ${target.name} with an H1`, heading.length > 0, heading.slice(0, 60))
      await cdp.screenshot(`seo-${target.name}.png`)
    }

    // Editor smoke test.
    log('opening the editor at /app…')
    await cdp.send('Page.navigate', { url: `http://127.0.0.1:${SERVER_PORT}/app` })
    await poll(cdp, `document.querySelector('.uploader-wrap input[type=file]') ? true : false`, 30000, 'editor mount')
    const generated = await cdp.evaluate(generateVideoSource(1280, 720, 4, 30))
    check('test clip loads into the editor', generated?.ok === true, JSON.stringify(generated))
    await poll(cdp, `document.querySelector('.generate-control .button-generate') ? true : false`, 20000, 'generate button')
    await cdp.evaluate(`document.querySelector('.generate-control .button-generate').click()`)
    await poll(cdp, `document.querySelectorAll('.caption-row').length > 0 ? true : false`, 180000, 'captions from mock API')
    const captionCount = await cdp.evaluate(`document.querySelectorAll('.caption-row').length`)
    check('captions are generated from the API', captionCount > 0, String(captionCount))
    await cdp.screenshot('editor-captions.png')

    // Export a captioned video.
    log('exporting a captioned video…')
    await cdp.evaluate(`document.querySelector('#download-option-video').click()`)
    await sleep(300)
    await cdp.evaluate(`[...document.querySelectorAll('.resolution-pills .format-pill')].find((b) => b.textContent.trim() === '480p').click()`)
    await sleep(300)
    await cdp.evaluate(`(() => { try { HTMLVideoElement.prototype.requestVideoFrameCallback = undefined } catch (e) {} return true })()`)
    const exportSelector = `[...document.querySelectorAll('.video-export-actions button')].find((b) => b.textContent.includes('Export video'))`
    const available = await cdp.evaluate(`(() => { const b = ${exportSelector}; return b ? { text: b.textContent.trim(), disabled: b.disabled } : null })()`)
    log('export button:', JSON.stringify(available))
    check('export button is available', Boolean(available) && !available.disabled, JSON.stringify(available))
    await cdp.evaluate(`(${exportSelector}).click()`)
    const started = Date.now()
    let status = 'running'
    while (Date.now() - started < 150000) {
      const snapshot = await cdp.evaluate(`(() => {
        const error = document.querySelector('.export-error')
        if (error && error.textContent.trim()) return { status: 'error', message: error.textContent.trim() }
        const button = [...document.querySelectorAll('.video-export-actions button')].find((b) => b.textContent.includes('Downloaded'))
        if (button) return { status: 'ok' }
        const span = document.querySelector('.export-progress span')
        const strong = document.querySelector('.export-progress strong')
        return { status: 'running', message: (span ? span.textContent.trim() : '') + ' ' + (strong ? strong.textContent.trim() : '') }
      })()`)
      log('export:', snapshot.status, snapshot.message ?? '')
      if (snapshot.status !== 'running') { status = snapshot.status; if (snapshot.status === 'error') log('export error:', snapshot.message); break }
      await sleep(3000)
    }
    check('captioned video export completes', status === 'ok', status)
    await sleep(1000)
    const download = newestDownload()
    check('an exported video file was downloaded', Boolean(download), download?.name ?? 'none')
    if (download) {
      const bytes = readFileSync(download.path)
      check('exported file is a real MP4', bytes.subarray(4, 8).toString('latin1') === 'ftyp', `${bytes.length} bytes`)
    }

    if (PERF) {
      const results = {}
      const perfSeconds = Number(process.env.PERF_SECONDS ?? 60)
      if (PERF === 'all' || PERF === '720') {
        log(`perf: loading a ${perfSeconds}s 720p clip…`)
        await loadClipAndCaptions(cdp, { width: 1280, height: 720, seconds: perfSeconds })
        results['720p_offline_ms'] = await timeExport(cdp, '720p', 'offline')
        log('perf: 720p offline =', results['720p_offline_ms'], 'ms')
        results['720p_playback_ms'] = await timeExport(cdp, '720p', 'playback')
        log('perf: 720p playback (BEFORE) =', results['720p_playback_ms'], 'ms')
      }
      if (PERF === 'all' || PERF === '1080') {
        log(`perf: loading a ${perfSeconds}s 1080p clip…`)
        await loadClipAndCaptions(cdp, { width: 1920, height: 1080, seconds: perfSeconds })
        results['1080p_offline_ms'] = await timeExport(cdp, '1080p', 'offline')
        log('perf: 1080p offline =', results['1080p_offline_ms'], 'ms')
      }
      if (PERF === 'all' || PERF === 'long') {
        const longSeconds = Number(process.env.LONG_SECONDS ?? 600)
        const callsBefore = transcribeCalls
        log(`perf: loading a ${longSeconds}s clip…`)
        const rows = await loadClipAndCaptions(cdp, { width: 1280, height: 720, seconds: longSeconds, fps: 10, name: 'long.mp4', bitrate: 400000 })
        results.long_caption_rows = rows
        results.long_transcribe_calls = transcribeCalls - callsBefore
        log('perf: long clip rows =', rows, 'transcribe calls =', results.long_transcribe_calls)
        check('long clip was split into multiple transcription chunks', results.long_transcribe_calls >= 2, String(results.long_transcribe_calls))
        results.long_720p_offline_ms = await timeExport(cdp, '720p', 'offline')
        log('perf: long 720p offline =', results.long_720p_offline_ms, 'ms')
      }
      writeFileSync(join(projectRoot, '.verify', 'perf.json'), JSON.stringify(results, null, 2))
      log('perf results:', JSON.stringify(results))
    }

    const realErrors = pageErrors.filter((message) => !message.includes('favicon'))
    check('no browser errors across the run', realErrors.length === 0, realErrors.join(' | ').slice(0, 400))

    writeFileSync(join(projectRoot, '.verify', 'seo-summary.json'), JSON.stringify({ checks, pageErrors: realErrors }, null, 2))
    log(`ALL CHECKS PASSED (${checks.length})`)
  } finally {
    try { cdp?.ws.close() } catch { /* ignore */ }
    try { chrome?.kill() } catch { /* ignore */ }
    try { server.close() } catch { /* ignore */ }
    await sleep(400)
    try { if (userDataDir) rmSync(userDataDir, { recursive: true, force: true }) } catch { /* ignore */ }
  }
}

main().catch((error) => {
  writeFileSync(join(projectRoot, '.verify', 'seo-summary.json'), JSON.stringify({ checks, error: String(error) }, null, 2))
  console.error('[verify] FAILED:', error.message)
  process.exit(1)
})
