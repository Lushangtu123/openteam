// The real AI library against a stand-in Gemini server: after the model reads a page, the next request
// must carry the tool call's thought signature back, or Gemini refuses it (seen live).
import { describe, expect, it, vi } from 'vitest'
import type { ExternalModelConfig } from '../group/types'
import { createExternalModelClient } from './externalModelClient'

const gemini: ExternalModelConfig = { id: 'g', name: 'Gemini API', format: 'openai', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', apiKey: 'test-key', modelName: 'gemini-flash-latest', createdAt: 0, updatedAt: 0 }

function sse(chunks: unknown[]): Response {
  const body = chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n'
  return new Response(body, { headers: { 'content-type': 'text/event-stream' } })
}

const chunk = (delta: Record<string, unknown>, finish: string | null = null) => ({ id: 'x', object: 'chat.completion.chunk', created: 1, model: 'gemini-flash-latest', choices: [{ index: 0, delta, finish_reason: finish }] })

describe('a Gemini member reading a page', () => {
  it('sends the tool call\'s thought signature back with the page, and gets its answer', async () => {
    const requests: Array<Record<string, unknown>> = []
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>
      requests.push(body)
      if (requests.length === 1) {
        return sse([
          chunk({ role: 'assistant', tool_calls: [{ index: 0, id: 'call-1', type: 'function', function: { name: 'read_web_page', arguments: '{"url":"https://www.npr.org/a"}' }, extra_content: { google: { thought_signature: 'SIG-123' } } }] }),
          chunk({}, 'tool_calls'),
        ])
      }
      // Gemini refuses a follow-up whose tool call lost its signature.
      const messages = body.messages as Array<{ role: string; tool_calls?: Array<{ extra_content?: { google?: { thought_signature?: string } } }> }>
      const call = messages.find(message => message.role === 'assistant')?.tool_calls?.[0]
      if (call?.extra_content?.google?.thought_signature !== 'SIG-123') {
        return new Response(JSON.stringify([{ error: { code: 400, message: 'Function call is missing a thought_signature in functionCall parts.', status: 'INVALID_ARGUMENT' } }]), { status: 400, headers: { 'content-type': 'application/json' } })
      }
      return sse([chunk({ role: 'assistant', content: 'NPR 报道了记者会。' }), chunk({}, 'stop')])
    })
    const readWebPage = vi.fn(async () => 'page text')
    let text = ''
    for await (const piece of createExternalModelClient(fetchImpl as unknown as typeof fetch).stream!({ model: gemini, prompt: '看看这个网页', readWebPage })) text += piece
    expect(readWebPage).toHaveBeenCalledWith('https://www.npr.org/a')
    expect(text).toBe('NPR 报道了记者会。')
    expect(requests).toHaveLength(2)
    const toolMessage = (requests[1].messages as Array<{ role: string; content?: string }>).find(message => message.role === 'tool')
    expect(toolMessage?.content).toContain('page text')
  })
})
