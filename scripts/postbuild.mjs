// 构建后处理：扩展页面资源改为相对路径并移除 crossorigin。
// 部分 Chrome 环境会拦截扩展页面上带 crossorigin 的 link/script，
// 导致 CSS 加载失败后页面裸渲染（"大片空白 + 一小列文字"）。
// 相对路径（assets/...、chunks/...）对 chrome-extension:// 解析最稳。
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const outputDir = resolve('.output');
const htmlNames = new Set(['popup.html', 'options.html', 'image-translate.html']);

for (const target of await readdir(outputDir)) {
  const dir = join(outputDir, target);
  for (const name of htmlNames) {
    const file = join(dir, name);
    try {
      let content = await readFile(file, 'utf8');
      let changed = false;
      const next = content
        .replace(/href="\/assets\//g, 'href="assets/')
        .replace(/src="\/chunks\//g, 'src="chunks/')
        .replace(/href="\/chunks\//g, 'href="chunks/')
        .replace(/\s+crossorigin(?=[\s>])/g, '');
      if (next !== content) {
        content = next;
        changed = true;
      }
      if (changed) {
        await writeFile(file, content, 'utf8');
        console.log(`postbuild: fixed ${join(target, name)}`);
      }
    } catch {
      /* 目标目录无该页面时跳过 */
    }
  }
}
