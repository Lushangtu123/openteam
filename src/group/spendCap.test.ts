import { describe, expect, it } from 'vitest'
import { capBlocks, capReachedReason, capNotice, liftCapToday, modelSpendToday, normalizeModelSpend, readDailyCap, recordModelSpend } from './spendCap'
import { createDefaultStore } from './store'
import type { ExternalModelConfig, OpenTeamStore } from './types'

const at = (day: number, hour = 10) => new Date(2026, 10, day, hour).getTime()

function setup(fields: Partial<ExternalModelConfig> = {}): { store: OpenTeamStore; model: ExternalModelConfig } {
  const store = createDefaultStore()
  const model: ExternalModelConfig = { id: 'ds', name: 'DeepSeek', format: 'openai', baseUrl: 'https://api.deepseek.com/v1', apiKey: 'k', modelName: 'deepseek-chat', pricing: { input: 2, output: 8, currency: 'CNY' }, dailyCap: 5, createdAt: 0, updatedAt: 0, ...fields }
  store.settings.externalModelsById = { ds: model }
  return { store, model }
}

// ¥2 per million input tokens and ¥8 per million output: 1M in + 250k out is ¥4.
const fourYuan = { inputTokens: 1_000_000, outputTokens: 250_000 }
const oneYuan = { inputTokens: 500_000, outputTokens: 0 }

describe('a model\'s daily cap as entered', () => {
  it('is a number above 0, or none when left empty', () => {
    expect(readDailyCap('5')).toBe(5)
    expect(readDailyCap(' 0.5 ')).toBe(0.5)
    expect(readDailyCap('')).toBeUndefined()
    expect(readDailyCap(undefined)).toBeUndefined()
    expect(() => readDailyCap('0')).toThrow('每日花费上限要写成大于 0 的数字')
    expect(() => readDailyCap('abc')).toThrow('每日花费上限要写成大于 0 的数字')
  })
})

describe('what a model spent today', () => {
  it('adds each call\'s estimated cost, and starts again at 0 the next day', () => {
    const { store, model } = setup()
    recordModelSpend(store, model, oneYuan, at(19, 9))
    recordModelSpend(store, model, oneYuan, at(19, 11))
    expect(modelSpendToday(store, 'ds', at(19, 12)).spent).toBe(2)
    expect(modelSpendToday(store, 'ds', at(20, 8)).spent).toBe(0)
    recordModelSpend(store, model, oneYuan, at(20, 9))
    expect(store.modelSpendById?.ds).toEqual({ day: '2026-11-20', spent: 1 })
  })

  it('is not kept for a model without a price, or a call without tokens', () => {
    const { store, model } = setup({ pricing: undefined, dailyCap: undefined })
    expect(recordModelSpend(store, model, fourYuan, at(19))).toBeUndefined()
    expect(store.modelSpendById?.ds).toBeUndefined()
    const priced = setup()
    recordModelSpend(priced.store, priced.model, undefined, at(19))
    expect(priced.store.modelSpendById?.ds).toBeUndefined()
  })

  it('says once when it passes 80% of the cap, and once when it reaches the cap', () => {
    const { store, model } = setup()
    expect(recordModelSpend(store, model, oneYuan, at(19, 9))).toBeUndefined()
    expect(recordModelSpend(store, model, { inputTokens: 1_500_000 }, at(19, 10))).toBe('warn')
    expect(recordModelSpend(store, model, { inputTokens: 100_000 }, at(19, 11))).toBeUndefined()
    expect(recordModelSpend(store, model, oneYuan, at(19, 12))).toBe('reached')
    expect(recordModelSpend(store, model, oneYuan, at(19, 13))).toBeUndefined()
    // A single call that jumps past both says only that the cap is reached.
    const jump = setup()
    expect(recordModelSpend(jump.store, jump.model, { inputTokens: 3_000_000 }, at(19))).toBe('reached')
  })
})

describe('a call to a model at its cap', () => {
  it('is refused until midnight, unless the user lifted the cap for today', () => {
    const { store, model } = setup()
    recordModelSpend(store, model, fourYuan, at(19, 9))
    expect(capBlocks(store, model, at(19, 10))).toBe(false)
    recordModelSpend(store, model, oneYuan, at(19, 10))
    expect(capBlocks(store, model, at(19, 11))).toBe(true)
    expect(capBlocks(store, model, at(20, 0))).toBe(false)
    liftCapToday(store, 'ds', at(19, 12))
    expect(capBlocks(store, model, at(19, 13))).toBe(false)
    // Lifted for that day only.
    recordModelSpend(store, model, { inputTokens: 3_000_000 }, at(20, 9))
    expect(capBlocks(store, model, at(20, 10))).toBe(true)
  })

  it('is not refused for a model with no cap or no price', () => {
    const { store, model } = setup({ dailyCap: undefined })
    recordModelSpend(store, model, { inputTokens: 10_000_000 }, at(19))
    expect(capBlocks(store, model, at(19))).toBe(false)
    const unpriced = setup({ pricing: undefined })
    expect(capBlocks(unpriced.store, unpriced.model, at(19))).toBe(false)
  })

  it('says why, and what to do, in Chinese and English', () => {
    const { store, model } = setup({ pricing: { input: 2, output: 8, currency: 'USD' } })
    recordModelSpend(store, model, { inputTokens: 2_600_000 }, at(19))
    const spend = modelSpendToday(store, 'ds', at(19))
    expect(capReachedReason(model, spend, false)).toBe('「DeepSeek」今天的估算花费 $5.20 已到每日上限 $5.00，明天 0 点前不再调用。点「今天继续用」可以放开今天的上限。')
    expect(capReachedReason(model, spend, true)).toBe('"DeepSeek" has spent an estimated $5.20 today, reaching its daily cap of $5.00; it is not called again until midnight. Click Keep using today to lift the cap for today.')
    expect(capNotice(model, spend, 'warn', false)).toEqual({ title: '「DeepSeek」今天快到花费上限', message: '估算已花 $5.20，每日上限 $5.00；到上限后今天不再调用。' })
    expect(capNotice(model, spend, 'reached', true)).toEqual({ title: '"DeepSeek" reached its daily spending cap', message: 'An estimated $5.20 spent, cap $5.00. Calls stop until midnight; open the Usage window to keep using it today.' })
  })
})

describe('kept spend records', () => {
  it('keep only well-formed entries', () => {
    expect(normalizeModelSpend({ ds: { day: '2026-11-19', spent: 2, warned: true, lifted: true }, bad: { day: 'x', spent: 1 }, neg: { day: '2026-11-19', spent: -1 } })).toEqual({ ds: { day: '2026-11-19', spent: 2, warned: true, lifted: true } })
    expect(normalizeModelSpend(undefined)).toEqual({})
  })
})
