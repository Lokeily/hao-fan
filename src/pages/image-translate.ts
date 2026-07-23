import { storage } from 'wxt/utils/storage';
import type { ImageResult } from '../../utils/vision';

if (typeof document !== 'undefined' && typeof location !== 'undefined') {
  const job = new URLSearchParams(location.search).get('job');
  const root = document.body;

  if (!job) {
    root.innerHTML = '<div class="empty">缺少任务参数。</div>';
  } else {
    root.innerHTML = `
      <header>
        <h1>好翻 · 图片翻译</h1>
        <label><input type="checkbox" id="show-orig" checked /> 叠加显示译文</label>
      </header>
      <main>
        <div class="stage" id="stage"><div class="empty">加载中…</div></div>
        <div class="list" id="list"></div>
      </main>
    `;

    const result = (await storage.getItem<ImageResult>(`local:imageJob:${job}`)) ?? null;
    // 读取后即删除，避免 base64 大图长期堆积撑爆 storage.local（P1-3）
    await storage.removeItem(`local:imageJob:${job}`).catch(() => {});
    if (!result) {
      root.innerHTML = '<div class="empty">未找到翻译结果，请重试。</div>';
    } else {
      const stage = document.getElementById('stage') as HTMLElement;
      const list = document.getElementById('list') as HTMLElement;
      const toggle = document.getElementById('show-orig') as HTMLInputElement;

      stage.innerHTML = '';
      const canvas = document.createElement('div');
      canvas.className = 'canvas';
      const img = document.createElement('img');
      img.src = result.image;
      canvas.appendChild(img);
      stage.appendChild(canvas);

      result.segments.forEach((s) => {
        const box = document.createElement('div');
        box.className = 'seg';
        box.style.left = `${s.x * 100}%`;
        box.style.top = `${s.y * 100}%`;
        box.style.width = `${s.w * 100}%`;
        box.style.height = `${s.h * 100}%`;
        box.textContent = s.translation || s.text;
        canvas.appendChild(box);

        const item = document.createElement('div');
        item.className = 'item';
        const source = document.createElement('div');
        source.className = 'src';
        source.textContent = s.text;
        const translation = document.createElement('div');
        translation.className = 'dst';
        translation.textContent = s.translation;
        item.append(source, translation);
        list.appendChild(item);
      });

      toggle.addEventListener('change', () => {
        canvas.querySelectorAll('.seg').forEach((el) => {
          (el as HTMLElement).classList.toggle('hide', !toggle.checked);
        });
      });
    }
  }
}
