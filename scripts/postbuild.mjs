// Post-build fix-ups for the Vite output.
//
// The editor imports the ffmpeg worker with `@ffmpeg/ffmpeg/worker?url`. Vite
// copies that file verbatim, so the worker's own relative imports (const.js,
// errors.js) are not bundled and would be missing from dist, which makes the
// worker fail to start and stalls audio extraction during export. Copy those
// sibling modules next to the emitted worker. No application logic is changed.

import { copyFileSync, existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const assetsDir = join(projectRoot, 'dist', 'assets')
const ffmpegEsmDir = join(projectRoot, 'node_modules', '@ffmpeg', 'ffmpeg', 'dist', 'esm')

if (!existsSync(assetsDir)) {
  throw new Error('dist/assets is missing. Run `vite build` before the post-build step.')
}

const copied = new Set()
const queue = readdirSync(assetsDir).filter((name) => name.startsWith('worker-') && name.endsWith('.js'))

while (queue.length) {
  const name = queue.shift()
  const text = readFileSync(join(assetsDir, name), 'utf8')
  for (const match of text.matchAll(/from\s+["'](\.\/[^"']+)["']/gu)) {
    const dep = match[1].slice(2)
    if (copied.has(dep)) continue
    const source = join(ffmpegEsmDir, dep)
    if (existsSync(source)) {
      copyFileSync(source, join(assetsDir, dep))
      copied.add(dep)
      queue.push(dep)
    }
  }
}

console.log(copied.size
  ? `[postbuild] restored ffmpeg worker modules: ${[...copied].join(', ')}`
  : '[postbuild] no ffmpeg worker modules needed restoring')
