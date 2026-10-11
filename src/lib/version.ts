/**
 * New-deployment detection.
 *
 * The build id is baked into the bundle via Vite `define` (`__BUILD_ID__`) and
 * written to `dist/version.json` by the same build. `version.json` is served
 * with `no-store`, so the editor can notice when a newer deploy is live even if
 * the browser is still holding stale hashed JS (cached immutable). On a mismatch
 * we offer a refresh, without interrupting an in-flight transcription or export.
 */

const buildId = __BUILD_ID__

let busy = false
let shown = false

/** Mark the app as busy (transcribing/exporting) so a refresh is deferred. */
export function setBusy(value: boolean) {
  busy = value
}

function isBusy() {
  return busy
}

export function initVersionCheck() {
  check()
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') check()
  })
}

async function check() {
  if (shown) return
  try {
    const url = new URL(`${import.meta.env.BASE_URL}version.json`, window.location.href)
    const response = await fetch(url, { cache: 'no-store' })
    if (!response.ok) return
    const data = (await response.json()) as { build?: unknown }
    if (typeof data.build === 'string' && data.build !== '' && data.build !== buildId) {
      showToast()
    }
  } catch {
    // Offline, or version.json missing (e.g. local dev). Nothing to do.
  }
}

function showToast() {
  shown = true
  injectStyle()

  const toast = document.createElement('div')
  toast.id = 'xc-version-toast'
  toast.setAttribute('role', 'status')

  const text = document.createElement('span')
  text.textContent = 'A new version is available.'

  const refresh = document.createElement('button')
  refresh.type = 'button'
  refresh.textContent = 'Refresh'
  refresh.addEventListener('click', () => {
    if (isBusy()) return // never reload during an active transcription or export
    window.location.reload()
  })

  toast.appendChild(text)
  toast.appendChild(refresh)
  document.body.appendChild(toast)
}

function injectStyle() {
  if (document.getElementById('xc-version-style')) return
  const style = document.createElement('style')
  style.id = 'xc-version-style'
  style.textContent = [
    '#xc-version-toast{position:fixed;left:16px;bottom:16px;z-index:2147483000;display:flex;align-items:center;gap:12px;padding:12px 14px;border-radius:12px;background:#171816;border:1px solid #3a3b36;color:#e8e8e4;font:13px/1.4 system-ui,-apple-system,"Segoe UI",Roboto,Arial,sans-serif;box-shadow:0 12px 34px rgba(0,0,0,.5)}',
    '#xc-version-toast button{cursor:pointer;border:0;background:#d1fa70;color:#111210;font-weight:700;padding:8px 14px;border-radius:8px;font:inherit}',
  ].join('\n')
  document.head.appendChild(style)
}
