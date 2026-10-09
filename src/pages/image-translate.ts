import { browser } from 'wxt/browser';
import { deleteImageJob, getImageJob } from '../../utils/image-job-store.ts';
import { downloadCanvas, renderTranslatedImage, type ImageRenderMode } from '../../utils/image-render.ts';
import { normalizeConfig } from '../../utils/config.ts';
import { configItem } from '../../utils/storage.ts';
import type { ImageSegment } from '../../utils/vision-parser.ts';
import '../../styles/image-translate.css';

if (typeof document !== 'undefined' && typeof location !== 'undefined') {
  const job = new URLSearchParams(location.search).get('job');
  const root = document.body;
  const logoUrl = browser.runtime.getURL('/icon-128.png');

  function renderState(title: string, detail: string) {
    root.innerHTML = `
      <main class="ot-image-state" role="status">
        <span class="ot-brand-mark" aria-hidden="true"><img src="${logoUrl}" alt="" /></span>
        <h1></h1>
        <p></p>
      </main>
    `;
    root.querySelector('h1')!.textContent = title;
    root.querySelector('p')!.textContent = detail;
  }

  if (!job) {
    renderState('缺少图片翻译任务', '请从扩展弹窗重新选择图片。');
  } else {
    root.innerHTML = `
      <header class="ot-image-head">
        <div class="ot-image-brand">
          <span class="ot-brand-mark" aria-hidden="true"><img src="${logoUrl}" alt="" /></span>
          <div>
            <strong>好翻</strong>
            <h1>图片翻译</h1>
          </div>
        </div>
        <div class="ot-image-tools" id="result-tools" hidden>
          <span id="result-count"></span>
          <label class="ot-image-seg-toggle"><input type="checkbox" id="show-orig" checked /> 显示图片上的译文</label>
          <label class="ot-image-mode">渲染
            <select id="render-mode">
              <option value="translation">仅译文</option>
              <option value="bilingual">原文 + 译文</option>
            </select>
          </label>
          <button type="button" id="save-image" class="ot-image-save">保存图片</button>
          <button type="button" id="close-job" class="ot-image-close-job" title="清理该任务占用的存储">×</button>
        </div>
      </header>
      <main class="ot-image-layout">
        <section class="ot-image-stage" id="stage" aria-label="图片翻译预览">
          <div class="ot-image-loading" role="status">正在读取翻译结果…</div>
        </section>
        <aside class="ot-image-list-shell" id="list-shell" hidden>
          <div class="ot-image-list-head">
            <h2>译文列表</h2>
            <span id="list-count"></span>
          </div>
          <div class="ot-image-list" id="list"></div>
        </aside>
      </main>
    `;

    try {
      // v0.2.15：改为「只读不消费」，刷新页面 / 切换渲染方式 / 导出图片
      // 都能重来一次；任务由 TTL（24h）与「×」按钮清理。
      const result = (await getImageJob(job)) ?? null;
      if (!result || typeof result.image !== 'string') {
        renderState('翻译结果已失效', '结果可能已被清理或浏览器已清空存储，请重新翻译图片。');
      } else {
        const segments: ImageSegment[] = Array.isArray(result.segments) ? result.segments : [];
        const stage = document.getElementById('stage') as HTMLElement;
        const list = document.getElementById('list') as HTMLElement;
        const tools = document.getElementById('result-tools') as HTMLElement;
        const listShell = document.getElementById('list-shell') as HTMLElement;
        const toggle = document.getElementById('show-orig') as HTMLInputElement;
        const modeSelect = document.getElementById('render-mode') as HTMLSelectElement;
        const saveButton = document.getElementById('save-image') as HTMLButtonElement;
        const closeButton = document.getElementById('close-job') as HTMLButtonElement;

        tools.hidden = false;
        listShell.hidden = false;

        // 模型返回的区域结构不受本页控制：坐标缺失/非法的段会渲染成 NaN%
        // （样式被浏览器丢弃，色块错位到左上角），文案缺省会把字面量 "undefined"
        // 渲染出来。渲染前过滤 + 空值兜底。
        const validSegments = segments.filter(
          (s: ImageSegment) =>
            s &&
            [s.x, s.y, s.w, s.h].every((n: number) => Number.isFinite(Number(n))) &&
            typeof (s.translation || s.text) === 'string',
        );

        stage.replaceChildren();
        const canvasBox = document.createElement('div');
        canvasBox.className = 'ot-image-canvas';
        const img = document.createElement('img');
        img.src = result.image;
        img.alt = '图片翻译预览';
        // 渲染层 canvas（真·canvas：擦掉原文 + 按原位重排译文），
        // <img> 保留在底层作为尺寸基准与无 JS 时的可读兜底。
        const canvas = document.createElement('canvas');
        canvas.className = 'ot-image-overlay';
        canvasBox.append(img, canvas);
        stage.appendChild(canvasBox);

        const cfg = normalizeConfig(await configItem.getValue());
        if (cfg.imageRenderMode === 'bilingual') modeSelect.value = 'bilingual';

        let painted = false;
        const paint = () => {
          if (!img.complete || !img.naturalWidth) return;
          renderTranslatedImage(canvas, img, validSegments, {
            mode: modeSelect.value as ImageRenderMode,
          });
          painted = true;
        };
        img.addEventListener('load', paint);
        img.addEventListener('error', () => {
          stage.innerHTML = '<div class="ot-image-loading is-error">图片加载失败，请重新翻译。</div>';
        });
        paint();

        // 透明命中层：不画字（字在 canvas 上），只用来悬停查看原文。
        for (const segment of validSegments) {
          const box = document.createElement('div');
          box.className = 'ot-image-segment';
          box.style.left = `${Number(segment.x) * 100}%`;
          box.style.top = `${Number(segment.y) * 100}%`;
          box.style.width = `${Math.max(0, Math.min(1, Number(segment.w))) * 100}%`;
          box.style.height = `${Math.max(0, Math.min(1, Number(segment.h))) * 100}%`;
          box.title = String(segment.text || '');
          canvasBox.appendChild(box);

          const item = document.createElement('article');
          item.className = 'ot-image-item';
          const source = document.createElement('div');
          source.className = 'ot-image-source';
          source.textContent = String(segment.text ?? '');
          const translation = document.createElement('div');
          translation.className = 'ot-image-translation';
          translation.textContent = String(segment.translation ?? '');
          item.append(source, translation);
          list.appendChild(item);
        }

        if (validSegments.length === 0) {
          list.innerHTML = '<div class="ot-image-list-empty">未识别到可翻译文字</div>';
        }
        document.getElementById('result-count')!.textContent = `${validSegments.length} 处文本`;
        document.getElementById('list-count')!.textContent = `${validSegments.length} 条`;

        const syncOverlay = () => {
          canvas.classList.toggle('is-hidden', !toggle.checked);
          canvasBox
            .querySelectorAll('.ot-image-segment')
            .forEach((element) => ((element as HTMLElement).hidden = !toggle.checked));
        };
        toggle.addEventListener('change', syncOverlay);
        modeSelect.addEventListener('change', () => {
          if (!painted && !img.complete) return;
          paint();
        });
        saveButton.addEventListener('click', async () => {
          saveButton.disabled = true;
          const original = saveButton.textContent;
          saveButton.textContent = '导出中…';
          try {
            if (!img.complete || !img.naturalWidth) {
              await new Promise<void>((resolve) => {
                img.addEventListener('load', () => resolve(), { once: true });
                img.addEventListener('error', () => resolve(), { once: true });
              });
            }
            // 关闭状态导出也要带上译文：临时渲染一份完整图再导出。
            const snapshot = document.createElement('canvas');
            if (!toggle.checked || !painted) {
              renderTranslatedImage(snapshot, img, validSegments, {
                mode: modeSelect.value as ImageRenderMode,
              });
            } else {
              snapshot.width = canvas.width;
              snapshot.height = canvas.height;
              snapshot.getContext('2d')?.drawImage(canvas, 0, 0);
            }
            await downloadCanvas(snapshot, `haofan-image-${Date.now()}.png`);
          } catch {
            saveButton.textContent = '导出失败';
            setTimeout(() => (saveButton.textContent = original), 1600);
          } finally {
            saveButton.disabled = false;
          }
        });
        closeButton.addEventListener('click', () => {
          void deleteImageJob(job);
          closeButton.disabled = true;
        });
      }
    } catch {
      renderState('无法读取翻译结果', '扩展存储暂不可用，请重新发起图片翻译。');
    }
  }
}
