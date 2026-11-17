import { streamText } from 'ai'
import { createAnthropic } from '@ai-sdk/anthropic'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import type { ExternalModelConfig, ExternalModelFormat } from '../group/types'

export class ExternalModelError extends Error {
  constructor(public message: string, public status?: number, public code?: string) {
    super(message)
    this.name = 'ExternalModelError'
  }

  get friendlyMessage(): string {
    // Says what to do itself (OpenTeam was not allowed to reach the address).
    if (this.code === 'host_access') return this.message
    if (this.status === 401 || this.status === 403) return 'API Key 无效或权限不足，请检查配置'
    if (this.code === QUOTA_EXHAUSTED_CODE) return this.message
    if (this.status === 429) return '请求过于频繁，请稍后再试 (Rate Limit)'
    if (this.status === 404) return '模型名称不正确或端点路径错误'
    if (this.status && this.status >= 500) return '模型服务器出现内部错误，请稍后重试'
    if (this.message.includes('timeout') || this.message.includes('Network')) return '网络连接超时，请检查 BaseURL 和网络设置'
    return this.message
  }
}

export interface ExternalModelCompletionInput {
  model: ExternalModelConfig
  prompt: string
  // Images the user attached, sent with the prompt as image parts (the model must accept images).
  images?: ExternalModelImage[]
  abortSignal?: AbortSignal
  // Told how many tokens the reply used, once the model reports it at the end of the stream.
  onUsage?(usage: ExternalModelUsage): void
  // The member and message the reply is for (a local agent asks the user's approval on that member).
  context?: { chatId: string; roleId: string; messageId: string; roleName?: string }
}

export interface ExternalModelUsage {
  inputTokens?: number
  outputTokens?: number
  totalTokens?: number
}

export interface ExternalModelImage {
  bytes: Uint8Array
  mimeType: string
}

export interface ExternalModelCompletionResult {
  content: string
}

export interface ExternalModelClient {
  stream?(input: ExternalModelCompletionInput): AsyncIterable<string>
  complete(input: ExternalModelCompletionInput): Promise<ExternalModelCompletionResult>
}

export interface ExternalModelClientOptions {
  timeoutMs?: number
}

// How long a request may go without new text: before the first piece (a thinking model under load
// can be slow to start) and between pieces. A long reply runs as long as text keeps coming.
const DEFAULT_EXTERNAL_MODEL_TIMEOUT_MS = 60_000

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

export function createExternalModelClient(fetchImpl: typeof fetch = fetch, options: ExternalModelClientOptions = {}): ExternalModelClient {
  let lastResponseMetadata: Record<string, unknown> = {}
  const timeoutMs = options.timeoutMs ?? DEFAULT_EXTERNAL_MODEL_TIMEOUT_MS

  const wrappedFetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const response = await fetchImpl(input, init)
    lastResponseMetadata = {
      url: input instanceof Request ? input.url : String(input),
      status: response.status,
      statusText: response.statusText,
      headers: Object.fromEntries(response.headers.entries()),
    }
    return response
  }

  return {
    stream(input) {
      return streamExternalModelWithTimeout(input, wrappedFetch, timeoutMs)
    },
    async complete(input) {
      const timeout = createTimedAbortSignal(input.abortSignal, timeoutMs)

      try {
        let content = ''
        const normalizedUrl = normalizeBaseUrl(input.model.baseUrl, input.model.format)
        const stream = streamExternalModel({ ...input, abortSignal: timeout.signal }, wrappedFetch)
        for await (const chunk of stream) {
          timeout.touch()
          content += chunk
        }
        if (!content.trim()) {
          throw new ExternalModelError(
            `外部模型返回内容为空 (URL: ${normalizedUrl}, Model: ${input.model.modelName}, Response: ${JSON.stringify(lastResponseMetadata)})`
          )
        }
        return { content }
      } catch (error: any) {
        if (isAbortError(error)) {
          if (!timeout.timedOut()) throw error
          throw new ExternalModelError('请求超时，模型响应时间过长', 408)
        }
        if (error instanceof ExternalModelError) throw error
        throw new ExternalModelError(error.message || '未知外部模型错误')
      } finally {
        timeout.clear()
      }
    },
  }
}

async function* streamExternalModelWithTimeout(input: ExternalModelCompletionInput, fetchImpl: typeof fetch, timeoutMs: number): AsyncIterable<string> {
  const timeout = createTimedAbortSignal(input.abortSignal, timeoutMs)
  try {
    // A group reply: OpenTeam's reply loop retries it and says so on the reply, so one attempt here.
    for await (const chunk of streamExternalModel({ ...input, abortSignal: timeout.signal }, fetchImpl, 1)) {
      timeout.touch()
      yield chunk
    }
  } catch (error: any) {
    if (isAbortError(error)) {
      if (!timeout.timedOut()) throw error
      throw new ExternalModelError('请求超时，模型响应时间过长', 408)
    }
    if (error instanceof ExternalModelError) throw error
    throw new ExternalModelError(error.message || '未知外部模型错误')
  } finally {
    timeout.clear()
  }
}

// Aborts once `timeoutMs` pass without a touch().
function createTimedAbortSignal(parentSignal: AbortSignal | undefined, timeoutMs: number): { signal: AbortSignal; touch(): void; clear(): void; timedOut(): boolean } {
  const controller = new AbortController()
  let didTimeout = false
  const onTimeout = () => {
    didTimeout = true
    controller.abort()
  }
  let timeoutId = setTimeout(onTimeout, timeoutMs)
  const abortFromParent = () => controller.abort()

  if (parentSignal?.aborted) {
    abortFromParent()
  } else {
    parentSignal?.addEventListener('abort', abortFromParent, { once: true })
  }

  return {
    signal: controller.signal,
    touch() {
      if (controller.signal.aborted) return
      clearTimeout(timeoutId)
      timeoutId = setTimeout(onTimeout, timeoutMs)
    },
    clear() {
      clearTimeout(timeoutId)
      parentSignal?.removeEventListener('abort', abortFromParent)
    },
    timedOut() {
      return didTimeout
    },
  }
}

// `attempts`: tries for 429, 5xx and network errors. One layer of retries only: the AI library's own
// (maxRetries) is off, or every attempt here would be three requests.
async function* streamExternalModel(input: ExternalModelCompletionInput, fetchImpl: typeof fetch, attempts = 3): AsyncIterable<string> {
  const maxRetries = attempts
  let attempt = 0

  while (true) {
    try {
      const normalizedUrl = normalizeBaseUrl(input.model.baseUrl, input.model.format)
      // The start of the server's answer, kept in case it carries no text and that needs saying why.
      let answerStart: Promise<string> | undefined
      const keepingFetch = async (url: RequestInfo | URL, init?: RequestInit) => {
        const response = await fetchImpl(url, init)
        answerStart = readStart(response)
        return response
      }
      const provider = input.model.format === 'anthropic'
        ? createAnthropic({
          apiKey: input.model.apiKey,
          baseURL: normalizedUrl,
          fetch: keepingFetch,
        })
        : createOpenAICompatible({
          name: `openteam-${input.model.id}`,
          apiKey: input.model.apiKey,
          baseURL: normalizedUrl,
          fetch: keepingFetch,
          // Asks for the token counts at the end of the stream (stream_options.include_usage).
          includeUsage: true,
        })

      // The text stream leaves errors out (an HTTP 500 just ends it empty); they arrive here, and
      // are thrown once the text ends, so the real reason and status reach the caller.
      let streamError: unknown
      const result = streamText({
        model: provider(input.model.modelName as never),
        ...promptOrMessages(input),
        abortSignal: input.abortSignal,
        maxRetries: 0,
        onError: ({ error }) => {
          streamError ??= error
        },
      })

      let sawText = false
      for await (const textPart of result.textStream) {
        if (!textPart) continue
        if (textPart.trim()) sawText = true
        yield textPart
      }
      if (streamError) throw streamError
      // The AI library ends the text quietly when the request is aborted (a timeout, or the user).
      if (input.abortSignal?.aborted) throw new DOMException('Aborted', 'AbortError')
      if (!sawText) throw await emptyReplyError(result, answerStart, input.model.apiKey)
      await reportUsage(result.usage, input.onUsage)
      return
    } catch (error: any) {
      if (isAbortError(error)) throw error
      attempt++
      // The AI library reports the HTTP status as statusCode.
      const status = error.status || error.statusCode || error.response?.status
      const quotaExhausted = isQuotaExhausted(error)
      const isRetryable = quotaExhausted ? false : status === 429 || (status >= 500 && status <= 599) || error.message?.includes('timeout') || error.message?.includes('Network')

      if (!isRetryable || attempt >= maxRetries) {
        const message = requestErrorMessage(error, status, input.model.apiKey)
        if (quotaExhausted) throw new ExternalModelError(`额度已用完：${message}`, status, QUOTA_EXHAUSTED_CODE)
        throw new ExternalModelError(message, status, error.code)
      }

      const delay = Math.pow(2, attempt) * 500
      await new Promise(resolve => setTimeout(resolve, delay))
    }
  }
}

// Some servers send no usage; the reply is fine without it.
async function reportUsage(usage: PromiseLike<{ inputTokens?: number; outputTokens?: number; totalTokens?: number }>, onUsage: ExternalModelCompletionInput['onUsage']): Promise<void> {
  if (!onUsage) return
  try {
    const normalized = normalizeUsage(await usage)
    if (normalized) onUsage(normalized)
  } catch {
    // No usage reported.
  }
}

export function normalizeUsage(usage: { inputTokens?: number; outputTokens?: number; totalTokens?: number } | undefined): ExternalModelUsage | undefined {
  const count = (value: number | undefined) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.round(value) : undefined
  const inputTokens = count(usage?.inputTokens)
  const outputTokens = count(usage?.outputTokens)
  const totalTokens = count(usage?.totalTokens) ?? (inputTokens !== undefined || outputTokens !== undefined ? (inputTokens ?? 0) + (outputTokens ?? 0) : undefined)
  if (inputTokens === undefined && outputTokens === undefined && totalTokens === undefined) return undefined
  return {
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(totalTokens !== undefined ? { totalTokens } : {}),
  }
}

const ANSWER_START_CHARS = 300

export const QUOTA_EXHAUSTED_CODE = 'quota_exhausted'

// A refusal that retrying will not fix: the account's balance or the day's quota is gone, or the
// model has no free quota at all. A 429 also comes from per-minute limits, which retries do fix
// (Gemini words both the same and tells them apart only by the quota's id).
const QUOTA_EXHAUSTED = /insufficient[_ ]quota|insufficient[_ ]balance|exceeded_current_quota|余额不足|欠费|PerDay|limit: 0\b/i

function isQuotaExhausted(error: any): boolean {
  const status = error?.status || error?.statusCode
  if (status !== 429 && status !== 402 && status !== 403) return false
  return QUOTA_EXHAUSTED.test(`${typeof error?.responseBody === 'string' ? error.responseBody : ''}\n${error?.message ?? ''}`)
}

// What a failed request says. The server's own words come first: the AI library reads only the
// OpenAI error shape and otherwise falls back to the status text, which HTTP/2 leaves empty (Gemini
// answers a key with no quota with `[{"error": {...}}]`, which ended up as no message at all).
function requestErrorMessage(error: any, status: number | undefined, apiKey: string): string {
  const fromServer = serverErrorText(error?.responseBody)
  const text = fromServer
    ? (status ? `HTTP ${status}：${fromServer}` : fromServer)
    : error?.message || (status ? `外部模型请求失败（HTTP ${status}）` : '外部模型请求失败')
  return apiKey ? text.split(apiKey).join('***') : text
}

function serverErrorText(body: unknown): string {
  if (typeof body !== 'string' || !body.trim()) return ''
  try {
    let parsed = JSON.parse(body)
    if (Array.isArray(parsed)) parsed = parsed[0]
    const message = parsed?.error?.message ?? (typeof parsed?.error === 'string' ? parsed.error : undefined) ?? parsed?.message
    if (typeof message === 'string' && message.trim()) return message.trim().slice(0, ANSWER_START_CHARS)
  } catch {
    // Not JSON: its start is shown as it is.
  }
  return body.replace(/\s+/g, ' ').trim().slice(0, ANSWER_START_CHARS)
}

// The first characters of a response body, read from a copy so the AI library still gets all of it.
function readStart(response: Response): Promise<string> {
  const status = `HTTP ${response.status}`
  if (!response.body) return Promise.resolve(status)
  const reader = response.clone().body!.getReader()
  const decoder = new TextDecoder()
  return (async () => {
    let text = ''
    try {
      while (text.length < ANSWER_START_CHARS) {
        const { done, value } = await reader.read()
        if (done) break
        text += decoder.decode(value, { stream: true })
      }
    } catch {
      // What was read so far is enough.
    } finally {
      reader.cancel().catch(() => {})
    }
    const start = text.replace(/\s+/g, ' ').trim().slice(0, ANSWER_START_CHARS)
    return start ? `${status}：${start}` : status
  })()
}

// A stream that ended properly without any text: says how it ended (a filter, the length limit, or
// only the model's thinking) and how the server's answer began, without the API key.
async function emptyReplyError(
  result: { finishReason: PromiseLike<string>; reasoningText: PromiseLike<string | undefined> },
  answerStart: Promise<string> | undefined,
  apiKey: string,
): Promise<ExternalModelError> {
  const settle = async <T>(value: PromiseLike<T> | undefined) => {
    try {
      return await value
    } catch {
      return undefined
    }
  }
  const finishReason = await settle(result.finishReason)
  const reasoning = (await settle(result.reasoningText))?.trim()
  const start = await settle(answerStart)
  const details = [
    finishReason ? `结束原因：${finishReason}` : '',
    reasoning ? '只返回了思考过程' : '',
    start ? `响应开头：${apiKey ? start.split(apiKey).join('***') : start}` : '',
  ].filter(Boolean)
  return new ExternalModelError(details.length > 0 ? `模型没有返回内容（${details.join('；')}）` : '模型没有返回内容')
}

function promptOrMessages(input: ExternalModelCompletionInput) {
  if (!input.images?.length) return { prompt: input.prompt }
  return {
    messages: [{
      role: 'user' as const,
      content: [
        { type: 'text' as const, text: input.prompt },
        ...input.images.map(image => ({ type: 'image' as const, image: image.bytes, mediaType: image.mimeType })),
      ],
    }],
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError'
}
