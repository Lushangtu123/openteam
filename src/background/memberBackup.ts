// A web member's backup: an API model the user chose for it, which answers its prompt when its AI
// site cannot take one (a check page, an error page, a pop-up, a login page, a site error). The reply
// stays the member's, marked 备用 with the model's name, and the round, discussion or project goes
// on. A member without a backup is not given summaries or discussion turns while its site is
// blocked (canBeAskedNow).
import type { ExternalModelConfig, GroupRole, OpenTeamStore, RoleSiteHealthStatus } from '../group/types'
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

// Whether the member should be given a summary or a discussion turn now.
export function canBeAskedNow(store: OpenTeamStore, role: GroupRole): boolean {
  return !siteBlocksMember(role) || Boolean(backupModelFor(store, role))
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
    prompt: message.content,
    ...(delivery.imageAttachmentIds?.length ? { imageAttachmentIds: delivery.imageAttachmentIds } : {}),
    answeredBy: model.name,
  }
}
