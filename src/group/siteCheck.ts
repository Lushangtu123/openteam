// 网站自检: a group with one member on each AI website, asked to reply OK. Whether each one's reply
// is read back tells whether OpenTeam can still send to and read from that site, which is what a
// site's redesign breaks. The result is read from the group as it stands.
//
// The group stays, and the next check asks it again (src/background/siteCheckHandlers.ts): each site
// keeps one conversation, instead of a new chat in the user's account at every check. A site that
// fails is asked once more, its page loaded again (SiteCheckState.retry), before it is reported:
// a slow page or a passing server error is not the site having changed.
import { CHAT_SITE_INFO, CHAT_SITES, type ChatSite } from './chatSites'
import type { GroupChat, GroupMessage, OpenTeamLanguage, OpenTeamStore } from './types'

// Every AI site OpenTeam opens. A site that refuses to run inside the page shows as a page problem.
export const SITE_CHECK_SITES: ChatSite[] = [...CHAT_SITES]

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
  // Asked the second time, its page loaded again: this is that try's result.
  retried?: boolean
}

const NEEDS_ATTENTION: ReadonlySet<SiteCheckOutcome> = new Set(['login', 'page-problem', 'failed', 'not-sent', 'no-reply'])
// Tried again before it is reported. Signing in is the user's to do.
const RETRIED: ReadonlySet<SiteCheckOutcome> = new Set(['page-problem', 'failed', 'not-sent', 'no-reply'])

// The questions the checks of this group asked. A group from before marks none: its first message
// is the question.
export function siteCheckQuestionIds(store: Pick<OpenTeamStore, 'messagesById'>, chat: GroupChat): string[] {
  if (chat.siteCheck?.questionIds?.length) return chat.siteCheck.questionIds
  const first = chat.messageIds.map(id => store.messagesById[id]).find(message => message?.type === 'user')
  return first ? [first.id] : []
}

// A 网站自检 group the user went on using: changed in its settings (renamed, pinned, made 协作…) or
// sent a message of their own besides the checks' questions. The next check neither asks it again
// nor removes it (src/background/siteCheckHandlers.ts).
export function siteCheckGroupInUse(store: Pick<OpenTeamStore, 'messagesById'>, chat: GroupChat): boolean {
  if (chat.siteCheck?.kept) return true
  const questions = new Set(siteCheckQuestionIds(store, chat))
  return chat.messageIds.some(id => store.messagesById[id]?.type === 'user' && !questions.has(id))
}

export function siteCheckNeedsAttention(outcome: SiteCheckOutcome): boolean {
  return NEEDS_ATTENTION.has(outcome)
}

export function siteCheckRetries(outcome: SiteCheckOutcome): boolean {
  return RETRIED.has(outcome)
}

// This check's question: marked, or in a group from before, its first message. A group asked again
// has none until this check asks.
function checkQuestion(store: Pick<OpenTeamStore, 'messagesById'>, chat: GroupChat): GroupMessage | undefined {
  const check = chat.siteCheck
  if (check?.questionId) return store.messagesById[check.questionId]
  if (check?.questionIds?.length) return undefined
  return chat.messageIds.map(id => store.messagesById[id]).find(message => message?.type === 'user')
}

// When the last question asked has had its time: the page redraws then.
export function siteCheckDeadline(store: Pick<OpenTeamStore, 'messagesById'>, chat: GroupChat): number | undefined {
  const retry = chat.siteCheck?.retry?.messageId ? store.messagesById[chat.siteCheck.retry.messageId] : undefined
  const question = retry ?? checkQuestion(store, chat)
  return question ? question.createdAt + SITE_CHECK_TIMEOUT_MS : undefined
}

export function siteCheckResults(store: Pick<OpenTeamStore, 'messagesById' | 'rolesById'>, chat: GroupChat, now: number): SiteCheckResult[] {
  const messages = chat.messageIds.map(id => store.messagesById[id]).filter(Boolean)
  const first = checkQuestion(store, chat)
  const retry = chat.siteCheck?.retry
  return chat.roleIds.flatMap((roleId): SiteCheckResult[] => {
    const role = store.rolesById[roleId]
    if (!role?.chatSite || role.modelSource === 'external') return []
    const site = role.chatSite
    const retried = Boolean(retry?.roleIds.includes(roleId) && !retry.error)
    const base = { roleId, site, label: CHAT_SITE_INFO[site].label, ...(retried ? { retried: true } : {}) }
    // Being asked again: its page is loading.
    if (retried && !retry?.messageId) return [{ ...base, outcome: 'waiting' }]
    const question = retried ? store.messagesById[retry!.messageId!] : first
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

// What a site's result means, and what to do about it.
export function siteCheckExplanation(result: SiteCheckResult, en: boolean): string {
  if (result.retried && result.outcome === 'waiting') return en ? 'The first try did not work: its page was loaded again and it is asked once more.' : '第一次没成功，已重新打开页面，正在再问一次。'
  const said = outcomeExplanation(result, en)
  if (!result.retried || !siteCheckNeedsAttention(result.outcome)) return said
  return en ? `${said} Same on a second try with the page loaded again.` : `${said}重新打开页面再问了一次，还是这样。`
}

function outcomeExplanation(result: SiteCheckResult, en: boolean): string {
  const detail = result.detail ? (en ? ` (${result.detail})` : `（${result.detail}）`) : ''
  switch (result.outcome) {
    case 'ok':
      return en ? 'Sends, and its reply is read back.' : '能发送，也能读到回复。'
    case 'waiting':
      return en ? 'Waiting for its reply.' : '正在等它回复。'
    case 'login':
      return en ? 'The site asks to sign in. Click "Open site" on its member card, sign in, then check again.' : '网站要求登录。点成员卡片上的「打开网站」登录后，再查一次。'
    case 'page-problem':
      return en ? `Something covers or breaks the page${detail}. Open the AI pages to see it.` : `页面被挡住或出错${detail}。打开 AI 网页看看。`
    case 'failed':
      return en ? `Sending or reading the reply failed${detail}.` : `发送或读取回复失败${detail}。`
    case 'not-sent':
      return en ? 'The question did not reach the page in 5 minutes.' : '5 分钟内没能把提问送进页面。'
    case 'no-reply':
      return en ? 'The question reached the page, but no reply was read in 5 minutes. The site may have changed.' : '提问已送进页面，但 5 分钟内没读到回复，网站可能改版了。'
  }
}
