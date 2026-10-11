// XCaptions home page — tiny caption-demo interactivity. No libraries, no
// inline scripts (the CSP blocks inline). Without JavaScript the Pop style
// still renders statically with its first word highlighted.
(function () {
  'use strict';

  var demo = document.querySelector('.demo');
  if (!demo) return;

  var chips = Array.prototype.slice.call(demo.querySelectorAll('.style-chip'));
  var reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var index = 0;
  var timer = null;

  function words() {
    var isUrdu = demo.getAttribute('data-style') === 'ur';
    var container = demo.querySelector(isUrdu ? '.demo-words-ur' : '.demo-words:not(.demo-words-ur)');
    return container ? Array.prototype.slice.call(container.querySelectorAll('.w')) : [];
  }

  function show(i) {
    words().forEach(function (w, n) { w.classList.toggle('is-active', n === i); });
  }

  function start() {
    index = 0;
    show(0);
    if (reduced) return;
    if (timer) clearInterval(timer);
    timer = setInterval(function () {
      var list = words();
      if (!list.length) return;
      index = (index + 1) % list.length;
      show(index);
    }, 620);
  }

  chips.forEach(function (chip) {
    chip.addEventListener('click', function () {
      var style = chip.getAttribute('data-style');
      demo.setAttribute('data-style', style);
      chips.forEach(function (c) { c.setAttribute('aria-pressed', String(c === chip)); });
      start();
    });
  });

  start();
})();
