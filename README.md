# XCaptions

XCaptions is a free CapCut-style auto-caption tool that runs in your browser. Drop a video, get word-timed subtitles, pick an animated style, edit, translate and export. No account, no watermark. Your video never leaves your device; only the extracted audio is sent for transcription.

Built for creators who need Urdu, Roman Urdu, Hindi and English captions, with 9:16 reframing for Reels and Shorts, and SRT/VTT/TXT/video export.

Live: https://xcaptions.studio

## Features
- Word-timed AI captions (Whisper via Groq)
- Animated caption styles, edit / split / merge / retime
- Urdu (RTL), Hindi and English; translate to Urdu, Roman Urdu, Hindi, Arabic
- Reframe 9:16, 1:1, 4:5, 16:9; trim; auto-save in the browser
- Export SRT, VTT, TXT, audio or captioned video (480p to 1080p)
- Video is processed in your browser; only extracted audio is sent for transcription

## Tech
React, Vite, TypeScript, Tailwind, ffmpeg.wasm, WebCodecs, a small PHP proxy for the Groq API.

## Run locally

```bash
npm install
cp .env.example .env            # mock transcription is on by default
npm run dev
```

For real transcription, add `GROQ_API_KEY` to `.env.local` and set `VITE_MOCK_TRANSCRIBE=false`.

## Deploy

```bash
npm run build
```

Then upload the contents of `dist/` to any PHP host. Copy `public/api/config.example.php` to `config.php` on the server (outside the public web root) and add your key. Never commit it.

## License
Source code: MIT (see LICENSE). Third-party components keep their own licenses: the bundled FFmpeg WebAssembly core in public/ffmpeg/ is GPL-2.0-or-later (see public/ffmpeg/NOTICE.txt).
