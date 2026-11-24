import type { JSONContent } from '@tiptap/core'
import type { MessageHighlightColor } from './highlightColors'

export type RoomMode = 'independent' | 'collaborative'
import type { ChatSite } from './chatSites'
import type { SiteUsageRecord } from './siteUsage'
import type { AccountBalance } from './accountBalance'
import type { ModelSpend } from './spendCap'
import type { ResultDestination } from './resultDestinations'
import type { SiteFaultRecord } from './siteFaults'
import type { SiteCheckSchedule } from './siteCheckSchedule'
import type { WebSearchSettings } from '../shared/webSearch'
import type { WebSearchUsage } from '../shared/webSearchUsage'
import type { LibraryDoc } from './groupLibrary'
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
  // The memory store: long-term knowledge the user saved. Kept under its own storage key.
  memoryItemsById?: Record<string, MemoryItem>
  // Item ids, newest first.
  memoryOrder?: string[]
  // How much each AI site was used today, and whether it is limiting (src/group/siteUsage.ts).
  siteUsageBySite?: SiteUsageRecord
  // 网站失效提醒: each site's failures since its last reply (src/group/siteFaults.ts).
  siteFaultsBySite?: SiteFaultRecord
  // 联网搜索's count of searches (src/shared/webSearchUsage.ts).
  webSearchUsage?: WebSearchUsage
  // API accounts' balances and daily spend, read from the providers (src/group/accountBalance.ts).
  accountBalancesById?: Record<string, AccountBalance>
  // What each priced API model spent today, against its daily cap (src/group/spendCap.ts).
  modelSpendById?: Record<string, ModelSpend>
  // 群资料库: each group's documents, by chat id (src/group/groupLibrary.ts). The page gets them
  // without their text.
  libraryByChatId?: Record<string, LibraryDoc[]>
  settings: OpenTeamSettings
  viewState?: OpenTeamViewState
}

export interface OpenTeamViewState {
  chatReadSeqById?: Record<string, number>
  chatHasNewMessageById?: Record<string, boolean>
}

// How the members of a 协作 group answer a message to several of them: each answers and then
// reviews the others' answers (互相审), they take turns (轮流讨论), or each answers on its own.
export type CollaborationStyle = 'review' | 'turns' | 'parallel'

export interface NewChatCollaboration {
  style: CollaborationStyle
  // 不@也回复: a message without @ goes to every member.
  replyAll: boolean
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
  // Members may propose memory at the end of a reply; off unless true.
  memoryProposals?: boolean
  // Once every member of such a round has answered, one member writes a short summary. On unless
  // set to false.
  roundSummary?: boolean
  // Where scheduled tasks can send their results (src/group/resultDestinations.ts).
  resultDestinations?: ResultDestination[]
  // 联网搜索: the user's Tavily key, for API members' searches (src/shared/webSearch.ts).
  webSearch?: WebSearchSettings
  // 定时自检: the site check run on set days (src/group/siteCheckSchedule.ts).
  siteCheckSchedule?: SiteCheckSchedule
  // What the last group was created with, offered again for the next one.
  newChatCollaboration?: NewChatCollaboration
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
  avatarColor?: string
  avatarText?: string
  avatarImage?: string
  userNamed?: boolean
  teamPosition?: string
}

export interface TeamTemplate {
  id: string
  name: string
  task: string
  members: TeamTemplateMember[]
  createdAt: number
}

export interface ModelPricing {
  // Per million input and output tokens.
  input: number
  output: number
  currency: 'CNY' | 'USD'
}

export interface ExternalModelConfig {
  id: string
  name: string
  format: ExternalModelFormat
  baseUrl: string
  apiKey: string
  modelName: string
  // An API model's backup, at the same address with the same key: it answers a group reply when the
  // main model is busy, rate-limited, out of quota or too slow.
  fallbackModelName?: string
  // What the user entered the model costs, per million tokens, for the 用量 window's estimate.
  pricing?: ModelPricing
  // The most it may spend a day, in the price's currency, as estimated from that price (花费上限).
  dailyCap?: number
  // false: the model may not read web pages while it answers (读网页, on unless set to false).
  webReading?: boolean
  // false: the model may not search the web while it answers (联网搜索, on unless set to false; it
  // needs the user's search key in the settings).
  webSearch?: boolean
  // For a local agent: its ID in the daemon's agent list, and the folder it works in.
  localAgentId?: string
  workspace?: string
  // For a local agent: how long a run may take, in minutes (DEFAULT_RUN_LIMIT_MINUTES unless set,
  // src/shared/localAgentLimits.ts).
  runLimitMinutes?: number
  createdAt: number
  updatedAt: number
}

// A question OpenTeam waits on before a local agent goes on: run this task, or allow one of the
// agent's actions (editing a file, running a command).
export interface PendingApproval {
  id: string
  // run / permission: a local agent's; web-page: an API member asks to read a page (webPageReader.ts).
  kind: 'run' | 'permission' | 'web-page'
  title: string
  detail?: string
  // For web-page: the site to allow, as a host permission pattern.
  site?: string
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

// Who can read a memory item: every member of every group, the members of one group, or one member
// of one group. A member belongs to a single group, so 'role' never reaches another group.
export type MemoryScope = 'global' | 'chat' | 'role'

export type MemoryKind = 'fact' | 'decision' | 'preference' | 'note'

// Who wrote the text. Every item is saved by the user; this records where the content came from.
export interface MemorySource {
  origin: 'user' | 'member'
  roleId?: string
  chatId?: string
  messageId?: string
}

// What a member proposed to remember at the end of a reply, waiting for the user to save or
// dismiss it. It is not a memory item and reaches no prompt.
export interface MemoryProposal {
  id: string
  kind: MemoryKind
  content: string
}

export interface MemoryItem {
  id: string
  scope: MemoryScope
  // The chat id for 'chat', the role id for 'role', absent for 'global'.
  scopeId?: string
  kind: MemoryKind
  content: string
  tags?: string[]
  // Sent every time without being searched for, within the budget.
  pinned?: boolean
  source: MemorySource
  createdAt: number
  // When the text a member receives (content or kind) last changed.
  updatedAt: number
  // Switched off by the user for now.
  disabled?: boolean
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
  // 互相审: in a 协作 group, once the members a message went to have all answered, each reads the
  // others' answers, says what it agrees with, disputes or finds missing, and revises its own. Not
  // together with discussionMode.
  crossReview?: boolean
  // The group's latest discussion.
  discussion?: DiscussionRun
  // A 网站自检 group (src/group/siteCheck.ts): its result is shown at the end of the chat.
  // error: why the question could not be sent. scheduled: the last check was 定时自检's.
  // kept: the user changed the group (renamed, pinned, made 协作…), so it is theirs now: the next
  // check makes a new group, as it does when the user sent a message of their own in it.
  siteCheck?: SiteCheckState
  // The group's latest 项目 (a coordinator plans tasks for the members and checks the results).
  project?: ProjectRun
  // No memory items are sent to this group's members.
  memoryDisabled?: boolean
  // Set when an 独立专家 group was made 协作群聊: the last message before; earlier messages are not
  // shared among the members (src/group/chatMode.ts).
  sharedFromSeq?: number
  // Messages the group sends itself on set days at a set time (src/group/scheduledTasks.ts).
  scheduledTasks?: ScheduledTask[]
  createdAt: number
  updatedAt: number
}

// A message a group sends itself every week on its days at its time (local time), as if the user
// had typed it: its @mentions pick who answers.
export interface ScheduledTask {
  id: string
  content: string
  // 0 is Sunday, as Date.getDay().
  days: number[]
  // HH:MM, 24-hour.
  time: string
  enabled: boolean
  // Where the result goes once the round is over (OpenTeamSettings.resultDestinations).
  destinationId?: string
  // Times up to this moment are never run: when the task was made, switched on or changed.
  armedAt: number
  // The latest time already run or skipped.
  lastSlotAt?: number
  lastRun?: ScheduledTaskRun
  createdAt: number
  updatedAt: number
}

export interface ScheduledTaskRun {
  at: number
  // sent: the message went out; failed: it could not; skipped: the time was missed by too long.
  status: 'sent' | 'failed' | 'skipped'
  // The time it was due; missing for 立即运行.
  slotAt?: number
  // Run late, when the browser came back after missing the time.
  catchUp?: boolean
  detail?: string
  messageId?: string
  // Sending the round's result to the task's destination.
  delivery?: ScheduledTaskDelivery
}

export interface ScheduledTaskDelivery {
  status: 'sending' | 'sent' | 'failed'
  at: number
  // The destination's name when it was sent.
  destination: string
  detail?: string
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
  // How many times it went to another member after work on it had started.
  reassigns?: number
  summary?: string
  // The coordinator's note (what to redo) or why the member was blocked.
  note?: string
  resultMessageId?: string
  // The request out for this task.
  requestId?: string
  // The coordinator has checked the latest result.
  checked?: boolean
}

// Reading and searching; editing files. A command, a delete or a move is asked every time.
export type ProjectToolKind = 'read' | 'edit'

// A 网站自检 group's check (src/group/siteCheck.ts). The group stays and is asked again by the next
// check, so each site keeps one conversation.
export interface SiteCheckState {
  startedAt: number
  error?: string
  scheduled?: boolean
  kept?: boolean
  // This check's question, and every question the checks of this group asked, so that the user's
  // own messages tell from them. A group from before has neither: its first message is the question.
  questionId?: string
  questionIds?: string[]
  // The second try for the sites that failed: their pages loaded again and asked once more. A site
  // whose page did not come back is left out, keeping its first result; error: none could be asked.
  retry?: { roleIds: string[]; messageId?: string; error?: string }
  // Every site has its result, the second try included.
  finishedAt?: number
  // Members whose page was hidden at some time during the check (the OpenTeam window minimized, the
  // screen locked): one failing then was not checked, rather than failed.
  hiddenRoleIds?: string[]
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
  // The coordinator's request out (plan, check or final write-up); a check may be another member's.
  coordinatorRequestId?: string
  // The check out: who checks and which tasks' results. Nobody checks their own work: the
  // coordinator checks the others' tasks, and another member checks the coordinator's.
  reviewerRoleId?: string
  reviewTaskIds?: string[]
  finalMessageId?: string
  // Local agent members the user let run every request of this project without asking each time
  // (src/background/projectRunGrants.ts). Ends with the project: cleared when it stops or is done.
  runAllowedRoleIds?: string[]
  // The kinds of a local agent member's own actions the user let through for the rest of this
  // project, by member (src/background/projectRunGrants.ts). Ends with the project too.
  toolAllowedKinds?: Record<string, ProjectToolKind[]>
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
  // Members added to a group that had members already (添加成员 → 新成员自己认领): only these choose
  // positions; the others' roles count as taken.
  joiningRoleIds?: string[]
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
  // 群资料库 passages a web member's site conversation holds, and those its last prompt carried.
  librarySent?: string[]
  libraryPending?: { messageId: string; keys: string[] }
  id: string
  chatId: string
  createdBy?: 'orchestration-auto' | 'orchestration-template' | 'team-formation'
  templateId?: string
  modelSource?: RoleModelSource
  chatSite?: ChatSite
  externalModelId?: string
  // A web member's backup: the API model that answers for it when its site cannot take a prompt
  // (src/background/memberBackup.ts).
  backupModelId?: string
  name: string
  description?: string
  systemPrompt?: string
  // The avatar the user picked: a preset colour (tone-0 … tone-5), up to two characters in place of
  // the name's first one, or a small picture (a data: URL) shown instead of both.
  avatarColor?: string
  avatarText?: string
  avatarImage?: string
  // The user named this member. Confirming a team keeps the name and records the position beside it.
  userNamed?: boolean
  // The position the member holds in a confirmed team.
  teamPosition?: string
  // How many of its finished replies the user asked again (重新回复); 让 AI 按任务挑 weighs it
  // (src/group/memberRecord.ts). The reply asked again is gone, so it is counted here.
  redoneReplies?: number
  status: RoleStatus
  contextCursor: number
  // Messages up to this seq were in an earlier conversation of this member (another model or site,
  // or a site conversation that was lost): its persona goes again with its first prompt after it.
  conversationStartedAfterSeq?: number
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
  // Memory items a web member already received in its current site conversation: item id to the
  // item's updatedAt at that time.
  memorySent?: Record<string, number>
  // The items the prompt for this message carries; they join memorySent once it is confirmed sent.
  memoryPending?: { messageId: string; sent: Record<string, number> }
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

// How a source link in a reply was found to be (src/background/linkCheck.ts): it opens, the page is
// missing, the site refuses automatic visits, the site errors, the site responds (page not checked,
// as no access to it was granted), no response without access (the site may not exist, or may block
// such requests), too slow to answer in time, it cannot be reached even with access, or it was not
// checked (not https).
export interface LinkCheck {
  status: 'ok' | 'missing' | 'refused' | 'error' | 'reachable' | 'no-response' | 'slow' | 'unreachable' | 'unchecked'
  httpStatus?: number
  title?: string
  checkedAt: number
}

// A vote (src/group/poll.ts): the question and its options, on the message that asks for it.
export interface MessagePoll {
  question: string
  options: string[]
  round: 1 | 2
  // A second round: the first round's message.
  of?: string
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
  // On a member's reply: what it proposed to remember, until the user saves or dismisses each.
  memoryProposals?: MemoryProposal[]
  // The text of the proposals the user already saved or dismissed, so that reading the reply again
  // (重新同步完整回复) does not offer them again.
  memoryProposalsHandled?: string[]
  // Tokens an API member's reply used, as its model reported them.
  usage?: MessageTokenUsage
  // The API model (its settings' id) that wrote the reply, for the 用量 window. Replies from before
  // it was kept count under the member's model.
  modelId?: string
  // The backup model that wrote an API member's reply, when its main model could not.
  answeredByFallback?: string
  // Why the main model did not answer, when its backup did (an API model's own backup).
  fallbackReason?: string
  // A reply refused because this API model reached its daily spending cap: it offers 今天继续用.
  spendCapModelId?: string
  // The web pages an API member read while it wrote this reply (读网页).
  readPages?: Array<{ url: string; title: string }>
  // The searches an API member made while it wrote this reply (联网搜索), and how many results each had.
  searches?: Array<{ query: string; results: number }>
  // On a web member's reply its site kept saying it was still writing, with no new text for
  // STALLED_GENERATING_MS (src/content/replyObserver.ts): taken as it stood, so the chat goes on.
  stalledWhileGenerating?: boolean
  // On an API member's reply while its request failed and is about to be sent again: which retry
  // this is, of how many, and why the last attempt failed. Gone once text arrives or it ends.
  retry?: { attempt: number; total: number; reason: string }
  // On a request OpenTeam sends to one member to summarize a round: the message that started the
  // round. That member's answer is the round's summary.
  roundSummaryOf?: string
  // On a request OpenTeam sends to the members who answered a message, once all of them had, to
  // review each other's answers (互相审): the message they answered.
  crossReviewOf?: string
  // On the user's message that started a turn-by-turn discussion.
  discussionTopic?: boolean
  // On a request OpenTeam sends to the member whose turn it is: the topic message, the turn number,
  // and the member who handed the turn over by @-mentioning them, if any.
  discussionTurnOf?: string
  discussionTurn?: number
  discussionHandoffFrom?: string
  // On a message the user sent while a discussion ran: the topic. It is shown to the next speakers.
  discussionNoteOf?: string
  // Sent by this group's scheduled task (ScheduledTask.id), not typed by the user.
  scheduledTaskId?: string
  // On the user's message that asks members to vote.
  poll?: MessagePoll
  // On the user's message that asks members to give sources (src/group/sources.ts).
  wantsSources?: boolean
  // A 网站自检's question (src/background/siteCheckHandlers.ts): sent by OpenTeam, answered as it is,
  // with nothing after the round (no 要点 form, summary or review).
  siteCheckQuestion?: boolean
  // On a reply to such a message: what OpenTeam found opening each of its source links.
  linkChecks?: Record<string, LinkCheck>
  // On a request OpenTeam sends to one member to check the facts of a round asked with sources:
  // the message that started the round.
  factCheckOf?: string
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
  // The page load of the frame (Chrome's documentId): a new one means the member's page was loaded
  // again, and with it went whatever it was reading.
  documentId?: string
}

export type RuntimeFrameBindingKey = `${string}:${string}`

export type RuntimeFrameAddressKey = `${number}:${number}`
