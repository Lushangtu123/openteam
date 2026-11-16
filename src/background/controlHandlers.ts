import { OPENTEAM_CONTROL_CAPABILITIES, controlFailure, controlSuccess, isRecord, type ControlHttpCommand, type ControlHttpResult } from '../shared/localControlProtocol'
import type { GroupChat, GroupMessage, GroupRole, MemoryItem, OpenTeamStore, RoomMode, RuntimeFrameBinding } from '../group/types'
import type { RuntimeMessage } from './runtimeClient'
import { readNewChatCollaboration } from '../group/collaboration'
import { MEMORY_MAX_RETRIEVED, memoryModeForChat, pinnedMemoryItems, searchMemoryItems, visibleMemoryItems } from '../group/memoryRetrieval'

export interface ControlActionExecutorDependencies {
  loadStore(): Promise<OpenTeamStore>
  routeRuntimeMessage(message: RuntimeMessage): Promise<unknown>
  runtimeFrames: {
    list(): RuntimeFrameBinding[]
  }
  openTeamPage(): Promise<void> | void
  waitFor(ms: number): Promise<void>
  now(): number
}

export interface TaskReadResult {
  chatId: string
  messageId: string
  status: GroupMessage['status']
  targetRoleIds: string[]
  pendingRoleIds: string[]
  receivedRoleIds: string[]
  errorRoleIds: string[]
  replies: Array<{
    messageId: string
    roleId: string
    roleName: string
    content: string
    status: GroupMessage['status']
    conversationUrl?: string
  }>
}

type RuntimeResponse = { ok?: boolean; error?: string; [key: string]: unknown }

const DEFAULT_WAIT_TIMEOUT_MS = 300_000
const WAIT_POLL_INTERVAL_MS = 500

export function createControlActionExecutor(deps: ControlActionExecutorDependencies): (command: ControlHttpCommand) => Promise<ControlHttpResult> {
  return async command => {
    try {
      const store = await deps.loadStore()
      if (!store.settings.agentControlEnabled) {
        return controlFailure(command.id, 'control_disabled', 'OpenTeam 尚未启用本机智能体控制。', {
          hint: '请在 OpenTeam 页面设置里开启“本机智能体控制”。',
          recoverable: true,
        })
      }

      const data = await executeEnabledCommand(command, store, deps)
      return controlSuccess(command.id, withoutStoreSecrets(data))
    } catch (error) {
      return controlFailure(command.id, errorCode(error), error instanceof Error ? error.message : String(error), { recoverable: true })
    }
  }
}

// Local agents read these results into their LLM context, so never hand them API keys.
function withoutStoreSecrets(data: unknown): unknown {
  if (!isRecord(data) || !isRecord(data.store)) return data
  return { ...data, store: redactStoreSecrets(data.store as unknown as OpenTeamStore) }
}

export function redactStoreSecrets(store: OpenTeamStore): OpenTeamStore {
  const externalModelsById = Object.fromEntries(
    Object.entries(store.settings?.externalModelsById ?? {}).map(([id, model]) => [id, { ...model, apiKey: model.apiKey ? '[redacted]' : '' }]),
  )
  return { ...store, settings: { ...store.settings, externalModelsById } }
}

async function executeEnabledCommand(command: ControlHttpCommand, initialStore: OpenTeamStore, deps: ControlActionExecutorDependencies): Promise<unknown> {
  switch (command.action) {
    case 'store.get':
      return { store: initialStore, bindings: deps.runtimeFrames.list(), capabilities: OPENTEAM_CONTROL_CAPABILITIES }
    case 'chat.list':
      return { chats: initialStore.chatOrder.map(chatId => chatSummary(initialStore.chatsById[chatId], initialStore)).filter(Boolean) }
    case 'chat.get':
      return chatDetails(initialStore, requirePayloadString(command.payload, 'chatId'))
    case 'chat.create':
      return createChat(command.payload, deps)
    case 'chat.activate':
      return activateChat(command.payload, deps)
    case 'chat.initialize':
      return initializeChat(command.payload, deps)
    case 'roles.batchAdd':
      return batchAddRoles(command.payload, deps)
    case 'task.post':
      return postTask(command.payload, initialStore, deps)
    case 'task.read':
      return readTaskResult(initialStore, requirePayloadString(command.payload, 'chatId'), requirePayloadString(command.payload, 'messageId'))
    case 'task.wait':
      return waitForTask(command.payload, deps)
    case 'run.createAndPost':
      return createAndPost(command.payload, initialStore, deps)
    case 'memory.search':
      return searchMemory(command.payload, initialStore)
    case 'memory.add':
      return addMemory(command.payload, initialStore, deps)
    default:
      throw new Error(`不支持的控制命令：${command.action}`)
  }
}

async function createChat(payload: unknown, deps: ControlActionExecutorDependencies): Promise<unknown> {
  const input = requireRecord(payload, '缺少群聊参数')
  // How its members answer a message to several of them: { style: 'review' | 'turns' | 'parallel', replyAll }.
  const collaboration = readNewChatCollaboration(input.collaboration)
  const response = await routeOk(deps, {
    type: 'GROUP_CHAT_CREATE',
    name: readString(input.name) ?? '新群聊',
    description: readString(input.description),
    mode: readRoomMode(input.mode),
    ...(collaboration ? { collaboration } : {}),
  })
  return {
    chat: response.chat,
    store: response.store,
  }
}

async function activateChat(payload: unknown, deps: ControlActionExecutorDependencies): Promise<unknown> {
  const chatId = requirePayloadString(payload, 'chatId')
  const response = await routeOk(deps, { type: 'GROUP_CHAT_SWITCH', chatId })
  await deps.openTeamPage()
  return { chatId, store: response.store }
}

async function initializeChat(payload: unknown, deps: ControlActionExecutorDependencies): Promise<unknown> {
  const input = requireRecord(payload, '缺少初始化参数')
  const chatId = requireString(input.chatId, '缺少群聊 ID')
  const waitForReady = input.waitForReady !== false
  const timeoutMs = readPositiveNumber(input.timeoutMs) ?? 120_000
  await activateChat({ chatId }, deps)
  if (!waitForReady) return { chatId, readyRoleIds: [], pendingRoleIds: [], failedRoleIds: [], timedOut: false }
  return waitForReadyRoles(chatId, timeoutMs, deps)
}

async function batchAddRoles(payload: unknown, deps: ControlActionExecutorDependencies): Promise<unknown> {
  const input = requireRecord(payload, '缺少成员参数')
  return routeOk(deps, {
    type: 'GROUP_ROLES_CREATE_BATCH',
    chatId: requireString(input.chatId, '缺少群聊 ID'),
    items: Array.isArray(input.items) ? input.items : [],
  })
}

async function postTask(payload: unknown, store: OpenTeamStore, deps: ControlActionExecutorDependencies): Promise<unknown> {
  const input = requireRecord(payload, '缺少任务参数')
  const chatId = requireString(input.chatId, '缺少群聊 ID')
  const content = requireString(input.content, '任务内容不能为空')
  const target = input.target ?? 'all'
  const response = await routeOk(deps, {
    type: 'GROUP_MESSAGE_SEND',
    chatId,
    raw: buildTaskRaw(store, chatId, target, content),
    reference: input.reference,
  })
  return {
    message: response.message,
    deliveries: response.deliveries,
  }
}

async function waitForTask(payload: unknown, deps: ControlActionExecutorDependencies): Promise<TaskReadResult & { timedOut: boolean }> {
  const input = requireRecord(payload, '缺少等待任务参数')
  const chatId = requireString(input.chatId, '缺少群聊 ID')
  const messageId = requireString(input.messageId, '缺少消息 ID')
  const timeoutMs = readPositiveNumber(input.timeoutMs) ?? DEFAULT_WAIT_TIMEOUT_MS
  const start = deps.now()

  while (deps.now() - start <= timeoutMs) {
    const store = await deps.loadStore()
    const result = readTaskResult(store, chatId, messageId)
    if (result.pendingRoleIds.length === 0) return { ...result, timedOut: false }
    await deps.waitFor(WAIT_POLL_INTERVAL_MS)
  }

  return { ...readTaskResult(await deps.loadStore(), chatId, messageId), timedOut: true }
}

async function createAndPost(payload: unknown, initialStore: OpenTeamStore, deps: ControlActionExecutorDependencies): Promise<unknown> {
  const input = requireRecord(payload, '缺少一键运行参数')
  const chatInput = requireRecord(input.chat, '缺少群聊参数')
  const taskInput = requireRecord(input.task, '缺少任务参数')
  const options = isRecord(input.options) ? input.options : {}
  const chat = await resolveRunChat(chatInput, initialStore, deps)
  const rolesInput = Array.isArray(input.roles) ? input.roles : []

  let roles: GroupRole[] = chat.roleIds.map(roleId => initialStore.rolesById[roleId]).filter((role): role is GroupRole => Boolean(role))
  if (rolesInput.length > 0) {
    const roleResponse = await routeOk(deps, { type: 'GROUP_ROLES_CREATE_BATCH', chatId: chat.id, items: rolesInput })
    roles = Array.isArray(roleResponse.roles) ? roleResponse.roles as GroupRole[] : roles
  }

  if (options.activateChat !== false) {
    await routeOk(deps, { type: 'GROUP_CHAT_SWITCH', chatId: chat.id })
  }
  if (options.openTeamPage !== false) {
    await deps.openTeamPage()
  }

  const latestStore = await deps.loadStore()
  const postResponse = await postTask({
    chatId: chat.id,
    target: taskInput.target ?? 'all',
    content: requireString(taskInput.content, '任务内容不能为空'),
    reference: taskInput.reference,
  }, latestStore, deps) as { message?: GroupMessage }
  const message = requireMessage(postResponse.message)
  const waitForReplies = options.waitForReplies === true
  const readResult = waitForReplies
    ? await waitForTask({ chatId: chat.id, messageId: message.id, timeoutMs: readPositiveNumber(options.timeoutMs) }, deps)
    : readTaskResult(await deps.loadStore(), chat.id, message.id)

  return {
    chat: chatSummary(chat, await deps.loadStore()),
    roles: roles.map(roleSummary),
    taskMessage: {
      id: message.id,
      content: message.content,
      status: message.status,
    },
    replies: readResult.replies,
    warnings: 'timedOut' in readResult && readResult.timedOut ? ['任务等待超时，返回部分回复。'] : undefined,
  }
}

async function resolveRunChat(chatInput: Record<string, unknown>, store: OpenTeamStore, deps: ControlActionExecutorDependencies): Promise<GroupChat> {
  const reuse = isRecord(chatInput.reuse) ? chatInput.reuse : undefined
  const strategy = readString(reuse?.strategy) ?? 'none'
  if (strategy === 'by-id') {
    const chat = store.chatsById[requireString(reuse?.chatId, '缺少复用群聊 ID')]
    if (!chat) throw new Error('找不到要复用的群聊')
    return chat
  }
  if (strategy === 'by-name') {
    const name = requireString(chatInput.name, '群聊名称不能为空')
    const chat = store.chatOrder.map(chatId => store.chatsById[chatId]).find(item => item?.name === name)
    if (chat) return chat
  }

  const response = await routeOk(deps, {
    type: 'GROUP_CHAT_CREATE',
    name: readString(chatInput.name) ?? '智能体任务群聊',
    description: readString(chatInput.description),
    mode: readRoomMode(chatInput.mode),
  })
  return requireChat(response.chat)
}

export function readTaskResult(store: OpenTeamStore, chatId: string, messageId: string): TaskReadResult {
  const chat = store.chatsById[chatId]
  if (!chat) throw new Error(`找不到群聊：${chatId}`)
  const taskMessage = store.messagesById[messageId]
  if (!taskMessage || taskMessage.chatId !== chat.id || taskMessage.type !== 'user') throw new Error(`找不到任务消息：${messageId}`)

  const targetRoleIds = taskMessage.targetRoleIds?.length ? taskMessage.targetRoleIds : [...chat.roleIds]
  const explicitReplies = chat.messageIds
    .map(id => store.messagesById[id])
    .filter((message): message is GroupMessage => Boolean(message && message.type === 'assistant' && message.sourceMessageId === taskMessage.id && Boolean(message.roleId)))
  const replies = explicitReplies.length > 0 ? explicitReplies : inferRepliesAfterTask(store, chat, taskMessage, targetRoleIds)
  const statusByRole = taskMessage.deliveryStatus ?? {}

  return {
    chatId: chat.id,
    messageId: taskMessage.id,
    status: taskMessage.status,
    targetRoleIds,
    pendingRoleIds: targetRoleIds.filter(roleId => statusByRole[roleId] === 'pending' || statusByRole[roleId] === 'sent'),
    receivedRoleIds: targetRoleIds.filter(roleId => statusByRole[roleId] === 'received'),
    errorRoleIds: targetRoleIds.filter(roleId => statusByRole[roleId] === 'error'),
    replies: replies.map(reply => {
      const role = reply.roleId ? store.rolesById[reply.roleId] : undefined
      return {
        messageId: reply.id,
        roleId: reply.roleId ?? '',
        roleName: reply.roleName ?? role?.name ?? '未知成员',
        content: reply.content,
        status: reply.status,
        conversationUrl: role?.geminiConversationUrl,
      }
    }),
  }
}

function inferRepliesAfterTask(store: OpenTeamStore, chat: GroupChat, taskMessage: GroupMessage, targetRoleIds: string[]): GroupMessage[] {
  const taskIndex = chat.messageIds.indexOf(taskMessage.id)
  if (taskIndex < 0) return []
  const targetSet = new Set(targetRoleIds)
  const replies: GroupMessage[] = []
  for (let index = taskIndex + 1; index < chat.messageIds.length; index += 1) {
    const message = store.messagesById[chat.messageIds[index]]
    if (!message) continue
    if (message.type === 'user') break
    if (message.type === 'assistant' && message.roleId && targetSet.has(message.roleId)) replies.push(message)
  }
  return replies
}

// The memory store as one member of one group sees it (docs/MEMORY_STORE.zh-CN.md, sections 3
// and 10): the items it may read, its pinned ones, and those a query brings up. This is so a tool
// sees what the member sees; it is no barrier, since the same token reads the whole store.
const MAX_MEMORY_SEARCH_LIMIT = 50

function searchMemory(payload: unknown, store: OpenTeamStore): unknown {
  const input = requireRecord(payload, '缺少记忆查询参数')
  const chat = requireChatIn(store, requireString(input.chatId, '缺少群聊 ID'))
  const role = requireRoleIn(store, chat, input)
  const visible = visibleMemoryItems(store, chat, role, memoryModeForChat(chat))
  const query = readString(input.query)
  const limit = Math.min(readPositiveNumber(input.limit) ?? (query ? MEMORY_MAX_RETRIEVED : MAX_MEMORY_SEARCH_LIMIT), MAX_MEMORY_SEARCH_LIMIT)
  return {
    chatId: chat.id,
    roleId: role.id,
    roleName: role.name,
    memoryDisabled: chat.memoryDisabled === true,
    visibleCount: visible.length,
    // Sent with every prompt, whatever it asks.
    pinned: pinnedMemoryItems(visible).map(item => memorySummary(item)),
    // With a query: the items it brings up, best first. Without one: every item the member may read.
    items: query
      ? searchMemoryItems(visible, query, limit).map(found => memorySummary(found.item, found.score))
      : visible.slice(0, limit).map(item => memorySummary(item)),
  }
}

// Saves an item as the user's: whoever holds the control token acts for the user. --scope says who
// gets it, as in the save window: every group, one group, or one member of one group.
async function addMemory(payload: unknown, store: OpenTeamStore, deps: ControlActionExecutorDependencies): Promise<unknown> {
  const input = requireRecord(payload, '缺少记忆参数')
  const scope = readString(input.scope)
  if (scope !== 'global' && scope !== 'chat' && scope !== 'role') throw new Error('缺少记忆范围：global（全部群聊）、chat（本群）或 role（本群的一位成员）')
  let scopeId: string | undefined
  if (scope !== 'global') {
    const chat = requireChatIn(store, requireString(input.chatId, '缺少群聊 ID'))
    scopeId = scope === 'chat' ? chat.id : requireRoleIn(store, chat, input).id
  }
  const response = await routeOk(deps, {
    type: 'GROUP_MEMORY_ADD',
    item: {
      scope,
      ...(scopeId ? { scopeId } : {}),
      kind: readString(input.kind) ?? 'fact',
      content: typeof input.content === 'string' ? input.content : '',
      ...(Array.isArray(input.tags) ? { tags: input.tags } : {}),
      ...(typeof input.pinned === 'boolean' ? { pinned: input.pinned } : {}),
    },
  })
  return { item: isRecord(response.item) ? memorySummary(response.item as unknown as MemoryItem) : response.item }
}

function memorySummary(item: MemoryItem, score?: number): Record<string, unknown> {
  return {
    id: item.id,
    scope: item.scope,
    ...(item.scopeId ? { scopeId: item.scopeId } : {}),
    kind: item.kind,
    content: item.content,
    ...(item.tags?.length ? { tags: item.tags } : {}),
    ...(item.pinned ? { pinned: true } : {}),
    source: item.source.origin,
    ...(score === undefined ? {} : { score: Math.round(score * 1000) / 1000 }),
  }
}

function requireChatIn(store: OpenTeamStore, chatId: string): GroupChat {
  const chat = store.chatsById[chatId]
  if (!chat) throw new Error(`找不到群聊：${chatId}`)
  return chat
}

// The member named by roleId, or by roleName within the group (a name two members share is refused).
function requireRoleIn(store: OpenTeamStore, chat: GroupChat, input: Record<string, unknown>): GroupRole {
  const members = chat.roleIds.map(id => store.rolesById[id]).filter((role): role is GroupRole => Boolean(role))
  const roleId = readString(input.roleId)
  if (roleId) {
    const role = members.find(member => member.id === roleId)
    if (!role) throw new Error(`群聊里没有这位成员：${roleId}`)
    return role
  }
  const roleName = readString(input.roleName)
  if (!roleName) throw new Error('缺少成员：用 roleId 或 roleName 指定')
  const matches = members.filter(member => member.name === roleName)
  if (matches.length === 0) throw new Error(`群聊里没有叫「${roleName}」的成员`)
  if (matches.length > 1) throw new Error(`群聊里有 ${matches.length} 位叫「${roleName}」的成员，请改用 roleId`)
  return matches[0]
}

function buildTaskRaw(store: OpenTeamStore, chatId: string, target: unknown, content: string): string {
  if (target === 'all') return `@所有人 ${content}`
  if (isRecord(target) && Array.isArray(target.roleNames)) return `${target.roleNames.map(name => `@${String(name)}`).join(' ')} ${content}`
  if (isRecord(target) && Array.isArray(target.roleIds)) {
    const names = target.roleIds
      .map(roleId => store.rolesById[String(roleId)])
      .filter((role): role is GroupRole => Boolean(role && role.chatId === chatId))
      .map(role => `@${role.name}`)
    if (names.length === 0) throw new Error('没有找到可发送的目标人员')
    return `${names.join(' ')} ${content}`
  }
  throw new Error('不支持的任务目标')
}

async function waitForReadyRoles(chatId: string, timeoutMs: number, deps: ControlActionExecutorDependencies): Promise<{
  chatId: string
  readyRoleIds: string[]
  pendingRoleIds: string[]
  failedRoleIds: string[]
  timedOut: boolean
}> {
  const start = deps.now()
  while (deps.now() - start <= timeoutMs) {
    const store = await deps.loadStore()
    const chat = store.chatsById[chatId]
    if (!chat) throw new Error(`找不到群聊：${chatId}`)
    const roles = chat.roleIds.map(roleId => store.rolesById[roleId]).filter((role): role is GroupRole => Boolean(role))
    const siteRoles = roles.filter(role => role.modelSource !== 'external')
    const bindings = deps.runtimeFrames.list()
    const readyRoleIds = siteRoles.filter(role => bindings.some(binding => binding.chatId === chat.id && binding.roleId === role.id && binding.ready)).map(role => role.id)
    const failedRoleIds = siteRoles.filter(role => role.status === 'error').map(role => role.id)
    const pendingRoleIds = siteRoles.map(role => role.id).filter(roleId => !readyRoleIds.includes(roleId) && !failedRoleIds.includes(roleId))
    if (pendingRoleIds.length === 0) return { chatId, readyRoleIds, pendingRoleIds, failedRoleIds, timedOut: false }
    await deps.waitFor(WAIT_POLL_INTERVAL_MS)
  }
  const store = await deps.loadStore()
  const chat = store.chatsById[chatId]
  const bindings = deps.runtimeFrames.list()
  const roleIds = chat?.roleIds ?? []
  const readyRoleIds = roleIds.filter(roleId => bindings.some(binding => binding.chatId === chatId && binding.roleId === roleId && binding.ready))
  return {
    chatId,
    readyRoleIds,
    pendingRoleIds: roleIds.filter(roleId => !readyRoleIds.includes(roleId)),
    failedRoleIds: roleIds.filter(roleId => store.rolesById[roleId]?.status === 'error'),
    timedOut: true,
  }
}

async function routeOk(deps: ControlActionExecutorDependencies, message: RuntimeMessage): Promise<RuntimeResponse> {
  const response = await deps.routeRuntimeMessage(message) as RuntimeResponse
  if (response?.ok === false) throw new Error(response.error || `${message.type} 执行失败`)
  return response
}

function chatSummary(chat: GroupChat | undefined, store: OpenTeamStore): unknown {
  if (!chat) return undefined
  return {
    id: chat.id,
    name: chat.name,
    description: chat.description,
    mode: chat.mode,
    status: chat.status,
    roleCount: chat.roleIds.length,
    messageCount: chat.messageIds.length,
    current: store.currentChatId === chat.id,
    createdAt: chat.createdAt,
    updatedAt: chat.updatedAt,
  }
}

function chatDetails(store: OpenTeamStore, chatId: string): unknown {
  const chat = store.chatsById[chatId]
  if (!chat) throw new Error(`找不到群聊：${chatId}`)
  return {
    chat: chatSummary(chat, store),
    roles: chat.roleIds.map(roleId => store.rolesById[roleId]).filter((role): role is GroupRole => Boolean(role)).map(roleSummary),
    messages: chat.messageIds.map(messageId => store.messagesById[messageId]).filter(Boolean),
  }
}

function roleSummary(role: GroupRole): unknown {
  return {
    id: role.id,
    name: role.name,
    description: role.description,
    chatSite: role.chatSite,
    modelSource: role.modelSource,
    status: role.status,
    conversationUrl: role.geminiConversationUrl,
  }
}

function requirePayloadString(payload: unknown, key: string): string {
  return requireString(requireRecord(payload, '缺少命令参数')[key], `缺少 ${key}`)
}

function requireRecord(value: unknown, message: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(message)
  return value
}

function requireString(value: unknown, message: string): string {
  const text = readString(value)
  if (!text) throw new Error(message)
  return text
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' ? value.trim() || undefined : undefined
}

function readPositiveNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined
}

function readRoomMode(value: unknown): RoomMode | undefined {
  return value === 'collaborative' || value === 'independent' ? value : undefined
}

function requireChat(value: unknown): GroupChat {
  if (!isRecord(value) || typeof value.id !== 'string' || !Array.isArray(value.roleIds)) throw new Error('群聊创建返回格式无效')
  return value as unknown as GroupChat
}

function requireMessage(value: unknown): GroupMessage {
  if (!isRecord(value) || typeof value.id !== 'string' || value.type !== 'user') throw new Error('任务消息返回格式无效')
  return value as unknown as GroupMessage
}

function errorCode(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  if (message.includes('找不到群聊')) return 'chat_not_found'
  if (message.includes('找不到人员')) return 'role_not_found'
  if (message.includes('不支持')) return 'invalid_request'
  return 'internal_error'
}
