// 网站失效提醒: OpenTeam works a member's AI site through its page (the input box, the send button,
// where the reply shows), so a redesign of the site shows as a member failing in one of those ways.
// Each such failure is counted per site; a reply read from the site clears the count. Once a site
// has failed SITE_FAULT_THRESHOLD times (different prompts or members) with no reply in between, the
// page shows a notice for it. A 网站自检 asks a failing site a second time, its page loaded again
// (src/group/siteCheck.ts), so a site failing both shows the notice. Signing in, a verification page, a site that is limiting or busy, or a
// connection that dropped are not counted: they are not the site's layout.
import { chatSiteLabel, CHAT_SITES, type ChatSite } from './chatSites'
import { isSiteLimitMessage } from './siteUsage'
import type { OpenTeamStore } from './types'

export const SITE_FAULT_THRESHOLD = 2
const KEYS_KEPT = 10
const DETAIL_MAX = 160

// Where on the page it failed: the input box, the send button, reading the reply, or something the
// page should have had and did not.
export type SiteFaultStep = 'input' | 'send' | 'reply' | 'page'

export interface SiteFault {
  // Failures since the site last replied.
  count: number
  // What each failure was for (member and prompt), so a retry of the same prompt counts once.
  keys: string[]
  firstAt: number
  lastAt: number
  step: SiteFaultStep
  detail?: string
  // 知道了: the notice stays away until the site replies again and then fails again.
  dismissed?: boolean
}

export type SiteFaultRecord = Partial<Record<ChatSite, SiteFault>>

export interface SiteFaultNotice {
  site: ChatSite
  label: string
  fault: SiteFault
}

const STEP_PATTERNS: Array<[SiteFaultStep, RegExp]> = [
  ['reply', /^RESPONSE_NOT_FOUND$|页面上没有找到这条回复|页面上只有之前的回复/],
  ['send', /发送按钮/],
  ['input', /输入框|editor did not accept|editor is not a textarea/i],
  ['page', /^Element not found/],
]

// The step a member's failure points at, when it looks like the site's page changed.
export function layoutFaultStep(reason: string | undefined): SiteFaultStep | undefined {
  const text = reason?.trim()
  if (!text || isSiteLimitMessage(text)) return undefined
  return STEP_PATTERNS.find(([, pattern]) => pattern.test(text))?.[0]
}

export interface SiteFaultInput {
  key: string
  step: SiteFaultStep
  detail?: string
  now: number
}

// Counts a failure. Resolves to whether this one makes the notice show.
export function recordSiteFault(store: OpenTeamStore, site: ChatSite, input: SiteFaultInput): boolean {
  const record = store.siteFaultsBySite ??= {}
  const before = record[site]
  if (before?.keys.includes(input.key)) return false
  const wasShown = Boolean(before && before.count >= SITE_FAULT_THRESHOLD && !before.dismissed)
  const keys = [...(before?.keys ?? []).filter(key => key !== input.key), input.key].slice(-KEYS_KEPT)
  const count = (before?.count ?? 0) + 1
  const detail = input.detail?.trim().slice(0, DETAIL_MAX)
  record[site] = {
    count,
    keys,
    firstAt: before?.firstAt ?? input.now,
    lastAt: input.now,
    step: input.step,
    ...(detail ? { detail } : {}),
    ...(before?.dismissed ? { dismissed: true } : {}),
  }
  return !wasShown && count >= SITE_FAULT_THRESHOLD && !before?.dismissed
}

// The site replied. Resolves to whether there was anything to clear.
export function clearSiteFault(store: OpenTeamStore, site: ChatSite): boolean {
  if (!store.siteFaultsBySite?.[site]) return false
  delete store.siteFaultsBySite[site]
  return true
}

export function dismissSiteFault(store: OpenTeamStore, site: ChatSite): boolean {
  const fault = store.siteFaultsBySite?.[site]
  if (!fault || fault.dismissed) return false
  fault.dismissed = true
  return true
}

// The sites the page tells the user about, the latest failure first.
export function siteFaultNotices(store: Pick<OpenTeamStore, 'siteFaultsBySite'>): SiteFaultNotice[] {
  return CHAT_SITES.flatMap((site): SiteFaultNotice[] => {
    const fault = store.siteFaultsBySite?.[site]
    return fault && fault.count >= SITE_FAULT_THRESHOLD && !fault.dismissed ? [{ site, label: chatSiteLabel(site), fault }] : []
  }).sort((a, b) => b.fault.lastAt - a.fault.lastAt)
}

const STEP_TEXT: Record<SiteFaultStep, { zh: string; en: string }> = {
  input: { zh: '找不到输入框，或者输入框不接受文字', en: 'the input box could not be found or would not take the text' },
  send: { zh: '找不到发送按钮', en: 'the send button could not be found' },
  reply: { zh: '提问发出去了，但读不到回复', en: 'the question went in, but its reply could not be read' },
  page: { zh: '页面上缺了 OpenTeam 要用的部分', en: 'the page lacks a part OpenTeam needs' },
}

export function siteFaultStepText(step: SiteFaultStep, english: boolean): string {
  return english ? STEP_TEXT[step].en : STEP_TEXT[step].zh
}

// "ChatGPT may have changed: the last 3 times, …"
export function siteFaultMessage(notice: SiteFaultNotice, english: boolean): string {
  const { label, fault } = notice
  const step = siteFaultStepText(fault.step, english)
  return english
    ? `${label} may have changed its pages: ${fault.count} failures in a row since its last reply; last time ${step}. Its members cannot be used until OpenTeam is updated for it.`
    : `${label} 可能改版了：上次回复以来连续失败 ${fault.count} 次，最近一次${step}。要等 OpenTeam 更新适配后它的成员才能用。`
}

export function normalizeSiteFaultRecord(raw: unknown): SiteFaultRecord {
  const result: SiteFaultRecord = {}
  if (!isRecord(raw)) return result
  for (const site of CHAT_SITES) {
    const value = raw[site]
    if (!isRecord(value) || typeof value.count !== 'number' || value.count < 1) continue
    if (typeof value.firstAt !== 'number' || typeof value.lastAt !== 'number') continue
    const step = STEP_PATTERNS.some(([name]) => name === value.step) ? value.step as SiteFaultStep : 'page'
    const keys = Array.isArray(value.keys) ? value.keys.filter((key): key is string => typeof key === 'string').slice(-KEYS_KEPT) : []
    result[site] = {
      count: Math.floor(value.count),
      keys,
      firstAt: value.firstAt,
      lastAt: value.lastAt,
      step,
      ...(typeof value.detail === 'string' && value.detail ? { detail: value.detail.slice(0, DETAIL_MAX) } : {}),
      ...(value.dismissed === true ? { dismissed: true } : {}),
    }
  }
  return result
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
