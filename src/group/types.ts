import type { JSONContent } from '@tiptap/core'
import type { MessageHighlightColor } from './highlightColors'

export type RoomMode = 'independent' | 'collaborative'
import type { ChatSite } from './chatSites'
export type { ChatSite }
export type OpenTeamLanguage = 'en' | 'zh-CN'
export type RoleModelSource = 'site' | 'external'
export type ExternalModelFormat = 'openai' | 'anthropic'

export type ChatStatus = 'draft' | 'initializing' | 'ready' | 'running' | 'error'

export type RoleStatus = 'pending' | 'loading' | 'ready' | 'thinking' | 'stopped' | 'error'

export type RoleSiteHealthStatus = 'ready' | 'generating' | 'loading' | 'error' | 'blocked' | 'unauthorized'
// Why a site page is in its state: a verification interstitial, an HTTP error page, an overlay over
// the input box, a login page, usable without being logged in, no input box found, or a site error.
export type RoleSiteHealthReason = 'verification' | 'http-error' | 'overlay' | 'login' | 'guest' | 'no-editor' | 'site-error'

export type DeliveryStatus = 'pending' | 'sent' | 'received' | 'error'

export type ReplyFailureReason = 'SEND_FAILED' | 'RESPONSE_NOT_FOUND' | 'TIMEOUT' | 'SITE_BLOCKED' | 'UNKNOWN'

export type RoleTemplateType = 'builtin' | 'custom'

export interface OpenTeamStore {
  version: number
  currentChatId?: string
  chatOrder: string[]
  chatsById: Record<string, GroupChat>
  rolesById: Record<string, GroupRole>
  messagesById: Record<string, GroupMessage>
  roleTemplateOrder: string[]
  roleTemplatesById: Record<string, RoleTemplate>
  orchestrationFlowsById: Record<string, OrchestrationFlow>
  orchestrationFlowOrderByChatId: Record<string, string[]>
  orchestrationRunsById: Record<string, OrchestrationRun>
  activeOrchestrationRunIdByChatId: Record<string, string>
  globalNote?: RichNoteDocument
  chatNotesById?: Record<string, RichNoteDocument>
  messageHighlightsById?: Record<string, MessageHighlight[]>
  externalRoleMemoriesById?: Record<string, ExternalRoleMemory>
  externalChatMemoriesById?: Record<string, ExternalChatMemory>
  settings: OpenTeamSettings
  viewState?: OpenTeamViewState
}

export interface OpenTeamViewState {
  chatReadSeqById?: Record<string, number>
  chatHasNewMessageById?: Record<string, boolean>
}

export interface OpenTeamSettings {
  defaultMode: RoomMode
  maxContextChars: number
  defaultChatSite: ChatSite
  externalModelOrder: string[]
  externalModelsById: Record<string, ExternalModelConfig>
  agentControlEnabled: boolean
  agentControlPort: number
  language: OpenTeamLanguage
  // Teams saved from "按任务组队", to start the same line-up again.
  teamTemplates?: TeamTemplate[]
}

export interface TeamTemplateMember {
  name: string
  description?: string
  systemPrompt?: string
  modelSource: RoleModelSource
  chatSite?: ChatSite
  externalModelId?: string
}

export interface TeamTemplate {
  id: string
  name: string
  task: string
  members: TeamTemplateMember[]
  createdAt: number
}

export interface ExternalModelConfig {
  id: string
  name: string
  format: ExternalModelFormat
  baseUrl: string
  apiKey: string
  modelName: string
  createdAt: number
  updatedAt: number
}

export interface ExternalRoleMemory {
  roleId: string
  summary?: string
  summarizedThroughSeq: number
  updatedAt: number
}

export interface ExternalChatMemory {
  chatId: string
  summary?: string
  summarizedThroughSeq: number
  updatedAt: number
}

export const DEFAULT_ORCHESTRATION_MAX_NODE_EXECUTIONS = 50
export const MAX_ORCHESTRATION_MAX_NODE_EXECUTIONS = 200
export const DEFAULT_ORCHESTRATION_REVIEW_MAX_ATTEMPTS = 3
export const DEFAULT_ORCHESTRATION_MAX_ROUNDS = 1
export const MAX_ORCHESTRATION_MAX_ROUNDS = 50

export type OrchestrationStageKind = 'roles' | 'review'
export type OrchestrationRunStatus = 'pending' | 'running' | 'completed' | 'stopped' | 'error'
export type OrchestrationStepStatus = 'pending' | 'running' | 'completed' | 'skipped' | 'error'
export type ReviewDecision = 'pass' | 'fail'
export type ReviewMaxAttemptsAction = 'stop' | 'continue'

export interface OrchestrationReviewConfig {
  reviewerRoleIds: string[]
  approvalThreshold?: number
  instructions?: string
  maxAttempts?: number
  onMaxAttempts?: ReviewMaxAttemptsAction
}

export interface OrchestrationStage {
  id: string
  kind: OrchestrationStageKind
  name: string
  description?: string
  position?: OrchestrationGraphNodePosition
  roleIds: string[]
  review?: OrchestrationReviewConfig
}

export interface OrchestrationGraphNodePosition {
  x: number
  y: number
}

export interface OrchestrationGraphEdgeVertex {
  x: number
  y: number
}

export interface OrchestrationGraphEdge {
  sourceStageId: string
  targetStageId: string
  sourcePort?: 'out' | 'pass' | 'fail'
  targetPort?: 'in'
  vertices?: OrchestrationGraphEdgeVertex[]
}

export interface OrchestrationGraphSnapshot {
  stageNodes: OrchestrationStage[]
  edges: OrchestrationGraphEdge[]
}

export interface OrchestrationAutoPlanHistoryEntry {
  id: string
  role: 'user' | 'assistant'
  content: string
  createdAt: number
}

export interface OrchestrationFlow {
  id: string
  chatId: string
  name: string
  description?: string
  stages: OrchestrationStage[]
  graph?: OrchestrationGraphSnapshot
  autoPlanHistory?: OrchestrationAutoPlanHistoryEntry[]
  maxNodeExecutions?: number
  maxRounds: number
  createdAt: number
  updatedAt: number
}

export interface OrchestrationReviewResult {
  round: number
  stageRunId: string
  reviewerRoleId?: string
  messageId: string
  decision: ReviewDecision
  reason: string
  failedCriteria: string[]
  nextRoundInstruction: string
  rawJson: string
  createdAt: number
}

export interface OrchestrationRoleRun {
  roleId: string
  status: OrchestrationStepStatus
  messageId?: string
  error?: string
  startedAt?: number
  completedAt?: number
}

export interface OrchestrationStageRun {
  stageId: string
  stageIndex: number
  kind: OrchestrationStageKind
  round: number
  status: OrchestrationStepStatus
  roleRuns: Record<string, OrchestrationRoleRun>
  reviewResults?: OrchestrationReviewResult[]
  startedAt?: number
  completedAt?: number
}

export interface OrchestrationRun {
  id: string
  chatId: string
  flowId: string
  status: OrchestrationRunStatus
  currentRound: number
  maxNodeExecutions?: number
  maxRounds: number
  stageRuns: OrchestrationStageRun[]
  createdAt: number
  updatedAt: number
  completedAt?: number
  error?: string
}

export interface GroupChat {
  id: string
  name: string
  description?: string
  mode: RoomMode
  roleIds: string[]
  messageIds: string[]
  nextMessageSeq: number
  status: ChatStatus
  requireManualMention?: boolean
  // Set while the members of a group made with "按任务组队" pick their own positions.
  teamFormation?: TeamFormation
  createdAt: number
  updatedAt: number
}

export type TeamFormationStatus = 'checking' | 'claiming' | 'confirmed'

// A team built around a task, whose AI members choose their own positions. Members are asked in
// rounds: one copy of every model in the first round, a second copy of a model in the next one, and
// so on, so that copies of the same model see what the earlier copy took.
export interface TeamFormation {
  task: string
  requiredPositions: string[]
  status: TeamFormationStatus
  // Role ids per round, in the order the rounds are sent.
  rounds: string[][]
  // Index into rounds of the next round to invite.
  nextRound: number
  // The user messages that asked members to claim a position, oldest first (rounds and re-picks).
  invitationIds: string[]
  // Members already have positions (a team started from a saved team): it can start right away.
  preset?: boolean
  // The positions before the members were asked to divide the work again.
  previousPositions?: Array<{ position: string; holder: string }>
  createdAt: number
  confirmedAt?: number
}

export interface RoleTemplate {
  id: string
  type: RoleTemplateType
  name: string
  category?: string
  description?: string
  defaultModelSource?: RoleModelSource
  defaultChatSite?: ChatSite
  defaultExternalModelId?: string
  sourceTemplateId?: string
  sourceTemplateName?: string
  chatGptGptsUrl?: string
  grokProjectUrl?: string
  systemPrompt: string
  createdAt: number
  updatedAt: number
}

export interface GroupRole {
  id: string
  chatId: string
  createdBy?: 'orchestration-auto' | 'orchestration-template' | 'team-formation'
  templateId?: string
  modelSource?: RoleModelSource
  chatSite?: ChatSite
  externalModelId?: string
  name: string
  description?: string
  systemPrompt?: string
  avatarColor?: string
  status: RoleStatus
  contextCursor: number
  geminiConversationId?: string
  geminiConversationUrl?: string
  chatGptGptsUrl?: string
  grokProjectUrl?: string
  lastPromptMessageId?: string
  replyAttemptId?: string
  lastReplyAt?: number
  siteHealth?: RoleSiteHealth
  createdAt: number
  updatedAt: number
}

export interface RoleSiteHealth {
  siteId: ChatSite
  status: RoleSiteHealthStatus
  reason?: RoleSiteHealthReason
  detail?: string
  updatedAt: number
}

export interface GroupMessage {
  id: string
  chatId: string
  seq: number
  type: 'user' | 'assistant' | 'system'
  content: string
  contentFormat?: 'markdown'
  roleId?: string
  roleName?: string
  sourceMessageId?: string
  targetRoleIds?: string[]
  mentionedRoleIds?: string[]
  mentionsAll?: boolean
  references?: MessageReference[]
  orchestrationRunId?: string
  orchestrationRound?: number
  orchestrationStageId?: string
  orchestrationStageIndex?: number
  orchestrationKind?: 'task' | 'role' | 'review' | 'status'
  // Sends each target's persona with this message again, as on its first message. Set on the
  // message that starts work after members picked their positions.
  refreshPersona?: boolean
  createdAt: number
  status: DeliveryStatus
  deliveryStatus?: Record<string, DeliveryStatus>
  attachments?: MessageAttachment[]
}

export interface ReplyImageSource {
  sourceUrl: string
  alt?: string
  width?: number
  height?: number
}

export interface MessageImageAttachment {
  id: string
  type: 'image'
  status: 'ready' | 'error'
  // 'user-upload' for images the user attached; captured site replies have no source.
  source?: 'user-upload'
  alt?: string
  width?: number
  height?: number
  mimeType?: string
  size?: number
  fileName?: string
  error?: string
}

// A text file the user attached. Its content is put into the prompt, so it is kept with the message.
export interface MessageFileAttachment {
  id: string
  type: 'file'
  status: 'ready'
  fileName: string
  mimeType: string
  size: number
  text: string
}

export type MessageAttachment = MessageImageAttachment | MessageFileAttachment

export interface MessageReference {
  messageId: string
  roleId?: string
  roleName?: string
  contentSnapshot: string
}

export type RichNoteDocument = JSONContent

export interface MessageHighlight {
  id: string
  messageId: string
  text: string
  startOffset: number
  endOffset: number
  color?: MessageHighlightColor
  createdAt: number
}

export interface RuntimeFrameBinding {
  chatId: string
  roleId: string
  tabId: number
  frameId: number
  ready: boolean
  lastSeenAt: number
}

export type RuntimeFrameBindingKey = `${string}:${string}`

export type RuntimeFrameAddressKey = `${number}:${number}`
