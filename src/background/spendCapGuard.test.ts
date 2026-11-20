import { describe, expect, it, vi } from 'vitest'
import { createDefaultStore } from '../group/store'
import { SPEND_CAP_CODE } from '../group/spendCap'
import type { ExternalModelConfig, OpenTeamStore } from '../group/types'
import type { ExternalModelClient, ExternalModelCompletionInput } from './externalModelClient'
import { guardSpendCaps } from './spendCapGuard'

const NOW = new Date(2026, 10, 19, 10).getTime()

function setup(fields: Partial<ExternalModelConfig> = {}) {
  let store: OpenTeamStore = createDefaultStore()
  store.settings.language = 'zh-CN'
  const model: ExternalModelConfig = { id: 'ds', name: 'DeepSeek', format: 'openai', baseUrl: 'https://api.deepseek.com/v1', apiKey: 'k', modelName: 'deepseek-chat', pricing: { input: 2, output: 8, currency: 'CNY' }, dailyCap: 5, createdAt: 0, updatedAt: 0, ...fields }
  store.settings.externalModelsById = { ds: model }
  // Each call reports the tokens it used, as the API client does at the end of a stream.
  let tokens = { inputTokens: 1_000_000, outputTokens: 0 }
  const inner: ExternalModelClient = {
    stream: vi.fn(async function* (input: ExternalModelCompletionInput) {
      yield 'OK'
      input.onUsage?.(tokens)
    }),
    complete: vi.fn(async (input: ExternalModelCompletionInput) => {
      input.onUsage?.(tokens)
      return { content: 'OK' }
    }),
  }
  const notify = vi.fn()
  const broadcastStoreUpdated = vi.fn()
  const client = guardSpendCaps(inner, {
    loadStore: async () => structuredClone(store),
    mutateStore: async <T>(mutator: (current: OpenTeamStore) => T | Promise<T>) => {
      const next = structuredClone(store)
      const result = await mutator(next)
      store = next
      return { store, result }
    },
    broadcastStoreUpdated,
    now: () => NOW,
    notify,
  })
  const read = async (input: Partial<ExternalModelCompletionInput> = {}) => {
    let text = ''
    for await (const chunk of client.stream!({ model, prompt: 'hi', ...input })) text += chunk
    return text
  }
  return { client, inner, model, notify, broadcastStoreUpdated, read, store: () => store, setTokens: (value: typeof tokens) => { tokens = value } }
}

describe('every API call goes through the spending cap', () => {
  it('adds what each call cost to the model\'s spend today, and still tells the caller its tokens', async () => {
    const { read, store, broadcastStoreUpdated } = setup()
    const onUsage = vi.fn()
    expect(await read({ onUsage })).toBe('OK')
    expect(onUsage).toHaveBeenCalledWith({ inputTokens: 1_000_000, outputTokens: 0 })
    expect(store().modelSpendById?.ds).toEqual({ day: '2026-11-19', spent: 2 })
    expect(broadcastStoreUpdated).toHaveBeenCalled()
  })

  it('tells the user at 80% and at the cap, then refuses calls with the reason', async () => {
    const { read, notify, inner, setTokens } = setup()
    await read()
    await read()
    expect(notify).toHaveBeenLastCalledWith('openteam-spend-cap-ds', '「DeepSeek」今天快到花费上限', '估算已花 ¥4.00，每日上限 ¥5.00；到上限后今天不再调用。')
    setTokens({ inputTokens: 500_000, outputTokens: 0 })
    await read()
    expect(notify).toHaveBeenLastCalledWith('openteam-spend-cap-ds', '「DeepSeek」今天已到花费上限', expect.stringContaining('估算已花 ¥5.00'))
    expect(notify).toHaveBeenCalledTimes(2)

    const calls = vi.mocked(inner.stream!).mock.calls.length
    const refused = await read().then(() => undefined, (error: { code?: string; message: string }) => error)
    expect(refused?.code).toBe(SPEND_CAP_CODE)
    expect(refused?.message).toBe('「DeepSeek」今天的估算花费 ¥5.00 已到每日上限 ¥5.00，明天 0 点前不再调用。点「今天继续用」可以放开今天的上限。')
    expect(vi.mocked(inner.stream!).mock.calls.length).toBe(calls)
  })

  it('refuses a one-off request too, such as a project plan or team formation', async () => {
    const { client, model, store, inner } = setup()
    store().modelSpendById = { ds: { day: '2026-11-19', spent: 6 } }
    await expect(client.complete({ model, prompt: 'plan' })).rejects.toMatchObject({ code: SPEND_CAP_CODE })
    expect(inner.complete).not.toHaveBeenCalled()
  })

  it('goes by the model\'s current settings, and lets calls through once the cap is lifted for today', async () => {
    const { read, model, store } = setup()
    store().modelSpendById = { ds: { day: '2026-11-19', spent: 6 } }
    // The cap was raised after the request was made.
    store().settings.externalModelsById.ds = { ...model, dailyCap: 10 }
    expect(await read()).toBe('OK')
    store().modelSpendById = { ds: { day: '2026-11-19', spent: 12, lifted: true } }
    expect(await read()).toBe('OK')
  })

  it('leaves local agents and models without a price alone', async () => {
    const agent = setup({ format: 'local-agent', pricing: undefined, dailyCap: undefined })
    expect(await agent.read()).toBe('OK')
    expect(agent.store().modelSpendById?.ds).toBeUndefined()
    const unpriced = setup({ pricing: undefined, dailyCap: undefined })
    expect(await unpriced.read()).toBe('OK')
    expect(unpriced.store().modelSpendById?.ds).toBeUndefined()
  })
})
