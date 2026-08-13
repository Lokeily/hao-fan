import { browser } from 'wxt/browser';
import { takeImageJob } from '../../utils/image-job-store';
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
          <label><input type="checkbox" id="show-orig" checked /> 显示图片上的译文</label>
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
      // 图片任务已从 storage.local 迁移到 IndexedDB（见 utils/image-job-store.ts），
      // 读取即消费，避免大图长期占用存储。
      const result = (await takeImageJob(job)) ?? null;
      if (!result || typeof result.image !== 'string') {
        renderState('翻译结果已失效', '结果可能已被读取或浏览器已清理存储，请重新翻译图片。');
      } else {
        const segments = Array.isArray(result.segments) ? result.segments : [];
        const stage = document.getElementById('stage') as HTMLElement;
        const list = document.getElementById('list') as HTMLElement;
        const tools = document.getElementById('result-tools') as HTMLElement;
        const listShell = document.getElementById('list-shell') as HTMLElement;
        const toggle = document.getElementById('show-orig') as HTMLInputElement;

        tools.hidden = false;
        listShell.hidden = false;
        document.getElementById('result-count')!.textContent = `${segments.length} 处文本`;
        document.getElementById('list-count')!.textContent = `${segments.length} 条`;

        stage.replaceChildren();
        const canvas = document.createElement('div');
        canvas.className = 'ot-image-canvas';
        const img = document.createElement('img');
        img.src = result.image;
        img.alt = '图片翻译预览';
        img.addEventListener(
          'error',
          () => {
            stage.innerHTML =
              '<div class="ot-image-loading is-error">图片加载失败，请重新翻译。</div>';
          },
          { once: true },
        );
        canvas.appendChild(img);
        stage.appendChild(canvas);

        for (const segment of segments) {
          const box = document.createElement('div');
          box.className = 'ot-image-segment';
          box.style.left = `${segment.x * 100}%`;
          box.style.top = `${segment.y * 100}%`;
          box.style.width = `${segment.w * 100}%`;
          box.style.height = `${segment.h * 100}%`;
          box.textContent = segment.translation || segment.text;
          canvas.appendChild(box);

          const item = document.createElement('article');
          item.className = 'ot-image-item';
          const source = document.createElement('div');
          source.className = 'ot-image-source';
          source.textContent = segment.text;
          const translation = document.createElement('div');
          translation.className = 'ot-image-translation';
          translation.textContent = segment.translation;
          item.append(source, translation);
          list.appendChild(item);
        }

        if (segments.length === 0) {
          list.innerHTML = '<div class="ot-image-list-empty">未识别到可翻译文字</div>';
        }

        toggle.addEventListener('change', () => {
          canvas.querySelectorAll('.ot-image-segment').forEach((element) => {
            (element as HTMLElement).hidden = !toggle.checked;
          });
        });
      }
    } catch {
      renderState('无法读取翻译结果', '扩展存储暂不可用，请重新发起图片翻译。');
    }
  }
}
