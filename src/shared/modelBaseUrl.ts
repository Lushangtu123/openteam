import type { ExternalModelFormat } from '../group/types'

// An OpenAI-format address gets /v1 added unless its path already names an API version (/v1,
// /v1beta/openai for Gemini, /api/v3, /api/paas/v4): "https://api.deepseek.com" and OpenRouter's
// "…/api" need it; Gemini's "…/v1beta/openai" must be left as it is.
export function normalizeBaseUrl(url: string, format: ExternalModelFormat): string {
  let normalized = url.trim().replace(/\/+$/, '')
  if (format === 'openai') {
    normalized = normalizeOpenAiCompatibleBaseUrl(normalized)
    if (!hasVersionSegment(normalized)) {
      normalized += '/v1'
    }
  }
  return normalized
}

function hasVersionSegment(url: string): boolean {
  let path: string
  try {
    path = new URL(url).pathname
  } catch {
    path = url
  }
  return path.split('/').some(segment => /^v\d+(?:[a-z]+\d*)?$/i.test(segment))
}

function normalizeOpenAiCompatibleBaseUrl(url: string): string {
  try {
    const parsed = new URL(url)
    if (
      parsed.hostname === 'dashscope.aliyuncs.com' ||
      parsed.hostname === 'dashscope-intl.aliyuncs.com'
    ) {
      const path = parsed.pathname.replace(/\/+$/, '')
      if (!path || path === '/') parsed.pathname = '/compatible-mode'
      if (path === '/compatible-mode') parsed.pathname = '/compatible-mode'
      return parsed.href.replace(/\/+$/, '')
    }
  } catch {
    // Preserve existing free-form handling for local or custom provider URLs.
  }
  return url
}
