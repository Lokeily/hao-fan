// 翻译引擎注册表。覆盖「全球顶尖 AI + 国内主流大模型 + 传统翻译引擎」。
// - type 'llm'：走 OpenAI 兼容的 /chat/completions（含视觉模型可翻译图片）
// - type 'mt' ：走各家传统翻译 REST（DeepL / Google / Microsoft）
// 模型名会随厂商更新而变化，用户可在设置页手动改 Base URL / 模型。
export type ProviderType = 'llm' | 'mt';

export interface Provider {
  id: string;
  name: string;
  type: ProviderType;
  baseUrl: string;
  models: string[];
  defaultModel: string;
  docUrl: string;
  needsKey: boolean;
  vision?: boolean; // 是否支持图片（视觉）翻译
}

export const PROVIDERS: Provider[] = [
  // ===== 全球顶尖 AI（OpenAI 兼容） =====
  {
    id: 'openai',
    name: 'OpenAI (GPT)',
    type: 'llm',
    baseUrl: 'https://api.openai.com/v1',
    models: ['gpt-4o-mini', 'gpt-4o', 'gpt-4.1-mini', 'gpt-4.1'],
    defaultModel: 'gpt-4o-mini',
    docUrl: 'https://platform.openai.com/docs/api-reference',
    needsKey: true,
    vision: true,
  },
  {
    id: 'gemini',
    name: 'Google Gemini',
    type: 'llm',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    models: ['gemini-2.0-flash', 'gemini-1.5-pro', 'gemini-2.0-flash-exp'],
    defaultModel: 'gemini-2.0-flash',
    docUrl: 'https://ai.google.dev/gemini-api/docs',
    needsKey: true,
    vision: true,
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    type: 'llm',
    baseUrl: 'https://openrouter.ai/api/v1',
    models: [
      'openai/gpt-4o-mini',
      'anthropic/claude-3.5-sonnet',
      'google/gemini-pro-1.5',
      'meta-llama/llama-3.1-70b-instruct',
    ],
    defaultModel: 'openai/gpt-4o-mini',
    docUrl: 'https://openrouter.ai/docs',
    needsKey: true,
    vision: true,
  },

  // ===== 国内主流大模型（OpenAI 兼容） =====
  {
    id: 'deepseek',
    name: 'DeepSeek',
    type: 'llm',
    baseUrl: 'https://api.deepseek.com',
    models: ['deepseek-chat', 'deepseek-reasoner'],
    defaultModel: 'deepseek-chat',
    docUrl: 'https://platform.deepseek.com/api-docs',
    needsKey: true,
    vision: false,
  },
  {
    id: 'zhipu',
    name: '智谱 GLM',
    type: 'llm',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    models: ['glm-4.5-flash', 'glm-5.2', 'glm-4v', 'glm-4-flash', 'glm-4-plus'],
    defaultModel: 'glm-4.5-flash',
    docUrl: 'https://docs.bigmodel.cn/cn/guide/develop/openai/introduction',
    needsKey: true,
    vision: true,
  },
  {
    id: 'hunyuan',
    name: '腾讯混元',
    type: 'llm',
    baseUrl: 'https://api.hunyuan.cloud.tencent.com/v1',
    models: [
      'hunyuan-turbos-latest',
      'hunyuan-turbos-vision',
      'hunyuan-lite',
      'hunyuan-standard',
      'hunyuan-turbo',
      'hunyuan-pro',
    ],
    defaultModel: 'hunyuan-turbos-latest',
    docUrl: 'https://cloud.tencent.com/document/product/1729/111007',
    needsKey: true,
    vision: true,
  },
  {
    id: 'qwen',
    name: '通义千问',
    type: 'llm',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    models: ['qwen-plus', 'qwen-max', 'qwen-turbo', 'qwen2.5-vl-72b-instruct', 'qwen-long'],
    defaultModel: 'qwen-plus',
    docUrl: 'https://help.aliyun.com/zh/model-studio/',
    needsKey: true,
    vision: true,
  },
  {
    id: 'kimi',
    name: 'Kimi',
    type: 'llm',
    baseUrl: 'https://api.moonshot.cn/v1',
    models: ['moonshot-v1-8k', 'moonshot-v1-32k', 'moonshot-v1-128k'],
    defaultModel: 'moonshot-v1-8k',
    docUrl: 'https://platform.moonshot.cn/docs/api/chat',
    needsKey: true,
    vision: false,
  },
  {
    id: 'baichuan',
    name: '百川智能',
    type: 'llm',
    baseUrl: 'https://api.baichuan-ai.com/v1',
    models: ['baichuan4', 'baichuan3-turbo', 'baichuan2-turbo'],
    defaultModel: 'baichuan4',
    docUrl: 'https://platform.baichuan-ai.com/docs',
    needsKey: true,
    vision: false,
  },
  {
    id: 'doubao',
    name: '豆包',
    type: 'llm',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    models: ['doubao-lite-32k', 'doubao-pro-32k', 'doubao-vision-pro'],
    defaultModel: 'doubao-lite-32k',
    docUrl: 'https://www.volcengine.com/docs/82379',
    needsKey: true,
    vision: true,
  },
  {
    id: 'ollama',
    name: 'Ollama（本地）',
    type: 'llm',
    baseUrl: 'http://localhost:11434/v1',
    models: ['qwen2.5', 'llama3.1', 'gemma2', 'minicpm-v'],
    defaultModel: 'qwen2.5',
    docUrl: 'https://github.com/ollama/ollama',
    needsKey: false,
    vision: true,
  },

  // ===== 全球顶尖传统翻译引擎 =====
  {
    id: 'google',
    name: 'Google 翻译',
    type: 'mt',
    baseUrl: 'https://translate.googleapis.com',
    models: [],
    defaultModel: '',
    docUrl: 'https://translate.google.com',
    needsKey: false,
  },
  {
    id: 'deepl',
    name: 'DeepL',
    type: 'mt',
    baseUrl: 'https://api-free.deepl.com',
    models: [],
    defaultModel: '',
    docUrl: 'https://www.deepl.com/docs-api',
    needsKey: true,
  },
  {
    id: 'microsoft',
    name: 'Microsoft 翻译',
    type: 'mt',
    baseUrl: 'https://api.cognitive.microsofttranslator.com',
    models: [],
    defaultModel: '',
    docUrl: 'https://learn.microsoft.com/azure/ai-services/translator/',
    needsKey: true,
  },

  {
    id: 'custom',
    name: '自定义（OpenAI 兼容）',
    type: 'llm',
    baseUrl: '',
    models: [],
    defaultModel: '',
    docUrl: '',
    needsKey: true,
    vision: false,
  },
];

export function getProvider(id: string): Provider | undefined {
  return PROVIDERS.find((p) => p.id === id);
}
