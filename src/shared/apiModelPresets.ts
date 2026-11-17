// Ready-made settings for common API providers, and asking a provider which models it has. Model
// names change too often to keep a list of them here: the form fetches them from the provider.
import type { ExternalModelFormat } from '../group/types'
import { normalizeBaseUrl } from './modelBaseUrl'
import { serverErrorText } from './serverErrorText'

export type ApiModelFormat = Exclude<ExternalModelFormat, 'local-agent'>

export interface ApiModelPreset {
  id: string
  name: string
  format: ApiModelFormat
  // As OpenTeam sends it: normalizeBaseUrl leaves it as it is.
  baseUrl: string
  // Where the user makes a key.
  keyPage: string
  // Shown as the model field's placeholder; the list comes from the provider.
  exampleModel: string
}

export const API_MODEL_PRESETS: ApiModelPreset[] = [
  { id: 'deepseek', name: 'DeepSeek', format: 'openai', baseUrl: 'https://api.deepseek.com/v1', keyPage: 'https://platform.deepseek.com/api_keys', exampleModel: 'deepseek-chat' },
  { id: 'gemini', name: 'Google Gemini', format: 'openai', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', keyPage: 'https://aistudio.google.com/apikey', exampleModel: 'gemini-flash-latest' },
  { id: 'openai', name: 'OpenAI', format: 'openai', baseUrl: 'https://api.openai.com/v1', keyPage: 'https://platform.openai.com/api-keys', exampleModel: 'gpt-4.1-mini' },
  { id: 'anthropic', name: 'Anthropic Claude', format: 'anthropic', baseUrl: 'https://api.anthropic.com/v1', keyPage: 'https://console.anthropic.com/settings/keys', exampleModel: 'claude-sonnet-5-5' },
  { id: 'qwen', name: '阿里云百炼（通义千问）', format: 'openai', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', keyPage: 'https://bailian.console.aliyun.com/', exampleModel: 'qwen-plus' },
  { id: 'zhipu', name: '智谱 GLM', format: 'openai', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', keyPage: 'https://open.bigmodel.cn/usercenter/apikeys', exampleModel: 'glm-4-flash' },
  { id: 'moonshot', name: 'Moonshot（Kimi）', format: 'openai', baseUrl: 'https://api.moonshot.cn/v1', keyPage: 'https://platform.moonshot.cn/console/api-keys', exampleModel: 'moonshot-v1-8k' },
  { id: 'ark', name: '火山方舟（豆包）', format: 'openai', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3', keyPage: 'https://console.volcengine.com/ark', exampleModel: 'doubao-seed-1-6-250615' },
  { id: 'openrouter', name: 'OpenRouter', format: 'openai', baseUrl: 'https://openrouter.ai/api/v1', keyPage: 'https://openrouter.ai/keys', exampleModel: 'openai/gpt-4o-mini' },
  { id: 'siliconflow', name: '硅基流动 SiliconFlow', format: 'openai', baseUrl: 'https://api.siliconflow.cn/v1', keyPage: 'https://cloud.siliconflow.cn/account/ak', exampleModel: 'deepseek-ai/DeepSeek-V3' },
]

// The preset a saved address belongs to, compared as OpenTeam sends them.
export function presetForBaseUrl(baseUrl: string): ApiModelPreset | undefined {
  return API_MODEL_PRESETS.find(preset => normalizeBaseUrl(baseUrl, preset.format) === preset.baseUrl)
}

export interface ModelListRequest {
  format: ApiModelFormat
  baseUrl: string
  apiKey: string
}

// Models that do not chat: embeddings, speech, images, video, moderation, reranking.
const NOT_A_CHAT_MODEL = /embed|tts|whisper|dall-e|moderation|imagen|veo|aqa|transcribe|rerank/i
const ANTHROPIC_VERSION = '2023-06-01'

// The chat models the provider lists at {address}/models, sorted, each once.
export async function listModelNames(request: ModelListRequest, fetchImpl: typeof fetch = fetch): Promise<string[]> {
  const url = `${normalizeBaseUrl(request.baseUrl, request.format)}/models`
  const headers: Record<string, string> = request.format === 'anthropic'
    ? { 'x-api-key': request.apiKey, 'anthropic-version': ANTHROPIC_VERSION, 'anthropic-dangerous-direct-browser-access': 'true' }
    : { Authorization: `Bearer ${request.apiKey}` }
  const response = await fetchImpl(url, { headers })
  const body = await response.text()
  if (!response.ok) {
    const said = serverErrorText(body) || response.statusText
    const text = said ? `HTTP ${response.status}：${said}` : `HTTP ${response.status}`
    throw new Error(request.apiKey ? text.split(request.apiKey).join('***') : text)
  }
  let data: unknown
  try {
    data = (JSON.parse(body) as { data?: unknown }).data
  } catch {
    throw new Error('模型列表不是 JSON，请检查模型地址')
  }
  const names = (Array.isArray(data) ? data : [])
    .map(entry => (entry as { id?: unknown })?.id)
    .filter((id): id is string => typeof id === 'string' && id.trim() !== '')
    .map(id => id.replace(/^models\//, ''))
    .filter(id => !NOT_A_CHAT_MODEL.test(id))
  if (names.length === 0) throw new Error('这个地址没有列出任何模型，请直接填写模型名称')
  return [...new Set(names)].sort((left, right) => left.localeCompare(right))
}
