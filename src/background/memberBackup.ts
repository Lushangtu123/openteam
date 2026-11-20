// A web member's backup: an API model the user chose for it, which answers its prompt when its AI
// site cannot take one (a check page, an error page, a pop-up, a login page, a site error). The reply
// stays the member's, marked 备用 with the model's name, and the round, discussion or project goes
// on. The backup also answers while the member's site is limiting (src/group/siteUsage.ts). A member
// without a backup is not given summaries or discussion turns while its site is blocked or limiting
// (canBeAskedNow).
import { activeSiteLimit, isSiteLimitMessage, recordSiteLimit, type SiteLimit } from '../group/siteUsage'
import { capBlocks } from '../group/spendCap'
import type { ChatSite, ExternalModelConfig, GroupRole, OpenTeamStore, RoleSiteHealthStatus } from '../group/types'
import type { PromptDelivery } from './promptDelivery'
import { isExternalModelRole, type ExternalPromptDelivery } from './rolePromptDelivery'

// What a member's page reports when it cannot take a prompt. A page usable while signed out reports
// ready (reason guest).
const BLOCKED_STATUSES: ReadonlySet<RoleSiteHealthStatus> = new Set(['blocked', 'unauthorized', 'error'])

export function siteBlocksMember(role: GroupRole): boolean {
  return !isExternalModelRole(role) && Boolean(role.siteHealth && BLOCKED_STATUSES.has(role.siteHealth.status))
}

// The member's backup, when it is a web member and its backup is an API model that can be called.
export function backupModelFor(store: OpenTeamStore, role: GroupRole): ExternalModelConfig | undefined {
  if (isExternalModelRole(role) || !role.backupModelId) return undefined
  const model = store.settings.externalModelsById[role.backupModelId]
  if (!model || model.format === 'local-agent' || !model.apiKey?.trim()) return undefined
  return model
}

// A web member's site.
export function memberSite(store: OpenTeamStore, role: GroupRole): ChatSite | undefined {
  return isExternalModelRole(role) ? undefined : role.chatSite ?? store.settings.defaultChatSite
}

// The limit a web member's site is marked with now.
export function memberSiteLimit(store: OpenTeamStore, role: GroupRole, now: number): SiteLimit | undefined {
  const site = memberSite(store, role)
  return site ? activeSiteLimit(store, site, now) : undefined
}

// The member's site cannot be given prompts now: its page is blocked, or the site is limiting.
export function memberSiteUnavailable(store: OpenTeamStore, role: GroupRole, now: number): boolean {
  return siteBlocksMember(role) || Boolean(memberSiteLimit(store, role, now))
}

// The member's site said it is limiting (an error or page text in its words): the site is marked.
// Resolves to whether that started a new mark.
export function noteMemberSiteLimit(store: OpenTeamStore, role: GroupRole, text: string | undefined, now: number): boolean {
  const site = memberSite(store, role)
  if (!site || !text || !isSiteLimitMessage(text)) return false
  return recordSiteLimit(store, site, text, now)
}

// An API member's model, when it is at its daily spending cap (花费上限, src/group/spendCap.ts).
export function memberModelAtCap(store: OpenTeamStore, role: GroupRole, now: number): ExternalModelConfig | undefined {
  if (!isExternalModelRole(role) || !role.externalModelId) return undefined
  const model = store.settings.externalModelsById[role.externalModelId]
  return model && capBlocks(store, model, now) ? model : undefined
}

// Whether the member should be given a summary or a discussion turn now. A backup at its spending
// cap cannot answer for its member.
export function canBeAskedNow(store: OpenTeamStore, role: GroupRole, now: number): boolean {
  if (memberModelAtCap(store, role, now)) return false
  if (!memberSiteUnavailable(store, role, now)) return true
  const backup = backupModelFor(store, role)
  return Boolean(backup && !capBlocks(store, backup, now))
}

// The prompt the member's page could not take, for its backup: the same text, attempt and images.
export function backupDeliveryFor(store: OpenTeamStore, role: GroupRole, delivery: PromptDelivery): ExternalPromptDelivery | undefined {
  const model = backupModelFor(store, role)
  if (!model) return undefined
  const { message } = delivery
  return {
    roleId: role.id,
    roleName: role.name,
    chatId: message.chatId,
    messageId: message.messageId,
    replyAttemptId: message.replyAttemptId ?? '',
    model,
    prompt: delivery.backupPrompt ?? message.content,
    ...(delivery.imageAttachmentIds?.length ? { imageAttachmentIds: delivery.imageAttachmentIds } : {}),
    answeredBy: model.name,
  }
}
