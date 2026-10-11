// Google Analytics 4 loader with Google Consent Mode v2.
//
// The build emits this as a same-origin, deferred script plus an async
// `https://www.googletagmanager.com/gtag/js?id=ID` tag. It reads the measurement
// ID from its `data-ga-id` attribute so the ID only ever lives in the build
// config, never inline (which the CSP blocks).
//
// Consent defaults are set to "denied" for every storage type *before* the
// pageview is configured, so nothing is stored until the visitor accepts.
// Analytics never receives the video, audio or caption text.
(function () {
  'use strict';

  var script = document.currentScript || document.querySelector('script[data-ga-id]');
  var GA_ID = script ? (script.getAttribute('data-ga-id') || '').trim() : '';
  if (!GA_ID) return;

  // Idempotent dataLayer + gtag() stub. If the async gtag.js already loaded it
  // will have replaced this with the real implementation; either way `gtag()`
  // queues/processes commands in order.
  window.dataLayer = window.dataLayer || [];
  window.gtag = window.gtag || function gtag() { window.dataLayer.push(arguments); };

  // Consent Mode v2: deny everything before any tag can fire.
  window.gtag('consent', 'default', {
    analytics_storage: 'denied',
    ad_storage: 'denied',
    ad_user_data: 'denied',
    ad_personalization: 'denied',
  });

  window.gtag('js', new Date());
  window.gtag('config', GA_ID, {
    anonymize_ip: true,
    allow_google_signals: false,
    allow_ad_personalization_signals: false,
  });

  var STORAGE_KEY = 'xc-ga-consent';
  var consented = false;

  function readConsent() {
    try { return localStorage.getItem(STORAGE_KEY); } catch (error) { return null; }
  }
  function writeConsent(value) {
    try { localStorage.setItem(STORAGE_KEY, value); } catch (error) { /* storage may be unavailable */ }
  }
  function grantConsent() {
    consented = true;
    window.gtag('consent', 'update', { analytics_storage: 'granted' });
    writeConsent('granted');
  }
  function declineConsent() {
    consented = false;
    // Defaults are already "denied", so nothing to update — just remember the choice.
    writeConsent('denied');
  }

  var CSS = [
    '#xc-consent{position:fixed;left:0;right:0;bottom:0;z-index:2147483000;background:#0e0f0d;color:#e8e8e4;border-top:1px solid #2a2b27;padding:14px 18px;display:flex;align-items:center;gap:14px;flex-wrap:wrap;font:13px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,Arial,sans-serif;box-shadow:0 -6px 24px rgba(0,0,0,.35)}',
    '#xc-consent p{margin:0;flex:1 1 300px;color:#c7c8c0}',
    '#xc-consent .xc-actions{display:flex;gap:10px;flex-wrap:wrap}',
    '#xc-consent button{cursor:pointer;border:1px solid #3a3b36;background:#171816;color:#e8e8e4;padding:9px 16px;border-radius:6px;font:inherit}',
    '#xc-consent button:hover{border-color:#55564f}',
    '#xc-consent button.xc-accept{background:#d1fa70;border-color:#d1fa70;color:#111210;font-weight:600}',
    '#xc-cookie-settings{position:fixed;right:12px;bottom:12px;z-index:2147483000;cursor:pointer;border:1px solid #3a3b36;background:#171816;color:#c7c8c0;padding:7px 12px;border-radius:999px;font:12px system-ui,-apple-system,"Segoe UI",Roboto,Arial,sans-serif}',
  ].join('\n');

  var banner = null;
  var settingsButton = null;

  function injectStyle() {
    if (document.getElementById('xc-consent-style')) return;
    var style = document.createElement('style');
    style.id = 'xc-consent-style';
    style.textContent = CSS;
    document.head.appendChild(style);
  }

  function buildBanner() {
    var box = document.createElement('div');
    box.id = 'xc-consent';
    box.setAttribute('role', 'region');
    box.setAttribute('aria-label', 'Cookie consent');

    var text = document.createElement('p');
    text.textContent = 'We use Google Analytics to understand how the site is used. It never receives your video, audio or captions.';

    var actions = document.createElement('div');
    actions.className = 'xc-actions';

    var accept = document.createElement('button');
    accept.type = 'button';
    accept.className = 'xc-accept';
    accept.textContent = 'Accept analytics';
    accept.addEventListener('click', function () { grantConsent(); hideBanner(); });

    var decline = document.createElement('button');
    decline.type = 'button';
    decline.textContent = 'Decline';
    decline.addEventListener('click', function () { declineConsent(); hideBanner(); });

    actions.appendChild(accept);
    actions.appendChild(decline);
    box.appendChild(text);
    box.appendChild(actions);
    return box;
  }

  function showBanner() {
    injectStyle();
    if (!banner) banner = buildBanner();
    if (!banner.parentNode) document.body.appendChild(banner);
    banner.style.display = '';
  }

  function hideBanner() {
    if (banner) banner.style.display = 'none';
    ensureSettingsControl();
  }

  // Re-open the consent banner via a footer "Cookie settings" link on content
  // pages, or a small floating button injected on the editor (which has no footer).
  function ensureSettingsControl() {
    if (settingsButton) return;
    if (document.querySelector('[data-cookie-settings]')) return; // footer link exists
    injectStyle();
    settingsButton = document.createElement('button');
    settingsButton.type = 'button';
    settingsButton.id = 'xc-cookie-settings';
    settingsButton.setAttribute('data-cookie-settings', '');
    settingsButton.textContent = 'Cookie settings';
    document.body.appendChild(settingsButton);
  }

  document.addEventListener('click', function (event) {
    var target = event.target instanceof Element ? event.target : null;
    if (!target) return;
    var opener = target.closest('[data-cookie-settings]');
    if (opener) {
      if (opener.tagName === 'A') event.preventDefault();
      showBanner();
    }
  });

  /* ------------------------------------------------------------- custom events */

  function track(name, params) {
    if (!consented) return; // custom events are gated behind explicit consent
    try { window.gtag('event', name, params || {}); } catch (error) { /* ignore */ }
  }

  function durationBucket() {
    var video = document.querySelector('video');
    var seconds = video && Number.isFinite(video.duration) ? video.duration : 0;
    if (seconds <= 0) return 'unknown';
    if (seconds <= 60) return '0-60s';
    if (seconds <= 300) return '60-300s';
    return '300-600s';
  }

  function selectedResolution() {
    var pill = document.querySelector('[aria-label="Video resolution"] .format-pill.is-selected');
    var text = pill ? (pill.textContent || '').trim().toLowerCase() : '';
    return text || undefined;
  }

  function watchGenerateResult() {
    var bucket = durationBucket();
    var done = false;
    var observer = new MutationObserver(function () {
      if (done) return;
      if (document.querySelector('.caption-row')) { done = true; finish('success'); }
      else if (document.querySelector('.generate-control .error-message')) { done = true; finish('failure'); }
    });
    function finish(status) {
      observer.disconnect();
      track('generate_subtitles', { status: status, duration_bucket: bucket });
    }
    observer.observe(document.body, { childList: true, subtree: true });
    setTimeout(function () { observer.disconnect(); }, 300000); // safety timeout
  }

  document.addEventListener('click', function (event) {
    if (!consented) return;
    var target = event.target instanceof Element ? event.target : null;
    if (!target) return;
    var button = target.closest('button');
    if (!button) return;
    var text = (button.textContent || '').trim();

    if (/^Download SRT$/i.test(text)) {
      track('download_srt');
    } else if (text.indexOf('Export video') !== -1) {
      var resolution = selectedResolution();
      track('export_video', resolution ? { resolution: resolution } : {});
    } else if (button.classList.contains('button-generate') && /Generate Subtitles|Retry part/i.test(text)) {
      watchGenerateResult();
    }
  });

  /* ------------------------------------------------------------- initial state */

  injectStyle();
  var stored = readConsent();
  if (stored === 'granted') {
    grantConsent(); // re-apply consent for this page load
    ensureSettingsControl();
  } else if (stored === 'denied') {
    ensureSettingsControl();
  } else {
    showBanner();
  }
})();
