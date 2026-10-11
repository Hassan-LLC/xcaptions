/**
 * Content for the pre-rendered public pages.
 *
 * Each entry renders plain, semantic HTML so the text exists in the served
 * file without JavaScript. The copy is deliberately honest: it only describes
 * features that are actually wired up in the editor (see README > SEO).
 *
 * Urdu-ready by design: pages carry a `lang` and a `translationKey`. To add an
 * Urdu version later, add a page with the same `translationKey` and lang "ur";
 * the head builder then emits the matching hreflang alternate automatically.
 */

export const TOOL_PATH = '/app'

const brandMarkSvg = '<svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" focusable="false"><rect width="64" height="64" rx="15" fill="#111210"/><rect x="9" y="27" width="46" height="10" rx="5" fill="#d1fa70" transform="rotate(45 32 32)"/><rect x="13" y="26.5" width="38" height="11" rx="5.5" fill="#ff846b" transform="rotate(-45 32 32)"/><path d="M25 23 25 41 39 32Z" fill="#111210"/></svg>'

export const primaryNav = [
  { path: '/', label: 'Home', id: 'home' },
  { path: '/urdu-subtitle-generator/', label: 'Urdu subtitles', id: 'urdu' },
  { path: '/auto-subtitles-for-videos/', label: 'Auto subtitles', id: 'auto' },
  { path: '/how-it-works/', label: 'How it works', id: 'how' },
  { path: '/faq/', label: 'FAQ', id: 'faq' },
]

const legalNav = [
  { path: '/privacy/', label: 'Privacy', id: 'privacy' },
  { path: '/terms/', label: 'Terms & limits', id: 'terms' },
]

// SEO/comparison pages linked from the footer only (not the header).
const seoNav = [
  { path: '/free-capcut-alternative-for-subtitles/', label: 'CapCut alternative', id: 'capcut-alternative' },
  { path: '/best-free-urdu-subtitle-generator/', label: 'Best Urdu subtitle generator', id: 'urdu-best' },
  { path: '/xcaptions-vs-capcut/', label: 'XCaptions vs CapCut', id: 'vs-capcut' },
]

export function renderHeader(ctx, activeId) {
  // The logo already links home, so drop the redundant "Home" link on the
  // home page. Other pages keep the full nav.
  const items = primaryNav
    .filter((item) => !(item.id === 'home' && activeId === 'home'))
    .map((item) => {
      const current = item.id === activeId ? ' aria-current="page"' : ''
      return `<a href="${ctx.link(item.path)}"${current}>${item.label}</a>`
    }).join('')
  return `<header class="site-header">
  <div class="wrap">
    <a class="brand" href="${ctx.link('/')}"><span class="brand-mark" aria-hidden="true">${brandMarkSvg}</span><span class="brand-x">X</span>Captions</a>
    <nav class="site-nav" aria-label="Primary">${items}<a class="nav-cta" href="${ctx.link(TOOL_PATH)}">Open the editor</a></nav>
  </div>
</header>`
}

export function renderFooter(ctx) {
  const items = [...primaryNav, ...legalNav, ...seoNav].map((item) => `<a href="${ctx.link(item.path)}">${item.label}</a>`).join('')
  const cookieSettings = ctx.analyticsEnabled ? '<a href="#cookie-settings" data-cookie-settings>Cookie settings</a>' : ''
  return `<footer class="site-footer">
  <div class="wrap">
    <a class="brand footer-brand" href="${ctx.link('/')}"><span class="brand-mark" aria-hidden="true">${brandMarkSvg}</span><span class="brand-x">X</span>Captions</a>
    <nav class="footer-nav" aria-label="Footer">${items}<a href="${ctx.link(TOOL_PATH)}">Open the editor</a>${cookieSettings}</nav>
    <p class="footer-about"><strong>About:</strong> ${ctx.siteName} is an independent, browser-based subtitle editor run by ${ctx.operator}. Contact: <a href="mailto:${ctx.contactEmail}">${ctx.contactEmail}</a>.</p>
    <p class="footer-about">Your video is never uploaded. Only extracted audio is sent for transcription, and caption text is sent only when you translate.</p>
    <p class="footer-meta">&copy; ${ctx.year} ${ctx.siteName}</p>
  </div>
</footer>`
}

function faqItemsHtml(items) {
  return items.map((item) => `<div class="faq-item">
      <h3>${item.q}</h3>
      <p>${item.a}</p>
    </div>`).join('\n    ')
}

function faqSection(heading, items) {
  return `<section aria-labelledby="faq-heading">
    <h2 id="faq-heading">${heading}</h2>
    ${faqItemsHtml(items)}
  </section>`
}

function ctaBand(ctx, title, text) {
  return `<section class="cta-band" aria-label="Open the editor">
    <div><h2>${title}</h2><p>${text}</p></div>
    <a class="btn btn-primary" href="${ctx.link(TOOL_PATH)}">Open the editor</a>
  </section>`
}

/* -------------------------------------------------------------------------- */
/* Shared answers used on more than one page.                                  */
/* -------------------------------------------------------------------------- */

function buildCoreFaq(limits) {
  return [
  {
    q: 'Is my video uploaded to a server?',
    a: 'No. The video is opened and edited directly in your browser and is never uploaded. When you generate subtitles, only the extracted audio file is sent to a speech-to-text service. When you use Translate, only the caption text is sent. XCaptions does not store either on its server.',
  },
  {
    q: 'What are the limits?',
    a: `Videos longer than ${limits.videoMinutes} minutes are automatically shortened to the first ${limits.videoMinutes} minutes, and you can choose another part of the original. Files above ${limits.maxVideoMb} MB are locally prepared to fit the media size limit; source files above ${limits.maxFileHardMb} MB cannot be processed. The audio sent for transcription is split into short chunks (about ${limits.chunkSeconds} seconds each). Free provider quotas for transcription and translation may also apply.`,
  },
  {
    q: 'Which languages are supported?',
    a: 'The speech-to-text step detects the spoken language automatically and supports many languages, including English, Hindi, Arabic and Urdu. You can then translate captions into English, Urdu (Urdu script), Roman Urdu, Hindi (Devanagari), Roman Hindi or Arabic.',
  },
  {
    q: 'Can it write Roman Urdu?',
    a: 'You can translate captions into natural Roman Urdu. Automatic transcription of Roman Urdu speech is not reliable, because speech recognition expects standard script. The dependable route is to generate subtitles first and then translate them to Roman Urdu, or type the Roman Urdu yourself.',
  },
  {
    q: 'What subtitle formats can I export?',
    a: 'You can download SRT, VTT and plain TXT files (as paragraphs or with timestamps), export the extracted audio, or export a captioned video. Subtitle files apply your trim by default and start at zero, and you can turn that off to export every caption.',
  },
  {
    q: 'What video resolutions can I export?',
    a: 'You can export a captioned video at 480p, 720p, 1080p or the original size, as long as the source is at least that tall. Export is a real re-encode with the captions burned in, so it can be slow; keeping the tab open and in front helps.',
  },
  {
    q: 'Is XCaptions free?',
    a: 'Yes. Using the editor is free and needs no account. Transcription and translation run on a provider free tier, so those steps can have their own usage limits and may occasionally be busy.',
  },
  {
    q: 'How accurate are the subtitles?',
    a: 'Speech recognition is good but not perfect, and translation can make mistakes too. Names, strong accents, music and background noise are the usual problem areas. Always review and edit the captions in the editor before exporting and publishing.',
  },
  {
    q: 'Does it work on a phone?',
    a: 'Yes. XCaptions runs in a modern mobile browser and the layout adapts to small screens. Video export is the heaviest part, so on a phone it can be slow and use a lot of memory. Keep the tab open while it runs.',
  },
  {
    q: 'Do I need an account?',
    a: 'No. There is no sign-up, login or email required. Projects auto-save in your own browser, and XCaptions keeps up to three of them. Clearing your browser storage removes them.',
  },
  {
    q: 'Does it have a silence remover or clip cutter?',
    a: 'Not right now. You can trim the start and end of the clip, and you can split, merge and retime individual captions, but there is no automatic silence detection and no clip splitter in the editor today.',
  },
  {
    q: 'Does it work offline?',
    a: 'Editing, styling, trimming and video export happen in your browser, but generating subtitles and translating need an internet connection because those steps use an online service. Loading the page the first time also needs a connection.',
  },
  ]
}

/* -------------------------------------------------------------------------- */
/* Pages.                                                                      */
/* -------------------------------------------------------------------------- */

export const contentPages = [
  {
    id: 'home',
    path: '/',
    depth: 0,
    lang: 'en',
    translationKey: 'home',
    title: 'XCaptions: Free AI Auto Subtitles in Your Browser',
    description: 'Add word-timed AI subtitles to videos in your browser. Edit and style them, translate to Urdu or Hindi, and export SRT, VTT, TXT, audio or video. Free.',
    h1: 'Free AI auto subtitles for any video.',
    build(ctx) {
      const body = `<section class="home-hero" aria-labelledby="hero-heading">
      <p class="home-eyebrow">Free · No account · Runs in your browser</p>
      <h1 id="hero-heading"><span class="wm wm-lime">Free</span> AI auto <span class="wm wm-pink">subtitles</span> for any video.</h1>
      <p class="home-sub">Add word-timed captions, style them to match the platform, translate into Urdu or Hindi, and export — all on your device. Your video never leaves your browser.</p>
      <div class="home-cta">
        <a class="home-btn home-btn-primary" href="${ctx.link(TOOL_PATH)}">Open the editor</a>
        <a class="home-btn home-btn-ghost" href="${ctx.link('/how-it-works/')}">See how it works</a>
      </div>
    </section>

    <section class="home-demo" aria-label="Live caption style preview">
      <div class="demo" data-style="pop">
        <div class="demo-frame">
          <div class="demo-scene" aria-hidden="true">
            <span class="scene-orb scene-orb-lime"></span>
            <span class="scene-orb scene-orb-pink"></span>
            <span class="scene-streak scene-streak-1"></span>
            <span class="scene-streak scene-streak-2"></span>
          </div>
          <div class="demo-caption" aria-hidden="true">
            <span class="demo-words" lang="en"><span class="w is-active">Make</span> <span class="w">every</span> <span class="w">word</span> <span class="w">land</span></span>
            <span class="demo-words demo-words-ur" lang="ur" dir="rtl"><span class="w">آپ</span> <span class="w">کے</span> <span class="w">لفظ،</span> <span class="w">حرکت</span> <span class="w">میں</span></span>
          </div>
          <div class="demo-wave" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i></div>
        </div>
        <div class="demo-controls" role="group" aria-label="Caption styles">
          <button class="style-chip" type="button" data-style="pop" aria-pressed="true">Pop</button>
          <button class="style-chip" type="button" data-style="neon" aria-pressed="false">Neon</button>
          <button class="style-chip" type="button" data-style="box" aria-pressed="false">Box</button>
          <button class="style-chip" type="button" data-style="ur" aria-pressed="false">Urdu</button>
        </div>
        <p class="demo-note">This is a preview of the styles inside the editor.</p>
      </div>
    </section>

    <section class="frames" aria-labelledby="frames-heading">
      <h2 id="frames-heading">How do I create subtitles in three steps?</h2>
      <ol class="film">
        <li class="film-frame"><span class="film-num" aria-hidden="true">01</span><div><h3>Load your video</h3><p>Videos longer than ${ctx.limits.videoMinutes} minutes are automatically shortened to the first ${ctx.limits.videoMinutes} — you can pick another part. It is prepared on your device.</p></div></li>
        <li class="film-frame"><span class="film-num" aria-hidden="true">02</span><div><h3>Generate subtitles</h3><p>XCaptions extracts the audio and sends only that for speech recognition, returning word-timed captions.</p></div></li>
        <li class="film-frame"><span class="film-num" aria-hidden="true">03</span><div><h3>Edit, style and export</h3><p>Fix the text, pick a style and aspect ratio, translate if you like, then export SRT, VTT, TXT, audio or a captioned video.</p></div></li>
      </ol>
      <p class="frames-more">Full details on the <a href="${ctx.link('/how-it-works/')}">how it works</a> page.</p>
    </section>

    <section class="features" aria-labelledby="features-heading">
      <h2 id="features-heading">What can I do in the editor?</h2>
      <ul class="pills">
        <li>Word-timed captions</li>
        <li>Animated styles</li>
        <li>Urdu &amp; Hindi</li>
        <li>Translate</li>
        <li>Trim</li>
        <li>Reframe to 9:16</li>
        <li>SRT · VTT · TXT</li>
        <li>Audio export</li>
        <li>Video export</li>
        <li>Local auto-save</li>
        <li>No account</li>
      </ul>
    </section>

    <section class="privacy" aria-labelledby="privacy-heading">
      <h2 id="privacy-heading">Is my video private?</h2>
      <div class="privacy-panel">
        <span class="privacy-icon" aria-hidden="true"><svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><rect x="4.5" y="10" width="15" height="10.5" rx="3" fill="#d1fa70"/><path d="M8 10V7a4 4 0 0 1 8 0v3" fill="none" stroke="#d1fa70" stroke-width="2.4" stroke-linecap="round"/></svg></span>
        <div>
          <strong>Your video never leaves your device.</strong>
          <p>XCaptions reads your video locally and never uploads it. Only the extracted audio is sent when you generate subtitles, and only caption text when you translate. Nothing is stored on the server, and projects live in your browser's storage.</p>
          <a href="${ctx.link('/privacy/')}">Read the privacy page</a>
        </div>
      </div>
    </section>

    <section class="home-faq" aria-labelledby="home-faq-heading">
      <h2 id="home-faq-heading">Still have questions?</h2>
      <details>
        <summary>Is my video uploaded?</summary>
        <p>No. The video stays on your device. Only extracted audio is sent for transcription, and caption text only when you translate.</p>
      </details>
      <details>
        <summary>Is it free and account-free?</summary>
        <p>Yes. It is free and needs no account or login. Free provider quotas may apply to transcription and translation.</p>
      </details>
      <details>
        <summary>Which languages can I get?</summary>
        <p>Speech is detected automatically, and you can translate captions into English, Urdu, Roman Urdu, Hindi, Roman Hindi or Arabic.</p>
      </details>
      <details>
        <summary>What happens to videos longer than ${ctx.limits.videoMinutes} minutes?</summary>
        <p>They are automatically shortened to the first ${ctx.limits.videoMinutes} minutes, and you can choose another part of the original.</p>
      </details>
      <p class="home-faq-more"><a href="${ctx.link('/faq/')}">Read all frequently asked questions</a></p>
    </section>

    <section class="home-final" aria-label="Get started">
      <h2>Ready to caption your video?</h2>
      <p>Open the editor, load a clip, and export subtitles in a few minutes. Free, no account.</p>
      <a class="home-btn home-btn-primary home-btn-big" href="${ctx.link(TOOL_PATH)}">Open the editor</a>
    </section>`

      const organizationId = `${ctx.url('/')}#organization`
      const jsonLd = [
        {
          '@type': 'Organization',
          '@id': organizationId,
          name: ctx.siteName,
          url: ctx.url('/'),
          logo: { '@type': 'ImageObject', url: ctx.asset('icon-512.png') },
          email: ctx.contactEmail,
          description: `${ctx.siteName} is a browser-based subtitle editor for short videos.`,
        },
        {
          '@type': 'WebSite',
          '@id': `${ctx.url('/')}#website`,
          url: ctx.url('/'),
          name: ctx.siteName,
          description: this.description,
          inLanguage: 'en',
          publisher: { '@id': organizationId },
        },
        {
          '@type': 'SoftwareApplication',
          name: ctx.siteName,
          url: ctx.url(TOOL_PATH),
          applicationCategory: 'MultimediaApplication',
          operatingSystem: 'Web',
          isAccessibleForFree: true,
          offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
          description: 'Free browser-based editor that creates word-timed subtitles for short videos and exports SRT, VTT, TXT, audio or a captioned video.',
          publisher: { '@id': organizationId },
        },
      ]
      return { body, jsonLd }
    },
  },

  {
    id: 'urdu',
    path: '/urdu-subtitle-generator/',
    depth: 1,
    lang: 'en',
    translationKey: 'urdu',
    breadcrumb: 'Urdu subtitle generator',
    title: 'Urdu Subtitle Generator — Urdu & Roman Urdu',
    description: 'Generate subtitles from your video and get Urdu or Roman Urdu captions. Edit, preview right-to-left styles and export SRT or a captioned video.',
    h1: 'Urdu and Roman Urdu subtitle generator',
    build(ctx) {
      const faq = [
        {
          q: 'Can XCaptions make Urdu subtitles?',
          a: 'Yes. You can translate your captions into Urdu written in Urdu script, and the editor includes right-to-left caption styles designed for Urdu so the text previews and exports correctly.',
        },
        {
          q: 'Does it support Roman Urdu?',
          a: 'You can translate captions into Roman Urdu with natural, everyday spelling. Automatic speech recognition of Roman Urdu is not reliable, so the honest workflow is to generate subtitles first and then translate them, or type the Roman Urdu yourself.',
        },
        {
          q: 'Do Urdu captions display right to left?',
          a: 'Yes. Urdu caption styles render right to left, and the Nastaliq and Naskh templates are tuned for Urdu line height so the script stays readable in the preview and the exported video.',
        },
        {
          q: 'Can I download Urdu subtitles as an SRT file?',
          a: 'Yes. After generating or translating, export SRT, VTT or plain TXT. Subtitle files apply your trim by default and reset the timestamps to zero, and you can turn that off to keep the full list.',
        },
      ]
      const body = `<div class="hero">
      <p class="eyebrow">Urdu subtitles</p>
      <h1>${this.h1}</h1>
      <p class="answer">XCaptions turns the speech in a short video into editable captions, and you can translate them into Urdu script or Roman Urdu. Urdu text previews right to left with dedicated Nastaliq and Naskh caption styles, and you can export SRT, VTT, plain text or a captioned video.</p>
      <div class="hero-actions"><a class="btn btn-primary" href="${ctx.link(TOOL_PATH)}">Open the editor</a></div>
    </div>

    <section aria-labelledby="how-urdu-heading">
      <h2 id="how-urdu-heading">How do I add Urdu subtitles to a video?</h2>
      <ol class="steps">
        <li><h3>Load your video</h3><p>Videos longer than ${ctx.limits.videoMinutes} minutes are automatically shortened; choose another part of the original if needed. The video stays on your device.</p></li>
        <li><h3>Generate the subtitles</h3><p>XCaptions transcribes the audio and creates word-timed caption lines.</p></li>
        <li><h3>Translate to Urdu</h3><p>Open the Translate tab and choose Urdu, or Roman Urdu for captions written with Latin letters.</p></li>
        <li><h3>Pick an Urdu style and export</h3><p>Choose a right-to-left style, review the text, then export SRT, VTT, TXT or a captioned video.</p></li>
      </ol>
    </section>

    <section aria-labelledby="script-heading">
      <h2 id="script-heading">Urdu script or Roman Urdu?</h2>
      <p>Both are possible, in different ways. <strong>Urdu script</strong> is fully supported: you can translate captions into Urdu, preview them right to left, and export them. <strong>Roman Urdu</strong> is best produced by translating your generated captions into natural, conversational Roman Urdu. Speech recognition of spoken Roman Urdu is not dependable, because the tool expects the language's standard script, so treat any Roman Urdu you get from transcription as a draft to review.</p>
    </section>

    <section aria-labelledby="urdu-style-heading">
      <h2 id="urdu-style-heading">Which caption styles suit Urdu?</h2>
      <p>The editor includes an <strong>Urdu Nastaliq</strong> style and an <strong>Urdu Naskh</strong> style, both right to left, plus adjustable colours and fonts. Nastaliq gives the flowing look Urdu readers expect; Naskh is denser and can suit smaller screens. You can preview each style on your own video before exporting.</p>
    </section>

    <section aria-labelledby="urdu-export-heading">
      <h2 id="urdu-export-heading">What can I do with the Urdu captions after that?</h2>
      <p>You can edit every line, fix names and numbers, retime captions word by word, and then export. Subtitle files come as <strong>SRT</strong>, <strong>VTT</strong> or <strong>TXT</strong>, and the video export burns the Urdu captions into a <strong>9:16, 1:1, 4:5, 16:9</strong> or original-ratio clip at up to 1080p. See the <a href="${ctx.link('/how-it-works/')}">how it works</a> page or the <a href="${ctx.link('/faq/')}">FAQ</a> for more.</p>
    </section>

    ${faqSection('Urdu subtitle questions', faq)}

    ${ctaBand(ctx, 'Make Urdu subtitles now', 'Open the editor, load a short clip, and translate the captions to Urdu or Roman Urdu.')}`

      const jsonLd = [
        { '@type': 'FAQPage', mainEntity: faq.map((item) => ({ '@type': 'Question', name: item.q, acceptedAnswer: { '@type': 'Answer', text: item.a } })) },
      ]
      return { body, jsonLd }
    },
  },

  {
    id: 'auto',
    path: '/auto-subtitles-for-videos/',
    depth: 1,
    lang: 'en',
    translationKey: 'auto',
    breadcrumb: 'Automatic subtitles for videos',
    title: 'Automatic Subtitles for Videos — English, Hindi, Arabic',
    description: 'Make automatic subtitles for short videos online. Transcribe English, Hindi and Arabic speech, edit captions, translate and export SRT, VTT or MP4.',
    h1: 'Automatic subtitles for videos',
    build(ctx) {
      const faq = [
        {
          q: 'Which languages can it transcribe automatically?',
          a: 'The speech-to-text step detects the spoken language automatically and supports many languages, including English, Hindi, Arabic and Urdu. You do not pick the language first; the tool detects it from the audio.',
        },
        {
          q: 'Are the subtitles word-timed?',
          a: 'Yes. Captions come back with per-word timings, so you can retime, split and merge lines and change how many words appear at once without losing sync.',
        },
        {
          q: 'Can I turn the subtitles into another language?',
          a: 'Yes. After generating captions you can translate them into English, Urdu, Roman Urdu, Hindi, Roman Hindi or Arabic, and switch between the original and the translation at any time.',
        },
        {
          q: 'What file types can I open?',
          a: `Common video files such as MP4, MOV, MKV and WebM work. Videos longer than ${ctx.limits.videoMinutes} minutes are automatically shortened to the first ${ctx.limits.videoMinutes} minutes, and you can choose another part. For subtitles, the selected part should have an audio track.`,
        },
      ]
      const body = `<div class="hero">
      <p class="eyebrow">Automatic subtitles</p>
      <h1>${this.h1}</h1>
      <p class="answer">XCaptions creates automatic subtitles for short videos in your browser. It detects the spoken language and returns word-timed captions for English, Hindi, Arabic and many other languages. You can edit every line, translate captions, and export SRT, VTT, plain text or a video with burned-in captions.</p>
      <div class="hero-actions"><a class="btn btn-primary" href="${ctx.link(TOOL_PATH)}">Open the editor</a></div>
    </div>

    <section aria-labelledby="auto-how-heading">
      <h2 id="auto-how-heading">How do I make automatic subtitles for a video?</h2>
      <ol class="steps">
        <li><h3>Load a video</h3><p>Longer videos are automatically shortened to the first ${ctx.limits.videoMinutes} minutes. You can choose another part of the original; processing stays on your device.</p></li>
        <li><h3>Generate the captions</h3><p>Only the extracted audio is sent for speech recognition, which returns word-timed text.</p></li>
        <li><h3>Review and edit</h3><p>Correct names and numbers, split or merge lines, and choose a caption style and aspect ratio.</p></li>
        <li><h3>Export</h3><p>Download SRT, VTT or TXT, or export the video with captions burned in at up to 1080p.</p></li>
      </ol>
    </section>

    <section aria-labelledby="auto-lang-heading">
      <h2 id="auto-lang-heading">Which languages does it handle?</h2>
      <p>English, Hindi, Arabic and Urdu are the languages most people ask about, and they all work. The tool auto-detects the spoken language, so mixed-language clips can be less predictable. For translation you can choose English, Urdu (Urdu script), Roman Urdu, Hindi (Devanagari), Roman Hindi or Arabic. If you mainly need Urdu, see the <a href="${ctx.link('/urdu-subtitle-generator/')}">Urdu subtitle generator</a> page.</p>
    </section>

    <section aria-labelledby="auto-format-heading">
      <h2 id="auto-format-heading">What formats and resolutions can I export?</h2>
      <p>Text exports are <strong>SRT</strong>, <strong>VTT</strong> and <strong>TXT</strong> (as paragraphs or with timestamps). You can also export the extracted <strong>audio</strong>, or a <strong>captioned video</strong> at 480p, 720p, 1080p or the original size. Subtitle files apply your trim by default and start at zero; uncheck the trim option to export every caption.</p>
    </section>

    <section aria-labelledby="auto-review-heading">
      <h2 id="auto-review-heading">How accurate are automatic subtitles?</h2>
      <p>Speech recognition is usually good on clear speech and weaker on accents, names, crosstalk, music and background noise. Translation adds its own small errors. Treat the result as a strong first draft: read every line before you publish. The editor is built for exactly that, with word-level timing and quick split and merge tools.</p>
    </section>

    ${faqSection('Automatic subtitle questions', faq)}

    ${ctaBand(ctx, 'Make your first automatic subtitles', 'Open the editor with a short clip and export captions in minutes.')}`

      const jsonLd = [
        { '@type': 'FAQPage', mainEntity: faq.map((item) => ({ '@type': 'Question', name: item.q, acceptedAnswer: { '@type': 'Answer', text: item.a } })) },
      ]
      return { body, jsonLd }
    },
  },

  {
    id: 'how',
    path: '/how-it-works/',
    depth: 1,
    lang: 'en',
    translationKey: 'how',
    breadcrumb: 'How it works',
    title: 'How XCaptions Works',
    description: 'See how XCaptions turns a short video into editable subtitles: local video, audio transcription, on-device editing and export. Learn the steps.',
    h1: 'How XCaptions works',
    build(ctx) {
      const steps = [
        { title: 'Open a video', text: `Videos longer than ${ctx.limits.videoMinutes} minutes are shortened to the first ${ctx.limits.videoMinutes} minutes, and you can choose another part. The file is prepared locally and stays on your device.` },
        { title: 'Generate word-timed subtitles', text: `XCaptions extracts the audio in your browser, splits it into roughly ${ctx.limits.chunkSeconds}-second chunks and sends one chunk at a time to a speech-to-text service, which returns captions with per-word timings.` },
        { title: 'Edit the captions', text: 'Fix text, retime words, split or merge lines, and add or delete captions. Editing runs on your device.' },
        { title: 'Choose a style and ratio', text: 'Pick one of the caption styles, adjust colours or fonts, and reframe to 9:16, 1:1, 4:5, 16:9 or the original ratio.' },
        { title: 'Translate if you need to', text: 'Translate captions into English, Urdu, Roman Urdu, Hindi, Roman Hindi or Arabic, and switch between the original and the translation.' },
        { title: 'Trim and export', text: 'Set the start and end, then export SRT, VTT, TXT, audio, or a captioned video at 480p, 720p, 1080p or the original size.' },
        { title: 'Come back later', text: 'Projects auto-save in your browser, and the editor keeps up to three of them. Nothing is stored on the server.' },
      ]
      const body = `<div class="hero">
      <p class="eyebrow">How it works</p>
      <h1>${this.h1}</h1>
      <p class="answer">XCaptions is a browser-based subtitle editor. You load a short video, it extracts the audio and sends only that audio for speech recognition, then you edit word-timed captions, choose a style and ratio, translate if needed, and export. The video itself is never uploaded.</p>
      <div class="hero-actions"><a class="btn btn-primary" href="${ctx.link(TOOL_PATH)}">Open the editor</a></div>
    </div>

    <section aria-labelledby="steps-heading">
      <h2 id="steps-heading">What are the steps?</h2>
      <ol class="steps">
        ${steps.map((step) => `<li><h3>${step.title}</h3><p>${step.text}</p></li>`).join('\n        ')}
      </ol>
    </section>

    <section aria-labelledby="local-heading">
      <h2 id="local-heading">What happens on my device, and what leaves it?</h2>
      <p>Everything you can see happens in your browser: opening the video, editing captions, styling, trimming, previewing and exporting the video. Only two things leave your device, and only when you ask for them. Generating subtitles sends the extracted audio to a speech-to-text service, and translating sends the caption text. Neither is stored by XCaptions. Details are on the <a href="${ctx.link('/privacy/')}">privacy page</a>.</p>
    </section>

    <section aria-labelledby="limits-heading">
      <h2 id="limits-heading">What are the limits?</h2>
      <p>Videos longer than ${ctx.limits.videoMinutes} minutes are automatically shortened to the first ${ctx.limits.videoMinutes} minutes, and you can choose another part of the original. Files above ${ctx.limits.maxVideoMb} MB are locally prepared to fit the media size limit; source files above ${ctx.limits.maxFileHardMb} MB cannot be processed. Audio is transcribed in short chunks of about ${ctx.limits.chunkSeconds} seconds, and you can retry a single part. Free provider quotas for transcription and translation can also apply, and video export is the heaviest step, so keep the tab open while it finishes.</p>
    </section>

    ${ctaBand(ctx, 'Ready to try it?', 'Open the editor and turn a short clip into subtitles you can edit and export.')}`

      const jsonLd = [
        {
          '@type': 'HowTo',
          name: 'How to make subtitles for a short video with XCaptions',
          description: 'Turn a short video into editable, word-timed subtitles and export them as a subtitle file or a captioned video.',
          step: steps.map((step, index) => ({ '@type': 'HowToStep', position: index + 1, name: step.title, text: step.text })),
        },
      ]
      return { body, jsonLd }
    },
  },

  {
    id: 'faq',
    path: '/faq/',
    depth: 1,
    lang: 'en',
    translationKey: 'faq',
    breadcrumb: 'FAQ',
    title: 'XCaptions FAQ — Limits, Privacy and Export',
    description: 'Answers about XCaptions limits, privacy, languages, Urdu and Roman Urdu support, export formats, accuracy and mobile support.',
    h1: 'Frequently asked questions',
    build(ctx) {
      const body = `<div class="hero">
      <p class="eyebrow">FAQ</p>
      <h1>${this.h1}</h1>
      <p class="answer">These are short, direct answers about how XCaptions works: what happens to your video, the clip and file limits, which languages and subtitle formats are supported, how Urdu and Roman Urdu are handled, and what to check before you publish subtitles.</p>
      <div class="hero-actions"><a class="btn btn-primary" href="${ctx.link(TOOL_PATH)}">Open the editor</a></div>
    </div>

    ${faqSection('Questions and answers', buildCoreFaq(ctx.limits))}

    <section aria-labelledby="more-heading">
      <h2 id="more-heading">Where can I read more?</h2>
      <p>See <a href="${ctx.link('/how-it-works/')}">how it works</a> for the end-to-end process, <a href="${ctx.link('/urdu-subtitle-generator/')}">Urdu subtitles</a> for Urdu and Roman Urdu, <a href="${ctx.link('/auto-subtitles-for-videos/')}">automatic subtitles</a> for English, Hindi and Arabic, and the <a href="${ctx.link('/privacy/')}">privacy</a> and <a href="${ctx.link('/terms/')}">terms</a> pages for the fine print.</p>
    </section>

    ${ctaBand(ctx, 'Still have a clip to caption?', 'Open the editor and export subtitles in a few minutes.')}`

      const jsonLd = [
        { '@type': 'FAQPage', mainEntity: buildCoreFaq(ctx.limits).map((item) => ({ '@type': 'Question', name: item.q, acceptedAnswer: { '@type': 'Answer', text: item.a } })) },
      ]
      return { body, jsonLd }
    },
  },

  {
    id: 'privacy',
    path: '/privacy/',
    depth: 1,
    lang: 'en',
    translationKey: 'privacy',
    breadcrumb: 'Privacy',
    title: 'Privacy — XCaptions',
    description: 'How XCaptions handles your video, audio, captions and saved projects, and what its speech and translation providers receive.',
    h1: 'Privacy',
    build(ctx) {
      const analyticsParagraph = ctx.analyticsEnabled
        ? `<h2>Analytics</h2>
      <p>This site uses Google Analytics 4, and only after you accept the analytics banner. It records anonymous usage such as page views and approximate country, never your video, audio or caption text. You can accept or decline analytics at any time with the "Cookie settings" link in the footer, or opt out across the web with Google's <a href="https://tools.google.com/dlpage/gaoptout" rel="noopener">analytics opt-out browser add-on</a>. Transcription and translation still send only the audio or text you choose to process.</p>`
        : `<h2>Analytics</h2>
      <p>This build does not load any analytics scripts.</p>`
      const body = `<div class="hero">
      <p class="eyebrow">Privacy</p>
      <h1>${this.h1}</h1>
      <p class="answer">XCaptions keeps your video on your device and saves projects only in your browser. When you generate subtitles, the extracted audio is sent to a speech-to-text provider, and when you translate, the caption text is sent too. This site does not store your media or captions on its server.</p>
    </div>

    <section>
      <h2>What stays on your device</h2>
      <ul>
        <li>Your video file is opened and processed in your browser and is never uploaded.</li>
        <li>Editing, styling, reframing, trimming and video export all run locally.</li>
        <li>Saved projects are stored in your browser. The editor keeps up to three, and your browser can clear them at any time.</li>
      </ul>
    </section>

    <section>
      <h2>What is sent, and when</h2>
      <ul>
        <li><strong>Generating subtitles:</strong> the audio extracted from your video is sent to a speech-to-text service. The video itself is not sent.</li>
        <li><strong>Translating captions:</strong> the caption text is sent to a translation service.</li>
        <li>These steps only happen when you click the buttons, and XCaptions does not store the audio or text on its own server.</li>
      </ul>
    </section>

    <section>
      <h2>Saved projects</h2>
      <p>Projects are stored in your browser's own storage (IndexedDB) on this device. They are not synced to an account and are not visible to us. Deleting the project in the editor, or clearing your browser's site data, removes them.</p>
    </section>

    <section>
      ${analyticsParagraph}
    </section>

    <section>
      <h2>Providers and fonts</h2>
      <p>Speech recognition and translation are provided by a third-party service that processes the audio or text under its own terms. The editor uses web fonts served by Google Fonts, which can receive standard connection details such as your IP address when a font is requested. If you prefer, you can self-host those fonts.</p>
    </section>

    <section>
      <h2>Contact</h2>
      <p>Questions about privacy? Email <a href="mailto:${ctx.contactEmail}">${ctx.contactEmail}</a>. See also the <a href="${ctx.link('/terms/')}">terms and limits</a>.</p>
    </section>

    ${ctaBand(ctx, 'Back to the editor', 'Your video stays on your device while you work.')}`

      return { body, jsonLd: [] }
    },
  },

  {
    id: 'terms',
    path: '/terms/',
    depth: 1,
    lang: 'en',
    translationKey: 'terms',
    breadcrumb: 'Terms & limits',
    title: 'Terms and Limits — XCaptions',
    description: 'The terms and practical limits for using XCaptions: clip length and size, free usage, your responsibility for content, and availability.',
    h1: 'Terms and limits',
    build(ctx) {
      const body = `<div class="hero">
      <p class="eyebrow">Terms</p>
      <h1>${this.h1}</h1>
      <p class="answer">XCaptions is a free, browser-based tool. You may use it for personal or commercial videos as long as you own the content and follow the limits: videos longer than ${ctx.limits.videoMinutes} minutes are automatically shortened to the first ${ctx.limits.videoMinutes} minutes, and you can choose another part of the original. Files above ${ctx.limits.maxVideoMb} MB are prepared locally; files above the absolute source limit of ${ctx.limits.maxFileHardMb} MB cannot be processed. Free transcription and translation quotas may also apply. The service is provided as is.</p>
    </div>

    <section>
      <h2>Practical limits</h2>
      <ul>
        <li>Video length: videos longer than ${ctx.limits.videoMinutes} minutes are automatically shortened to the first ${ctx.limits.videoMinutes} minutes; you can choose another part of the original.</li>
        <li>Media size: files above ${ctx.limits.maxVideoMb} MB are prepared locally to fit the limit. The absolute source file ceiling is ${ctx.limits.maxFileHardMb} MB. Transcription audio is sent in chunks of about ${ctx.limits.chunkSeconds} seconds, one at a time.</li>
        <li>Free provider quotas for transcription and translation can add their own rate limits.</li>
      </ul>
    </section>

    <section>
      <h2>Free use</h2>
      <p>The editor is free to use and needs no account. Because transcription and translation rely on a shared free tier, those features can be rate-limited or occasionally busy. When that happens, waiting and retrying usually works.</p>
    </section>

    <section>
      <h2>Analytics</h2>
      <p>This site may use Google Analytics 4 to measure anonymous usage such as page views and approximate country. It is loaded only after you accept the analytics banner, and it never receives your video, audio or caption text. See the <a href="${ctx.link('/privacy/')}">privacy page</a> to change your choice.</p>
    </section>

    <section>
      <h2>Your content and your responsibility</h2>
      <p>You keep all rights to your video and captions. Only upload or process content you own or have permission to use. You are responsible for reviewing captions for accuracy before publishing, and for complying with the rules of whatever platform you post to.</p>
    </section>

    <section>
      <h2>Accuracy</h2>
      <p>Automatic subtitles and translations can contain mistakes. They are provided as a draft, not as a finished, guaranteed transcript. Always review the text in the editor.</p>
    </section>

    <section>
      <h2>Availability and changes</h2>
      <p>The tool is provided as is, without warranties, and features can change or be unavailable. These terms may be updated; the current version is always on this page. For anything else, see the <a href="${ctx.link('/privacy/')}">privacy page</a> or email <a href="mailto:${ctx.contactEmail}">${ctx.contactEmail}</a>.</p>
    </section>

    ${ctaBand(ctx, 'Back to the editor', 'Load a short clip and export your subtitles.')}`

      return { body, jsonLd: [] }
    },
  },

  {
    id: 'capcut-alternative',
    path: '/free-capcut-alternative-for-subtitles/',
    depth: 1,
    lang: 'en',
    translationKey: 'capcut-alternative',
    breadcrumb: 'Free CapCut alternative',
    title: 'Free CapCut Alternative for Auto Subtitles — XCaptions',
    description: 'A free CapCut alternative for auto subtitles. XCaptions adds word-timed captions in your browser, no account needed. Export SRT, VTT or MP4.',
    h1: 'Free CapCut alternative for auto subtitles',
    build(ctx) {
      const faq = [
        {
          q: 'Do I need a CapCut account to use XCaptions?',
          a: 'No. XCaptions needs no account, login or email. Open the editor, load a video and start generating subtitles right away.',
        },
        {
          q: 'Is XCaptions really free?',
          a: 'Yes. The editor is free to use. Transcription and translation run on a provider free tier, so those steps can have their own usage limits and may occasionally be busy.',
        },
        {
          q: 'Does it keep my video private?',
          a: 'Yes. The video is processed on your device and never uploaded. Only the extracted audio is sent for transcription, and caption text is sent only when you translate.',
        },
        {
          q: 'Can I use it on a phone?',
          a: 'Yes. XCaptions runs in a modern mobile browser and adapts to small screens. Video export is the heaviest step, so keep the tab open while it runs.',
        },
      ]
      const body = `<div class="hero">
      <p class="eyebrow">CapCut alternative</p>
      <h1>${this.h1}</h1>
      <p class="answer">XCaptions is a free, browser-based AI subtitle generator with word-timed captions, animated styles and Urdu support. No account needed.</p>
      <div class="hero-actions"><a class="btn btn-primary" href="${ctx.link(TOOL_PATH)}">Open the editor</a></div>
    </div>

    <section aria-labelledby="alt-what-heading">
      <h2 id="alt-what-heading">What is XCaptions, and how is it different from CapCut?</h2>
      <p>XCaptions is a focused subtitle tool that runs in your browser and creates word-timed captions from your video's audio. CapCut is a full-featured video editor where captions are one part of a larger app. If you only need auto subtitles, XCaptions gets you there in a few clicks without installing anything.</p>
    </section>

    <section aria-labelledby="alt-how-heading">
      <h2 id="alt-how-heading">How do I add auto subtitles without CapCut?</h2>
      <ol class="steps">
        <li><h3>Open a video</h3><p>Longer videos are automatically shortened to the first ${ctx.limits.videoMinutes} minutes, and you can pick another part. The video stays on your device.</p></li>
        <li><h3>Generate captions</h3><p>Only the extracted audio is sent for speech recognition, which returns word-timed captions.</p></li>
        <li><h3>Style and export</h3><p>Pick a caption style, reframe to 9:16, translate if you like, then export SRT, VTT, TXT or a captioned video.</p></li>
      </ol>
    </section>

    <section aria-labelledby="alt-export-heading">
      <h2 id="alt-export-heading">What can I export?</h2>
      <p>You can download <strong>SRT</strong>, <strong>VTT</strong> and <strong>TXT</strong> subtitle files, the extracted <strong>audio</strong>, or a <strong>captioned video</strong> at 480p, 720p, 1080p or the original size. You can also reframe to 9:16 for Shorts, Reels or TikTok. For the bigger picture, see <a href="${ctx.link('/xcaptions-vs-capcut/')}">XCaptions vs CapCut</a>.</p>
    </section>

    <section aria-labelledby="alt-urdu-heading">
      <h2 id="alt-urdu-heading">Does it support Urdu subtitles?</h2>
      <p>Yes. You can translate captions into Urdu, Roman Urdu, Hindi, Roman Hindi, Arabic or English. If Urdu is your main need, see the <a href="${ctx.link('/best-free-urdu-subtitle-generator/')}">best free Urdu subtitle generator</a> page.</p>
    </section>

    ${faqSection('Free CapCut alternative questions', faq)}

    ${ctaBand(ctx, 'Try it free', 'Open the editor, load a short clip and export captions in minutes — no account.')}`

      const jsonLd = [
        { '@type': 'FAQPage', mainEntity: faq.map((item) => ({ '@type': 'Question', name: item.q, acceptedAnswer: { '@type': 'Answer', text: item.a } })) },
      ]
      return { body, jsonLd }
    },
  },

  {
    id: 'urdu-best',
    path: '/best-free-urdu-subtitle-generator/',
    depth: 1,
    lang: 'en',
    translationKey: 'urdu-best',
    breadcrumb: 'Best Urdu subtitle generator',
    title: 'Best Free Urdu Subtitle Generator — XCaptions',
    description: 'Make Urdu and Roman Urdu subtitles free in your browser. XCaptions auto-detects speech, translates captions to Urdu, and exports SRT, VTT or MP4.',
    h1: 'Best free Urdu subtitle generator',
    build(ctx) {
      const faq = [
        {
          q: 'Does it auto-detect Urdu speech?',
          a: 'The speech-to-text step detects the spoken language automatically and supports Urdu among many languages. You do not pick the language first; the tool detects it from the audio.',
        },
        {
          q: 'Is Urdu text right-to-left?',
          a: 'Yes. Urdu captions use a right-to-left style in the editor and exports, so the script reads naturally.',
        },
        {
          q: 'Is it free and account-free?',
          a: 'Yes. The editor is free and needs no account. Transcription and translation use a provider free tier, which can have its own limits.',
        },
        {
          q: 'Do I need to type Urdu myself?',
          a: 'No. You can generate captions from the audio and then translate them to Urdu or Roman Urdu, then edit the text if needed.',
        },
      ]
      const body = `<div class="hero">
      <p class="eyebrow">Urdu subtitles</p>
      <h1>${this.h1}</h1>
      <p class="answer">XCaptions is a free, browser-based Urdu subtitle generator that turns your video's speech into word-timed captions and can translate them to Urdu or Roman Urdu — no login needed.</p>
      <div class="hero-actions"><a class="btn btn-primary" href="${ctx.link(TOOL_PATH)}">Open the editor</a></div>
    </div>

    <section aria-labelledby="urdu-best-how-heading">
      <h2 id="urdu-best-how-heading">How do I make Urdu subtitles for a video?</h2>
      <ol class="steps">
        <li><h3>Open a video</h3><p>Longer videos are shortened to the first ${ctx.limits.videoMinutes} minutes, and you can choose another part. The video stays on your device.</p></li>
        <li><h3>Generate captions</h3><p>Only the extracted audio is sent for speech recognition, which detects the language automatically.</p></li>
        <li><h3>Translate to Urdu</h3><p>Translate the captions to Urdu (Urdu script) or Roman Urdu, then review and edit the text.</p></li>
        <li><h3>Export</h3><p>Download SRT, VTT or TXT, or export a captioned video with right-to-left Urdu styling.</p></li>
      </ol>
    </section>

    <section aria-labelledby="urdu-best-roman-heading">
      <h2 id="urdu-best-roman-heading">Can it write Roman Urdu?</h2>
      <p>Yes. You can translate captions into natural Roman Urdu. Automatic transcription of Roman Urdu speech is not reliable, because speech recognition expects standard script; the dependable route is to generate subtitles first and then translate to Roman Urdu. See the full <a href="${ctx.link('/urdu-subtitle-generator/')}">Urdu subtitle generator</a> page for details.</p>
    </section>

    <section aria-labelledby="urdu-best-export-heading">
      <h2 id="urdu-best-export-heading">What formats can I export?</h2>
      <p>SRT, VTT and TXT subtitle files, the extracted audio, or a captioned video at up to 1080p. You can reframe to 9:16 for vertical video. If you are comparing tools, see the <a href="${ctx.link('/free-capcut-alternative-for-subtitles/')}">free CapCut alternative</a> page.</p>
    </section>

    ${faqSection('Urdu subtitle generator questions', faq)}

    ${ctaBand(ctx, 'Make Urdu subtitles free', 'Open the editor, load a short clip and translate the captions to Urdu or Roman Urdu.')}`

      const jsonLd = [
        { '@type': 'FAQPage', mainEntity: faq.map((item) => ({ '@type': 'Question', name: item.q, acceptedAnswer: { '@type': 'Answer', text: item.a } })) },
      ]
      return { body, jsonLd }
    },
  },

  {
    id: 'vs-capcut',
    path: '/xcaptions-vs-capcut/',
    depth: 1,
    lang: 'en',
    translationKey: 'vs-capcut',
    breadcrumb: 'XCaptions vs CapCut',
    title: 'XCaptions vs CapCut: Auto Captions Compared',
    description: 'XCaptions vs CapCut for auto captions: XCaptions is a free, no-login browser subtitle tool; CapCut is a full video editor. See how they compare.',
    h1: 'XCaptions vs CapCut: auto captions compared',
    build(ctx) {
      const faq = [
        {
          q: 'Does XCaptions need an account?',
          a: 'No. There is no sign-up, login or email required.',
        },
        {
          q: 'Is CapCut free?',
          a: 'CapCut has a free tier, and some features need an account or a paid plan. XCaptions is free and account-free for the core subtitle workflow.',
        },
        {
          q: 'Can XCaptions replace CapCut for subtitles?',
          a: 'For auto captions, yes — it does word-timed captions, styles, translation and export without leaving the browser. For full video editing, CapCut offers a broader feature set.',
        },
        {
          q: 'Does XCaptions upload my video?',
          a: 'No. The video is processed on your device. Only the extracted audio is sent for transcription, and caption text only when you translate.',
        },
      ]
      const body = `<div class="hero">
      <p class="eyebrow">Comparison</p>
      <h1>${this.h1}</h1>
      <p class="answer">XCaptions is a free, browser-based tool for word-timed auto captions, while CapCut is a full-featured video editor where captioning is one part of a larger app.</p>
      <div class="hero-actions"><a class="btn btn-primary" href="${ctx.link(TOOL_PATH)}">Open the editor</a></div>
    </div>

    <section aria-labelledby="vs-difference-heading">
      <h2 id="vs-difference-heading">What is the difference between XCaptions and CapCut?</h2>
      <p>XCaptions focuses on one job: turning your video's speech into editable, word-timed subtitles, then exporting them. CapCut is a full video editor that also offers captioning, along with editing, effects and publishing features. If you mainly need captions, XCaptions is the quicker path; if you need to edit the full video, CapCut does more.</p>
    </section>

    <section aria-labelledby="vs-free-heading">
      <h2 id="vs-free-heading">Are both free?</h2>
      <p>XCaptions is free and needs no account. CapCut has a free tier, though some features need an account and others are paid. Both are worth trying for their different strengths.</p>
    </section>

    <section aria-labelledby="vs-captions-heading">
      <h2 id="vs-captions-heading">Which is better for auto captions?</h2>
      <p>For quick, accurate word-timed captions with styles, translation and SRT/VTT export, XCaptions is built for exactly that and runs entirely in your browser. For full video editing with captions as one step, CapCut is the broader tool. See the <a href="${ctx.link('/free-capcut-alternative-for-subtitles/')}">free CapCut alternative</a> page to try the subtitle flow.</p>
    </section>

    <section aria-labelledby="vs-export-heading">
      <h2 id="vs-export-heading">Can XCaptions export SRT and 9:16?</h2>
      <p>Yes. XCaptions exports SRT, VTT, TXT, audio and a captioned video, and can reframe to 9:16 for vertical platforms. Urdu speakers can also translate captions to Urdu or Roman Urdu — see the <a href="${ctx.link('/best-free-urdu-subtitle-generator/')}">best free Urdu subtitle generator</a>.</p>
    </section>

    ${faqSection('XCaptions vs CapCut questions', faq)}

    ${ctaBand(ctx, 'Try XCaptions free', 'Open the editor, load a clip and see how fast word-timed captions come together.')}`

      const jsonLd = [
        { '@type': 'FAQPage', mainEntity: faq.map((item) => ({ '@type': 'Question', name: item.q, acceptedAnswer: { '@type': 'Answer', text: item.a } })) },
      ]
      return { body, jsonLd }
    },
  },
]

export { buildCoreFaq }
