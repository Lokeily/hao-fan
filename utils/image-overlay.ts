// 图片翻译结果浮层（从 entrypoints/content.ts 拆分）。
// v0.2.15：图片上的译文由 canvas 直接画出来——采样原区域底色抹掉原文、
// 按原位重排译文，读起来就是「图被翻译了」，而不是盖一层半透明色块。
// 侧边面板仍走与气泡/设置面板同一套 Liquid Glass JS 主题
// （applyGlassShell/applyThemeVars），深浅色由用户主题强制设置统一决定。
import type { ImageSegment } from './vision-parser.ts';
import { applyGlassShell, applyThemeVars, themeColors } from './content-ui.ts';
import { renderTranslatedImage, type ImageRenderMode } from './image-render.ts';
import { normalizeConfig, type AppConfig } from './config.ts';

export interface ImageOverlayResult {
  segments: ImageSegment[];
}

function findImage(srcUrl?: string): HTMLImageElement | null {
  if (!srcUrl) return null;
  const imgs = Array.from(document.images) as HTMLImageElement[];
  return imgs.find((im) => im.currentSrc === srcUrl || im.src === srcUrl) ?? null;
}

// 挂载图片翻译结果浮层，返回一次性清理函数（幂等，可重复调用）。
export function mountImageResultOverlay(
  srcUrl: string | undefined,
  result: ImageOverlayResult,
  cfg?: AppConfig,
): () => void {
  const img = findImage(srcUrl);
  const segments: ImageSegment[] = Array.isArray(result?.segments) ? result.segments : [];
  const validSegments = segments.filter(
    (s) =>
      s &&
      [s.x, s.y, s.w, s.h].every((n) => Number.isFinite(Number(n))) &&
      typeof (s.translation || s.text) === 'string',
  );
  const mode: ImageRenderMode = cfg?.imageRenderMode === 'bilingual' ? 'bilingual' : 'translation';

  // canvas 覆盖层：贴在图片上（fixed 定位 + 视口坐标），不进页面布局流，
  // 也不会像旧版 div 那样被站点的 flex/grid 挤变形。
  const canvas = document.createElement('canvas');
  canvas.className = 'ot-img-canvas';
  if (img) document.body.appendChild(canvas);

  const panel = document.createElement('div');
  panel.className = 'ot-img-panel';
  // JS 主题玻璃外壳：与气泡/设置面板同一套材质（半透明底 + 模糊 + 高光描边 + 弥散阴影）。
  const theme = themeColors();
  applyGlassShell(panel, theme, '18px');
  applyThemeVars(panel, theme);
  const head = document.createElement('div');
  head.className = 'ot-img-head';
  const title = document.createElement('span');
  title.textContent = '\u597D\u7FFB \u00B7 \u56FE\u7247\u7FFB\u8BD1'; // "好翻 · 图片翻译"
  const close = document.createElement('button');
  close.className = 'ot-img-close';
  close.textContent = '\u00D7'; // ×
  close.title = '\u5173\u95ED'; // "关闭"
  head.appendChild(title);
  head.appendChild(close);
  panel.appendChild(head);

  const toggleLabel = document.createElement('label');
  toggleLabel.className = 'ot-img-toggle';
  const toggle = document.createElement('input');
  toggle.type = 'checkbox';
  toggle.checked = true;
  toggleLabel.appendChild(toggle);
  toggleLabel.appendChild(document.createTextNode('\u5728\u56FE\u4E0A\u6807\u8BB0\u8BD1\u6587')); // " 在图上标记译文"
  panel.appendChild(toggleLabel);

  const hint = document.createElement('div');
  hint.className = 'ot-img-hint';
  hint.textContent = '\u60AC\u505C\u56FE\u4E0A\u6587\u5B57\u53EF\u67E5\u770B\u539F\u6587'; // "悬停图上文字可查看原文"
  panel.appendChild(hint);

  const list = document.createElement('div');
  list.className = 'ot-img-list';
  if (validSegments.length === 0) {
    list.innerHTML = '<div class="ot-img-empty">\u672A\u8BC6\u522B\u5230\u6587\u5B57</div>'; // "未识别到文字"
  } else {
    validSegments.forEach((s) => {
      const item = document.createElement('div');
      item.className = 'ot-img-item';
      const src = document.createElement('div');
      src.className = 'src';
      src.textContent = s.text;
      const dst = document.createElement('div');
      dst.className = 'dst';
      dst.textContent = s.translation;
      item.appendChild(src);
      item.appendChild(dst);
      list.appendChild(item);
    });
  }
  panel.appendChild(list);
  document.body.appendChild(panel);

  let cleaned = false;
  function cleanup() {
    if (cleaned) return;
    cleaned = true;
    panel.remove();
    canvas.remove();
    window.removeEventListener('scroll', reposition, true);
    window.removeEventListener('resize', reposition);
    resizeObserver?.disconnect();
  }
  close.addEventListener('click', cleanup);
  toggle.addEventListener('change', reposition);

  // 图片尺寸变化（懒加载完成、CSS 缩放、窗口变化）都要重画，
  // 否则译文框会停在旧尺寸上——旧版只在 scroll/resize 时重算，懒加载必然错位。
  const resizeObserver =
    typeof ResizeObserver !== 'undefined' && img
      ? new ResizeObserver(() => reposition())
      : null;
  if (img && resizeObserver) resizeObserver.observe(img);

  let painted = false;
  function reposition() {
    if (!img) {
      panel.style.right = '16px';
      panel.style.top = '16px';
      panel.style.left = 'auto';
      return;
    }
    const r = img.getBoundingClientRect();
    const panelW = panel.offsetWidth || 300;
    const panelH = panel.offsetHeight || 200;
    let left = r.right + 12;
    let top = r.top;
    if (left + panelW > window.innerWidth - 8) {
      left = r.left;
      top = r.bottom + 12;
    }
    if (top + panelH > window.innerHeight - 8) top = Math.max(8, window.innerHeight - panelH - 8);
    panel.style.left = Math.max(8, left) + 'px';
    panel.style.top = Math.max(8, top) + 'px';
    panel.style.right = 'auto';

    if (!img.complete || !img.naturalWidth) return;
    // canvas 按「图片显示尺寸」绘制，CSS 再拉伸到同样的 CSS 尺寸：
    // 既保证文字锐利（按 dpr 采样），又不改变页面布局。
    if (!painted) {
      renderTranslatedImage(canvas, img, validSegments, { mode });
      painted = true;
    }
    canvas.style.width = `${r.width}px`;
    canvas.style.height = `${r.height}px`;
    canvas.style.left = `${r.left + window.scrollX}px`;
    canvas.style.top = `${r.top + window.scrollY}px`;
    canvas.style.display = toggle.checked ? 'block' : 'none';
  }

  reposition();
  window.addEventListener('scroll', reposition, true);
  window.addEventListener('resize', reposition);
  return cleanup;
}

// 供内容脚本调用前统一取一次配置（含用户选择的渲染方式）。
export function currentImageRenderMode(cfg: AppConfig): ImageRenderMode {
  return normalizeConfig(cfg).imageRenderMode === 'bilingual' ? 'bilingual' : 'translation';
}
