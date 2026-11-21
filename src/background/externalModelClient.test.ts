import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createExternalModelClient, ExternalModelError, normalizeBaseUrl, normalizeUsage } from './externalModelClient'
import type { ExternalModelConfig } from '../group/types'
import { streamText } from 'ai'

vi.mock('ai', async importOriginal => ({
  ...(await importOriginal<typeof import('ai')>()),
  streamText: vi.fn(),
}))

describe('ExternalModelClient Stability Baseline', () => {
  const mockConfig: ExternalModelConfig = {
    id: 'test-model',
    name: 'Test Model',
    format: 'openai',
    baseUrl: 'https://api.example.com/v1',
    apiKey: '***',
    modelName: 'gpt-4',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }

  let mockFetch: any

  beforeEach(() => {
    vi.clearAllMocks()
    mockFetch = vi.fn()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  function createMockStreamResult(texts: string[]) {
    return {
      textStream: {
        async *[Symbol.asyncIterator]() {
          for (const text of texts) {
            yield text
          }
        },
      },
      content: '',
      text: '',
      reasoning: '',
      reasoningText: '',
    } as any
  }

  it('adds /v1 to an OpenAI-format address only when its path names no API version', () => {
    // Paths that already name a version are left as they are.
    expect(normalizeBaseUrl('https://generativelanguage.googleapis.com/v1beta/openai/', 'openai')).toBe('https://generativelanguage.googleapis.com/v1beta/openai')
    expect(normalizeBaseUrl('https://open.bigmodel.cn/api/paas/v4', 'openai')).toBe('https://open.bigmodel.cn/api/paas/v4')
    expect(normalizeBaseUrl('https://ark.cn-beijing.volces.com/api/v3', 'openai')).toBe('https://ark.cn-beijing.volces.com/api/v3')
    expect(normalizeBaseUrl('https://api.meta.ai/v1', 'openai')).toBe('https://api.meta.ai/v1')
    // As before: a bare host, or a path without a version, gets /v1.
    expect(normalizeBaseUrl('https://api.deepseek.com', 'openai')).toBe('https://api.deepseek.com/v1')
    expect(normalizeBaseUrl('http://localhost:11434/', 'openai')).toBe('http://localhost:11434/v1')
    expect(normalizeBaseUrl('https://openrouter.ai/api', 'openai')).toBe('https://openrouter.ai/api/v1')
    expect(normalizeBaseUrl('https://api.groq.com/openai', 'openai')).toBe('https://api.groq.com/openai/v1')
    // A host whose name has "v1" in it is not a version.
    expect(normalizeBaseUrl('https://v1.example.com', 'openai')).toBe('https://v1.example.com/v1')
    // Anthropic-format addresses are left alone.
    expect(normalizeBaseUrl('https://api.anthropic.com/', 'anthropic')).toBe('https://api.anthropic.com')
  })

  it('normalizes DashScope root URLs to the OpenAI-compatible endpoint', () => {
    expect(normalizeBaseUrl('https://dashscope.aliyuncs.com', 'openai')).toBe('https://dashscope.aliyuncs.com/compatible-mode/v1')
    expect(normalizeBaseUrl('https://dashscope-intl.aliyuncs.com/compatible-mode', 'openai')).toBe('https://dashscope-intl.aliyuncs.com/compatible-mode/v1')
  })

  it('should succeed when the API returns a valid stream', async () => {
    vi.mocked(streamText).mockReturnValue(createMockStreamResult(['Hello', ' World']))

    const client = createExternalModelClient(mockFetch)
    const result = await client.complete({ model: mockConfig, prompt: 'Hi' })

    expect(result.content).toBe('Hello World')
  })

  it('reports the tokens a reply used once the stream ends, and lives without them', async () => {
    vi.mocked(streamText).mockReturnValueOnce({ ...createMockStreamResult(['Hi']), usage: Promise.resolve({ inputTokens: 1200, outputTokens: 34, totalTokens: 1234 }) })
    const client = createExternalModelClient(mockFetch)
    const onUsage = vi.fn()

    const chunks: string[] = []
    for await (const chunk of client.stream!({ model: mockConfig, prompt: 'Hi', onUsage })) chunks.push(chunk)

    expect(chunks).toEqual(['Hi'])
    expect(onUsage).toHaveBeenCalledWith({ inputTokens: 1200, outputTokens: 34, totalTokens: 1234 })

    vi.mocked(streamText).mockReturnValueOnce({ ...createMockStreamResult(['ok']), usage: Promise.reject(new Error('no usage')) })
    const silent = vi.fn()
    expect((await client.complete({ model: mockConfig, prompt: 'Hi', onUsage: silent })).content).toBe('ok')
    expect(silent).not.toHaveBeenCalled()
  })

  it('counts usage only from real numbers, adding up a missing total', () => {
    expect(normalizeUsage({ inputTokens: 10, outputTokens: 5 })).toEqual({ inputTokens: 10, outputTokens: 5, totalTokens: 15 })
    expect(normalizeUsage({ totalTokens: 7.4 })).toEqual({ totalTokens: 7 })
    expect(normalizeUsage({ inputTokens: Number.NaN })).toBeUndefined()
    expect(normalizeUsage(undefined)).toBeUndefined()
  })

  it('asks OpenAI-compatible servers to include usage in the stream', async () => {
    vi.mocked(streamText).mockReturnValue(createMockStreamResult(['ok']))
    await createExternalModelClient(mockFetch).complete({ model: mockConfig, prompt: 'Hi' })
    const model = (vi.mocked(streamText).mock.calls[0][0] as { model: { config?: { includeUsage?: boolean } } }).model
    expect(model.config?.includeUsage).toBe(true)
  })

  it('sends attached images as image parts next to the prompt', async () => {
    vi.mocked(streamText).mockReturnValue(createMockStreamResult(['ok']))
    const client = createExternalModelClient(mockFetch)
    const bytes = new Uint8Array([1, 2, 3])

    await client.complete({ model: mockConfig, prompt: 'Describe the chart', images: [{ bytes, mimeType: 'image/png' }] })
    await client.complete({ model: mockConfig, prompt: 'No images' })

    const [withImages, withoutImages] = vi.mocked(streamText).mock.calls.map(call => call[0] as Record<string, unknown>)
    expect(withImages.prompt).toBeUndefined()
    expect(withImages.messages).toEqual([{ role: 'user', content: [{ type: 'text', text: 'Describe the chart' }, { type: 'image', image: bytes, mediaType: 'image/png' }] }])
    expect(withoutImages).toMatchObject({ prompt: 'No images' })
    expect(withoutImages.messages).toBeUndefined()
  })

  it('should retry on 429 and eventually succeed', async () => {
    let callCount = 0
    vi.mocked(streamText).mockImplementation(() => {
      callCount++
      if (callCount === 1) {
        const error: any = new Error('Too Many Requests')
        error.status = 429
        throw error
      }
      return createMockStreamResult(['Success after retry'])
    })

    const client = createExternalModelClient(mockFetch)
    const result = await client.complete({ model: mockConfig, prompt: 'Hi' })

    expect(callCount).toBe(2)
    expect(result.content).toBe('Success after retry')
  }, 10000)

  it('should fail after max retries on persistent 500 error', async () => {
    let callCount = 0
    vi.mocked(streamText).mockImplementation(() => {
      callCount++
      const error: any = new Error('Internal Server Error')
      error.status = 500
      throw error
    })

    const client = createExternalModelClient(mockFetch)

    await expect(client.complete({ model: mockConfig, prompt: 'Hi' }))
      .rejects.toThrow(ExternalModelError)

    expect(callCount).toBe(3)
  }, 10000)

  it('retries the status the AI library reports as statusCode, with its own retries off', async () => {
    let callCount = 0
    vi.mocked(streamText).mockImplementation(() => {
      callCount++
      if (callCount < 3) {
        const error: any = new Error('Service Unavailable')
        error.statusCode = 503
        throw error
      }
      return createMockStreamResult(['ok'])
    })

    const client = createExternalModelClient(mockFetch)
    const result = await client.complete({ model: mockConfig, prompt: 'Hi' })

    expect(callCount).toBe(3)
    expect(result.content).toBe('ok')
    expect(vi.mocked(streamText).mock.calls[0][0]).toMatchObject({ maxRetries: 0 })
  }, 10000)

  it('reports an error the stream ends with, instead of an empty reply', async () => {
    vi.mocked(streamText).mockImplementation((options: any) => {
      const error: any = new Error('upstream overloaded')
      error.statusCode = 500
      options.onError({ error })
      return createMockStreamResult([])
    })

    const client = createExternalModelClient(mockFetch)
    const failure = await (async () => { for await (const chunk of client.stream!({ model: mockConfig, prompt: 'Hi' })) void chunk })().catch(error => error)

    expect(failure).toBeInstanceOf(ExternalModelError)
    expect(failure).toMatchObject({ message: 'upstream overloaded', status: 500 })
  })

  it('tries a group reply once: OpenTeam retries it and shows the retries', async () => {
    vi.mocked(streamText).mockImplementation(() => {
      const error: any = new Error('Internal Server Error')
      error.statusCode = 500
      throw error
    })

    const client = createExternalModelClient(mockFetch)
    const chunks: string[] = []
    await expect((async () => { for await (const chunk of client.stream!({ model: mockConfig, prompt: 'Hi' })) chunks.push(chunk) })())
      .rejects.toThrow(ExternalModelError)

    expect(vi.mocked(streamText)).toHaveBeenCalledTimes(1)
  })

  it('should fail immediately on non-retryable error (e.g. 400)', async () => {
    vi.mocked(streamText).mockImplementation(() => {
      const error: any = new Error('Bad Request')
      error.status = 400
      throw error
    })

    const client = createExternalModelClient(mockFetch)

    await expect(client.complete({ model: mockConfig, prompt: 'Hi' }))
      .rejects.toThrow(ExternalModelError)

    expect(vi.mocked(streamText)).toHaveBeenCalledTimes(1)
  })

  it('times out complete calls when the provider stream never yields', async () => {
    vi.useFakeTimers()
    vi.mocked(streamText).mockImplementation(({ abortSignal }: any) => ({
      textStream: {
        async *[Symbol.asyncIterator]() {
          await new Promise<void>((_, reject) => {
            abortSignal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true })
          })
        },
      },
    }) as any)

    const client = createExternalModelClient(mockFetch, { timeoutMs: 20 })
    let rejection: unknown
    const completion = client.complete({ model: mockConfig, prompt: 'Hi' }).catch(error => {
      rejection = error
    })

    await vi.advanceTimersByTimeAsync(21)
    await Promise.resolve()

    expect(rejection).toBeInstanceOf(ExternalModelError)
    expect((rejection as ExternalModelError).status).toBe(408)
    await completion
  })

  it('times out streaming chat calls when no token arrives', async () => {
    vi.useFakeTimers()
    vi.mocked(streamText).mockImplementation(({ abortSignal }: any) => ({
      textStream: {
        async *[Symbol.asyncIterator]() {
          await new Promise<void>((_, reject) => {
            abortSignal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true })
          })
        },
      },
    }) as any)

    const client = createExternalModelClient(mockFetch, { timeoutMs: 20 })
    const iterator = client.stream!({ model: mockConfig, prompt: 'Hi' })[Symbol.asyncIterator]()
    let rejection: unknown
    const next = iterator.next().catch(error => {
      rejection = error
    })

    await vi.advanceTimersByTimeAsync(21)
    await Promise.resolve()

    expect(rejection).toBeInstanceOf(ExternalModelError)
    expect((rejection as ExternalModelError).status).toBe(408)
    await next
  })

  describe('reading web pages', () => {
    type ToolCall = { execute(input: { url: string }, options: unknown): Promise<string> }
    const toolsOf = (call: number) => (vi.mocked(streamText).mock.calls[call][0] as { tools?: Record<string, ToolCall>; stopWhen?: unknown }).tools

    it('offers a member a read_web_page tool that goes to OpenTeam\'s reader, for a few steps at most', async () => {
      vi.mocked(streamText).mockReturnValueOnce(createMockStreamResult(['ok']))
      const readWebPage = vi.fn(async (url: string) => `text of ${url}`)
      for await (const _chunk of createExternalModelClient(mockFetch).stream!({ model: mockConfig, prompt: 'Hi', readWebPage })) { /* read */ }
      const tools = toolsOf(0)!
      expect(Object.keys(tools)).toEqual(['read_web_page'])
      expect(await tools.read_web_page.execute({ url: 'https://example.com' }, {})).toBe('text of https://example.com')
      expect((vi.mocked(streamText).mock.calls[0][0] as { stopWhen?: unknown }).stopWhen).toBeDefined()
      // Without a reader, no tool.
      vi.mocked(streamText).mockReturnValueOnce(createMockStreamResult(['ok']))
      for await (const _chunk of createExternalModelClient(mockFetch).stream!({ model: mockConfig, prompt: 'Hi' })) { /* read */ }
      expect(toolsOf(1)).toBeUndefined()
    })

    it('asks again without the tool when the provider does not take tools', async () => {
      vi.mocked(streamText)
        .mockReturnValueOnce({ ...createMockStreamResult([]), textStream: { async *[Symbol.asyncIterator]() { throw Object.assign(new Error('tools is not supported for this model'), { statusCode: 400 }) } } })
        .mockReturnValueOnce(createMockStreamResult(['answer without tools']))
      const chunks: string[] = []
      for await (const chunk of createExternalModelClient(mockFetch).stream!({ model: mockConfig, prompt: 'Hi', readWebPage: async () => '' })) chunks.push(chunk)
      expect(chunks).toEqual(['answer without tools'])
      expect(toolsOf(0)).toBeDefined()
      expect(toolsOf(1)).toBeUndefined()
    })

    it('does not time the request out while a page is being read (the user may be asked first)', async () => {
      vi.mocked(streamText).mockImplementationOnce(((options: { tools: Record<string, ToolCall> }) => ({
        ...createMockStreamResult([]),
        textStream: {
          async *[Symbol.asyncIterator]() {
            yield 'Looking. '
            yield await options.tools.read_web_page.execute({ url: 'https://example.com' }, {})
          },
        },
      })) as never)
      const readWebPage = () => new Promise<string>(resolve => setTimeout(() => resolve('Done.'), 120))
      const chunks: string[] = []
      for await (const chunk of createExternalModelClient(mockFetch, { timeoutMs: 40 }).stream!({ model: mockConfig, prompt: 'Hi', readWebPage })) chunks.push(chunk)
      expect(chunks.join('')).toBe('Looking. Done.')
    })

    it('counts the tokens of every step', async () => {
      vi.mocked(streamText).mockReturnValueOnce({ ...createMockStreamResult(['Hi']), usage: Promise.resolve({ inputTokens: 10, outputTokens: 1 }), totalUsage: Promise.resolve({ inputTokens: 900, outputTokens: 50 }) })
      const onUsage = vi.fn()
      for await (const _chunk of createExternalModelClient(mockFetch).stream!({ model: mockConfig, prompt: 'Hi', onUsage, readWebPage: async () => '' })) { /* read */ }
      expect(onUsage).toHaveBeenCalledWith({ inputTokens: 900, outputTokens: 50, totalTokens: 950 })
    })

    it('names a Gemini connection google, so Gemini\'s thought signatures go back with a tool call', async () => {
      vi.mocked(streamText).mockReturnValue(createMockStreamResult(['ok']))
      const gemini = { ...mockConfig, baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai' }
      for await (const _chunk of createExternalModelClient(mockFetch).stream!({ model: gemini, prompt: 'Hi', readWebPage: async () => '' })) { /* read */ }
      for await (const _chunk of createExternalModelClient(mockFetch).stream!({ model: mockConfig, prompt: 'Hi' })) { /* read */ }
      const provider = (call: number) => (vi.mocked(streamText).mock.calls[call][0] as { model: { config?: { provider?: string } } }).model.config?.provider
      expect(provider(0)).toBe('google.chat')
      expect(provider(1)).toBe('openteam-test-model.chat')
    })

    it('tells the model it can read pages, so it does not say it cannot open a link', async () => {
      vi.mocked(streamText).mockReturnValue(createMockStreamResult(['ok']))
      for await (const _chunk of createExternalModelClient(mockFetch).stream!({ model: mockConfig, prompt: 'Hi', readWebPage: async () => '' })) { /* read */ }
      for await (const _chunk of createExternalModelClient(mockFetch).stream!({ model: mockConfig, prompt: 'Hi' })) { /* read */ }
      const system = (call: number) => (vi.mocked(streamText).mock.calls[call][0] as { system?: string }).system
      expect(system(0)).toContain('read_web_page')
      expect(system(1)).toBeUndefined()
    })
  })

  describe('searching the web', () => {
    type SearchCall = { execute(input: { query: string; topic?: string; time_range?: string }, options: unknown): Promise<string> }
    const callOf = (call: number) => vi.mocked(streamText).mock.calls[call][0] as { tools?: Record<string, SearchCall>; system?: string; stopWhen?: unknown }

    it('offers a search_web tool that goes to OpenTeam\'s searcher, with the topic and time range it asks for', async () => {
      vi.mocked(streamText).mockReturnValueOnce(createMockStreamResult(['ok']))
      const searchWeb = vi.fn(async (query: string) => `results for ${query}`)
      for await (const _chunk of createExternalModelClient(mockFetch).stream!({ model: mockConfig, prompt: 'Hi', searchWeb, readWebPage: async () => '' })) { /* read */ }
      const options = callOf(0)
      expect(Object.keys(options.tools!)).toEqual(['read_web_page', 'search_web'])
      expect(await options.tools!.search_web.execute({ query: 'OpenTeam', topic: 'news', time_range: 'week' }, {})).toBe('results for OpenTeam')
      expect(searchWeb).toHaveBeenCalledWith('OpenTeam', { topic: 'news', timeRange: 'week' })
      expect(options.stopWhen).toBeDefined()
      expect(options.system).toContain('search_web')
      expect(options.system).toContain('read_web_page')
    })

    it('offers search alone when reading is off, and says so to the model', async () => {
      vi.mocked(streamText).mockReturnValueOnce(createMockStreamResult(['ok']))
      for await (const _chunk of createExternalModelClient(mockFetch).stream!({ model: mockConfig, prompt: 'Hi', searchWeb: async () => '' })) { /* read */ }
      const options = callOf(0)
      expect(Object.keys(options.tools!)).toEqual(['search_web'])
      expect(options.system).toContain('search_web')
      expect(options.system).not.toContain('read_web_page')
    })

    it('asks again without tools when the provider does not take them, and does not time out while searching', async () => {
      vi.mocked(streamText)
        .mockReturnValueOnce({ ...createMockStreamResult([]), textStream: { async *[Symbol.asyncIterator]() { throw Object.assign(new Error('tools is not supported for this model'), { statusCode: 400 }) } } })
        .mockReturnValueOnce(createMockStreamResult(['answer without tools']))
      const chunks: string[] = []
      for await (const chunk of createExternalModelClient(mockFetch).stream!({ model: mockConfig, prompt: 'Hi', searchWeb: async () => '' })) chunks.push(chunk)
      expect(chunks).toEqual(['answer without tools'])
      expect(callOf(1).tools).toBeUndefined()

      vi.mocked(streamText).mockImplementationOnce(((options: { tools: Record<string, SearchCall> }) => ({
        ...createMockStreamResult([]),
        textStream: {
          async *[Symbol.asyncIterator]() {
            yield 'Searching. '
            yield await options.tools.search_web.execute({ query: 'q' }, {})
          },
        },
      })) as never)
      const slow = () => new Promise<string>(resolve => setTimeout(() => resolve('Found.'), 120))
      const timed: string[] = []
      for await (const chunk of createExternalModelClient(mockFetch, { timeoutMs: 40 }).stream!({ model: mockConfig, prompt: 'Hi', searchWeb: slow })) timed.push(chunk)
      expect(timed.join('')).toBe('Searching. Found.')
    })
  })
})
