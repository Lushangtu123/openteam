import { libraryPassagesForPrompt, noteLibraryPending, withLibraryBlock } from '../group/groupLibrary'
import { buildUnsyncedContext } from '../group/contextSync'
import { contextCharBudgetForRole } from '../group/contextBudget'
import { buildExternalModelPrompt, type ExternalMemoryPatch } from '../group/externalModelContext'
import { buildOrchestrationReviewResponseInstruction } from '../group/orchestrationPrompts'
import { uploadedImageIds } from '../group/messageUploads'
import { buildPrompt, roleUsesChatGptGptsPersona } from '../group/promptBuilder'
import { buildRoundSummaryPrompt, keyPointsInstruction, readSummarizableRound, wantsKeyPoints } from '../group/roundSummary'
import { buildCrossReviewPrompt } from '../group/collaboration'
import { buildDiscussionTurnPrompt, discussionTranscript } from '../group/discussion'
import { buildProjectPrompt } from '../group/project'
import { memoryItemsForPrompt, noteMemoryPending, withMemoryBlock } from '../group/memoryPrompt'
import { wantsMemoryProposals, withMemoryProposalInstruction } from '../group/memoryProposals'
import { withTeamHandbook } from '../group/teamHandbooks'
import { pollInstruction } from '../group/poll'
import { buildFactCheckPrompt, readCheckableRound, sourcesInstruction } from '../group/sources'
import { normalizeLanguage } from '../shared/i18n'
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
  // Answering for a web member whose site could not take the prompt (memberBackup.ts): the model's
  // name, shown on the reply as 备用.
  answeredBy?: string
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
  const summaryPrompt = roundSummaryPromptFor(input) ?? crossReviewPromptFor(input) ?? factCheckPromptFor(input)
  const projectKind = input.userMessage.projectRequest?.kind
  const includesPersona = !summaryPrompt && (!projectKind || projectKind === 'task') && (shouldIncludePersonaForPrompt(input.role, roleHistoryCount, input.userMessage) || isFirstProjectTask(input))
  // OpenTeam's own requests (a summary, a discussion turn, a project step) carry their whole prompt.
  const summary = summaryPrompt ?? (input.userMessage.discussionTurnOf
    ? buildDiscussionTurnPrompt({ store: input.store, chat: input.chat, request: input.userMessage, role: input.role, roles: input.roles, includePersona: includesPersona, language: input.store.settings.language })
    : projectKind
      ? buildProjectPromptFor(input, includesPersona)
      : undefined)
  const replyAttemptId = input.newId('attempt')
  const responseInstruction = responseInstructionForMessage(input.store, input.chat, input.userMessage)
  const extraInstruction = joinInstructions(
    wantsKeyPoints(input.store.settings, input.chat, input.userMessage) ? keyPointsInstruction(input.store.settings.language) : undefined,
    // 要来源: number each fact's source and list the links (src/group/sources.ts).
    input.userMessage.wantsSources ? sourcesInstruction(normalizeLanguage(input.store.settings.language) === 'en') : undefined,
  )
  const maxContextChars = contextCharBudgetForRole(input.store, input.role)
  const imageAttachmentIds = uploadedImageIds(discussionImagesSource(input) ?? input.userMessage)
  const images = imageAttachmentIds.length > 0 ? { imageAttachmentIds } : {}
  // What the user saved in the memory store and this request brings up. Added after the context
  // budget, with a budget of its own, and before the handbook, whose last line starts the task.
  const language = input.store.settings.language
  const memoryItems = memoryItemsForPrompt({ store: input.store, chat: input.chat, role: input.role, message: input.userMessage, reference: input.reference })
  // With the user's switch on, the same requests are told how to propose something to remember.
  const asksForProposals = wantsMemoryProposals(input.store.settings, input.chat, input.userMessage)
  // 群资料库: the passages of the group's library this request brings up (groupLibrary.ts).
  const libraryPassages = libraryPassagesForPrompt({ store: input.store, chat: input.chat, role: input.role, message: input.userMessage })
  const withAdditions = (prompt: string) => withTeamHandbook(withMemoryProposalInstruction(withLibraryBlock(withMemoryBlock(prompt, memoryItems, language), libraryPassages, language), asksForProposals, language), input.chat, language)

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
        prompt: withAdditions(prompt.content),
        ...images,
      },
    }
  }

  const binding = input.runtimeFrames.getByRole(input.chat.id, input.role.id)
  if (!binding?.ready) throw new Error('成员 iframe 尚未就绪，请先恢复成员')
  // A web member's site conversation keeps what it is sent: see memoryPrompt.ts.
  noteMemoryPending(input.role, input.userMessage.id, memoryItems)
  noteLibraryPending(input.role, input.userMessage.id, libraryPassages)
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
        content: withAdditions(content),
        includesPersona,
      },
      ...images,
      // Its backup may answer if the site cannot take the prompt (memberBackup.ts).
      ...(input.role.backupModelId ? { hasBackup: true } : {}),
      ...(input.role.backupModelId && !summary ? { backupPrompt: withAdditions(buildBackupPrompt(input, input.role.backupModelId, responseInstruction, extraInstruction)) } : {}),
    },
  }
}

// The whole prompt for a web member's backup API model: built as an API member's is (persona, the
// group's messages with the member's own earlier answers, the conversation summary), in the backup
// model's budget.
function buildBackupPrompt(input: PrepareRolePromptDeliveryInput, backupModelId: string, responseInstruction: string | undefined, extraInstruction: string | undefined): string {
  const asBackup: GroupRole = { ...input.role, modelSource: 'external', externalModelId: backupModelId }
  const maxContextChars = contextCharBudgetForRole(input.store, asBackup)
  // The summary it may compress older messages into is not kept: the member's own is the site's.
  return buildExternalModelPrompt(input.store, input.chat, input.role, input.userMessage, input.roles, { responseInstruction, extraInstruction, maxContextChars }).content
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

// A member's first task in a project carries its persona, also when it has spoken before (a team's
// members have, to choose their positions).
function isFirstProjectTask(input: PrepareRolePromptDeliveryInput): boolean {
  const project = input.chat.project
  if (input.userMessage.projectRequest?.kind !== 'task' || !project || roleUsesChatGptGptsPersona(input.role)) return false
  const goal = input.store.messagesById[project.goalMessageId]
  return !input.messages.some(message => message.id !== input.userMessage.id
    && message.projectRequest?.kind === 'task'
    && message.targetRoleIds?.includes(input.role.id)
    && (!goal || message.seq > goal.seq))
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

// A fact check's request carries the answers, their link checks and unsourced claims itself.
function factCheckPromptFor(input: PrepareRolePromptDeliveryInput): string | undefined {
  if (!input.userMessage.factCheckOf) return undefined
  const round = readCheckableRound(input.store, input.chat, input.store.messagesById[input.userMessage.factCheckOf])
  if (!round) throw new Error('这一轮的回答已经不在了，无法核查')
  return buildFactCheckPrompt({ round, checker: input.role, language: input.store.settings.language, maxReplyChars: contextCharBudgetForRole(input.store, input.role) })
}

function joinInstructions(...parts: Array<string | undefined>): string | undefined {
  const present = parts.filter((part): part is string => Boolean(part))
  return present.length > 0 ? present.join('\n\n') : undefined
}

// A review round's request carries the question and everyone's answers itself (互相审).
function crossReviewPromptFor(input: PrepareRolePromptDeliveryInput): string | undefined {
  if (!input.userMessage.crossReviewOf) return undefined
  const round = readSummarizableRound(input.store, input.chat, input.store.messagesById[input.userMessage.crossReviewOf])
  if (!round) throw new Error('上一轮的回答已经不在了，无法互相审阅')
  return buildCrossReviewPrompt({ round, reviewer: input.role, language: input.store.settings.language, maxReplyChars: contextCharBudgetForRole(input.store, input.role) })
}

// The prompts this member got in its current conversation: one that started over (another model or
// site, a lost site conversation) holds none of the earlier ones, so its first prompt carries the
// persona again.
function countLocalRoleHistory(messages: GroupMessage[], role: GroupRole, currentMessageId: string): number {
  const startedAfter = role.conversationStartedAfterSeq ?? 0
  return messages.filter(message => message.id !== currentMessageId && message.seq > startedAfter && isRoleHistoryMessage(message, role.id)).length
}

function isRoleHistoryMessage(message: GroupMessage, roleId: string): boolean {
  // A summary request, or a project's plan, check or write-up, is not the member's own conversation.
  if (message.type !== 'user' || message.roundSummaryOf || (message.projectRequest && message.projectRequest.kind !== 'task')) return false
  if (!Array.isArray(message.targetRoleIds) || !message.targetRoleIds.includes(roleId)) return false
  const deliveryStatus = message.deliveryStatus?.[roleId]
  return deliveryStatus === 'sent' || deliveryStatus === 'received'
}

function responseInstructionForMessage(store: OpenTeamStore, chat: GroupChat, message: GroupMessage): string | undefined {
  const language = store.settings.language
  if (message.orchestrationKind === 'review') return buildOrchestrationReviewResponseInstruction(language)
  // A vote: how to answer it, and in a second round, the first round's votes (src/group/poll.ts).
  return pollInstruction(store, chat, message, normalizeLanguage(language) === 'en')
}
