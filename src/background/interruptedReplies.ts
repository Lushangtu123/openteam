// Replies that were on their way when their member could no longer give them. A web member's
// reply is read by its page inside an OpenTeam tab: once no OpenTeam tab is open, or the browser
// has started again, that page is gone, and a page opened later does not go on reading the reply.
// An API member's reply comes through the background: when the background starts again, the
// request it was reading is gone. Left alone, such a member would show as replying until it counted
// as stuck, and its question would never be answered.
//
// Each of those replies is ended: the member can be asked again, the question no longer waits for
// it, and what had arrived is kept. A web member's reply may be complete on its site by now, so it
// is kept the way a stopped reply is, where 重新同步完整回复 reads it again; an API member's is
// kept as a failed reply, where 重新回复 asks again.
import { updateUserMessageDeliveryStatus } from '../group/deliveryStatus'
import type { GroupChat, GroupMessage, GroupRole, OpenTeamStore } from '../group/types'
import { isExternalModelRole } from './rolePromptDelivery'

const SITE_REPLY_NOTICE = '⚠️ 这条回复还没有读完，成员页面就关闭了（OpenTeam 页面或浏览器被关闭）。站点上可能已经写完。\n\n可以点击下方的重新同步完整回复按钮把它读回来。'
const API_REPLY_NOTICE = '⚠️ 回复中断了：扩展的后台重新启动，这条回复没有写完。\n\n可以点击下方的重新回复按钮再试一次。'

// What had been read of a web member's reply that was ended here, without the note: the text the
// member's page looks for on the site when the reply is read again (重新同步完整回复).
export function textReadBeforeInterruption(content: string): string {
  if (content === SITE_REPLY_NOTICE) return ''
  const suffix = `\n\n${SITE_REPLY_NOTICE}`
  return content.endsWith(suffix) ? content.slice(0, -suffix.length) : content
}

export interface InterruptedReply {
  chatId: string
  roleId: string
  promptMessageId?: string
}

// Which replies count as interrupted.
export interface InterruptedReplyScope {
  siteMembers: boolean
  apiMembers: boolean
  // Only members with no sign of their reply since this time: a reply begun after the background
  // started is its own and goes on.
  quietSince?: number
}

export interface SettleInterruptedRepliesOptions extends InterruptedReplyScope {
  timestamp: number
  newId(prefix: string): string
  getChatStatusFromRoles(store: OpenTeamStore, chat: GroupChat): GroupChat['status']
}

export function settleInterruptedReplies(store: OpenTeamStore, options: SettleInterruptedRepliesOptions): InterruptedReply[] {
  const settled: InterruptedReply[] = []
  for (const chat of Object.values(store.chatsById)) {
    let changed = false
    for (const roleId of chat.roleIds) {
      const role = store.rolesById[roleId]
      if (!role || role.chatId !== chat.id || role.status !== 'thinking') continue
      const external = isExternalModelRole(role)
      if (!(external ? options.apiMembers : options.siteMembers)) continue
      if (options.quietSince !== undefined && role.updatedAt >= options.quietSince) continue

      const promptMessageId = role.lastPromptMessageId
      const prompt = promptMessageId ? store.messagesById[promptMessageId] : undefined
      if (prompt?.chatId === chat.id && prompt.type === 'user') {
        keepInterruptedReply(store, chat, role, prompt, external, options)
        if (prompt.deliveryStatus?.[role.id]) {
          prompt.deliveryStatus[role.id] = 'error'
          updateUserMessageDeliveryStatus(prompt)
        }
      }
      // A web member waits for its page again, which loads when the group is opened.
      role.status = external ? 'ready' : 'loading'
      role.updatedAt = options.timestamp
      delete role.lastPromptMessageId
      delete role.replyAttemptId
      delete role.liveReply
      settled.push({ chatId: chat.id, roleId: role.id, ...(promptMessageId ? { promptMessageId } : {}) })
      changed = true
    }
    if (!changed) continue
    chat.status = options.getChatStatusFromRoles(store, chat)
    chat.updatedAt = options.timestamp
  }
  return settled
}

// What had arrived of the reply, with a note on what happened, as the member's reply to the prompt.
function keepInterruptedReply(store: OpenTeamStore, chat: GroupChat, role: GroupRole, prompt: GroupMessage, external: boolean, options: SettleInterruptedRepliesOptions): void {
  const replies = chat.messageIds
    .map(id => store.messagesById[id])
    .filter(message => message?.type === 'assistant' && message.roleId === role.id && message.sourceMessageId === prompt.id && (message.status === 'pending' || message.status === 'error'))
  const existing = replies[replies.length - 1]
  // An earlier failure's note is replaced; text that was still arriving is kept.
  const arrived = (existing?.status === 'pending' ? existing.content : role.liveReply?.promptMessageId === prompt.id ? role.liveReply.content : '').trim()
  const content = [arrived, external ? API_REPLY_NOTICE : SITE_REPLY_NOTICE].filter(Boolean).join('\n\n')
  const status = external ? 'error' : 'received'
  if (existing) {
    existing.content = content
    existing.contentFormat = 'markdown'
    existing.status = status
    delete existing.retry
    return
  }
  const reply: GroupMessage = {
    id: options.newId('msg'),
    chatId: chat.id,
    seq: chat.nextMessageSeq,
    type: 'assistant',
    content,
    contentFormat: 'markdown',
    roleId: role.id,
    roleName: role.name,
    sourceMessageId: prompt.id,
    createdAt: options.timestamp,
    status,
  }
  store.messagesById[reply.id] = reply
  chat.messageIds.push(reply.id)
  chat.nextMessageSeq += 1
}

// Set in the browser's session storage at the background's first start: kept while the browser
// runs, gone after it restarts or the extension is loaded again.
export const BACKGROUND_STARTED_KEY = 'openteam.backgroundStarted'

export interface InterruptedReplySweeperDependencies {
  tabs: { query(queryInfo: { url: string }): Promise<unknown[]> }
  teamPageUrl: string
  // chrome.storage.session, where the browser has it.
  sessionStorage?: {
    get(key: string): Promise<Record<string, unknown>>
    set(items: Record<string, unknown>): Promise<void>
  }
  settle(scope: InterruptedReplyScope): Promise<number>
  now(): number
  log: { warn(event: string, details?: Record<string, unknown>): void }
}

// When to look for interrupted replies. Created once per start of the background.
export function createInterruptedReplySweeper(deps: InterruptedReplySweeperDependencies) {
  const startedAt = deps.now()
  const openTeamPageIsOpen = async () => (await deps.tabs.query({ url: `${deps.teamPageUrl}*` })).length > 0
  // The first start since the browser started, or since the extension was loaded: the member pages
  // of before are gone, even where the browser has opened OpenTeam pages again (new pages; and the
  // background may have been started by one of them).
  const firstStartInBrowserSession = async () => {
    const session = deps.sessionStorage
    if (!session) return false
    const startedBefore = (await session.get(BACKGROUND_STARTED_KEY))[BACKGROUND_STARTED_KEY] === true
    if (!startedBefore) await session.set({ [BACKGROUND_STARTED_KEY]: true })
    return !startedBefore
  }
  const sweep = async (event: string, scope: () => Promise<InterruptedReplyScope | undefined>): Promise<number> => {
    try {
      const chosen = await scope()
      return chosen ? await deps.settle(chosen) : 0
    } catch (error) {
      deps.log.warn('interrupted-replies:failed', { event, error: error instanceof Error ? error.message : String(error) })
      return 0
    }
  }
  return {
    // API requests of the previous background are gone. Web members' pages are gone after a browser
    // or extension restart; when the browser only restarted the background, the OpenTeam pages
    // still open go on reading their members' replies.
    atBackgroundStart: () => sweep('background-start', async () => {
      const newSession = await firstStartInBrowserSession().catch(() => false)
      return { siteMembers: newSession || !await openTeamPageIsOpen(), apiMembers: true, quietSince: startedAt }
    }),
    // Once the last OpenTeam page is closed, nothing is reading web members' replies.
    afterTabClosed: () => sweep('tab-closed', async () => await openTeamPageIsOpen() ? undefined : { siteMembers: true, apiMembers: false }),
  }
}
