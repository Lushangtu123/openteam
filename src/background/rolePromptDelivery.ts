import { buildUnsyncedContext } from '../group/contextSync'
import { contextCharBudgetForRole } from '../group/contextBudget'
import { buildExternalModelPrompt, type ExternalMemoryPatch } from '../group/externalModelContext'
import { buildOrchestrationReviewResponseInstruction } from '../group/orchestrationPrompts'
import { uploadedImageIds } from '../group/messageUploads'
import { buildPrompt, roleUsesChatGptGptsPersona } from '../group/promptBuilder'
import { buildRoundSummaryPrompt, keyPointsInstruction, readSummarizableRound, wantsKeyPoints } from '../group/roundSummary'
import { buildDiscussionTurnPrompt, discussionTranscript } from '../group/discussion'
import { buildProjectPrompt } from '../group/project'
import type { ExternalModelConfig, GroupChat, GroupMessage, GroupRole, MessageReference, OpenTeamStore } from '../group/types'
import type { PromptDelivery } from './promptDelivery'
import type { RuntimeFrameRegistry } from './runtimeFrames'

export interface ExternalPromptDelivery {
  roleId: string
  roleName?: string
  chatId: string
  messageId: string
  replyAttemptId: string
  model: ExternalModelConfig
  prompt: string
  imageAttachmentIds?: string[]
}

export type PreparedRolePromptDelivery = {
  includesPersona: boolean
  replyAttemptId: string
  roleHistoryCount: number
} & (
  | { delivery: PromptDelivery; externalDelivery?: undefined }
  | { delivery?: undefined; externalDelivery: ExternalPromptDelivery }
)

export interface PrepareRolePromptDeliveryInput {
  store: OpenTeamStore
  chat: GroupChat
  role: GroupRole
  userMessage: GroupMessage
  roles: GroupRole[]
  messages: GroupMessage[]
  reference?: MessageReference
  timestamp: number
  newId(prefix: string): string
  runtimeFrames: Pick<RuntimeFrameRegistry, 'getByRole'>
}

export function prepareRolePromptDelivery(input: PrepareRolePromptDeliveryInput): PreparedRolePromptDelivery {
  const roleHistoryCount = countLocalRoleHistory(input.messages, input.role, input.userMessage.id)
  const summaryPrompt = roundSummaryPromptFor(input)
  const projectKind = input.userMessage.projectRequest?.kind
  const includesPersona = !summaryPrompt && (!projectKind || projectKind === 'task') && shouldIncludePersonaForPrompt(input.role, roleHistoryCount, input.userMessage)
  // OpenTeam's own requests (a summary, a discussion turn, a project step) carry their whole prompt.
  const summary = summaryPrompt ?? (input.userMessage.discussionTurnOf
    ? buildDiscussionTurnPrompt({ store: input.store, chat: input.chat, request: input.userMessage, role: input.role, roles: input.roles, includePersona: includesPersona, language: input.store.settings.language })
    : projectKind
      ? buildProjectPromptFor(input, includesPersona)
      : undefined)
  const replyAttemptId = input.newId('attempt')
  const responseInstruction = responseInstructionForMessage(input.userMessage, input.store.settings.language)
  const extraInstruction = wantsKeyPoints(input.store.settings, input.chat, input.userMessage) ? keyPointsInstruction(input.store.settings.language) : undefined
  const maxContextChars = contextCharBudgetForRole(input.store, input.role)
  const imageAttachmentIds = uploadedImageIds(discussionImagesSource(input) ?? input.userMessage)
  const images = imageAttachmentIds.length > 0 ? { imageAttachmentIds } : {}

  if (isExternalModelRole(input.role)) {
    const model = requireExternalModelForRole(input.store, input.role)
    const prompt = summary
      ? { content: summary }
      : buildExternalModelPrompt(input.store, input.chat, input.role, input.userMessage, input.roles, { responseInstruction, extraInstruction, maxContextChars })
    if ('memoryPatch' in prompt && prompt.memoryPatch) applyExternalMemoryPatch(input.store, prompt.memoryPatch, input.timestamp)
    return {
      includesPersona,
      roleHistoryCount,
      replyAttemptId,
      externalDelivery: {
        roleId: input.role.id,
        roleName: input.role.name,
        chatId: input.chat.id,
        messageId: input.userMessage.id,
        replyAttemptId,
        model,
        prompt: prompt.content,
        ...images,
      },
    }
  }

  const binding = input.runtimeFrames.getByRole(input.chat.id, input.role.id)
  if (!binding?.ready) throw new Error('人员 iframe 尚未就绪，请先恢复人员')
  const unsyncedContext = buildUnsyncedContext(input.chat, input.role, input.messages, input.userMessage, maxContextChars, input.store.settings.language)
  const content = summary ?? buildPrompt({
    chat: input.chat,
    role: input.role,
    userMessage: input.userMessage,
    roles: input.roles,
    unsyncedContext,
    reference: input.reference,
    includePersona: includesPersona,
    responseInstruction,
    extraInstruction,
    language: input.store.settings.language,
  })

  return {
    includesPersona,
    roleHistoryCount,
    replyAttemptId,
    delivery: {
      roleId: input.role.id,
      chatSite: input.role.chatSite ?? input.store.settings.defaultChatSite,
      tabId: binding.tabId,
      frameId: binding.frameId,
      message: {
        type: 'TEAM_SEND_PROMPT',
        chatId: input.chat.id,
        roleId: input.role.id,
        messageId: input.userMessage.id,
        replyAttemptId,
        content,
        includesPersona,
      },
      ...images,
    },
  }
}

export function isExternalModelRole(role: GroupRole): boolean {
  return role.modelSource === 'external'
}

export function getExternalModelForRole(store: OpenTeamStore, role: GroupRole): ExternalModelConfig | undefined {
  if (!isExternalModelRole(role) || !role.externalModelId) return undefined
  return store.settings.externalModelsById[role.externalModelId]
}

export function requireExternalModelForRole(store: OpenTeamStore, role: GroupRole): ExternalModelConfig {
  const model = getExternalModelForRole(store, role)
  if (!model) throw new Error(`找不到外部模型：${role.externalModelId ?? role.name}`)
  return model
}

function applyExternalMemoryPatch(store: OpenTeamStore, patch: ExternalMemoryPatch, timestamp: number): void {
  if (patch.scope === 'chat') {
    store.externalChatMemoriesById ??= {}
    store.externalChatMemoriesById[patch.id] = {
      chatId: patch.id,
      summary: patch.summary,
      summarizedThroughSeq: patch.summarizedThroughSeq,
      updatedAt: timestamp,
    }
    return
  }

  store.externalRoleMemoriesById ??= {}
  store.externalRoleMemoriesById[patch.id] = {
    roleId: patch.id,
    summary: patch.summary,
    summarizedThroughSeq: patch.summarizedThroughSeq,
    updatedAt: timestamp,
  }
}

// The persona goes with a role's first message, and again with a message that asks for it (after
// team members picked new positions).
function shouldIncludePersonaForPrompt(role: GroupRole, roleHistoryCount: number, message: GroupMessage): boolean {
  return !roleUsesChatGptGptsPersona(role) && (roleHistoryCount === 0 || message.refreshPersona === true)
}

function buildProjectPromptFor(input: PrepareRolePromptDeliveryInput, includePersona: boolean): string {
  const project = input.chat.project
  if (!project) throw new Error('这个群聊没有进行中的项目')
  return buildProjectPrompt({ store: input.store, chat: input.chat, project, request: input.userMessage, role: input.role, includePersona, language: input.store.settings.language })
}

// A member's first turn in a discussion carries the images the user attached to the topic.
function discussionImagesSource(input: PrepareRolePromptDeliveryInput): GroupMessage | undefined {
  const topicId = input.userMessage.discussionTurnOf
  if (!topicId) return undefined
  const spokeBefore = discussionTranscript(input.store, input.chat, topicId).some(entry => entry.kind === 'turn' && entry.message.roleId === input.role.id)
  return spokeBefore ? { ...input.userMessage, attachments: [] } : input.store.messagesById[topicId]
}

// A request to summarize a round carries the round's replies itself, instead of the usual prompt.
function roundSummaryPromptFor(input: PrepareRolePromptDeliveryInput): string | undefined {
  if (!input.userMessage.roundSummaryOf) return undefined
  const round = readSummarizableRound(input.store, input.chat, input.store.messagesById[input.userMessage.roundSummaryOf])
  if (!round) throw new Error('这一轮的回复已经不在了，无法汇总')
  return buildRoundSummaryPrompt({ round, summarizer: input.role, language: input.store.settings.language, maxReplyChars: contextCharBudgetForRole(input.store, input.role) })
}

function countLocalRoleHistory(messages: GroupMessage[], role: GroupRole, currentMessageId: string): number {
  return messages.filter(message => message.id !== currentMessageId && isRoleHistoryMessage(message, role.id)).length
}

function isRoleHistoryMessage(message: GroupMessage, roleId: string): boolean {
  // A summary request, or a project's plan, check or write-up, is not the member's own conversation.
  if (message.type !== 'user' || message.roundSummaryOf || (message.projectRequest && message.projectRequest.kind !== 'task')) return false
  if (!Array.isArray(message.targetRoleIds) || !message.targetRoleIds.includes(roleId)) return false
  const deliveryStatus = message.deliveryStatus?.[roleId]
  return deliveryStatus === 'sent' || deliveryStatus === 'received'
}

function responseInstructionForMessage(message: GroupMessage, language: OpenTeamStore['settings']['language']): string | undefined {
  return message.orchestrationKind === 'review'
    ? buildOrchestrationReviewResponseInstruction(language)
    : undefined
}
