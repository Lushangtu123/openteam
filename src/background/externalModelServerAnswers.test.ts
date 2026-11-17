import { describe, expect, it } from 'vitest'
import { createExternalModelClient, ExternalModelError } from './externalModelClient'
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

async function failureOf(response: Response, attempts?: number): Promise<ExternalModelError> {
  const client = createExternalModelClient(async () => response.clone())
  if (attempts) {
    try {
      await client.complete({ model, prompt: 'Hi' })
    } catch (error) {
      return error as ExternalModelError
    }
    throw new Error('expected the request to fail')
  }
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
    const failure = await failureOf(new Response('<html>Gateway sk-secret-123 down</html>', { status: 502, statusText: '' }), 1)

    expect(failure.status).toBe(502)
    expect(failure.message).toContain('HTTP 502')
    expect(failure.message).toContain('Gateway')
    expect(failure.message).not.toContain('sk-secret-123')
  })
})
