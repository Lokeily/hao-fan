// 生成 UUID v4 风格的随机 ID。
//
// 注意：不要使用 `crypto.randomUUID()`！它在「非安全上下文」（如 http:// 站点）
// 的 content script 中是 undefined，调用会抛 "crypto.randomUUID is not a function"，
// 直接导致整页 / 划词翻译在 http 页面崩溃。
// `crypto.getRandomValues` 不依赖安全上下文，在所有页面（含 http）都可用，故用它兜底。

export function randomId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  // 设置版本(4)与变体位(RFC 4122)
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0'));
  return (
    hex.slice(0, 4).join('') +
    '-' +
    hex.slice(4, 6).join('') +
    '-' +
    hex.slice(6, 8).join('') +
    '-' +
    hex.slice(8, 10).join('') +
    '-' +
    hex.slice(10, 16).join('')
  );
}
