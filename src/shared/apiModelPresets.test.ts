import { describe, expect, it, vi } from 'vitest'
import { API_MODEL_PRESETS, listModelNames, presetForBaseUrl } from './apiModelPresets'
import { normalizeBaseUrl } from './modelBaseUrl'

describe('API model presets', () => {
  it('give each provider a web address, a format and a page for its key', () => {
    expect(API_MODEL_PRESETS.length).toBeGreaterThanOrEqual(8)
    for (const preset of API_MODEL_PRESETS) {
      expect(new URL(preset.baseUrl).protocol).toBe('https:')
      expect(new URL(preset.keyPage).protocol).toBe('https:')
      expect(['openai', 'anthropic']).toContain(preset.format)
      expect(preset.exampleModel).toBeTruthy()
    }
    expect(new Set(API_MODEL_PRESETS.map(preset => preset.id)).size).toBe(API_MODEL_PRESETS.length)
  })

  it('keep their addresses as OpenTeam sends them, with no /v1 added', () => {
    for (const preset of API_MODEL_PRESETS) expect(normalizeBaseUrl(preset.baseUrl, preset.format)).toBe(preset.baseUrl)
  })

  it('are found again from a saved address', () => {
    expect(presetForBaseUrl('https://generativelanguage.googleapis.com/v1beta/openai/')?.id).toBe('gemini')
    expect(presetForBaseUrl('https://api.deepseek.com')?.id).toBe('deepseek')
    expect(presetForBaseUrl('https://my-proxy.example.test/v1')).toBeUndefined()
  })
})

describe('listing a provider\'s models', () => {
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

  it('asks an OpenAI-format server for /models with the key, and lists the chat models', async () => {
    const fetchImpl = vi.fn(async () => json({ data: [{ id: 'deepseek-reasoner' }, { id: 'deepseek-chat' }, { id: 'text-embedding-3-small' }, { id: 'deepseek-chat' }] }))
    const names = await listModelNames({ format: 'openai', baseUrl: 'https://api.deepseek.com', apiKey: 'sk-1' }, fetchImpl)

    expect(names).toEqual(['deepseek-chat', 'deepseek-reasoner'])
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://api.deepseek.com/v1/models')
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer sk-1')
  })

  it('drops the models/ prefix Gemini puts on its names', async () => {
    const fetchImpl = vi.fn(async () => json({ object: 'list', data: [{ id: 'models/gemini-flash-latest' }, { id: 'models/gemini-flash-lite-latest' }, { id: 'models/imagen-4.0-generate-001' }] }))
    const names = await listModelNames({ format: 'openai', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', apiKey: 'k' }, fetchImpl)

    expect(names).toEqual(['gemini-flash-latest', 'gemini-flash-lite-latest'])
    expect((fetchImpl.mock.calls[0] as unknown as [string])[0]).toBe('https://generativelanguage.googleapis.com/v1beta/openai/models')
  })

  it('sends an Anthropic key the way Anthropic asks for it', async () => {
    const fetchImpl = vi.fn(async () => json({ data: [{ id: 'claude-sonnet-5-5', display_name: 'Claude Sonnet 5.5' }] }))
    const names = await listModelNames({ format: 'anthropic', baseUrl: 'https://api.anthropic.com/v1', apiKey: 'sk-ant' }, fetchImpl)

    expect(names).toEqual(['claude-sonnet-5-5'])
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://api.anthropic.com/v1/models')
    const headers = new Headers(init.headers)
    expect(headers.get('x-api-key')).toBe('sk-ant')
    expect(headers.get('anthropic-version')).toBeTruthy()
    expect(headers.get('authorization')).toBeNull()
  })

  it("says what the server said when it refuses, without the key", async () => {
    const fetchImpl = vi.fn(async () => json([{ error: { code: 400, message: 'API key not valid. Please pass a valid API key. (sk-bad)' } }], 400))
    await expect(listModelNames({ format: 'openai', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', apiKey: 'sk-bad' }, fetchImpl))
      .rejects.toThrow('HTTP 400：API key not valid. Please pass a valid API key. (***)')
  })

  it('says when the answer holds no models', async () => {
    const fetchImpl = vi.fn(async () => json({ data: [] }))
    await expect(listModelNames({ format: 'openai', baseUrl: 'https://api.example.test/v1', apiKey: 'k' }, fetchImpl)).rejects.toThrow('没有列出任何模型')
  })
})
