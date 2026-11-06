import type { RoleSiteHealthReason, RoleSiteHealthStatus } from '../group/types'

// How long an opened page may take to connect before it counts as not responding. A page that
// redirects to a sign-in domain (accounts.google.com, auth.openai.com, …) never connects, because
// OpenTeam's content script only runs on the AI sites themselves.
export const UNRESPONSIVE_AFTER_MS = 20_000

export type RolePageHealthStatus =
  | 'closed'
  | 'opening'
  | 'unresponsive'
  | 'checking'
  | 'loading'
  | 'ready'
  | 'generating'
  | 'login-required'
  | 'blocked'
  | 'error'

export interface RolePageHealth {
  status: RolePageHealthStatus
  reason?: RoleSiteHealthReason
  detail?: string
}

export interface SiteHealthReport {
  status: RoleSiteHealthStatus
  reason?: RoleSiteHealthReason
  detail?: string
}

// States where a message sent to the role is unlikely to arrive.
export const PROBLEM_HEALTH_STATUSES: ReadonlySet<RolePageHealthStatus> = new Set(['unresponsive', 'login-required', 'blocked', 'error'])

export interface RoleHealthTracker {
  // The role's page was created, recovered or navigated to a new document.
  frameOpened(chatId: string, roleId: string): void
  // The page's content script completed the handshake.
  frameConnected(chatId: string, roleId: string): void
  frameClosed(chatId: string, roleId: string): void
  siteReported(chatId: string, roleId: string, report: SiteHealthReport): void
  get(chatId: string, roleId: string): RolePageHealth
  dispose(): void
}

export interface RoleHealthTrackerOptions {
  now?: () => number
  setTimer?: (handler: () => void, ms: number) => number
  clearTimer?: (timer: number) => void
  unresponsiveAfterMs?: number
  onChange(chatId: string, roleId: string): void
}

interface FrameHealthRecord {
  phase: 'opening' | 'connected'
  openedAt: number
  report?: SiteHealthReport
  timer?: number
}

export function createRoleHealthTracker(options: RoleHealthTrackerOptions): RoleHealthTracker {
  const now = options.now ?? (() => Date.now())
  const setTimer = options.setTimer ?? ((handler, ms) => window.setTimeout(handler, ms))
  const clearTimer = options.clearTimer ?? (timer => window.clearTimeout(timer))
  const unresponsiveAfterMs = options.unresponsiveAfterMs ?? UNRESPONSIVE_AFTER_MS
  const records = new Map<string, FrameHealthRecord>()

  function replace(chatId: string, roleId: string, record: FrameHealthRecord | undefined): void {
    const key = roleKey(chatId, roleId)
    const previous = records.get(key)
    if (previous?.timer !== undefined) clearTimer(previous.timer)
    if (record) records.set(key, record)
    else records.delete(key)
    options.onChange(chatId, roleId)
  }

  return {
    frameOpened(chatId, roleId) {
      const record: FrameHealthRecord = { phase: 'opening', openedAt: now() }
      replace(chatId, roleId, record)
      record.timer = setTimer(() => {
        record.timer = undefined
        if (records.get(roleKey(chatId, roleId)) === record && record.phase === 'opening') options.onChange(chatId, roleId)
      }, unresponsiveAfterMs)
    },
    frameConnected(chatId, roleId) {
      // A frame can complete the handshake more than once (assignments already in flight), and a
      // repeat must keep the report that arrived in between. A new document goes through
      // frameOpened first, which drops the old document's report.
      const existing = records.get(roleKey(chatId, roleId))
      if (existing?.phase === 'connected') return
      replace(chatId, roleId, { phase: 'connected', openedAt: existing?.openedAt ?? now() })
    },
    frameClosed(chatId, roleId) {
      if (records.has(roleKey(chatId, roleId))) replace(chatId, roleId, undefined)
    },
    siteReported(chatId, roleId, report) {
      const existing = records.get(roleKey(chatId, roleId))
      // A report also proves the page is connected, even if the handshake notice was missed.
      replace(chatId, roleId, { phase: 'connected', openedAt: existing?.openedAt ?? now(), report })
    },
    get(chatId, roleId) {
      const record = records.get(roleKey(chatId, roleId))
      if (!record) return { status: 'closed' }
      if (record.phase === 'opening') return { status: now() - record.openedAt >= unresponsiveAfterMs ? 'unresponsive' : 'opening' }
      if (!record.report) return { status: 'checking' }
      return healthFromReport(record.report)
    },
    dispose() {
      for (const record of records.values()) {
        if (record.timer !== undefined) clearTimer(record.timer)
      }
      records.clear()
    },
  }
}

function healthFromReport(report: SiteHealthReport): RolePageHealth {
  const status: RolePageHealthStatus = report.status === 'unauthorized' ? 'login-required' : report.status
  return {
    status,
    ...(report.reason ? { reason: report.reason } : {}),
    ...(report.detail ? { detail: report.detail } : {}),
  }
}

function roleKey(chatId: string, roleId: string): string {
  return `${chatId}:${roleId}`
}

// Short label for a role's page health, in the Chinese source copy that translateUi localizes.
export function rolePageHealthLabel(health: RolePageHealth): string {
  switch (health.status) {
    case 'closed': return '网页未打开'
    case 'opening': return '正在打开网页'
    case 'unresponsive': return '网页没有响应'
    case 'checking': return '正在检查网页'
    case 'loading': return '网页加载中'
    case 'ready': return health.reason === 'guest' ? '可以发送（未登录）' : '可以发送'
    case 'generating': return '网页回复中'
    case 'login-required': return '需要登录'
    case 'blocked':
      if (health.reason === 'verification') return '需要人机验证'
      if (health.reason === 'http-error') return '网站拒绝访问'
      if (health.reason === 'overlay') return '有弹窗挡住页面'
      if (health.reason === 'embed-blocked') return '网站不允许嵌入'
      return '页面被拦截'
    case 'error':
      if (health.reason === 'no-editor') return '找不到输入框'
      if (health.reason === 'site-error') return '网站报错'
      return '网页异常'
  }
}
