// 好翻官网交互脚本：滚动进度条、导航栏滚动态、栏目高亮、进场动画、移动端菜单
(function () {
  'use strict';

  // 标记 JS 已激活：CSS 据此才隐藏 .reveal 初始态。
  // 若脚本未加载/出错，内容默认可见，杜绝「整块空白/文字不可见」的动画事故。
  document.documentElement.classList.add('js');

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

  // 兜底：若 IntersectionObserver 因故未触发（极旧环境、容器异常、脚本中断），
  // 页面 load 后延时强制显示所有 .reveal，确保绝无内容永久隐藏。
  window.addEventListener('load', function () {
    setTimeout(function () {
      document.querySelectorAll('.reveal:not(.in)').forEach(function (el) {
        el.classList.add('in');
      });
    }, 2600);
  });

  // ---- 当前页导航高亮（按文件名匹配）----
  var navLinks = Array.prototype.slice.call(document.querySelectorAll('.nav-links a'));
  if (navLinks.length) {
    var path = location.pathname.split('/').pop() || 'index.html';
    navLinks.forEach(function (a) {
      var href = a.getAttribute('href') || '';
      var name = href.split('/').pop();
      // 首页无需高亮；其余页面与文件名一致时高亮
      if (name && name === path && path !== 'index.html') {
        a.classList.add('active');
      }
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

// ---- 自动同步最新版本号：跟随 GitHub 仓库 ----
// 主数据源：raw.githubusercontent.com 上的 package.json（Fastly CDN，带 CORS、
//   国内可稳定访问、且不受 GitHub API 60次/小时限流影响）。
// 次数据源：GitHub Release API（境外可用，作为兜底）。
// 按钮链接本身始终指向 releases/latest（GitHub 自动跳转到最新版），无需脚本干预；
// 即使两个数据源都失败，也显示 FALLBACK_VERSION，不会出现错误编号。
(function () {
  'use strict';

  var REPO = 'Lokeily/hao-fan';
  var FALLBACK_VERSION = 'v0.1.23'; // 与当前真实发布一致，作为脚本失效时的兜底
  var RAW_URL = 'https://raw.githubusercontent.com/' + REPO + '/main/package.json';
  var API_URL = 'https://api.github.com/repos/' + REPO + '/releases/latest';
  var versionEls = document.querySelectorAll('.js-latest-version');

  // 兜底：先填已知版本（GitHub 发新版后即被下面的逻辑覆盖）
  versionEls.forEach(function (el) { el.textContent = FALLBACK_VERSION; });

  function applyVersion(v) {
    if (!v) return;
    var tag = String(v).indexOf('v') === 0 ? v : 'v' + v;
    versionEls.forEach(function (el) { el.textContent = tag; });
  }

  if (!window.fetch) return; // 极老浏览器：保持兜底

  function tryRaw() {
    return fetch(RAW_URL, { cache: 'no-cache' })
      .then(function (r) { if (!r.ok) throw new Error('raw ' + r.status); return r.json(); })
      .then(function (data) { if (data && data.version) { applyVersion(data.version); return true; } throw new Error('no version'); });
  }
  function tryApi() {
    return fetch(API_URL, { headers: { 'Accept': 'application/vnd.github+json' }, cache: 'no-cache' })
      .then(function (r) { if (!r.ok) throw new Error('api ' + r.status); return r.json(); })
      .then(function (data) { if (data && data.tag_name) applyVersion(data.tag_name); })
      .catch(function () { /* 全部失败：保留兜底 */ });
  }

  // 先试国内可达的 raw 源，失败再试 API
  tryRaw().catch(tryApi).catch(function () {});
})();

// ---- 内容动画：数字滚动 / 错落进场 / 打字机演示 / 回到顶部 ----
(function () {
  'use strict';

  var reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // 1) 错落进场：为带 data-stagger 的容器内的 .reveal 子项设置递增 delay
  if (!reduceMotion) {
    document.querySelectorAll('[data-stagger]').forEach(function (group) {
      var items = group.querySelectorAll(':scope > .reveal');
      items.forEach(function (el, i) {
        el.style.transitionDelay = Math.min(i * 0.07, 0.5) + 's';
      });
    });
  }

  // 2) 数字滚动计数
  function animateCount(el) {
    var target = parseFloat(el.getAttribute('data-count')) || 0;
    var suffix = el.getAttribute('data-suffix') || '';
    el.textContent = '0' + suffix;
    var dur = 1300;
    var start = null;
    function tick(now) {
      if (start === null) start = now;
      var t = Math.min(1, (now - start) / dur);
      var eased = 1 - Math.pow(1 - t, 3);
      el.textContent = Math.round(eased * target) + suffix;
      if (t < 1) requestAnimationFrame(tick);
      else el.textContent = target + suffix;
    }
    requestAnimationFrame(tick);
  }

  // 3) 打字机演示（双语对照流式输出）
  // 若所在区块仍带 .reveal（尚未 .in），先等其渐显完成再开始，避免文字在模糊态下被“打出来”显得乱
  function typeWriter(el) {
    var text = el.getAttribute('data-typetext') || '';
    if (reduceMotion) { el.textContent = text; return; }
    var host = el.closest ? el.closest('.reveal') : null;
    if (host && !host.classList.contains('in')) {
      var wait = setInterval(function () {
        if (host.classList.contains('in')) {
          clearInterval(wait);
          doType(el, text);
        }
      }, 120);
      return;
    }
    doType(el, text);
  }
  function doType(el, text) {
    el.classList.add('typing');
    el.textContent = '';
    var i = 0;
    (function step() {
      el.textContent = text.slice(0, i);
      if (i <= text.length) {
        i++;
        setTimeout(step, 36);
      } else {
        el.classList.remove('typing');
      }
    })();
  }

  // 用 IntersectionObserver 触发计数与打字机（进入视口才动，省资源）
  if ('IntersectionObserver' in window) {
    var io2 = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (!entry.isIntersecting) return;
        var el = entry.target;
        if (el.matches('.stat .num[data-count]')) animateCount(el);
        else if (el.matches('.tgt[data-typetext]')) typeWriter(el);
        io2.unobserve(el);
      });
    }, { threshold: 0.4 });
    document.querySelectorAll('.stat .num[data-count], .tgt[data-typetext]:not([data-loop])').forEach(function (el) {
      io2.observe(el);
    });
  } else {
    document.querySelectorAll('.stat .num[data-count]').forEach(function (el) {
      el.textContent = (parseFloat(el.getAttribute('data-count')) || 0) + (el.getAttribute('data-suffix') || '');
    });
    document.querySelectorAll('.tgt[data-typetext]').forEach(function (el) {
      el.textContent = el.getAttribute('data-typetext') || '';
    });
  }

  // 4) 回到顶部
  var toTop = document.querySelector('.to-top');
  if (toTop) {
    var t2 = false;
    function onScroll2() {
      if (t2) return;
      t2 = true;
      window.requestAnimationFrame(function () {
        toTop.classList.toggle('show', (window.scrollY || document.documentElement.scrollTop) > 600);
        t2 = false;
      });
    }
    window.addEventListener('scroll', onScroll2, { passive: true });
    onScroll2();
    toTop.addEventListener('click', function () {
      window.scrollTo({ top: 0, behavior: reduceMotion ? 'auto' : 'smooth' });
    });
  }
})();

// ---- Apple 风格增强：滚动视差 + 磁吸按钮 ----
(function () {
  'use strict';

  var reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var finePointer = window.matchMedia('(pointer: fine)').matches;

  // 1) 视差：带 data-parallax 的元素随滚动做轻微位移（外层，不影响内部浮动动画）
  var parallaxEls = Array.prototype.slice.call(document.querySelectorAll('[data-parallax]'));
  if (!reduceMotion && parallaxEls.length) {
    var pTick = false;
    function applyParallax() {
      if (pTick) return;
      pTick = true;
      window.requestAnimationFrame(function () {
        var y = window.scrollY || document.documentElement.scrollTop;
        parallaxEls.forEach(function (el) {
          var f = parseFloat(el.getAttribute('data-parallax')) || 0;
          el.style.transform = 'translate3d(0,' + (y * f).toFixed(2) + 'px,0)';
        });
        pTick = false;
      });
    }
    window.addEventListener('scroll', applyParallax, { passive: true });
    applyParallax();
  }

  // 2) 磁吸按钮：指针靠近时轻微吸附（仅精确指针 + 非减弱动效）
  if (!reduceMotion && finePointer) {
    var magnets = document.querySelectorAll('.btn-primary, .to-top');
    Array.prototype.forEach.call(magnets, function (el) {
      var scale = el.classList.contains('to-top') ? '' : ' scale(1.03)';
      var max = el.classList.contains('to-top') ? 5 : 8;
      el.addEventListener('pointermove', function (e) {
        var r = el.getBoundingClientRect();
        var mx = e.clientX - (r.left + r.width / 2);
        var my = e.clientY - (r.top + r.height / 2);
        var x = Math.max(-max, Math.min(max, mx * 0.25));
        var y = Math.max(-max, Math.min(max, my * 0.35));
        el.style.transform = 'translate(' + x.toFixed(1) + 'px,' + y.toFixed(1) + 'px)' + scale;
      });
      el.addEventListener('pointerleave', function () {
        el.style.transform = '';
      });
    });
  }
})();

// ---- 第二轮增强：卡片光标聚光 / 隐私目录高亮 / 文档目录高亮 ----
(function () {
  'use strict';

  var reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // 1) 卡片光标聚光：随指针更新 --mx/--my，由 CSS radial-gradient 呈现
  if (!reduceMotion) {
    var spotEls = document.querySelectorAll('.card, .usecase, .pillar, .step');
    Array.prototype.forEach.call(spotEls, function (el) {
      el.addEventListener('pointermove', function (e) {
        var r = el.getBoundingClientRect();
        el.style.setProperty('--mx', (((e.clientX - r.left) / r.width) * 100).toFixed(1) + '%');
        el.style.setProperty('--my', (((e.clientY - r.top) / r.height) * 100).toFixed(1) + '%');
      });
    });
  }

  // 2) 隐私页侧边目录滚动高亮
  var toc = document.querySelector('.doc-toc');
  if (toc) {
    var links = Array.prototype.slice.call(toc.querySelectorAll('a'));
    var map = {};
    links.forEach(function (a) {
      var id = (a.getAttribute('href') || '').replace('#', '');
      if (id) map[id] = a;
    });
    if ('IntersectionObserver' in window && Object.keys(map).length) {
      var spy = new IntersectionObserver(function (entries) {
        entries.forEach(function (entry) {
          if (entry.isIntersecting) {
            links.forEach(function (l) { l.classList.remove('active'); });
            if (map[entry.target.id]) map[entry.target.id].classList.add('active');
          }
        });
      }, { rootMargin: '-18% 0px -72% 0px', threshold: 0 });
      Object.keys(map).forEach(function (id) {
        var t = document.getElementById(id);
        if (t) spy.observe(t);
      });
    }
    links.forEach(function (a) {
      a.addEventListener('click', function (e) {
        var id = (a.getAttribute('href') || '').replace('#', '');
        var t = id && document.getElementById(id);
        if (t) {
          e.preventDefault();
          t.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'start' });
          if (history.replaceState) history.replaceState(null, '', '#' + id);
        }
      });
    });
  }

})();

// ---- 第三轮增强：卡片 3D 倾斜 + 双语对照实时切换 ----
(function () {
  'use strict';

  var reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var finePointer = window.matchMedia('(pointer: fine)').matches;

  // 1) 卡片 3D 倾斜：指针靠近时朝指针方向轻微抬起，premium 手感
  //    幅度克制（±5°），且内部文字不再 translateZ，旋转时不会分层重影/糊字。
  //    用 requestAnimationFrame 合并高频 pointermove，避免每次移动都触发 layout。
  if (!reduceMotion && finePointer) {
    var tilts = document.querySelectorAll('.tilt');
    Array.prototype.forEach.call(tilts, function (el) {
      var rafId = 0;
      el.addEventListener('pointermove', function (e) {
        if (rafId) return;
        rafId = window.requestAnimationFrame(function () {
          rafId = 0;
          var r = el.getBoundingClientRect();
          if (!r.width || !r.height) return;
          var px = (e.clientX - r.left) / r.width - 0.5;
          var py = (e.clientY - r.top) / r.height - 0.5;
          el.style.transform =
            'perspective(1000px) rotateX(' + (-py * 5).toFixed(2) + 'deg) rotateY(' +
            (px * 6).toFixed(2) + 'deg)';
        });
      });
      el.addEventListener('pointerleave', function () {
        if (rafId) { window.cancelAnimationFrame(rafId); rafId = 0; }
        el.style.transform = '';
      });
    });
  }

  // 2) 双语对照实时切换（原文 / 双语 / 仅译文）——对标沉浸式翻译的核心交互
  var bili = document.querySelector('[data-bili-toggle]');
  if (bili) {
    var btns = Array.prototype.slice.call(bili.querySelectorAll('button'));
    function setMode(mode, btn) {
      document.body.classList.remove('mode-both', 'mode-original', 'mode-translated');
      document.body.classList.add('mode-' + mode);
      btns.forEach(function (b) { b.classList.toggle('active', b === btn); });
    }
    btns.forEach(function (btn) {
      btn.addEventListener('click', function () {
        setMode(btn.getAttribute('data-mode') || 'both', btn);
      });
    });
    // 默认双语
    setMode('both', btns[0]);
  }
})();

// ---- 第四轮增强：展示区演示持续流式重播 + 引擎轮换（直观呈现翻译能力）----
(function () {
  'use strict';

  var reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var demo = document.querySelector('.showcase .demo');
  if (!demo) return;
  var tgts = Array.prototype.slice.call(demo.querySelectorAll('.tgt[data-typetext][data-loop]'));
  var engineEl = document.querySelector('.js-engine');
  if (!tgts.length) return;

  var engines = ['DeepSeek', 'Google 翻译', '智谱 GLM', '腾讯混元', '通义千问', 'Kimi'];
  var ei = 0;
  function setEngine() {
    if (engineEl) engineEl.textContent = engines[ei % engines.length];
  }

  function typeEl(el, text, done) {
    el.classList.add('typing', 'thinking');
    el.textContent = '';
    setTimeout(function () {
      el.classList.remove('thinking');
      var i = 0;
      (function step() {
        el.textContent = text.slice(0, i);
        if (i <= text.length) {
          i++;
          setTimeout(step, 34);
        } else {
          el.classList.remove('typing');
          if (done) done();
        }
      })();
    }, 440);
  }

  function cycle() {
    setEngine();
    ei++;
    var idx = 0;
    function next() {
      if (idx >= tgts.length) {
        // 一轮打完：保留已显示译文，停顿后从首行就地重打，
        // 窗口始终有可见译文，绝不出现整片空白被误读为「文字消失」
        setTimeout(cycle, 2200);
        return;
      }
      var t = tgts[idx++];
      typeEl(t, t.getAttribute('data-typetext'), next);
    }
    next();
  }

  if ('IntersectionObserver' in window) {
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) {
          io.disconnect();
          if (reduceMotion) {
            tgts.forEach(function (t) { t.textContent = t.getAttribute('data-typetext'); });
            if (engineEl) engineEl.textContent = engines[0];
          } else {
            cycle();
          }
        }
      });
    }, { threshold: 0.35 });
    io.observe(demo);
  } else {
    tgts.forEach(function (t) { t.textContent = t.getAttribute('data-typetext'); });
    if (engineEl) engineEl.textContent = engines[0];
  }
}());

/* 给 macOS 窗口的红黄绿按钮加语义化 tooltip（关闭/最小化/缩放），仅增强可访问性 */
(function () {
  'use strict';
  var labels = ['关闭', '最小化', '缩放'];
  document.querySelectorAll('.win-bar').forEach(function (bar) {
    var spans = bar.querySelectorAll('span');
    for (var i = 0; i < spans.length && i < 3; i++) {
      spans[i].title = labels[i];
    }
  });
}());
