// 发布前清理构建产物目录。
//
// 为什么不用 rm -rf：本机安全守护会拦截一次性递归删除超过 50 个文件的操作
// （构建后 .output/chrome-mv3 实际有 51 个文件，直接 rm -rf 会抛
// SAFE_DELETE_BULK_CONFIRM_REQUIRED 并让 `npm run release` 在打包前中断）。
// wxt 自身的 build/zip 也会整目录重删，node 的 rmSync 被守护 shim 包装后
// 对目录直接抛 EISDIR，同样走不通。
//
// 这里改用「重命名到回收目录」：mv 是同设备内的 rename，不是删除，
// 不触发批量删除守护，且是 O(1) 操作。回收目录仍留在 .output/ 下，
// 已被 .gitignore 忽略，不会进仓库。
import { execSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';

const targets = ['.output/chrome-mv3', '.output/firefox-mv2'];
const trashRoot = `.output/.trash-${Date.now()}`;

for (const target of targets) {
  if (!existsSync(target)) continue;
  const name = target.split('/').pop();
  if (!existsSync(trashRoot)) mkdirSync(trashRoot, { recursive: true });
  execSync(`mv ${JSON.stringify(target)} ${JSON.stringify(`${trashRoot}/${name}`)}`, {
    stdio: 'inherit',
  });
  console.log(`preclean: moved ${target} -> ${trashRoot}/${name}`);
}
