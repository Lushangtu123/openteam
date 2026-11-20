// 用量: what the group's members answered, read from the message history. Each finished reply counts
// once, for its member, group and day; an API model's reply adds the tokens its model reported, and
// its cost when the user entered that model's price (src/group/pricing.ts). A web member's own
// answers count for its site; one its backup model wrote is the model's. A reply written by an API
// model's backup model (another model name at the same address) is not priced: its price is not known.
import { chatSiteLabel, type ChatSite } from './chatSites'
import { replyCost } from './pricing'
import type { ExternalModelConfig, GroupMessage, GroupRole, OpenTeamStore } from './types'

export type UsageRange = 'today' | '7d' | '30d' | 'all'

export interface UsageQuery {
  range: UsageRange
  chatId?: string
  now: number
}

export interface UsageCost {
  CNY?: number
  USD?: number
}

export interface UsageRow {
  replies: number
  inputTokens: number
  outputTokens: number
  cost: UsageCost
  // Tokens of replies with no price: their model has none, or a backup model wrote them.
  unpricedTokens: number
}

export interface MemberUsage extends UsageRow {
  roleId: string
  name: string
  chatName: string
  kind: 'api' | 'web' | 'agent'
  // The model's name, or the site's for a web member.
  model: string
  // Answers its backup model wrote (a web member's).
  backupReplies: number
  // The member has left its group.
  removed?: boolean
}

export interface ChatUsage extends UsageRow {
  chatId: string
  name: string
}

export interface DayUsage extends UsageRow {
  // Local day, YYYY-MM-DD.
  day: string
}

export interface SiteReplies {
  site: ChatSite
  label: string
  replies: number
  // How many prompts the site had taken the day it last said it was limiting (网站额度提醒).
  limitCount?: number
}

export interface UsageReport {
  total: UsageRow
  members: MemberUsage[]
  chats: ChatUsage[]
  days: DayUsage[]
  sites: SiteReplies[]
}

const DAY_MS = 24 * 60 * 60 * 1000

export function computeUsage(store: OpenTeamStore, query: UsageQuery): UsageReport {
  const start = rangeStart(query.range, query.now)
  const total = emptyRow()
  const members = new Map<string, MemberUsage>()
  const chats = new Map<string, ChatUsage>()
  const days = new Map<string, DayUsage>()
  const sites = new Map<ChatSite, number>()

  for (const chatId of store.chatOrder) {
    if (query.chatId && chatId !== query.chatId) continue
    const chat = store.chatsById[chatId]
    if (!chat) continue
    for (const id of chat.messageIds) {
      const message = store.messagesById[id]
      if (!message || message.type !== 'assistant' || message.status !== 'received' || !message.roleId) continue
      if (message.createdAt < start || message.createdAt > query.now) continue
      const role = store.rolesById[message.roleId] as GroupRole | undefined
      const web = role ? role.modelSource !== 'external' : !message.usage && !message.modelId
      const model = modelFor(store, message, role)
      const byBackup = web && Boolean(message.answeredByFallback)
      const tokens = { input: message.usage?.inputTokens ?? 0, output: message.usage?.outputTokens ?? (message.usage?.inputTokens === undefined ? message.usage?.totalTokens ?? 0 : 0) }
      // A model's own backup model (another name at its address) has no known price.
      const ownBackup = Boolean(message.answeredByFallback && model?.fallbackModelName && message.answeredByFallback === model.fallbackModelName)
      const cost = model?.pricing && !ownBackup ? replyCost(model.pricing, message.usage) : undefined
      const add = (row: UsageRow) => {
        row.replies += 1
        row.inputTokens += tokens.input
        row.outputTokens += tokens.output
        if (cost !== undefined && model?.pricing) row.cost[model.pricing.currency] = (row.cost[model.pricing.currency] ?? 0) + cost
        else row.unpricedTokens += tokens.input + tokens.output
      }
      add(total)
      let member = members.get(message.roleId)
      if (!member) {
        const memberModel = role && !web ? store.settings.externalModelsById[role.externalModelId ?? ''] : undefined
        member = {
          ...emptyRow(),
          roleId: message.roleId,
          name: role?.name ?? message.roleName ?? message.roleId,
          chatName: chat.name,
          kind: web ? 'web' : memberModel?.format === 'local-agent' ? 'agent' : 'api',
          model: web ? chatSiteLabel(role?.chatSite ?? store.settings.defaultChatSite) : memberModel?.name ?? model?.name ?? '',
          backupReplies: 0,
          ...(role ? {} : { removed: true }),
        }
        members.set(message.roleId, member)
      }
      add(member)
      if (byBackup) member.backupReplies += 1
      const chatRow = chats.get(chat.id) ?? { ...emptyRow(), chatId: chat.id, name: chat.name }
      chats.set(chat.id, chatRow)
      add(chatRow)
      const day = localDay(message.createdAt)
      const dayRow = days.get(day) ?? { ...emptyRow(), day }
      days.set(day, dayRow)
      add(dayRow)
      if (web && !byBackup && role) {
        const site = role.chatSite ?? store.settings.defaultChatSite
        sites.set(site, (sites.get(site) ?? 0) + 1)
      }
    }
  }

  return {
    total,
    members: [...members.values()].sort((left, right) => right.replies - left.replies),
    chats: [...chats.values()].sort((left, right) => right.replies - left.replies),
    days: dayList(query.range, start, query.now, days),
    sites: [...sites.entries()].sort((left, right) => right[1] - left[1]).map(([site, replies]) => {
      const limitCount = store.siteUsageBySite?.[site]?.limitCount
      return { site, label: chatSiteLabel(site), replies, ...(limitCount ? { limitCount } : {}) }
    }),
  }
}

// The cost in yuan and dollars, each with two decimals, or two significant digits below a cent.
export function formatCost(cost: UsageCost): string {
  const parts = (['CNY', 'USD'] as const).flatMap(currency => {
    const amount = cost[currency]
    if (amount === undefined) return []
    const text = amount === 0 || amount >= 0.01 ? amount.toFixed(2) : String(Number(amount.toPrecision(2)))
    return [`${currency === 'CNY' ? '¥' : '$'}${text}`]
  })
  return parts.length > 0 ? parts.join(' + ') : '—'
}

// The model that wrote a reply: the one recorded on it, else the member's (older replies).
function modelFor(store: OpenTeamStore, message: GroupMessage, role: GroupRole | undefined): ExternalModelConfig | undefined {
  if (message.modelId) return store.settings.externalModelsById[message.modelId]
  if (role?.modelSource === 'external' && role.externalModelId) return store.settings.externalModelsById[role.externalModelId]
  return undefined
}

function rangeStart(range: UsageRange, now: number): number {
  if (range === 'all') return 0
  const midnight = new Date(now)
  midnight.setHours(0, 0, 0, 0)
  const back = range === 'today' ? 0 : range === '7d' ? 6 : 29
  return new Date(midnight.getFullYear(), midnight.getMonth(), midnight.getDate() - back).getTime()
}

// Every day of a fixed range, empty ones included; for 全部, only the days with answers.
function dayList(range: UsageRange, start: number, now: number, days: Map<string, DayUsage>): DayUsage[] {
  if (range === 'all') return [...days.values()].sort((left, right) => left.day.localeCompare(right.day))
  const list: DayUsage[] = []
  for (let time = start; time <= now; time += DAY_MS) {
    const day = localDay(time)
    if (list.some(row => row.day === day)) continue
    list.push(days.get(day) ?? { ...emptyRow(), day })
  }
  return list
}

function emptyRow(): UsageRow {
  return { replies: 0, inputTokens: 0, outputTokens: 0, cost: {}, unpricedTokens: 0 }
}

function localDay(time: number): string {
  const date = new Date(time)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}
