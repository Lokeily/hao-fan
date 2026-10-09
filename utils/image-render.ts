// 图片译文渲染引擎：把 OCR 得到的文字区域「擦掉原文 → 按原位置重排译文」，
// 让译文真正长在图上，而不是浮一层半透明色块。
//
// 三段式：
//   1) 采样区域背景色 → 用同色铺底抹掉原文（比粗暴盖白块干净得多）；
//   2) 按区域尺寸自适应字号：从大到小试，直到折行后的总高度塞得进原框；
//   3) 按背景明暗自动选黑/白字，保证在任何海报底图上都读得清。
//
// 所有排版相关的纯函数（wrapLines / fitFontSize / textColorOn）都接收
// measure 回调而不直接依赖 canvas，既能在页面/内容脚本复用，也能在
// 无 DOM 的 node 单测里直接验证（见 tests/core.test.mjs）。

import type { ImageSegment } from './vision-parser.ts';

export type ImageRenderMode = 'translation' | 'bilingual';

export interface RenderOptions {
  mode?: ImageRenderMode;
  /** 字号上限（px，按原图像素计）。默认取区域高度的 0.9 倍 */
  maxFontSize?: number;
  minFontSize?: number;
  lineHeight?: number;
  fontFamily?: string;
  /** 双语模式里原文行的相对字号 */
  sourceScale?: number;
}

const CJK_RE = /[\u3000-\u9fff\u3400-\u4dbf\uf900-\ufaff\uac00-\ud7af\uff00-\uffef]/;
const WORD_RE = new RegExp(`(${CJK_RE.source})|([^\\s${CJK_RE.source}]+\\s*)|(\\s+)`, 'g');

/** 把一段文本切成可断行的单元：CJK 逐字可断，拉丁词整词不断，空白保留。 */
export function tokenize(text: string): string[] {
  const tokens: string[] = [];
  for (const match of String(text).matchAll(WORD_RE)) {
    tokens.push(match[0]);
  }
  return tokens.length > 0 ? tokens : [String(text)];
}

/**
 * 按给定宽度折行。measure 返回文本在该字号下的像素宽度。
 * 单个超长不可断单元（一长串无空格英文/URL）会退化为逐字符硬断，
 * 保证任何文本都不会溢出区域。
 */
export function wrapLines(
  text: string,
  measure: (s: string) => number,
  maxWidth: number,
): string[] {
  if (maxWidth <= 0) return String(text).split(/\r?\n/);
  const lines: string[] = [];
  const paragraphs = String(text).split(/\r?\n/);
  for (const paragraph of paragraphs) {
    if (!paragraph.trim()) {
      lines.push('');
      continue;
    }
    let line = '';
    const pushLine = () => {
      lines.push(line.trimEnd());
      line = '';
    };
    for (const token of tokenize(paragraph)) {
      const piece = token.replace(/\s+$/, '');
      if (!piece) continue;
      // 单个单元就超宽：逐字符硬断，避免一行永远放不下
      if (measure(piece) > maxWidth && piece.length > 1) {
        for (const char of piece) {
          if (line && measure(line + char) > maxWidth) pushLine();
          line += char;
        }
        if (/\s$/.test(token) && line) line += ' ';
        continue;
      }
      const candidate = line ? line + piece : piece;
      if (measure(candidate) <= maxWidth || !line.trim()) {
        line = candidate;
        if (/\s$/.test(token)) line += ' ';
        continue;
      }
      pushLine();
      line = piece + (/\s$/.test(token) ? ' ' : '');
    }
    if (line.trim()) pushLine();
  }
  return lines.length > 0 ? lines : [''];
}

export interface FittedText {
  size: number;
  lines: string[];
}

/**
 * 自适应字号：从大到小试，直到折行后的总高度塞得进区域高度；
 * 试不到就停在最小字号（宁可挤一点也不把译文丢掉）。
 */
export function fitFontSize(
  text: string,
  measureAt: (text: string, size: number) => number,
  boxWidth: number,
  boxHeight: number,
  options: RenderOptions = {},
): FittedText {
  const lineHeight = options.lineHeight ?? 1.15;
  const min = Math.max(6, Math.round(options.minFontSize ?? 8));
  const max = Math.max(min, Math.round(options.maxFontSize ?? Math.max(min, boxHeight * 0.9)));
  let size = max;
  let lines = wrapLines(text, (s) => measureAt(s, size), Math.max(1, boxWidth));
  while (size > min && lines.length * size * lineHeight > Math.max(1, boxHeight)) {
    size -= 1;
    lines = wrapLines(text, (s) => measureAt(s, size), Math.max(1, boxWidth));
  }
  return { size, lines };
}

/** 按背景明暗选文字颜色：暗底白字、亮底黑字。 */
export function textColorOn(r: number, g: number, b: number): string {
  // 感知亮度（ITU-R BT.601 近似）：比简单平均更贴近人眼对绿/蓝的敏感度。
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return luminance < 0.55 ? '#ffffff' : '#111111';
}

/** 取一块像素区域的平均色（用于铺底抹字）。返回 null 表示画布被跨域污染。 */
export function sampleAverageColor(
  data: Uint8ClampedArray,
  _width: number,
  _height: number,
): { r: number; g: number; b: number } | null {
  if (!data || data.length < 4) return null;
  let r = 0;
  let g = 0;
  let b = 0;
  const pixels = Math.floor(data.length / 4);
  const step = Math.max(4, Math.floor(pixels / 400) * 4); // 最多采样 ~400 点，够准也够快
  let count = 0;
  for (let i = 0; i + 3 < data.length; i += step) {
    r += data[i];
    g += data[i + 1];
    b += data[i + 2];
    count++;
  }
  if (count === 0) return null;
  return { r: Math.round(r / count), g: Math.round(g / count), b: Math.round(b / count) };
}

const DEFAULT_FONT =
  '"PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Noto Sans SC", system-ui, sans-serif';

interface DrawSegmentContext {
  ctx: CanvasRenderingContext2D;
  canvasWidth: number;
  canvasHeight: number;
}

function drawSegmentText(
  { ctx, canvasWidth, canvasHeight }: DrawSegmentContext,
  segment: ImageSegment,
  translation: string,
  options: RenderOptions,
  bg: { r: number; g: number; b: number },
): void {
  const x = Math.max(0, segment.x * canvasWidth);
  const y = Math.max(0, segment.y * canvasHeight);
  const width = Math.max(2, Math.min(segment.w, 1 - segment.x) * canvasWidth);
  const height = Math.max(2, Math.min(segment.h, 1 - segment.y) * canvasHeight);

  // ① 抹掉原文：用采样到的背景色铺底，四周外扩盖住文字描边残影与
  // OCR 略窄于实际文字的框误差（v0.2.15 实测「worldwide」尾部残字漏出）。
  const pad = Math.max(2, Math.round(Math.min(width, height) * 0.1));
  ctx.fillStyle = `rgb(${bg.r}, ${bg.g}, ${bg.b})`;
  ctx.fillRect(
    Math.max(0, x - pad),
    Math.max(0, y - pad),
    Math.min(canvasWidth - x + pad, width + pad * 2),
    Math.min(canvasHeight - y + pad, height + pad * 2),
  );

  // ② 排译文：双语模式先画一行小字原文，再画译文。
  const fontFamily = options.fontFamily || DEFAULT_FONT;
  const measureAt = (text: string, size: number) => {
    ctx.font = `${size}px ${fontFamily}`;
    return ctx.measureText(text).width;
  };
  const innerWidth = width * 0.94;
  const mode: ImageRenderMode = options.mode ?? 'translation';
  const sourceScale = options.sourceScale ?? 0.62;

  const blocks: { text: string; size: number; lines: string[]; color: string; alpha: number }[] =
    [];
  if (mode === 'bilingual' && segment.text) {
    // 原文行只在双语模式出现：占 1/3 高度、字号按 sourceScale 压小、半透明，
    // 视觉上退为「注解」，不与译文抢注意力。
    const sourceBoxHeight = height * (1 - sourceScale) * 0.8;
    const sourceFit = fitFontSize(segment.text, measureAt, innerWidth, sourceBoxHeight, {
      ...options,
      maxFontSize: Math.max(8, sourceBoxHeight * 0.9),
    });
    blocks.push({
      text: segment.text,
      size: sourceFit.size,
      lines: sourceFit.lines,
      color: textColorOn(bg.r, bg.g, bg.b),
      alpha: 0.55,
    });
  }

  const body = translation || segment.translation || segment.text;
  if (!body) return;
  const bodyBoxHeight = mode === 'bilingual' ? height * sourceScale : height * 0.92;
  const bodyFit = fitFontSize(body, measureAt, innerWidth, bodyBoxHeight, {
    ...options,
    maxFontSize: Math.max(options.minFontSize ?? 8, Math.min(options.maxFontSize ?? bodyBoxHeight, bodyBoxHeight * 0.92)),
  });
  blocks.push({
    text: body,
    size: bodyFit.size,
    lines: bodyFit.lines,
    color: textColorOn(bg.r, bg.g, bg.b),
    alpha: 1,
  });

  // ③ 垂直居中整体块，水平居中每行（海报/截图里的文字多为居中排版）。
  const lineHeightFactor = options.lineHeight ?? 1.15;
  const totalHeight = blocks.reduce(
    (sum, block) => sum + block.lines.length * block.size * lineHeightFactor,
    0,
  );
  let cursorY = y + (height - totalHeight) / 2;
  const centerX = x + width / 2;

  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (const block of blocks) {
    ctx.globalAlpha = block.alpha;
    ctx.fillStyle = block.color;
    ctx.font = `${block.size}px ${fontFamily}`;
    const lineStep = block.size * lineHeightFactor;
    for (const line of block.lines) {
      if (!line) {
        cursorY += lineStep;
        continue;
      }
      ctx.fillText(line, centerX, cursorY + lineStep / 2);
      cursorY += lineStep;
    }
    ctx.globalAlpha = 1;
  }
}

export interface RenderedImage {
  width: number;
  height: number;
}

/**
 * 把原图 + 译文区域渲染进 canvas。跨域图片会让 getImageData 抛错
 * （画布被污染），此时退化为白色铺底 + 黑字，渲染照常进行。
 */
export function renderTranslatedImage(
  canvas: HTMLCanvasElement,
  image: HTMLImageElement,
  segments: ImageSegment[],
  options: RenderOptions = {},
): RenderedImage {
  const naturalWidth = image.naturalWidth || image.width;
  const naturalHeight = image.naturalHeight || image.height;
  // 超长边压到 2400px：canvas 过大在部分浏览器会直接分配失败，
  // 而渲染是等比重采样，视觉上无损（显示时再按容器缩放）。
  const scale = Math.min(1, 2400 / Math.max(naturalWidth || 1, naturalHeight || 1));
  const width = Math.max(1, Math.round((naturalWidth || 1) * scale));
  const height = Math.max(1, Math.round((naturalHeight || 1) * scale));
  canvas.width = width;
  canvas.height = height;

  const ctx = canvas.getContext('2d');
  if (!ctx) return { width, height };
  ctx.clearRect(0, 0, width, height);
  ctx.drawImage(image, 0, 0, width, height);

  let tainted = false;
  const readable = (x: number, y: number, w: number, h: number) => {
    if (tainted) return null;
    try {
      return ctx.getImageData(Math.round(x), Math.round(y), Math.max(1, Math.round(w)), Math.max(1, Math.round(h)));
    } catch {
      tainted = true;
      return null;
    }
  };
  // 背景采样只取文字区「上下边缘条带」：中间是原文像素（白字会拉偏平均色，
  // 把擦除块染成脏黑色），边缘条带几乎全是纯背景，铺底色才贴合原图。
  const sampleBackground = (bx: number, by: number, bw: number, bh: number) => {
    const strip = Math.max(2, Math.round(bh * 0.18));
    const samples = [
      readable(bx, by, bw, Math.min(strip, bh)),
      readable(bx, by + bh - strip, bw, Math.min(strip, bh)),
    ].filter((imageData): imageData is ImageData => imageData !== null);
    if (samples.length === 0) return null;
    const merged = new Uint8ClampedArray(samples.reduce((sum, s) => sum + s.data.length, 0));
    let offset = 0;
    for (const s of samples) {
      merged.set(s.data, offset);
      offset += s.data.length;
    }
    return sampleAverageColor(merged, merged.length / 4, 1);
  };

  const context: DrawSegmentContext = { ctx, canvasWidth: width, canvasHeight: height };
  for (const segment of segments) {
    if (!segment) continue;
    const bx = Math.max(0, Math.min(1, segment.x)) * width;
    const by = Math.max(0, Math.min(1, segment.y)) * height;
    // 注意括号位置：2px 的下限必须作用在「乘以画布尺寸之后」的像素值上。
    // 若写成 Math.max(2, 归一化值) * width，归一化坐标（恒 < 2）会被钳成 2，
    // 采样区域膨胀成整张画布，采出的底色是全图平均（脏黑），擦除块全部偏色。
    const bw = Math.max(2, Math.min(segment.w, 1 - segment.x) * width);
    const bh = Math.max(2, Math.min(segment.h, 1 - segment.y) * height);
    const average = sampleBackground(bx, by, bw, bh);
    drawSegmentText(
      context,
      segment,
      segment.translation || segment.text,
      options,
      average ?? { r: 255, g: 255, b: 255 },
    );
  }
  return { width, height };
}

/** 导出渲染结果为 PNG 下载（结果页「保存图片」按钮）。 */
export function downloadCanvas(canvas: HTMLCanvasElement, filename: string): Promise<void> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) {
        reject(new Error('图片导出失败'));
        return;
      }
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = filename;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      resolve();
    }, 'image/png');
  });
}
