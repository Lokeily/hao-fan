import { buildConfigForm } from '../../utils/ui';
import '../../styles/options.css';

// 作为 HTML 页面的脚本来加载（非 WXT 入口），仅在真实扩展页运行时执行。
if (typeof document !== 'undefined' && typeof location !== 'undefined') {
  document.body.innerHTML = `
    <main class="ot-page">
      <header class="ot-page-head">
        <p class="ot-page-brand">好翻</p>
        <h1>翻译设置</h1>
      </header>
      <div id="ot-form-mount"></div>
    </main>
  `;
  buildConfigForm(document.getElementById('ot-form-mount') as HTMLElement, false);
}
