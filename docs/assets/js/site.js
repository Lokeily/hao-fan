// 好翻官网 · 共享交互脚本 v2
(function () {
  'use strict';

  // ===== 主题切换：浅色 ↔ 深色（默认跟随系统，选择存 localStorage） =====
  var THEME_KEY = 'hf-theme';
  function applyTheme(t) {
    if (t === 'light' || t === 'dark') document.documentElement.setAttribute('data-theme', t);
    else document.documentElement.removeAttribute('data-theme');
  }
  try {
    var saved = localStorage.getItem(THEME_KEY);
    if (saved) applyTheme(saved);
  } catch { /* 隐私模式下不可用，跟随系统 */ }
  var tbtn = document.querySelector('.theme-toggle');
  if (tbtn) {
    tbtn.addEventListener('click', function () {
      var cur = document.documentElement.getAttribute('data-theme');
      var sysDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
      var resolved = cur || (sysDark ? 'dark' : 'light');
      var next = resolved === 'dark' ? 'light' : 'dark';
      applyTheme(next);
      try { localStorage.setItem(THEME_KEY, next); } catch { /* ignore */ }
    });
  }

  // ===== 导航滚动状态：滚过首屏顶后浮出分隔线与投影 =====
  var nav = document.querySelector('.nav');
  if (nav) {
    var onScroll = function () { nav.classList.toggle('scrolled', window.scrollY > 8); };
    window.addEventListener('scroll', onScroll, { passive: true });
    onScroll();
  }

  // ===== 移动端菜单 =====
  var toggle = document.getElementById('navToggle');
  var links = document.getElementById('navLinks');
  if (toggle && links) {
    toggle.addEventListener('click', function () {
      var o = links.classList.toggle('open');
      toggle.setAttribute('aria-expanded', String(o));
    });
    links.addEventListener('click', function (event) {
      if (event.target.closest('a')) links.classList.remove('open');
    });
  }

  // ===== 导航高亮当前页 =====
  var path = location.pathname.split('/').pop() || 'index.html';
  document.querySelectorAll('.nav-links a.op').forEach(function (a) {
    var href = a.getAttribute('href') || '';
    if (href === path) a.classList.add('active');
  });

  // ===== 滚动显现 =====
  var io = new IntersectionObserver(function (es) {
    es.forEach(function (e) {
      if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); }
    });
  }, { threshold: 0.12 });
  document.querySelectorAll('.reveal').forEach(function (el) { io.observe(el); });

  // ===== 网格子项交错入场：容器标 data-stagger，直接子项依次点亮（上限 600ms） =====
  var reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  document.querySelectorAll('[data-stagger]').forEach(function (group) {
    var kids = group.querySelectorAll(':scope > *');
    if (!kids.length) return;
    kids.forEach(function (c, i) {
      c.classList.add('reveal-child');
      c.style.setProperty('--d', Math.min(i * 65, 600) + 'ms');
    });
    if (reduced) {
      kids.forEach(function (c) { c.classList.add('in'); });
      return;
    }
    var gio = new IntersectionObserver(function (es) {
      es.forEach(function (e) {
        if (!e.isIntersecting) return;
        e.target.querySelectorAll(':scope > .reveal-child').forEach(function (c) { c.classList.add('in'); });
        gio.unobserve(e.target);
      });
    }, { threshold: 0.05 }); // 长页面（如功能页整块 main）也能在首屏立即触发
    gio.observe(group);
  });

  // ===== FAQ 手风琴互斥 =====
  document.querySelectorAll('details.q').forEach(function (d) {
    d.addEventListener('toggle', function () {
      if (d.open) document.querySelectorAll('details.q').forEach(function (o) { if (o !== d) o.open = false; });
    });
  });

  // ===== 数字滚动计数动画 =====
  function countUp(el) {
    var target = parseFloat(el.dataset.count || '0');
    var suffix = el.dataset.suffix || '';
    var decimals = Number(el.dataset.decimals || '0');
    if (reduced) { el.textContent = target.toFixed(decimals) + suffix; return; }
    var dur = 1300;
    var t0 = performance.now();
    function tick(t) {
      var p = Math.min(1, (t - t0) / dur);
      var eased = 1 - Math.pow(1 - p, 3);
      el.textContent = (target * eased).toFixed(decimals) + suffix;
      if (p < 1) requestAnimationFrame(tick);
    }
    requestAnimationFrame(tick);
  }
  var cio = new IntersectionObserver(function (es) {
    es.forEach(function (e) { if (e.isIntersecting) { countUp(e.target); cio.unobserve(e.target); } });
  }, { threshold: 0.5 });
  document.querySelectorAll('[data-count]').forEach(function (el) { cio.observe(el); });

  // ===== Hero 流式打字演示：逐字回填译文，模拟「首字即显」 =====
  var demoBody = document.querySelector('[data-typing]');
  if (demoBody) {
    var pairs = [];
    demoBody.querySelectorAll('.pair').forEach(function (p) {
      var src = p.querySelector('.src');
      var tgt = p.querySelector('.tgt');
      if (src && tgt) pairs.push({ src: src, tgt: tgt, text: tgt.dataset.text || tgt.textContent });
    });
    if (pairs.length && !reduced) {
      pairs.forEach(function (p) { p.tgt.textContent = ''; });
      var pi = 0;
      var caret = document.createElement('span');
      caret.className = 'caret';
      function typePair(p, done) {
        p.tgt.textContent = '';
        p.tgt.appendChild(caret);
        var i = 0;
        var text = p.text;
        (function step() {
          if (i < text.length) {
            // 一次敲 1~2 个字符，接近真实流式节奏
            i += 1 + (Math.random() < 0.35 ? 1 : 0);
            p.tgt.textContent = text.slice(0, i);
            p.tgt.appendChild(caret);
            setTimeout(step, 26 + Math.random() * 44);
          } else {
            p.tgt.textContent = text;
            setTimeout(done, 1500);
          }
        })();
      }
      function runLoop() {
        var p = pairs[pi % pairs.length];
        typePair(p, function () {
          pi += 1;
          if (pi % pairs.length === 0) {
            // 一轮结束：全部保留 1.2s，再清空重来
            setTimeout(function () {
              pairs.forEach(function (q) { q.tgt.textContent = ''; });
              setTimeout(runLoop, 400);
            }, 1200);
          } else {
            runLoop();
          }
        });
      }
      // 演示窗进入视口后再开始，省电且不抢首屏动画
      var dio = new IntersectionObserver(function (es) {
        es.forEach(function (e) {
          if (e.isIntersecting) { runLoop(); dio.disconnect(); }
        });
      }, { threshold: 0.35 });
      dio.observe(demoBody);
    }
  }

  // ===== 从 GitHub Release 拉取版本号与下载直链 =====
  // 版本号只在「接口返回的版本更新」时覆盖静态文案（官网文案以上架版本为准，不被旧 Release 倒退）。
  function isNewer(a, b) {
    var pa = a.split('.'), pb = b.split('.');
    for (var i = 0; i < 3; i++) {
      var x = parseInt(pa[i] || '0', 10), y = parseInt(pb[i] || '0', 10);
      if (x !== y) return x > y;
    }
    return false;
  }
  (async function () {
    try {
      var r = await fetch('https://api.github.com/repos/Lokeily/hao-fan/releases/latest');
      if (!r.ok) return;
      var rel = await r.json();
      var v = (rel.tag_name || '').replace(/^v/, '');
      if (!v) return;
      document.querySelectorAll('[data-ver]').forEach(function (el) {
        var cur = (el.textContent || '').replace(/^v/, '');
        if (!/^\d+\.\d+/.test(cur) || isNewer(v, cur)) el.textContent = 'v' + v;
      });
      var names = {
        chrome: 'open-translator-cn-' + v + '-chrome.zip',
        firefox: 'open-translator-cn-' + v + '-firefox.zip'
      };
      document.querySelectorAll('[data-dl]').forEach(function (a) {
        var f = names[a.dataset.dl];
        var asset = (rel.assets || []).find(function (x) { return x.name === f; });
        if (asset) a.href = asset.browser_download_url;
      });
    } catch { /* 保持 releases/latest 兜底 */ }
  })();
})();
