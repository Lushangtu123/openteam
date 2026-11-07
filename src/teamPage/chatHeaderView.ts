import type { GroupChat, GroupMessage, GroupRole, RoomMode } from '../group/types'
import { normalizeLanguage, translateUi, type TeamLanguage } from '../shared/i18n'
import type { TeamPageState } from './appState'
import { roleAvatarLabel, roleToneClass } from './viewHelpers'

export interface ChatHeaderViewDependencies {
  state: TeamPageState
  chatTitleEl: HTMLElement
  // The group's avatar next to its title (shown by the Grok style).
  chatTitleAvatarEl?: HTMLElement
  chatSubtitleEl: HTMLElement
  chatStatusEl: HTMLElement
  togglePeopleDrawerEl: HTMLButtonElement
  openOrchestrationEl: HTMLButtonElement
  // The 工作流 menu (编排, 项目) and the 更多 menu (恢复会话), shown once a group is open.
  workflowMenuWrapEl?: HTMLElement
  moreMenuWrapEl?: HTMLElement
  getLanguage(): TeamLanguage
  getCurrentChat(): GroupChat | undefined
  getCurrentRoles(): GroupRole[]
  getCurrentMessages(): GroupMessage[]
}

export interface ChatHeaderView {
  renderChatHeader(): void
}

// The header is about the open group: its name and state, its workflows, members and notes. How the
// next message is answered is chosen in the input box (composerModesView).
export function createChatHeaderView(deps: ChatHeaderViewDependencies): ChatHeaderView {
  function renderTitleAvatar(chat: GroupChat | undefined): void {
    const avatar = deps.chatTitleAvatarEl
    if (!avatar) return
    avatar.hidden = !chat
    if (!chat) return
    avatar.className = `chat-avatar chat-title-avatar ${roleToneClass(chat.name)}`
    avatar.textContent = roleAvatarLabel(chat.name)
  }

  function renderChatHeader(): void {
    const chat = deps.getCurrentChat()
    const roles = deps.getCurrentRoles()
    const messages = deps.getCurrentMessages()
    renderTitleAvatar(chat)
    // Without a group, the controls for one are not shown at all.
    deps.chatStatusEl.hidden = !chat
    deps.togglePeopleDrawerEl.hidden = !chat
    if (deps.workflowMenuWrapEl) deps.workflowMenuWrapEl.hidden = !chat
    if (deps.moreMenuWrapEl) deps.moreMenuWrapEl.hidden = !chat
    if (!chat) {
      deps.chatTitleEl.textContent = ui('未选择群聊')
      deps.chatSubtitleEl.textContent = ui('创建或选择一个群聊开始协作')
      deps.chatStatusEl.className = 'status-pill'
      deps.chatStatusEl.textContent = ''
      deps.togglePeopleDrawerEl.textContent = ui('成员 0')
      deps.togglePeopleDrawerEl.disabled = true
      deps.openOrchestrationEl.hidden = true
      return
    }

    deps.chatTitleEl.textContent = chat.name
    deps.chatSubtitleEl.textContent = roles.length ? ui(`${modeLabel(chat.mode)} · ${roles.length} 位成员 · ${messages.length} 条消息`) : ui('暂无成员')
    deps.chatStatusEl.className = `status-pill status-${chat.status}`
    deps.chatStatusEl.textContent = ui(chatStatusLabel(chat.status))
    // A group that has not started (no message yet) shows no state, rather than 草稿.
    deps.chatStatusEl.hidden = chat.status === 'draft'
    // Narrow windows show only the dot; the state stays readable on hover and to screen readers.
    deps.chatStatusEl.title = deps.chatStatusEl.textContent
    deps.togglePeopleDrawerEl.disabled = false
    deps.togglePeopleDrawerEl.textContent = ui(`成员 ${roles.length}`)
    deps.togglePeopleDrawerEl.setAttribute('aria-label', ui(deps.state.peopleDrawerOpen ? '收起成员面板' : '打开成员面板'))
    deps.togglePeopleDrawerEl.setAttribute('aria-expanded', String(deps.state.peopleDrawerOpen))
    deps.openOrchestrationEl.hidden = chat.mode !== 'collaborative'
  }

  function ui(source: string): string {
    return translateUi(source, normalizeLanguage(deps.getLanguage()))
  }

  return { renderChatHeader }
}

function modeLabel(mode: RoomMode): string {
  return mode === 'collaborative' ? '协作群聊模式' : '独立专家模式'
}

function chatStatusLabel(status: GroupChat['status']): string {
  const labels: Record<GroupChat['status'], string> = {
    draft: '草稿',
    initializing: '初始化中',
    ready: '进行中',
    running: '运行中',
    error: '异常',
  }
  return labels[status]
}
