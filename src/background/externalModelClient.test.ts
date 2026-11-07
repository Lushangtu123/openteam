import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createExternalModelClient, ExternalModelError, normalizeBaseUrl, normalizeUsage } from './externalModelClient'
import type { ExternalModelConfig } from '../group/types'
import { streamText } from 'ai'

vi.mock('ai', () => ({
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
})
