// 定时自检: the 网站自检 (src/group/siteCheck.ts) run on set days at a set time, so that a site's
// redesign is found before the user next needs it. The run (src/background/siteCheckScheduler.ts)
// opens OpenTeam, checks, goes back to the group that was open, and removes its group when every
// site worked; when some did not, the group stays for the user to look at and, if a destination is
// chosen, those sites are sent there. Nothing is sent when every site worked.
import { readWeeklyTimes } from './scheduledTasks'
import { siteCheckExplanation, siteCheckTimeline, siteCheckNeedsAttention, type SiteCheckOutcome, type SiteCheckResult } from './siteCheck'
import type { RoundResult } from './resultDestinations'
import { CHAT_SITES, type ChatSite } from './chatSites'
import type { ScheduledTaskDelivery } from './types'

export interface SiteCheckSchedule {
  // 0 is Sunday, as Date.getDay().
  days: number[]
  // HH:MM, 24-hour.
  time: string
  enabled: boolean
  // Where the sites that need attention are sent (OpenTeamSettings.resultDestinations).
  destinationId?: string
  // Times up to this moment are never run: when it was set, switched on or changed.
  armedAt: number
  // The latest time already run or skipped.
  lastSlotAt?: number
  lastRun?: SiteCheckRun
}

export interface SiteCheckRun {
  at: number
  // ok: every site worked; problems: some need attention; failed: the check could not run; skipped:
  // the time was missed by too long (the browser was closed).
  status: 'ok' | 'problems' | 'failed' | 'skipped'
  slotAt?: number
  // The check's group, kept when some sites need attention.
  chatId?: string
  problems?: Array<{ site: ChatSite; outcome: SiteCheckOutcome }>
  detail?: string
  delivery?: ScheduledTaskDelivery
  // The page's notice that its result was not sent was put away (知道了).
  noticeDismissed?: boolean
}

export interface SiteCheckScheduleInput {
  days: number[]
  time: string
  enabled: boolean
  destinationId?: string
}

export function readSiteCheckScheduleInput(value: unknown): SiteCheckScheduleInput {
  const input = typeof value === 'object' && value !== null ? value as Record<string, unknown> : {}
  const { days, time } = readWeeklyTimes(input)
  const destinationId = typeof input.destinationId === 'string' && input.destinationId ? input.destinationId : undefined
  return { days, time, enabled: input.enabled !== false, ...(destinationId ? { destinationId } : {}) }
}

// What goes to the destination: one entry for each site that needs attention.
export function siteCheckReport(results: SiteCheckResult[], schedule: string, english: boolean): RoundResult {
  const problems = results.filter(result => siteCheckNeedsAttention(result.outcome))
  const hidden = problems.filter(result => result.outcome === 'page-hidden').length
  const attention = problems.length - hidden
  return {
    chatName: english ? 'Site check' : '网站自检',
    schedule,
    question: english
      ? hidden
        ? `${attention ? `${attention} of ${results.length} sites need attention; ${hidden}` : `${hidden} of ${results.length} sites`} were not checked: the OpenTeam page was not on screen. The others work.`
        : `${problems.length} of ${results.length} sites need attention; the others work.`
      : `${results.length} 个网站里有 ${[attention ? `${attention} 个需要处理` : '', hidden ? `${hidden} 个没查成：检查时 OpenTeam 页面不在前台。` : ''].filter(Boolean).join('，')}${hidden ? '' : '，'}其余正常。`,
    answers: problems.map(result => ({ member: result.label, text: [siteCheckExplanation(result, english), siteCheckTimeline(result, english)].filter(Boolean).join('\n'), failed: true })),
  }
}

const RUN_STATUSES: ReadonlySet<SiteCheckRun['status']> = new Set(['ok', 'problems', 'failed', 'skipped'])
const OUTCOMES: ReadonlySet<SiteCheckOutcome> = new Set(['ok', 'waiting', 'login', 'page-problem', 'failed', 'not-sent', 'no-reply', 'page-hidden'])

export function normalizeSiteCheckSchedule(raw: unknown): SiteCheckSchedule | undefined {
  if (!isRecord(raw)) return undefined
  let times: { days: number[]; time: string }
  try {
    times = readWeeklyTimes(raw)
  } catch {
    return undefined
  }
  const schedule: SiteCheckSchedule = {
    ...times,
    enabled: raw.enabled !== false,
    armedAt: typeof raw.armedAt === 'number' ? raw.armedAt : 0,
    ...(typeof raw.destinationId === 'string' && raw.destinationId ? { destinationId: raw.destinationId } : {}),
    ...(typeof raw.lastSlotAt === 'number' ? { lastSlotAt: raw.lastSlotAt } : {}),
  }
  const run = normalizeRun(raw.lastRun)
  if (run) schedule.lastRun = run
  return schedule
}

function normalizeRun(raw: unknown): SiteCheckRun | undefined {
  if (!isRecord(raw) || typeof raw.at !== 'number' || !RUN_STATUSES.has(raw.status as SiteCheckRun['status'])) return undefined
  const problems = Array.isArray(raw.problems)
    ? raw.problems.filter((item): item is { site: ChatSite; outcome: SiteCheckOutcome } => isRecord(item) && CHAT_SITES.includes(item.site as ChatSite) && OUTCOMES.has(item.outcome as SiteCheckOutcome)).map(item => ({ site: item.site, outcome: item.outcome }))
    : []
  const delivery = raw.delivery
  return {
    at: raw.at,
    status: raw.status as SiteCheckRun['status'],
    ...(typeof raw.slotAt === 'number' ? { slotAt: raw.slotAt } : {}),
    ...(typeof raw.chatId === 'string' && raw.chatId ? { chatId: raw.chatId } : {}),
    ...(problems.length ? { problems } : {}),
    ...(typeof raw.detail === 'string' && raw.detail ? { detail: raw.detail } : {}),
    ...(isRecord(delivery) && (delivery.status === 'sending' || delivery.status === 'sent' || delivery.status === 'failed') && typeof delivery.at === 'number'
      ? { delivery: { status: delivery.status, at: delivery.at, destination: typeof delivery.destination === 'string' ? delivery.destination : '', ...(typeof delivery.detail === 'string' && delivery.detail ? { detail: delivery.detail } : {}) } }
      : {}),
    ...(raw.noticeDismissed === true ? { noticeDismissed: true } : {}),
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
