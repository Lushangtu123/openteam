// A model's price as the user entered it (用量, src/group/usageStats.ts): per million input and output
// tokens, in yuan or dollars. Read from the model form and from storage alike.
import type { ModelPricing } from './types'

const MAX_PRICE = 100_000

// Undefined when neither price is given, so clearing both fields removes the pricing. Throws for a
// price that is not a number from 0 up.
export function readModelPricing(raw: unknown): ModelPricing | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const value = raw as Record<string, unknown>
  const input = readPrice(value.input)
  const output = readPrice(value.output)
  if (input === undefined && output === undefined) return undefined
  return { input: input ?? 0, output: output ?? 0, currency: value.currency === 'USD' ? 'USD' : 'CNY' }
}

function readPrice(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') return undefined
  const number = typeof value === 'number' ? value : Number(String(value).trim())
  if (!Number.isFinite(number) || number < 0 || number > MAX_PRICE) throw new Error('单价要写成 0 或更大的数字（每百万 token 的价格）')
  return number
}

// What a reply cost, from its tokens; undefined without tokens.
export function replyCost(pricing: ModelPricing, usage: { inputTokens?: number; outputTokens?: number; totalTokens?: number } | undefined): number | undefined {
  if (!usage || (usage.inputTokens === undefined && usage.outputTokens === undefined)) return undefined
  return ((usage.inputTokens ?? 0) * pricing.input + (usage.outputTokens ?? 0) * pricing.output) / 1_000_000
}
