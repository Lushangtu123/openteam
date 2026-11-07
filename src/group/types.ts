import type { JSONContent } from '@tiptap/core'
import type { MessageHighlightColor } from './highlightColors'

export type RoomMode = 'independent' | 'collaborative'
import type { ChatSite } from './chatSites'
export type { ChatSite }
export type OpenTeamLanguage = 'en' | 'zh-CN'
export type RoleModelSource = 'site' | 'external'
// 'local-agent': an agent on this computer (Claude Code, Codex…) that works in one folder, run through the
// OpenTeam daemon over ACP; each run needs the user's approval.
export type ExternalModelFormat = 'openai' | 'anthropic' | 'local-agent'

export type ChatStatus = 'draft' | 'initializing' | 'ready' | 'running' | 'error'

export type RoleStatus = 'pending' | 'loading' | 'ready' | 'thinking' | 'stopped' | 'error'

export type RoleSiteHealthStatus = 'ready' | 'generating' | 'loading' | 'error' | 'blocked' | 'unauthorized'
// Why a site page is in its state: a verification interstitial, an HTTP error page, an overlay over
// the input box, a login page, usable without being logged in, no input box found, or a site error.
export type RoleSiteHealthReason = 'verification' | 'http-error' | 'overlay' | 'embed-blocked' | 'login' | 'guest' | 'no-editor' | 'site-error'

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
  teamHandbooks?: TeamHandbook[]
  // A desktop notification when every member has answered while OpenTeam is not in front. On
  // unless set to false.
  replyNotifications?: boolean
  // When a message goes to two or more members, they start with a few key points and long replies
  // fold to them. On unless set to false.
  replyKeyPoints?: boolean
  // Once every member of such a round has answered, one member writes a short summary. On unless
  // set to false.
  roundSummary?: boolean
}

export interface TeamHandbook {
  id: string
  name: string
  content: string
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
  // For a local agent: its ID in the daemon's agent list, and the folder it works in.
  localAgentId?: string
  workspace?: string
  createdAt: number
  updatedAt: number
}

// A question OpenTeam waits on before a local agent goes on: run this task, or allow one of the
// agent's actions (editing a file, running a command).
export interface PendingApproval {
  id: string
  kind: 'run' | 'permission'
  title: string
  detail?: string
  options: Array<{ id: string; label: string; kind?: string }>
  createdAt: number
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
  // Kept at the top of the group list.
  pinned?: boolean
  // Set while the members of a group made with "按任务组队" pick their own positions.
  teamFormation?: TeamFormation
  executionHandbook?: TeamHandbook
  // 轮流讨论: in a 协作 group, a message to two or more members starts a turn-by-turn discussion
  // instead of everyone answering at once.
  discussionMode?: boolean
  // The group's latest discussion.
  discussion?: DiscussionRun
  // The group's latest 项目 (a coordinator plans tasks for the members and checks the results).
  project?: ProjectRun
  createdAt: number
  updatedAt: number
}

export type ProjectStatus = 'planning' | 'awaiting-approval' | 'running' | 'reviewing' | 'waiting-user' | 'finishing' | 'done' | 'stopped'
export type ProjectTaskStatus = 'todo' | 'redo' | 'doing' | 'done' | 'blocked' | 'failed'
export type ProjectRequestKind = 'plan' | 'task' | 'review' | 'final'

export interface ProjectTask {
  id: string
  title: string
  // What to do and deliver.
  detail: string
  ownerRoleId: string
  dependsOn: string[]
  // How to tell it is done; the coordinator checks results against it.
  doneWhen: string
  status: ProjectTaskStatus
  // Tries so far (the first one included).
  attempts: number
  summary?: string
  // The coordinator's note (what to redo) or why the member was blocked.
  note?: string
  resultMessageId?: string
  // The request out for this task.
  requestId?: string
  // The coordinator has checked the latest result.
  checked?: boolean
}

export interface ProjectRun {
  id: string
  goalMessageId: string
  coordinatorRoleId: string
  status: ProjectStatus
  tasks: ProjectTask[]
  // Requests sent so far (plans, tasks, checks, the final write-up), and the most allowed.
  steps: number
  maxSteps: number
  planAttempts: number
  reviewAttempts: number
  // The coordinator's question while it waits for the user.
  question?: string
  stopReason?: 'user' | 'budget' | 'failed' | 'unavailable'
  stopDetail?: string
  // The coordinator's request out (plan, check or final write-up).
  coordinatorRequestId?: string
  finalMessageId?: string
  createdAt: number
  updatedAt: number
}

export type DiscussionStatus = 'running' | 'done' | 'stopped'

// A turn-by-turn discussion: members speak one at a time about the topic message.
export interface DiscussionRun {
  id: string
  topicMessageId: string
  // The members taking part, in speaking order.
  roleIds: string[]
  maxTurns: number
  // Turns started so far.
  turn: number
  status: DiscussionStatus
  // Set when the user stops it: the member speaking finishes, and nobody speaks after.
  stopRequested?: boolean
  stopReason?: 'user' | 'failed' | 'unavailable'
  currentRoleId?: string
  // The request for the current turn.
  currentMessageId?: string
  // Turns in a row that got no reply.
  failedTurns: number
  startedAt: number
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
  // The message holding the files attached to the task; every invitation carries copies of them.
  materialsMessageId?: string
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
  // A local agent member waiting for the user's answer.
  pendingApproval?: PendingApproval
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
  // What a web member has written so far, while it is still replying.
  liveReply?: RoleLiveReply
  createdAt: number
  updatedAt: number
}

// A web member's reply as it is being written. The chat shows it in the member's "replying" row
// until the finished reply arrives as a message. It is not a message, so it never becomes context
// for other members and never changes the order of the chat.
export interface RoleLiveReply {
  promptMessageId: string
  replyAttemptId?: string
  content: string
  contentFormat?: 'markdown'
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
  // Tokens an API member's reply used, as its model reported them.
  usage?: MessageTokenUsage
  // On a request OpenTeam sends to one member to summarize a round: the message that started the
  // round. That member's answer is the round's summary.
  roundSummaryOf?: string
  // On the user's message that started a turn-by-turn discussion.
  discussionTopic?: boolean
  // On a request OpenTeam sends to the member whose turn it is: the topic message, the turn number,
  // and the member who handed the turn over by @-mentioning them, if any.
  discussionTurnOf?: string
  discussionTurn?: number
  discussionHandoffFrom?: string
  // On a message the user sent while a discussion ran: the topic. It is shown to the next speakers.
  discussionNoteOf?: string
  // On the user's message that started a 项目 (its goal).
  projectGoal?: boolean
  // On a request OpenTeam sends to a member for a project: a plan, a task, a check or the final
  // write-up.
  projectRequest?: { kind: ProjectRequestKind; taskId?: string }
  // On a message the user sent while a project ran: the goal message. The coordinator reads it.
  projectNoteOf?: string
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
  // The image itself (base64), read inside the page, when its source is a page blob: URL that
  // only that page can open (ChatGPT's generated images), or a site's image CDN that lets the site's
  // page download but not OpenTeam (readInPage: Qwen's generated images).
  data?: string
  mimeType?: string
  readInPage?: boolean
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

export interface MessageTokenUsage {
  inputTokens?: number
  outputTokens?: number
  totalTokens?: number
}

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
