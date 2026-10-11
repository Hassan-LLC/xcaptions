import { execFileSync } from 'node:child_process'
import { readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const distDirectory = path.join(projectRoot, 'dist')
const archivePath = path.join(projectRoot, 'subtitle-studio-hostinger.zip')
const requiredFiles = [
  '.htaccess',
  '.user.ini',
  'index.html',
  'api/transcribe.php',
  'api/translate.php',
  'api/.htaccess',
  'api/config.example.php',
  'ffmpeg/NOTICE.txt',
  'ffmpeg/ffmpeg-core.js',
  'ffmpeg/ffmpeg-core.wasm',
]
const forbiddenEntry = /(^|[\\/])(?:\.env(?:$|\.)|config\.php|node_modules)(?:[\\/]|$)|\.map$/i

function listFiles(directory, prefix = '') {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const relativeName = path.join(prefix, entry.name).split(path.sep).join('/')
    const absoluteName = path.join(directory, entry.name)
    if (forbiddenEntry.test(relativeName)) {
      throw new Error(`Refusing to package forbidden file: ${relativeName}`)
    }
    if (entry.isSymbolicLink()) {
      throw new Error(`Refusing to package symbolic link: ${relativeName}`)
    }
    return entry.isDirectory()
      ? listFiles(absoluteName, relativeName)
      : [relativeName]
  })
}

if (!statSync(distDirectory, { throwIfNoEntry: false })?.isDirectory()) {
  throw new Error('The dist folder is missing. Run npm run build first.')
}

const files = listFiles(distDirectory)
for (const requiredFile of requiredFiles) {
  if (!files.includes(requiredFile)) {
    throw new Error(`The production build is missing ${requiredFile}.`)
  }
}

if (process.platform !== 'win32') {
  throw new Error('The pack command currently uses Windows PowerShell. Run npm run pack on Windows.')
}

const quotePowerShell = (value) => `'${value.replaceAll("'", "''")}'`
const source = quotePowerShell(distDirectory)
const destination = quotePowerShell(archivePath)
const script = [
  '$ErrorActionPreference = "Stop"',
  'Add-Type -AssemblyName System.IO.Compression.FileSystem',
  `$source = ${source}`,
  `$destination = ${destination}`,
  'if (Test-Path -LiteralPath $destination) { Remove-Item -LiteralPath $destination -Force }',
  '[System.IO.Compression.ZipFile]::CreateFromDirectory($source, $destination, [System.IO.Compression.CompressionLevel]::Optimal, $false)',
  '$archive = [System.IO.Compression.ZipFile]::OpenRead($destination)',
  'try {',
  '  $names = @($archive.Entries | ForEach-Object { $_.FullName.Replace([char]92, [char]47) })',
  '  $required = @(".htaccess", ".user.ini", "api/.htaccess", "api/transcribe.php", "api/translate.php", "api/config.example.php", "ffmpeg/NOTICE.txt", "ffmpeg/ffmpeg-core.js", "ffmpeg/ffmpeg-core.wasm")',
  '  foreach ($name in $required) { if ($names -notcontains $name) { throw "ZIP is missing $name" } }',
  '  if ($names | Where-Object { $_ -match "(^|/)\\.env($|\\.)|(^|/)config\\.php$|(^|/)node_modules(/|$)|\\.map$" }) { throw "ZIP contains a forbidden file" }',
  '} finally { $archive.Dispose() }',
].join('; ')

execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], { stdio: 'inherit' })
console.log(`Created ${path.basename(archivePath)} from the checked dist folder.`)
