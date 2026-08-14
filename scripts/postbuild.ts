// 构建后处理（通过 wxt.config.ts 的 build:done hook 调用，保证 wxt build 与 wxt zip 都生效）：
// 1) 页面资源改相对路径并移除 crossorigin——部分浏览器环境会拦截扩展页面
//    上带 crossorigin 的 link/script，导致 CSS/JS 加载失败、页面裸渲染。
// 2) 把页面 CSS 直接内联为 <style>——彻底消除样式加载失败的可能
//    （"大片空白 + 一小列文字"即 CSS 未加载的裸渲染形态）。
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const HTML_NAMES = ['popup.html', 'options.html', 'image-translate.html'];

export async function runPostbuild(outputDir = resolve('.output')): Promise<void> {
  for (const target of await readdir(outputDir)) {
    const dir = join(outputDir, target);
    for (const name of HTML_NAMES) {
      const file = join(dir, name);
      let content: string;
      try {
        content = await readFile(file, 'utf8');
      } catch {
        continue; // 该目标目录无此页面
      }
      let changed = false;

      // 内联样式表：<link rel="stylesheet" href="assets/x.css"> → <style>...</style>
      const linkRe = /<link rel="stylesheet"[^>]*href="([^"]+)"[^>]*>/g;
      let m: RegExpExecArray | null;
      while ((m = linkRe.exec(content))) {
        const href = m[1].replace(/^\//, '');
        try {
          const css = await readFile(join(dir, href), 'utf8');
          content = content.replace(m[0], `<style>\n${css}\n</style>`);
          changed = true;
        } catch {
          /* CSS 缺失时保留 link 并修正为相对路径 */
        }
      }

      // 剩余资源引用：绝对路径 → 相对路径；移除 crossorigin
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
    }
  }
}
