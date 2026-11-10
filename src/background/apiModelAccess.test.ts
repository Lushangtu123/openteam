import { describe, expect, it, vi } from 'vitest'
import type { ExternalModelConfig } from '../group/types'
import { HOST_ACCESS_ERROR_CODE, requireApiModelAccess } from './apiModelAccess'
import { ExternalModelError } from './externalModelClient'

const apiModel: ExternalModelConfig = { id: 'm1', name: 'DeepSeek API', format: 'openai', baseUrl: 'https://api.deepseek.com/v1', apiKey: 'sk-test', modelName: 'deepseek-chat', createdAt: 1, updatedAt: 1 }
const localAgent: ExternalModelConfig = { ...apiModel, id: 'm2', name: 'Claude Code', format: 'local-agent', baseUrl: '', apiKey: '', localAgentId: 'claude-code', workspace: '/tmp/work' }

function client() {
  return {
    stream: vi.fn(async function* () { yield '你'; yield '好' }),
    complete: vi.fn(async () => ({ content: 'OK' })),
  }
}

async function read(stream: AsyncIterable<string>): Promise<string> {
  let text = ''
  for await (const chunk of stream) text += chunk
  return text
}

describe('API model access', () => {
  it('calls the model when its address is allowed', async () => {
    const inner = client()
    const guarded = requireApiModelAccess(inner, async () => true)

    expect(await read(guarded.stream!({ model: apiModel, prompt: 'hi' }))).toBe('你好')
    expect(await guarded.complete({ model: apiModel, prompt: 'hi' })).toEqual({ content: 'OK' })
  })

  it('refuses without calling the model when its address is not allowed, saying where to allow it', async () => {
    const inner = client()
    const guarded = requireApiModelAccess(inner, async () => false)

    const error = await guarded.complete({ model: apiModel, prompt: 'hi' }).catch(reason => reason)
    expect(error).toBeInstanceOf(ExternalModelError)
    expect(error.code).toBe(HOST_ACCESS_ERROR_CODE)
    expect(error.message).toContain('api.deepseek.com')
    expect(error.message).toContain('「DeepSeek API」')
    expect(error.friendlyMessage).toBe(error.message)
    // A 4xx status is not retried.
    expect(error.status).toBe(403)
    await expect(read(guarded.stream!({ model: apiModel, prompt: 'hi' }))).rejects.toThrow('api.deepseek.com')
    expect(inner.complete).not.toHaveBeenCalled()
    expect(inner.stream).not.toHaveBeenCalled()
  })

  it('does not ask about a local agent, which has no address', async () => {
    const hasAccess = vi.fn(async () => false)
    const guarded = requireApiModelAccess(client(), hasAccess)

    expect(await guarded.complete({ model: localAgent, prompt: 'hi' })).toEqual({ content: 'OK' })
    expect(hasAccess).not.toHaveBeenCalled()
  })
})
