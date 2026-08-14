import { buildConfigForm } from '../../utils/ui.ts';
import { browser } from 'wxt/browser';
import '../../styles/options.css';

// 作为 HTML 页面的脚本来加载（非 WXT 入口），仅在真实扩展页运行时执行。
if (typeof document !== 'undefined' && typeof location !== 'undefined') {
  const logoUrl = browser.runtime.getURL('/icon-128.png');
  document.body.innerHTML = `
    <main class="ot-page">
      <header class="ot-page-head">
        <div class="ot-page-brandline">
          <span class="ot-brand-mark" aria-hidden="true"><img src="${logoUrl}" alt="" /></span>
          <div>
            <p class="ot-page-brand">好翻</p>
            <h1>翻译设置</h1>
          </div>
        </div>
      </header>
      <div id="ot-form-mount"></div>
    </main>
  `;
  buildConfigForm(document.getElementById('ot-form-mount') as HTMLElement, false);
}
