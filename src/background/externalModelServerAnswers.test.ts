import { describe, expect, it } from 'vitest'
import { createExternalModelClient, ExternalModelError } from './externalModelClient'
import { isPermanentModelError } from './externalModelReplies'
import type { ExternalModelConfig } from '../group/types'

// The real AI library, with the server's answer made up: a failed request or a stream with no text
// must say why, in the server's own words where it gave any.
const model: ExternalModelConfig = {
  id: 'empty-model',
  name: 'Empty',
  format: 'openai',
  baseUrl: 'https://api.example.test/v1',
  apiKey: 'sk-secret-123',
  modelName: 'm',
  createdAt: 0,
  updatedAt: 0,
}

function sse(...chunks: unknown[]): Response {
  const body = [...chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`), 'data: [DONE]\n\n'].join('')
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

function chunk(delta: Record<string, unknown>, finishReason: string | null = null) {
  return { id: '1', object: 'chat.completion.chunk', created: 1, model: 'm', choices: [{ index: 0, delta, finish_reason: finishReason }] }
}

// A group reply's failure: the stream tries once, so nothing here waits for retries.
async function failureOf(response: Response): Promise<ExternalModelError> {
  const client = createExternalModelClient(async () => response.clone())
  try {
    for await (const part of client.stream!({ model, prompt: 'Hi' })) void part
  } catch (error) {
    return error as ExternalModelError
  }
  throw new Error('expected the reply to fail')
}

describe('a reply that ends with no text', () => {
  it('names the finish reason and the start of what the server sent', async () => {
    const failure = await failureOf(sse(chunk({ role: 'assistant', content: '' }), chunk({}, 'content_filter')))

    expect(failure).toBeInstanceOf(ExternalModelError)
    expect(failure.message).toContain('模型没有返回内容')
    expect(failure.message).toContain('content-filter')
    expect(failure.message).toContain('HTTP 200')
    expect(failure.message).toContain('chat.completion.chunk')
  })

  it('says when the model sent only its thinking', async () => {
    const failure = await failureOf(sse(chunk({ reasoning_content: 'Let me think' }), chunk({}, 'length')))

    expect(failure.message).toContain('只返回了思考过程')
    expect(failure.message).toContain('length')
  })

  it('never shows the API key, even if the server repeats it', async () => {
    const failure = await failureOf(sse({ ...chunk({}, 'stop'), echo: 'Bearer sk-secret-123' }))

    expect(failure.message).not.toContain('sk-secret-123')
  })

  it('leaves a reply with text alone', async () => {
    const client = createExternalModelClient(async () => sse(chunk({ content: 'OK' }), chunk({}, 'stop')))
    let text = ''
    for await (const part of client.stream!({ model, prompt: 'Hi' })) text += part
    expect(text).toBe('OK')
  })
})

describe('a request the server refuses', () => {
  // Gemini's answer to a key with no quota left. Over HTTP/2 there is no status text, so the AI
  // library, which cannot read this shape, gives an empty message.
  const quota = '[{\n  "error": {\n    "code": 429,\n    "message": "You exceeded your current quota, please check your plan and billing details.",\n    "status": "RESOURCE_EXHAUSTED"\n  }\n}\n]'

  it("gives the server's own message and the status", async () => {
    const failure = await failureOf(new Response(quota, { status: 429, statusText: '', headers: { 'content-type': 'application/json' } }))

    expect(failure).toBeInstanceOf(ExternalModelError)
    expect(failure.status).toBe(429)
    expect(failure.message).toBe('HTTP 429：You exceeded your current quota, please check your plan and billing details.')
  })

  it('prefers the server message to a bare status text', async () => {
    const body = JSON.stringify({ error: { message: 'Please pass a valid API key', code: 400 } })
    const failure = await failureOf(new Response(body, { status: 400, statusText: 'Bad Request', headers: { 'content-type': 'application/json' } }))

    expect(failure.message).toBe('HTTP 400：Please pass a valid API key')
  })

  it('shows the start of a body it cannot read, without the API key', async () => {
    const failure = await failureOf(new Response('<html>Gateway sk-secret-123 down</html>', { status: 502, statusText: '' }))

    expect(failure.status).toBe(502)
    expect(failure.message).toContain('HTTP 502')
    expect(failure.message).toContain('Gateway')
    expect(failure.message).not.toContain('sk-secret-123')
  })
})

describe('how long a reply may take', () => {
  // A server that answers in pieces, `gapMs` apart.
  function slowSse(pieces: string[], gapMs: number): typeof fetch {
    return async (_url, init) => {
      const encoder = new TextEncoder()
      const body = new ReadableStream<Uint8Array>({
        async start(controller) {
          // As fetch does, an abort makes the body fail.
          init?.signal?.addEventListener('abort', () => controller.error(new DOMException('Aborted', 'AbortError')), { once: true })
          for (const piece of pieces) {
            await new Promise(resolve => setTimeout(resolve, gapMs))
            if (init?.signal?.aborted) return
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk({ content: piece }))}\n\n`))
          }
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk({}, 'stop'))}\n\ndata: [DONE]\n\n`))
          controller.close()
        },
      })
      return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
    }
  }

  it('lets a long reply run as long as text keeps coming', async () => {
    const client = createExternalModelClient(slowSse(['a', 'b', 'c', 'd', 'e', 'f'], 30), { timeoutMs: 80 })
    let text = ''
    for await (const part of client.stream!({ model, prompt: 'Hi' })) text += part
    expect(text).toBe('abcdef')
  })

  it('says the request timed out when the server never answers', async () => {
    const neverAnswers: typeof fetch = (_url, init) => new Promise((_, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true })
    })
    const client = createExternalModelClient(neverAnswers, { timeoutMs: 50 })
    const failure = await (async () => { for await (const part of client.stream!({ model, prompt: 'Hi' })) void part })().catch(error => error)

    expect(failure).toBeInstanceOf(ExternalModelError)
    expect(failure.status).toBe(408)
  })

  it('says the request timed out when the text stops coming', async () => {
    const client = createExternalModelClient(slowSse(['a', 'b'], 120), { timeoutMs: 50 })
    const failure = await (async () => { for await (const part of client.stream!({ model, prompt: 'Hi' })) void part })().catch(error => error)

    expect(failure).toBeInstanceOf(ExternalModelError)
    expect(failure.status).toBe(408)
  })
})

describe('a quota that is used up', () => {
  const geminiQuota = (quotaId: string, limit: number, retry: string) => JSON.stringify([{
    error: {
      code: 429,
      message: `You exceeded your current quota, please check your plan and billing details.\n* Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, limit: ${limit}\nPlease retry in ${retry}.`,
      status: 'RESOURCE_EXHAUSTED',
      details: [{ '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [{ quotaId }] }],
    },
  }])
  const refused = (body: string, status = 429) => new Response(body, { status, statusText: '', headers: { 'content-type': 'application/json' } })

  it("is not retried when the day's quota is gone", async () => {
    let requests = 0
    const client = createExternalModelClient(async () => { requests += 1; return refused(geminiQuota('GenerateRequestsPerDayPerProjectPerModel-FreeTier', 250, '7h12m')) })
    const failure = await client.complete({ model, prompt: 'Hi' }).catch(error => error)

    expect(requests).toBe(1)
    expect(failure.code).toBe('quota_exhausted')
    expect(failure.message).toMatch(/^额度已用完/)
    expect(isPermanentModelError(failure)).toBe(true)
  })

  it('is not retried when the model has no free quota at all', async () => {
    const failure = await failureOf(refused(geminiQuota('GenerateRequestsPerMinutePerProjectPerModel-FreeTier', 0, '30s')))
    expect(failure.code).toBe('quota_exhausted')
  })

  it("is not retried when the account's balance is gone", async () => {
    const openai = await failureOf(refused(JSON.stringify({ error: { message: 'You exceeded your current quota.', type: 'insufficient_quota', code: 'insufficient_quota' } })))
    const zhipu = await failureOf(refused(JSON.stringify({ error: { code: '1113', message: '您的账户已欠费，请充值后重试。' } })))
    expect(openai.code).toBe('quota_exhausted')
    expect(zhipu.code).toBe('quota_exhausted')
  })

  it('leaves a per-minute limit to the retries', async () => {
    const failure = await failureOf(refused(geminiQuota('GenerateRequestsPerMinutePerProjectPerModel-FreeTier', 10, '41s')))
    expect(failure.code).toBeUndefined()
    expect(failure.status).toBe(429)
    expect(isPermanentModelError(failure)).toBe(false)
  })
})

describe('a backup model', () => {
  const busy = () => new Response(JSON.stringify([{ error: { code: 503, message: 'This model is currently experiencing high demand.', status: 'UNAVAILABLE' } }]), { status: 503, statusText: '', headers: { 'content-type': 'application/json' } })
  const answer = (text: string) => sse(chunk({ content: text }), chunk({}, 'stop'))
  const modelAsked = async (init?: RequestInit) => JSON.parse(String(init?.body)).model as string

  it('answers when the main model is busy, and the reply is told so', async () => {
    const asked: string[] = []
    const client = createExternalModelClient(async (_url, init) => {
      const name = await modelAsked(init)
      asked.push(name)
      return name === 'main' ? busy() : answer('from backup')
    })
    const used: Array<[string, string | undefined]> = []
    let text = ''
    for await (const part of client.stream!({ model: { ...model, modelName: 'main', fallbackModelName: 'lite' }, prompt: 'Hi', onFallback: (name, reason) => used.push([name, reason]) })) text += part

    expect(text).toBe('from backup')
    expect(asked).toEqual(['main', 'lite'])
    // Why the main model did not answer, in the server's words.
    expect(used).toEqual([['lite', 'HTTP 503：This model is currently experiencing high demand.']])
  })

  it('is not asked when the main model refuses the request itself, or has no backup', async () => {
    const asked: string[] = []
    const refuses = createExternalModelClient(async (_url, init) => {
      asked.push(await modelAsked(init))
      return new Response(JSON.stringify({ error: { message: 'Invalid API key' } }), { status: 401, headers: { 'content-type': 'application/json' } })
    })
    await expect((async () => { for await (const part of refuses.stream!({ model: { ...model, modelName: 'main', fallbackModelName: 'lite' }, prompt: 'Hi' })) void part })()).rejects.toThrow('Invalid API key')
    expect(asked).toEqual(['main'])

    const noBackup = createExternalModelClient(async () => busy())
    const failure = await (async () => { for await (const part of noBackup.stream!({ model: { ...model, modelName: 'main' }, prompt: 'Hi' })) void part })().catch(error => error)
    expect(failure.status).toBe(503)
  })

  it("gives the backup's own failure when it fails too", async () => {
    const client = createExternalModelClient(async (_url, init) => (await modelAsked(init)) === 'main'
      ? busy()
      : new Response(JSON.stringify({ error: { message: 'lite is down' } }), { status: 500, headers: { 'content-type': 'application/json' } }))
    const failure = await (async () => { for await (const part of client.stream!({ model: { ...model, modelName: 'main', fallbackModelName: 'lite' }, prompt: 'Hi' })) void part })().catch(error => error)
    expect(failure.message).toContain('lite is down')
  })
})
