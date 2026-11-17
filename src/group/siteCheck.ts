// 网站自检: a throwaway group with one member on each AI website, asked to reply OK. Whether each
// one's reply is read back tells whether OpenTeam can still send to and read from that site, which
// is what a site's redesign breaks. The result is read from the group as it stands.
import { CHAT_SITE_INFO, CHAT_SITES, type ChatSite } from './chatSites'
import type { GroupChat, OpenTeamLanguage, OpenTeamStore } from './types'

// Every site that can open inside OpenTeam: claude.ai refuses to run inside other pages.
export const SITE_CHECK_SITES: ChatSite[] = CHAT_SITES.filter(site => site !== 'claude')

// A site that has not replied by then is reported as not answering. Slow sites take minutes (Qwen
// took three in a live check), so this is longer than that.
export const SITE_CHECK_TIMEOUT_MS = 300_000

export const SITE_CHECK_PROMPT = '这是 OpenTeam 的网站自检，请只回复：OK'
export const SITE_CHECK_PERSONA = '你在帮 OpenTeam 检查这个网站能否正常收发消息。'

export type SiteCheckOutcome =
  | 'ok' // its reply was read back
  | 'waiting'
  | 'login' // the site asks to sign in
  | 'page-problem' // a verification page, an error page, a dialog over the page, no input box
  | 'failed' // sending or reading the reply failed
  | 'not-sent' // the question never reached the page
  | 'no-reply' // it was sent, but no reply was read

export interface SiteCheckResult {
  roleId: string
  site: ChatSite
  label: string
  outcome: SiteCheckOutcome
  detail?: string
}

const NEEDS_ATTENTION: ReadonlySet<SiteCheckOutcome> = new Set(['login', 'page-problem', 'failed', 'not-sent', 'no-reply'])

export function siteCheckNeedsAttention(outcome: SiteCheckOutcome): boolean {
  return NEEDS_ATTENTION.has(outcome)
}

export function siteCheckResults(store: Pick<OpenTeamStore, 'messagesById' | 'rolesById'>, chat: GroupChat, now: number): SiteCheckResult[] {
  const messages = chat.messageIds.map(id => store.messagesById[id]).filter(Boolean)
  const question = messages.find(message => message.type === 'user')
  return chat.roleIds.flatMap((roleId): SiteCheckResult[] => {
    const role = store.rolesById[roleId]
    if (!role?.chatSite || role.modelSource === 'external') return []
    const site = role.chatSite
    const base = { roleId, site, label: CHAT_SITE_INFO[site].label }
    if (!question) return [{ ...base, outcome: 'waiting' }]

    const reply = messages.filter(message => message.type === 'assistant' && message.roleId === roleId && message.sourceMessageId === question.id).slice(-1)[0]
    // What the reply says outranks what the page last reported.
    if (reply?.status === 'received' && reply.content.trim()) return [{ ...base, outcome: 'ok' }]
    if (reply?.status === 'error') return [{ ...base, outcome: 'failed', detail: failureReason(reply.content) }]

    const health = role.siteHealth
    if (health?.status === 'unauthorized') return [{ ...base, outcome: 'login' }]
    if (health?.status === 'blocked' || health?.status === 'error') return [{ ...base, outcome: 'page-problem', detail: health.detail || health.reason }]

    const delivery = question.deliveryStatus?.[roleId]
    if (delivery === 'error') return [{ ...base, outcome: 'failed' }]
    if (now - question.createdAt > SITE_CHECK_TIMEOUT_MS) return [{ ...base, outcome: delivery === 'pending' || !delivery ? 'not-sent' as const : 'no-reply' }]
    return [{ ...base, outcome: 'waiting' }]
  })
}

// A failed reply's text without the note that it failed or the hint to retry.
function failureReason(content: string): string | undefined {
  const reason = content.replace(/\n+可以点击下方的.*$/s, '').replace(/^回复失败：/, '').trim()
  return reason || undefined
}

export function siteCheckSummary(results: SiteCheckResult[], language: OpenTeamLanguage): string {
  const ok = results.filter(result => result.outcome === 'ok').length
  const attention = results.filter(result => siteCheckNeedsAttention(result.outcome)).length
  const waiting = results.filter(result => result.outcome === 'waiting').length
  if (language === 'en') {
    const parts = [`${ok} working`, attention ? `${attention} needs attention` : '', waiting ? `${waiting} waiting` : ''].filter(Boolean)
    return `${waiting ? 'Checking' : 'Check finished'}: ${parts.join(', ')}`
  }
  const parts = [`${ok} 个正常`, attention ? `${attention} 个需要处理` : '', waiting ? `${waiting} 个等待中` : ''].filter(Boolean)
  return `${waiting ? '检查中' : '检查完成'}：${parts.join('，')}`
}
