export interface ImageSegment {
  x: number;
  y: number;
  w: number;
  h: number;
  text: string;
  translation: string;
  /** 模型自评置信度 0~1（可缺省）。低于阈值时渲染层可保留原文做兜底。 */
  confidence?: number;
}

export interface ImageSegmentParseResult {
  segments: ImageSegment[];
  valid: boolean;
}

export function parseImageSegmentsResult(content: string): ImageSegmentParseResult {
  let json = content.trim();
  const fence = json.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) json = fence[1].trim();
  const start = json.indexOf('[');
  const end = json.lastIndexOf(']');
  if (start === -1 || end === -1) return { segments: [], valid: false };

  let parsed: unknown;
  try {
    parsed = JSON.parse(json.slice(start, end + 1));
  } catch {
    return { segments: [], valid: false };
  }
  if (!Array.isArray(parsed)) return { segments: [], valid: false };

  // 上限 200 → 400：真 OCR 输出的文字行远多于旧版「整段合并」的粒度，
  // 海报/截图类图片轻松超过 200 行，截掉会直接丢掉半张图的文字。
  const segments = parsed
    .slice(0, 400)
    .map((item) => {
      if (!item || typeof item !== 'object') return null;
      const record = item as Record<string, unknown>;
      const numberInRange = (value: unknown) => {
        const number = Number(value);
        return Number.isFinite(number) ? Math.min(1, Math.max(0, number)) : 0;
      };
      const x = numberInRange(record.x);
      const y = numberInRange(record.y);
      return {
        x,
        y,
        w: Math.min(numberInRange(record.w), 1 - x),
        h: Math.min(numberInRange(record.h), 1 - y),
        text: String(record.text ?? '')
          .trim()
          .slice(0, 2_000),
        translation: String(record.translation ?? '')
          .trim()
          .slice(0, 2_000),
        ...(Number.isFinite(Number(record.confidence))
          ? { confidence: Math.min(1, Math.max(0, Number(record.confidence))) }
          : {}),
      };
    })
    .filter(
      (segment): segment is ImageSegment =>
        segment !== null && Boolean(segment.text || segment.translation),
    );
  return { segments, valid: true };
}

export function parseImageSegments(content: string): ImageSegment[] {
  return parseImageSegmentsResult(content).segments;
}
