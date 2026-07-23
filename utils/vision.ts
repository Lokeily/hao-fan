import { getProviderApiKey, type AppConfig } from './config';
import { getProvider } from './providers';
import { postJson, cleanSecret } from './requester';
import { parseImageSegmentsResult, type ImageSegment } from './vision-parser';

export interface ImageResult {
  image: string; // data URL
  segments: ImageSegment[];
}

// 调用支持视觉的模型：OCR + 翻译，返回每张图中文字的区域与译文。
export async function translateImage(
  cfg: AppConfig,
  dataUrl: string,
  signal?: AbortSignal,
): Promise<ImageResult> {
  const provider = getProvider(cfg.provider);
  const supportsVision = provider?.vision || (provider?.id === 'custom' && cfg.customVision);
  if (!provider || provider.type !== 'llm' || !supportsVision) {
    throw new Error('当前引擎不支持图片翻译，请选择支持视觉的模型（如 GPT-4o / Gemini / 智谱 GLM-4V / 通义千问 VL）');
  }
  const base = (cfg.baseUrl || '').replace(/\/+$/, '');
  if (!base) throw new Error('未配置 API Base URL');
  const apiKey = cleanSecret(getProviderApiKey(cfg));
  const url = `${base}/chat/completions`;

  const prompt =
    `这是一张图片。请识别图中所有文字，逐段翻译为${cfg.targetLang}。` +
    `以 JSON 数组返回，每个元素包含：` +
    `x,y,w,h（归一化到 0~1，表示该段文字在图中的大致区域，x/y 为左上角，w/h 为宽高）、` +
    `text（原文）、translation（译文）。只返回 JSON，不要任何额外说明或代码块标记。`;

  const data = await postJson(
    url,
    {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    JSON.stringify({
      model: cfg.model,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: prompt },
            { type: 'image_url', image_url: { url: dataUrl } },
          ],
        },
      ],
      temperature: 0.2,
    }),
    { timeout: 45000, retries: 1, signal },
  );
  const content: string = data?.choices?.[0]?.message?.content ?? '';
  const finishReason = String(data?.choices?.[0]?.finish_reason || '').toLowerCase();
  if (finishReason === 'length' || finishReason === 'max_tokens') {
    throw new Error('图片翻译结果不完整，请缩小图片或提高模型输出上限');
  }
  const parsed = parseImageSegmentsResult(content);
  if (!parsed.valid) throw new Error('图片模型返回格式无效，请重试或更换模型');
  const segments = parsed.segments;
  return { image: dataUrl, segments };
}
