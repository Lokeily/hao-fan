// 好翻官网交互脚本：滚动进度条、导航栏滚动态、栏目高亮、进场动画、移动端菜单
(function () {
  'use strict';

  var reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // ---- 导航栏滚动状态 + 顶部进度条 ----
  var nav = document.querySelector('.nav');
  var progress = document.querySelector('.scroll-progress');
  var ticking = false;

  function onScroll() {
    if (ticking) return;
    ticking = true;
    window.requestAnimationFrame(function () {
      var y = window.scrollY || document.documentElement.scrollTop;
      if (nav) nav.classList.toggle('scrolled', y > 16);

      if (progress) {
        var doc = document.documentElement;
        var max = doc.scrollHeight - doc.clientHeight;
        var pct = max > 0 ? (y / max) * 100 : 0;
        progress.style.width = pct + '%';
      }
      ticking = false;
    });
  }
  window.addEventListener('scroll', onScroll, { passive: true });
  onScroll();

  // ---- 进场动画（IntersectionObserver 渐显上浮）----
  var revealEls = document.querySelectorAll('.reveal');
  if (reduceMotion || !('IntersectionObserver' in window)) {
    revealEls.forEach(function (el) { el.classList.add('in'); });
  } else {
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) {
          entry.target.classList.add('in');
          io.unobserve(entry.target);
        }
      });
    }, { threshold: 0.12, rootMargin: '0px 0px -8% 0px' });
    revealEls.forEach(function (el) { io.observe(el); });
  }

  // ---- 栏目滚动高亮（scroll-spy）----
  var links = Array.prototype.slice.call(document.querySelectorAll('.nav-links a[data-spy]'));
  if (links.length && 'IntersectionObserver' in window) {
    var map = {};
    links.forEach(function (a) {
      var id = a.getAttribute('href');
      if (id && id.indexOf('#') === 0) {
        var sec = document.querySelector(id);
        if (sec) map[id] = a;
      }
    });
    var spy = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) {
          links.forEach(function (a) { a.classList.remove('active'); });
          var active = map['#' + entry.target.id];
          if (active) active.classList.add('active');
        }
      });
    }, { rootMargin: '-45% 0px -50% 0px' });
    Object.keys(map).forEach(function (id) {
      var sec = document.querySelector(id);
      if (sec) spy.observe(sec);
    });
  }

  // ---- 移动端菜单 ----
  var toggle = document.querySelector('.nav-toggle');
  if (toggle) {
    toggle.addEventListener('click', function () {
      var open = document.body.classList.toggle('nav-open');
      toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    });
    // 点击菜单项后收起
    document.querySelectorAll('.nav-links a').forEach(function (a) {
      a.addEventListener('click', function () {
        document.body.classList.remove('nav-open');
        if (toggle) toggle.setAttribute('aria-expanded', 'false');
      });
    });
  }
})();
