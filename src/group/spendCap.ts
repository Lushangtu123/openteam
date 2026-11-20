// 花费上限: a daily cap on what an API model may spend, as estimated from the price the user entered
// (src/group/pricing.ts). Every call's cost is added to the model's spend for the day (the background
// does this in one place, src/background/spendCapGuard.ts, so summaries, project tasks, team
// formation and a web member's backup all count). At 80% the user is told; at the cap the model is
// not called again until local midnight, unless the user clicks 今天继续用 for the rest of the day.
// A call answered by the model's own backup (another name at its address) is counted at the main
// model's price: its own price is not known.
import { replyCost } from './pricing'
import { formatCost } from './usageStats'
import type { ExternalModelConfig, OpenTeamStore } from './types'

export interface ModelSpend {
  // Local day, YYYY-MM-DD.
  day: string
  spent: number
  // The user was told it passed 80% / reached the cap that day.
  warned?: boolean
  reached?: boolean
  // The user lifted the cap for that day.
  lifted?: boolean
}

export const SPEND_CAP_CODE = 'spend_cap'
const WARN_SHARE = 0.8
const MAX_CAP = 1_000_000

// Undefined when left empty, so clearing the field removes the cap.
export function readDailyCap(raw: unknown): number | undefined {
  if (raw === undefined || raw === null || (typeof raw === 'string' && !raw.trim())) return undefined
  const value = typeof raw === 'number' ? raw : Number(String(raw).trim())
  if (!Number.isFinite(value) || value <= 0 || value > MAX_CAP) throw new Error('每日花费上限要写成大于 0 的数字')
  return value
}

// The model's spend record for today: a fresh one when the last was another day.
export function modelSpendToday(store: OpenTeamStore, modelId: string, now: number): ModelSpend {
  const day = localDay(now)
  const kept = store.modelSpendById?.[modelId]
  return kept?.day === day ? kept : { day, spent: 0 }
}

// Adds a call's cost to the model's spend today. Says when that passed 80% of the cap or reached it,
// once each a day.
export function recordModelSpend(store: OpenTeamStore, model: ExternalModelConfig, usage: { inputTokens?: number; outputTokens?: number } | undefined, now: number): 'warn' | 'reached' | undefined {
  if (!model.pricing) return undefined
  const cost = replyCost(model.pricing, usage)
  if (cost === undefined) return undefined
  const spend = { ...modelSpendToday(store, model.id, now) }
  spend.spent = Math.round((spend.spent + cost) * 1e6) / 1e6
  let notice: 'warn' | 'reached' | undefined
  const cap = model.dailyCap
  if (cap !== undefined && !spend.lifted) {
    if (spend.spent >= cap && !spend.reached) {
      notice = 'reached'
      spend.reached = true
      spend.warned = true
    } else if (spend.spent >= cap * WARN_SHARE && !spend.warned) {
      notice = 'warn'
      spend.warned = true
    }
  }
  store.modelSpendById = { ...(store.modelSpendById ?? {}), [model.id]: spend }
  return notice
}

// Whether a call to the model is refused now.
export function capBlocks(store: OpenTeamStore, model: ExternalModelConfig, now: number): boolean {
  if (model.format === 'local-agent' || !model.pricing || model.dailyCap === undefined) return false
  const spend = modelSpendToday(store, model.id, now)
  return !spend.lifted && spend.spent >= model.dailyCap
}

// 今天继续用: no cap for the model for the rest of today.
export function liftCapToday(store: OpenTeamStore, modelId: string, now: number): void {
  store.modelSpendById = { ...(store.modelSpendById ?? {}), [modelId]: { ...modelSpendToday(store, modelId, now), lifted: true } }
}

export function capReachedReason(model: ExternalModelConfig, spend: ModelSpend, english: boolean): string {
  const spent = money(model, spend.spent)
  const cap = money(model, model.dailyCap ?? 0)
  return english
    ? `"${model.name}" has spent an estimated ${spent} today, reaching its daily cap of ${cap}; it is not called again until midnight. Click Keep using today to lift the cap for today.`
    : `「${model.name}」今天的估算花费 ${spent} 已到每日上限 ${cap}，明天 0 点前不再调用。点「今天继续用」可以放开今天的上限。`
}

// The desktop notification at 80% and at the cap.
export function capNotice(model: ExternalModelConfig, spend: ModelSpend, kind: 'warn' | 'reached', english: boolean): { title: string; message: string } {
  const spent = money(model, spend.spent)
  const cap = money(model, model.dailyCap ?? 0)
  if (kind === 'warn') {
    return english
      ? { title: `"${model.name}" is close to its daily spending cap`, message: `An estimated ${spent} spent, cap ${cap}; calls stop once it is reached.` }
      : { title: `「${model.name}」今天快到花费上限`, message: `估算已花 ${spent}，每日上限 ${cap}；到上限后今天不再调用。` }
  }
  return english
    ? { title: `"${model.name}" reached its daily spending cap`, message: `An estimated ${spent} spent, cap ${cap}. Calls stop until midnight; open the Usage window to keep using it today.` }
    : { title: `「${model.name}」今天已到花费上限`, message: `估算已花 ${spent}，每日上限 ${cap}。明天 0 点前不再调用；要继续用，在「用量」窗口里点「今天继续用」。` }
}

export function money(model: ExternalModelConfig, amount: number): string {
  return formatCost({ [model.pricing?.currency ?? 'CNY']: amount })
}

export function normalizeModelSpend(raw: unknown): Record<string, ModelSpend> {
  const result: Record<string, ModelSpend> = {}
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return result
  for (const [modelId, value] of Object.entries(raw as Record<string, unknown>)) {
    const item = value as Record<string, unknown> | undefined
    if (!item || typeof item.day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(item.day)) continue
    if (typeof item.spent !== 'number' || !Number.isFinite(item.spent) || item.spent < 0) continue
    result[modelId] = {
      day: item.day,
      spent: item.spent,
      ...(item.warned === true ? { warned: true } : {}),
      ...(item.reached === true ? { reached: true } : {}),
      ...(item.lifted === true ? { lifted: true } : {}),
    }
  }
  return result
}

function localDay(time: number): string {
  const date = new Date(time)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}
