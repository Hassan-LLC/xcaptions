import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import net from 'node:net'
import { createServer as createViteServer } from 'vite'

const PROJECT = process.cwd()
const SERVER_PORT = 5199
const CDP_PORT = 9333
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const shotsDir = join(PROJECT, '.verify', 'shots')
const downloadsDir = join(PROJECT, '.verify', 'downloads')
rmSync(downloadsDir, { recursive: true, force: true })
mkdirSync(shotsDir, { recursive: true })
mkdirSync(downloadsDir, { recursive: true })

const pageErrors = []
const consoleLogs = []
const summary = { checks: [] }

const log = (...args) => console.log('[verify]', ...args)
const sleep = (ms) => new Promise((done) => setTimeout(done, ms))

function check(name, condition, detail) {
  summary.checks.push({ name, pass: Boolean(condition), detail: detail ?? null })
  log(`${condition ? 'PASS' : 'FAIL'} — ${name}${detail ? ' :: ' + detail : ''}`)
  if (!condition) throw new Error(`Check failed: ${name} (${detail ?? ''})`)
}

// Mock transcription response, kept inside the 4-second test clip.
const MOCK_WORDS = [
  { word: 'Welcome', start: 0.25, end: 0.6 },
  { word: 'to', start: 0.65, end: 0.85 },
  { word: 'SubtitleStudio,', start: 0.9, end: 1.35 },
  { word: 'your', start: 1.5, end: 1.75 },
  { word: 'local', start: 1.8, end: 2.05 },
  { word: 'caption', start: 2.1, end: 2.4 },
  { word: 'editor.', start: 2.45, end: 2.8 },
  { word: 'Resize', start: 3.0, end: 3.3 },
  { word: 'any', start: 3.35, end: 3.5 },
  { word: 'clip.', start: 3.55, end: 3.85 },
]

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
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
    if (result.exceptionDetails) {
      throw new Error('Page exception: ' + JSON.stringify(result.exceptionDetails.exception?.description ?? result.exceptionDetails))
    }
    return result.result.value
  }
  async screenshot(name) {
    const { data } = await this.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
    writeFileSync(join(shotsDir, name), Buffer.from(data, 'base64'))
    log('screenshot ->', join(shotsDir, name))
  }
}

async function poll(cdp, expression, timeoutMs, description) {
  const started = Date.now()
  for (;;) {
    const value = await cdp.evaluate(expression)
    if (value) return value
    if (Date.now() - started > timeoutMs) throw new Error(`Timed out waiting for ${description}`)
    await sleep(200)
  }
}

function mp4VideoDimensions(buffer) {
  const findBox = (start, end, type) => {
    let offset = start
    while (offset + 8 <= end) {
      const size = buffer.readUInt32BE(offset)
      if (size < 8) break
      if (buffer.toString('latin1', offset + 4, offset + 8) === type) return { start: offset + 8, end: offset + size }
      offset += size
    }
    return null
  }
  const moov = findBox(0, buffer.length, 'moov')
  if (!moov) return null
  let cursor = moov.start
  while (cursor + 8 <= moov.end) {
    const size = buffer.readUInt32BE(cursor)
    if (size < 8) break
    if (buffer.toString('latin1', cursor + 4, cursor + 8) === 'trak') {
      const tkhd = findBox(cursor + 8, cursor + size, 'tkhd')
      if (tkhd) {
        const width = buffer.readUInt32BE(tkhd.end - 8) / 65536
        const height = buffer.readUInt32BE(tkhd.end - 4) / 65536
        if (width > 0 && height > 0) return { width: Math.round(width), height: Math.round(height) }
      }
    }
    cursor += size
  }
  return null
}

function newestDownload() {
  const files = readdirSync(downloadsDir).filter((name) => /^subtitled-video\.(mp4|webm)$/u.test(name))
  if (!files.length) return null
  return files.map((name) => ({ name, path: join(downloadsDir, name), mtime: statSync(join(downloadsDir, name)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)[0]
}

function pillByText(selector, text) {
  return `[...document.querySelectorAll(${JSON.stringify(selector)})].find((el) => el.textContent.trim().startsWith(${JSON.stringify(text)}))`
}

const generateVideoSource = `(async () => {
  const { Muxer, ArrayBufferTarget } = await import('/assets/mp4-muxer-verify.js')
  const width = 1280, height = 720, fps = 30, seconds = 4
  const frames = fps * seconds
  const target = new ArrayBufferTarget()
  const muxer = new Muxer({
    target,
    video: { codec: 'avc', width, height, frameRate: fps },
    audio: { codec: 'aac', sampleRate: 48000, numberOfChannels: 1 },
    fastStart: 'in-memory',
  })
  const videoConfig = { codec: 'avc1.42001f', width, height, bitrate: 2_000_000, framerate: fps, avc: { format: 'avc' } }
  const vSupport = await VideoEncoder.isConfigSupported(videoConfig)
  if (!vSupport.supported) return { ok: false, stage: 'video-encode', detail: JSON.stringify(vSupport) }
  const videoEncoder = new VideoEncoder({ output: (chunk, meta) => muxer.addVideoChunk(chunk, meta), error: (e) => { throw e } })
  videoEncoder.configure(videoConfig)
  const canvas = new OffscreenCanvas(width, height)
  const ctx = canvas.getContext('2d')
  for (let i = 0; i < frames; i++) {
    const t = i / fps
    const grad = ctx.createLinearGradient(0, 0, width, height)
    grad.addColorStop(0, 'hsl(' + ((i * 4) % 360) + ' 55% 24%)')
    grad.addColorStop(1, '#101010')
    ctx.fillStyle = grad
    ctx.fillRect(0, 0, width, height)
    ctx.fillStyle = '#ffe600'
    ctx.beginPath()
    ctx.arc(width / 2 + Math.sin(t * 2) * 320, height / 2 + Math.cos(t * 2) * 150, 85, 0, Math.PI * 2)
    ctx.fill()
    ctx.fillStyle = '#ffffff'
    ctx.textAlign = 'center'
    ctx.font = 'bold 78px sans-serif'
    ctx.fillText('SubtitleStudio', width / 2, height / 2 - 170)
    ctx.font = 'bold 52px sans-serif'
    ctx.fillText('t = ' + t.toFixed(1) + 's', width / 2, height / 2 + 210)
    ctx.fillStyle = '#111111'
    ctx.font = 'bold 40px sans-serif'
    ctx.fillText('LEFT', 150, height - 70)
    ctx.fillText('RIGHT', width - 150, height - 70)
    const frame = new VideoFrame(canvas, { timestamp: Math.round(i * 1e6 / fps), duration: Math.round(1e6 / fps) })
    videoEncoder.encode(frame, { keyFrame: i % 30 === 0 })
    frame.close()
  }
  await videoEncoder.flush()
  videoEncoder.close()
  const sampleRate = 48000, channels = 1
  const audioConfig = { codec: 'mp4a.40.2', sampleRate, numberOfChannels: channels, bitrate: 96000 }
  const aSupport = await AudioEncoder.isConfigSupported(audioConfig)
  if (!aSupport.supported) return { ok: false, stage: 'audio-encode', detail: JSON.stringify(aSupport) }
  const audioEncoder = new AudioEncoder({ output: (chunk, meta) => muxer.addAudioChunk(chunk, meta), error: (e) => { throw e } })
  audioEncoder.configure(audioConfig)
  const totalSamples = sampleRate * seconds
  const block = 4096
  for (let offset = 0; offset < totalSamples; offset += block) {
    const count = Math.min(block, totalSamples - offset)
    const data = new Float32Array(count)
    const audioData = new AudioData({ format: 'f32-planar', sampleRate, numberOfFrames: count, numberOfChannels: channels, timestamp: Math.round(offset / sampleRate * 1e6), data })
    audioEncoder.encode(audioData)
    audioData.close()
    if (audioEncoder.encodeQueueSize > 32) await audioEncoder.flush()
  }
  await audioEncoder.flush()
  audioEncoder.close()
  muxer.finalize()
  const blob = new Blob([target.buffer], { type: 'video/mp4' })
  const file = new File([blob], 'verify.mp4', { type: 'video/mp4', lastModified: Date.now() })
  const transfer = new DataTransfer()
  transfer.items.add(file)
  const input = document.querySelector('.uploader-wrap input[type=file]')
  if (!input) return { ok: false, stage: 'input' }
  input.files = transfer.files
  input.dispatchEvent(new Event('change', { bubbles: true }))
  return { ok: true, size: blob.size }
})()`

async function stateSnapshot(cdp) {
  return cdp.evaluate(`(() => {
    const canvas = document.querySelector('.preview-canvas')
    const output = document.querySelector('.reframe-output b')
    const selectedRatio = document.querySelector('.ratio-pill.is-selected')
    const selectedFit = document.querySelector('.fit-mode-pill.is-selected')
    return {
      canvas: canvas ? { width: canvas.width, height: canvas.height, aspect: +(canvas.width / canvas.height).toFixed(4) } : null,
      output: output ? output.textContent.trim() : null,
      ratio: selectedRatio ? selectedRatio.querySelector('span').textContent.trim() : null,
      fit: selectedFit ? selectedFit.textContent.trim() : null,
      safeArea: !!document.querySelector('.reframe-safe-toggle input:checked'),
      duration: (document.querySelector('.time-readout.end-time') || {}).textContent || null,
    }
  })()`)
}

async function main() {
  let chrome
  let userDataDir
  let server
  // Expose a standalone ESM copy of mp4-muxer so the page can synthesise a test clip.
  mkdirSync(join(DIST, 'assets'), { recursive: true })
  copyFileSync(join(PROJECT, 'node_modules/mp4-muxer/build/mp4-muxer.mjs'), join(DIST, 'assets', 'mp4-muxer-verify.js'))
  log('serving production build from', DIST)
  server = await startStaticServer()
  await waitForPort(SERVER_PORT, 15000)
  log('static server is up')

  userDataDir = mkdtempSync(join(tmpdir(), 'ss-verify-'))
  log('launching chrome…')
  chrome = spawn(CHROME, [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-dev-shm-usage',
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-sync',
    '--no-service-autorun',
    '--log-level=3',
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${userDataDir}`,
    '--window-size=1440,1200',
    'about:blank',
  ], { stdio: 'ignore' })

  let cdp
  try {
    await waitForPort(CDP_PORT, 30000)
    const targets = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json`)).json()
    const page = targets.find((target) => target.type === 'page')
    if (!page) throw new Error('No page target found')
    cdp = await CDP.connect(page.webSocketDebuggerUrl)
    await cdp.send('Page.enable')
    await cdp.send('Runtime.enable')
    await cdp.send('Log.enable')
    await cdp.send('Network.enable')
    cdp.on('Runtime.exceptionThrown', (params) => pageErrors.push(params.exceptionDetails?.exception?.description ?? JSON.stringify(params.exceptionDetails)))
    cdp.on('Log.entryAdded', (params) => { if (params.entry.level === 'error') pageErrors.push(params.entry.text) })
    cdp.on('Runtime.consoleAPICalled', (params) => {
      const text = params.args.map((a) => a.value ?? a.description ?? '').join(' ')
      consoleLogs.push(params.type + ': ' + text)
      if (params.type === 'error') pageErrors.push(text)
    })
    cdp.on('Network.responseReceived', (params) => {
      if (params.response.status >= 400) pageErrors.push(`HTTP ${params.response.status} ${params.response.url}`)
    })

    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1200, deviceScaleFactor: 1, mobile: false })
    await cdp.send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: downloadsDir })
    log('navigating…')
    await cdp.send('Page.navigate', { url: `http://127.0.0.1:${SERVER_PORT}/` })
    await poll(cdp, `document.querySelector('.uploader-wrap input[type=file]') ? true : false`, 30000, 'app mount')

    log('generating test video in-page…')
    const generated = await cdp.evaluate(generateVideoSource)
    log('video generation:', JSON.stringify(generated))
    if (!generated?.ok) throw new Error('Video generation failed: ' + JSON.stringify(generated))

    await poll(cdp, `document.querySelector('.reframe-controls') ? true : false`, 30000, 'reframe controls')
    await poll(cdp, `document.querySelector('.preview-canvas') && document.querySelector('.preview-canvas').width > 0 ? true : false`, 30000, 'canvas size')
    await sleep(700)
    const initial = await stateSnapshot(cdp)
    log('initial state:', JSON.stringify(initial))
    check('original ratio keeps source output size', initial.output === '1280 × 720', initial.output)
    check('original ratio preview aspect is 16:9', Math.abs(initial.canvas.aspect - 16 / 9) < 0.02, String(initial.canvas.aspect))
    await cdp.screenshot('01-original.png')

    log('switching to 9:16…')
    await cdp.evaluate(`${pillByText('.ratio-pill', '9:16')}.click()`)
    await sleep(600)
    const nineBySixteen = await stateSnapshot(cdp)
    log('9:16 state:', JSON.stringify(nineBySixteen))
    check('9:16 output is 720x1280 (short side capped at source)', nineBySixteen.output === '720 × 1280', nineBySixteen.output)
    check('9:16 preview aspect is 9:16', Math.abs(nineBySixteen.canvas.aspect - 9 / 16) < 0.01, String(nineBySixteen.canvas.aspect))
    check('landscape to 9:16 defaults to Fit + blur', nineBySixteen.fit === 'Fit + blur', nineBySixteen.fit)
    const blurProbe = await cdp.evaluate(`(() => { const c = document.querySelector('.preview-canvas'); const px = c.getContext('2d').getImageData(Math.round(c.width / 2), 4, 1, 1).data; return [px[0], px[1], px[2]] })()`)
    log('blur backdrop pixel (top of frame):', JSON.stringify(blurProbe))
    check('blur backdrop is not the solid-color black', !(blurProbe[0] <= 8 && blurProbe[1] <= 8 && blurProbe[2] <= 8), JSON.stringify(blurProbe))
    await cdp.screenshot('02-9x16-blur.png')

    log('switching fit to solid color…')
    await cdp.evaluate(`${pillByText('.fit-mode-pill', 'Fit + color')}.click()`)
    await sleep(500)
    log('color state:', JSON.stringify(await stateSnapshot(cdp)))
    const colorProbe = await cdp.evaluate(`(() => { const c = document.querySelector('.preview-canvas'); const px = c.getContext('2d').getImageData(Math.round(c.width / 2), 4, 1, 1).data; return [px[0], px[1], px[2]] })()`)
    log('color backdrop pixel (top of frame):', JSON.stringify(colorProbe))
    check('solid color backdrop fills the empty area with the chosen color', colorProbe[0] === 12 && colorProbe[1] === 14 && colorProbe[2] === 12, JSON.stringify(colorProbe))
    check('blur and color backdrops render differently', JSON.stringify(blurProbe) !== JSON.stringify(colorProbe), `${JSON.stringify(blurProbe)} vs ${JSON.stringify(colorProbe)}`)
    await cdp.screenshot('03-9x16-color.png')

    log('switching fit to fill (crop)…')
    await cdp.evaluate(`${pillByText('.fit-mode-pill', 'Fill (crop)')}.click()`)
    await sleep(500)
    log('fill state:', JSON.stringify(await stateSnapshot(cdp)))
    await cdp.screenshot('04-9x16-fill.png')

    log('enabling social safe area…')
    await cdp.evaluate(`document.querySelector('.reframe-safe-toggle input').click()`)
    await sleep(500)
    check('social safe area toggle turns on', (await stateSnapshot(cdp)).safeArea, 'checked')
    await cdp.screenshot('05-9x16-fill-safearea.png')
    await cdp.evaluate(`document.querySelector('.reframe-safe-toggle input').click()`)
    await sleep(300)

    log('dragging on the canvas to set crop focus…')
    const bounds = await cdp.evaluate(`(() => { const r = document.querySelector('.preview-canvas').getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height } })()`)
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: bounds.x + bounds.w * 0.5, y: bounds.y + bounds.h * 0.5, button: 'left', clickCount: 1, buttons: 1 })
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: bounds.x + bounds.w * 0.2, y: bounds.y + bounds.h * 0.25, button: 'left', buttons: 1 })
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: bounds.x + bounds.w * 0.2, y: bounds.y + bounds.h * 0.25, button: 'left', buttons: 0 })
    await sleep(500)
    const focus = await cdp.evaluate(`[...document.querySelectorAll('.reframe-detail .style-range-control')].map((l) => l.querySelector('output').textContent)`)
    log('crop slider values after drag:', JSON.stringify(focus))
    check('dragging on the canvas updates crop focus', focus[0] === '20%' && focus[1] === '25%', JSON.stringify(focus))
    await cdp.screenshot('06-9x16-fill-crop.png')

    log('switching ratio to 1:1…')
    await cdp.evaluate(`${pillByText('.ratio-pill', '1:1')}.click()`)
    await sleep(500)
    const square = await stateSnapshot(cdp)
    log('1:1 state:', JSON.stringify(square))
    check('1:1 output is 720x720', square.output === '720 × 720', square.output)
    check('1:1 preview aspect is 1', Math.abs(square.canvas.aspect - 1) < 0.01, String(square.canvas.aspect))
    await cdp.screenshot('07-1x1.png')

    log('switching ratio to 16:9…')
    await cdp.evaluate(`${pillByText('.ratio-pill', '16:9')}.click()`)
    await sleep(500)
    const wide = await stateSnapshot(cdp)
    log('16:9 state:', JSON.stringify(wide))
    check('16:9 output is 1280x720', wide.output === '1280 × 720', wide.output)
    await cdp.screenshot('08-16x9.png')

    log('switching to 4:5 and 480p…')
    await cdp.evaluate(`${pillByText('.ratio-pill', '4:5')}.click()`)
    await sleep(300)
    await cdp.evaluate(`[...document.querySelectorAll('.resolution-pills .format-pill')].find((b) => b.textContent.trim() === '480p').click()`)
    await sleep(500)
    const feed = await stateSnapshot(cdp)
    log('4:5 @480p state:', JSON.stringify(feed))
    check('4:5 at 480p output is 480x600', feed.output === '480 × 600', feed.output)
    await cdp.screenshot('09-4x5-480p.png')

    log('final ratio 9:16 with captions and export…')
    await cdp.evaluate(`${pillByText('.ratio-pill', '9:16')}.click()`)
    await sleep(400)

    await cdp.evaluate(`document.querySelector('.button-generate').click()`)
    log('waiting for mock transcription…')
    await poll(cdp, `document.querySelectorAll('.caption-row').length > 0 ? document.querySelectorAll('.caption-row').length : 0`, 120000, 'captions')
    await sleep(400)
    const captionsBefore = await cdp.evaluate(`[...document.querySelectorAll('.caption-row')].map((r) => r.textContent.trim())`)
    log('caption rows generated:', captionsBefore.length)
    check('captions were generated', captionsBefore.length > 0, String(captionsBefore.length))
    await cdp.screenshot('10-9x16-captions.png')

    await cdp.evaluate(`${pillByText('.ratio-pill', '1:1')}.click()`)
    await sleep(300)
    await cdp.evaluate(`${pillByText('.ratio-pill', '16:9')}.click()`)
    await sleep(300)
    await cdp.evaluate(`${pillByText('.ratio-pill', '9:16')}.click()`)
    await sleep(400)
    const captionsAfter = await cdp.evaluate(`[...document.querySelectorAll('.caption-row')].map((r) => r.textContent.trim())`)
    check('caption text and timings unchanged by ratio changes', JSON.stringify(captionsBefore) === JSON.stringify(captionsAfter), `${captionsBefore.length} rows`)

    log('starting video export…')
    await cdp.evaluate(`document.querySelector('#download-option-video').click()`)
    await sleep(300)
    await cdp.evaluate(`[...document.querySelectorAll('.resolution-pills .format-pill')].find((b) => b.textContent.trim() === '480p').click()`)
    await sleep(300)
    const beforeExport = await cdp.evaluate(`document.querySelector('.video-estimates strong') ? document.querySelector('.video-estimates strong').textContent.trim() : null`)
    log('export panel shows:', beforeExport)
    check('export panel shows real 9:16 480p dimensions', beforeExport === '480 × 854', String(beforeExport))

    // Headless Chrome does not reliably fire requestVideoFrameCallback; force the rAF pump.
    await cdp.evaluate(`(() => { try { HTMLVideoElement.prototype.requestVideoFrameCallback = undefined } catch (e) {} return true })()`)
    await cdp.evaluate(`[...document.querySelectorAll('.video-export-actions button')].find((b) => b.textContent.includes('Export video')).click()`)
    const exportStarted = Date.now()
    let exportResult = null
    while (Date.now() - exportStarted < 120000) {
      const status = await cdp.evaluate(`(() => {
        const error = document.querySelector('.export-error')
        const button = [...document.querySelectorAll('.video-export-actions button')].find((b) => b.textContent.includes('Downloaded') || b.textContent.includes('Export video'))
        const progress = document.querySelector('.export-progress span')
        const pct = document.querySelector('.export-progress strong')
        if (error && error.textContent.trim()) return { status: 'error', message: error.textContent.trim() }
        if (button && button.textContent.includes('Downloaded')) return { status: 'ok' }
        return { status: 'running', message: progress ? progress.textContent.trim() + ' ' + (pct ? pct.textContent.trim() : '') : 'starting' }
      })()`)
      if (status.status !== 'running') { exportResult = status; break }
      log('export progress:', status.message)
      await sleep(3000)
    }
    if (!exportResult) throw new Error('Timed out waiting for export result')
    check('video export completed without error', exportResult.status === 'ok', JSON.stringify(exportResult))
    await sleep(1000)

    const download = newestDownload()
    check('an exported video file was downloaded', Boolean(download), download ? download.name : 'none')
    const bytes = readFileSync(download.path)
    log('exported file:', download.name, bytes.length, 'bytes')
    check('exported file is an MP4', bytes.subarray(4, 8).toString('latin1') === 'ftyp')
    const dims = mp4VideoDimensions(bytes)
    log('exported MP4 video track dimensions:', JSON.stringify(dims))
    check('exported MP4 is 480x854', dims && dims.width === 480 && dims.height === 854, JSON.stringify(dims))

    // Decode the exported file and screenshot a real frame for visual proof.
    const base64 = JSON.stringify(bytes.toString('base64'))
    const decoded = await cdp.evaluate(`(async () => {
      const raw = atob(${base64})
      const bytes = Uint8Array.from(raw, (c) => c.charCodeAt(0))
      const blob = new Blob([bytes], { type: 'video/mp4' })
      const video = document.createElement('video')
      video.src = URL.createObjectURL(blob)
      video.muted = true
      await new Promise((done, fail) => { video.onloadeddata = done; video.onerror = () => fail(new Error('decode failed')) })
      video.currentTime = 1.5
      await new Promise((done) => { video.onseeked = done })
      const canvas = document.createElement('canvas')
      canvas.width = video.videoWidth
      canvas.height = video.videoHeight
      canvas.style.cssText = 'position:fixed;top:0;left:0;z-index:99999'
      canvas.getContext('2d').drawImage(video, 0, 0)
      document.body.appendChild(canvas)
      return { width: video.videoWidth, height: video.videoHeight }
    })()`)
    log('decoded exported frame:', JSON.stringify(decoded))
    await sleep(500)
    await cdp.screenshot('11-exported-frame.png')

    const realErrors = pageErrors.filter((message) => !message.includes('favicon.ico'))
    check('no page errors during the run', realErrors.length === 0, realErrors.join(' | ').slice(0, 400))
    writeFileSync(join(PROJECT, '.verify', 'summary.json'), JSON.stringify({ ...summary, pageErrors: realErrors, consoleLogs }, null, 2))
    log('ALL CHECKS PASSED (' + summary.checks.length + ')')
  } finally {
    try { cdp?.ws.close() } catch { /* ignore */ }
    try { chrome?.kill() } catch { /* ignore */ }
    try { server?.close() } catch { /* ignore */ }
    await sleep(500)
    try { if (userDataDir) rmSync(userDataDir, { recursive: true, force: true }) } catch { /* ignore */ }
  }
}

main().then(() => {
  process.exit(0)
}).catch((error) => {
  console.error('[verify] FAILED:', error)
  console.error('[verify] page errors:', JSON.stringify(pageErrors, null, 2))
  try { writeFileSync(join(PROJECT, '.verify', 'summary.json'), JSON.stringify({ ...summary, pageErrors, consoleLogs }, null, 2)) } catch { /* ignore */ }
  process.exit(1)
})
