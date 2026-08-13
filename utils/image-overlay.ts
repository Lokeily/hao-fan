// 图片翻译结果浮层（从 entrypoints/content.ts 拆分）。
// 在页面图片旁叠加译文标记框与结果面板；返回清理函数，由调用方管理生命周期。
import type { ImageSegment } from './vision-parser';

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
): () => void {
  const img = findImage(srcUrl);
  const segments: ImageSegment[] = Array.isArray(result?.segments) ? result.segments : [];

  const boxes: HTMLElement[] = [];
  if (img) {
    segments.forEach((s) => {
      const box = document.createElement('div');
      box.className = 'ot-img-seg';
      box.textContent = s.translation || s.text;
      document.body.appendChild(box);
      boxes.push(box);
    });
  }

  const panel = document.createElement('div');
  panel.className = 'ot-img-panel';
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

  const list = document.createElement('div');
  list.className = 'ot-img-list';
  if (segments.length === 0) {
    list.innerHTML = '<div class="ot-img-empty">\u672A\u8BC6\u522B\u5230\u6587\u5B57</div>'; // "未识别到文字"
  } else {
    segments.forEach((s) => {
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
    boxes.forEach((b) => b.remove());
    window.removeEventListener('scroll', reposition, true);
    window.removeEventListener('resize', reposition);
  }
  close.addEventListener('click', cleanup);
  toggle.addEventListener('change', () => {
    boxes.forEach((b) => (b.style.display = toggle.checked ? '' : 'none'));
  });

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

    const iw = r.width;
    const ih = r.height;
    boxes.forEach((b, i) => {
      const s = segments[i];
      if (!s) return;
      b.style.left = r.left + s.x * iw + 'px';
      b.style.top = r.top + s.y * ih + 'px';
      b.style.width = s.w * iw + 'px';
      b.style.height = s.h * ih + 'px';
    });
  }

  reposition();
  window.addEventListener('scroll', reposition, true);
  window.addEventListener('resize', reposition);
  return cleanup;
}
