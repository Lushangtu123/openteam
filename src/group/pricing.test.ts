import { describe, expect, it } from 'vitest'
import { readModelPricing, replyCost } from './pricing'

describe('a model\'s price', () => {
  it('is read as numbers per million tokens, in yuan unless dollars are chosen', () => {
    expect(readModelPricing({ input: '2', output: 8, currency: 'CNY' })).toEqual({ input: 2, output: 8, currency: 'CNY' })
    expect(readModelPricing({ input: 0.27, output: '', currency: 'USD' })).toEqual({ input: 0.27, output: 0, currency: 'USD' })
    expect(readModelPricing({ input: '', output: '' })).toBeUndefined()
    expect(readModelPricing(undefined)).toBeUndefined()
  })

  it('is refused when not a number from 0 up', () => {
    expect(() => readModelPricing({ input: 'abc' })).toThrow('单价要写成 0 或更大的数字')
    expect(() => readModelPricing({ output: -1 })).toThrow('单价')
  })

  it('makes a reply\'s cost from its tokens', () => {
    expect(replyCost({ input: 2, output: 8, currency: 'CNY' }, { inputTokens: 1_000_000, outputTokens: 500_000 })).toBe(6)
    expect(replyCost({ input: 2, output: 8, currency: 'CNY' }, { inputTokens: 1500 })).toBeCloseTo(0.003)
    expect(replyCost({ input: 2, output: 8, currency: 'CNY' }, { totalTokens: 10 })).toBeUndefined()
    expect(replyCost({ input: 2, output: 8, currency: 'CNY' }, undefined)).toBeUndefined()
  })
})
