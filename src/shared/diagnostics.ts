// 导出诊断信息: a file the user can attach to a bug report. It says which OpenTeam and browser this
// is, how each AI site's page is doing, what failed lately and why, and the recent logs. It holds
// no message text, no group or member names and no API key: members are named by their site or
// model format, API models by host and model name, and every saved key is blanked out at the end.
import { CHAT_SITE_INFO, CHAT_SITES } from '../group/chatSites'
import { siteCheckResults } from '../group/siteCheck'
import type { ExternalModelConfig, GroupChat, OpenTeamStore } from '../group/types'
import { redactSecrets, type RecentLogEntry } from './logger'
import type { UpdateCheckState } from './updateCheck'

export interface DiagnosticsInput {
  now: number
  extensionVersion: string
  userAgent: string
  store: OpenTeamStore
  updateCheck?: UpdateCheckState
  backgroundLogs: RecentLogEntry[]
  pageLogs: RecentLogEntry[]
}

const RECENT_FAILURES = 20
const FAILURE_TEXT_MAX_CHARS = 300

export function buildDiagnosticsReport(input: DiagnosticsInput) {
  const { store } = input
  const iso = (time: number) => new Date(time).toISOString()
  const models = store.settings.externalModelOrder
    .map(id => store.settings.externalModelsById[id])
    .filter((model): model is ExternalModelConfig => Boolean(model))
  const roles = Object.values(store.rolesById)
  const memberLabel = (roleId: string | undefined) => {
    const role = roleId ? store.rolesById[roleId] : undefined
    if (!role) return 'unknown'
    if (role.modelSource !== 'external') return `site:${role.chatSite ?? 'unknown'}`
    return `api:${store.settings.externalModelsById[role.externalModelId ?? '']?.format ?? 'unknown'}`
  }

  // Each site's newest health report, from whichever member reported it last.
  const healthBySite = new Map<string, NonNullable<(typeof roles)[number]['siteHealth']>>()
  for (const role of roles) {
    const health = role.siteHealth
    if (!health) continue
    const known = healthBySite.get(health.siteId)
    if (!known || known.updatedAt < health.updatedAt) healthBySite.set(health.siteId, health)
  }

  const failures = Object.values(store.messagesById)
    .filter(message => message.type === 'assistant' && message.status === 'error')
    .sort((left, right) => right.createdAt - left.createdAt)
    .slice(0, RECENT_FAILURES)
    .map(message => ({ at: iso(message.createdAt), member: memberLabel(message.roleId), reason: failureReason(message.content) }))

  const lastCheck = Object.values(store.chatsById)
    .filter((chat): chat is GroupChat & { siteCheck: NonNullable<GroupChat['siteCheck']> } => Boolean(chat.siteCheck))
    .sort((left, right) => right.siteCheck.startedAt - left.siteCheck.startedAt)[0]

  const report = {
    kind: 'openteam-diagnostics',
    generatedAt: iso(input.now),
    extensionVersion: input.extensionVersion,
    browser: input.userAgent,
    settings: {
      language: store.settings.language,
      defaultChatSite: store.settings.defaultChatSite,
      memoryProposals: Boolean(store.settings.memoryProposals),
    },
    counts: {
      chats: store.chatOrder.length,
      members: roles.length,
      messages: Object.keys(store.messagesById).length,
      memoryItems: store.memoryOrder?.length ?? 0,
    },
    currentChat: currentChatSummary(store, memberLabel),
    apiModels: models.filter(model => model.format !== 'local-agent').map(model => ({
      format: model.format,
      host: hostOf(model.baseUrl),
      modelName: model.modelName,
      ...(model.fallbackModelName ? { fallbackModelName: model.fallbackModelName } : {}),
      hasKey: Boolean(model.apiKey),
    })),
    localAgents: models.filter(model => model.format === 'local-agent').length,
    siteHealth: [...healthBySite.values()].map(health => ({
      site: health.siteId,
      status: health.status,
      ...(health.reason ? { reason: health.reason } : {}),
      ...(health.detail ? { detail: redactSecrets(health.detail).slice(0, FAILURE_TEXT_MAX_CHARS) } : {}),
      updatedAt: iso(health.updatedAt),
    })),
    recentFailures: failures,
    lastSiteCheck: lastCheck ? {
      startedAt: iso(lastCheck.siteCheck.startedAt),
      ...(lastCheck.siteCheck.error ? { error: lastCheck.siteCheck.error } : {}),
      results: siteCheckResults(store, lastCheck, input.now).map(result => ({ site: result.site, outcome: result.outcome, ...(result.detail ? { detail: result.detail } : {}) })),
    } : undefined,
    updateCheck: input.updateCheck ? {
      enabled: input.updateCheck.enabled,
      ...(input.updateCheck.latest ? { latestVersion: input.updateCheck.latest.version } : {}),
      ...(input.updateCheck.lastCheckedAt ? { lastCheckedAt: iso(input.updateCheck.lastCheckedAt) } : {}),
    } : undefined,
    backgroundLogs: input.backgroundLogs,
    pageLogs: input.pageLogs,
  }
  const names = [...Object.values(store.chatsById).map(chat => chat.name), ...roles.map(role => role.name)]
  return withoutSavedSecrets(report, models.map(model => model.apiKey), names)
}

export type DiagnosticsReport = ReturnType<typeof buildDiagnosticsReport>

// "openteam-diagnostics-20261117-0905.json", in the computer's own time.
export function diagnosticsFileName(now: number): string {
  const date = new Date(now)
  const two = (value: number) => String(value).padStart(2, '0')
  return `openteam-diagnostics-${date.getFullYear()}${two(date.getMonth() + 1)}${two(date.getDate())}-${two(date.getHours())}${two(date.getMinutes())}.json`
}

function currentChatSummary(store: OpenTeamStore, memberLabel: (roleId: string) => string) {
  const chat = store.currentChatId ? store.chatsById[store.currentChatId] : undefined
  if (!chat) return undefined
  return {
    mode: chat.mode,
    status: chat.status,
    members: chat.roleIds.map(roleId => ({ member: memberLabel(roleId), status: store.rolesById[roleId]?.status })),
    messages: chat.messageIds.length,
    ...(chat.project ? { project: { status: chat.project.status, stopReason: chat.project.stopReason } } : {}),
    ...(chat.discussion ? { discussion: { status: chat.discussion.status, turn: chat.discussion.turn, maxTurns: chat.discussion.maxTurns } } : {}),
  }
}

// A failed reply's text is OpenTeam's note about the failure, without the hint to retry.
function failureReason(content: string): string {
  const reason = content.replace(/\n+可以点击下方的.*$/s, '').replace(/^回复失败：/, '').trim()
  return redactSecrets(reason).slice(0, FAILURE_TEXT_MAX_CHARS)
}

function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return 'invalid'
  }
}

// A name that is only a site's (members of a 网站自检 are called Gemini, DeepSeek…) is not private,
// and blanking it would garble what the report says about that site.
const SITE_NAMES = new Set(CHAT_SITES.flatMap(site => [site, CHAT_SITE_INFO[site].label.toLowerCase()]))

// Every saved key, and every group and member name, wherever it might have ended up (a server
// message, an error, a log), blanked out. Longer names go first, so one inside another is caught.
function withoutSavedSecrets<T>(report: T, keys: string[], names: string[]): T {
  const secrets = keys.map(key => key.trim()).filter(key => key.length >= 6)
  const privateNames = [...new Set(names.map(name => name.trim()))]
    .filter(name => [...name].length >= 2 && !SITE_NAMES.has(name.toLowerCase()))
    .sort((left, right) => right.length - left.length)
  if (secrets.length === 0 && privateNames.length === 0) return report
  const escaped = (value: string) => JSON.stringify(value).slice(1, -1)
  let text = JSON.stringify(report)
  for (const secret of secrets) text = text.split(escaped(secret)).join('[secret]')
  for (const name of privateNames) text = text.split(escaped(name)).join('[name]')
  return JSON.parse(text) as T
}
