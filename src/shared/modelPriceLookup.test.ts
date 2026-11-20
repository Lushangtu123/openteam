import { describe, expect, it, vi } from 'vitest'
import { fetchPriceList, matchModelPrice, readPriceList, type PriceEntry } from './modelPriceLookup'

// As OpenRouter lists them: dollars per token, as strings.
const raw = {
  data: [
    { id: 'google/gemini-3.8-flash', name: 'Google: Gemini 3.8 Flash', created: 300, pricing: { prompt: '0.000000825', completion: '0.000004125' } },
    { id: 'google/gemini-3.7-flash', name: 'Google: Gemini 3.7 Flash', created: 200, pricing: { prompt: '0.00000075', completion: '0.00000375' } },
    { id: 'google/gemini-3.5-flash-lite', name: 'Google: Gemini 3.5 Flash Lite', created: 150, pricing: { prompt: '0.0000003', completion: '0.0000025' } },
    { id: 'google/gemini-3.1-flash-image', name: 'Google: Gemini 3.1 Flash Image', created: 250, pricing: { prompt: '0.0000005', completion: '0.000003' } },
    { id: 'google/gemini-3.1-pro-preview', name: 'Google: Gemini 3.1 Pro Preview', created: 100, pricing: { prompt: '0.000002', completion: '0.000012' } },
    { id: 'google/gemini-3.8-flash:free', name: 'free', created: 300, pricing: { prompt: '0', completion: '0' } },
    { id: 'anthropic/claude-sonnet-5.5', name: 'Anthropic: Claude Sonnet 5.5', created: 90, pricing: { prompt: '0.000003', completion: '0.000015' } },
    { id: 'deepseek/deepseek-v4-flash', name: 'DeepSeek: V4 Flash', created: 80, pricing: { prompt: '0.00000009', completion: '0.00000018' } },
    { id: 'openrouter/auto', name: 'Auto', created: 70, pricing: { prompt: '-1', completion: '-1' } },
    { id: 'broken' },
  ],
}

const GEMINI = 'https://generativelanguage.googleapis.com/v1beta/openai'
const ids = (entries: PriceEntry[]) => entries.map(entry => entry.id)

describe('the price list', () => {
  it('is read as dollars per million tokens, leaving out free variants and models without a fixed price', () => {
    const list = readPriceList(raw)
    expect(list.find(entry => entry.id === 'google/gemini-3.8-flash')).toEqual({ id: 'google/gemini-3.8-flash', name: 'Google: Gemini 3.8 Flash', created: 300, input: 0.825, output: 4.125 })
    expect(ids(list)).not.toContain('google/gemini-3.8-flash:free')
    expect(ids(list)).not.toContain('openrouter/auto')
    expect(ids(list)).not.toContain('broken')
  })

  it('is fetched without a key, and a failure says so', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(raw)))
    expect((await fetchPriceList(fetchImpl as unknown as typeof fetch)).length).toBe(7)
    expect(fetchImpl).toHaveBeenCalledWith('https://openrouter.ai/api/v1/models', { credentials: 'omit' })
    const failing = vi.fn(async () => new Response('nope', { status: 503 }))
    await expect(fetchPriceList(failing as unknown as typeof fetch)).rejects.toThrow('没能读到价格表（HTTP 503）')
  })
})

describe('a model\'s price in the list', () => {
  const list = readPriceList(raw)

  it('is found by its exact name, whatever the address writes it like', () => {
    expect(matchModelPrice(list, 'gemini-3.7-flash', GEMINI).exact?.id).toBe('google/gemini-3.7-flash')
    expect(matchModelPrice(list, 'models/gemini-3.7-flash', GEMINI).exact?.id).toBe('google/gemini-3.7-flash')
    // Anthropic writes versions with dashes, the list with dots.
    expect(matchModelPrice(list, 'claude-sonnet-5-5', 'https://api.anthropic.com/v1').exact?.id).toBe('anthropic/claude-sonnet-5.5')
    // Through OpenRouter the name is the list's own.
    expect(matchModelPrice(list, 'deepseek/deepseek-v4-flash', 'https://openrouter.ai/api/v1').exact?.id).toBe('deepseek/deepseek-v4-flash')
  })

  it('offers the matching models of the same maker, newest first, for a name such as gemini-flash-latest', () => {
    const match = matchModelPrice(list, 'gemini-flash-latest', GEMINI)
    expect(match.exact).toBeUndefined()
    // Image models only when the name asks for one.
    expect(ids(match.candidates)).toEqual(['google/gemini-3.8-flash', 'google/gemini-3.7-flash', 'google/gemini-3.5-flash-lite'])
    expect(ids(matchModelPrice(list, 'gemini-pro-latest', GEMINI).candidates)).toEqual(['google/gemini-3.1-pro-preview'])
  })

  it('finds nothing for a model the list does not have', () => {
    expect(matchModelPrice(list, 'qwen-plus', 'https://dashscope.aliyuncs.com/compatible-mode/v1')).toEqual({ candidates: [] })
  })
})
