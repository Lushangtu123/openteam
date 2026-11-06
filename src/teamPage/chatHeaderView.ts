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
  getLanguage(): TeamLanguage
  getCurrentChat(): GroupChat | undefined
  getCurrentRoles(): GroupRole[]
  getCurrentMessages(): GroupMessage[]
  runCommand(type: string, payload?: Record<string, unknown>): Promise<void>
}

export interface ChatHeaderView {
  renderChatHeader(): void
}

export function createChatHeaderView(deps: ChatHeaderViewDependencies): ChatHeaderView {
  let manualMentionToggle: HTMLButtonElement | undefined
  let discussionToggle: HTMLButtonElement | undefined

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
    if (!chat) {
      deps.chatTitleEl.textContent = ui('未选择群聊')
      deps.chatSubtitleEl.textContent = ui('创建或选择一个群聊开始协作')
      deps.chatStatusEl.className = 'status-pill'
      deps.chatStatusEl.textContent = ui('空')
      deps.togglePeopleDrawerEl.textContent = ui('成员 0')
      deps.togglePeopleDrawerEl.disabled = true
      deps.openOrchestrationEl.hidden = true
      if (manualMentionToggle) {
        manualMentionToggle.hidden = true
        manualMentionToggle.disabled = true
      }
      if (discussionToggle) {
        discussionToggle.hidden = true
        discussionToggle.disabled = true
      }
      return
    }

    deps.chatTitleEl.textContent = chat.name
    deps.chatSubtitleEl.textContent = roles.length ? ui(`${modeLabel(chat.mode)} · ${roles.length} 位成员 · ${messages.length} 条消息`) : ui('暂无成员')
    deps.chatStatusEl.className = `status-pill status-${chat.status}`
    deps.chatStatusEl.textContent = ui(chatStatusLabel(chat.status))
    deps.togglePeopleDrawerEl.disabled = false
    deps.togglePeopleDrawerEl.textContent = ui(`成员 ${roles.length}`)
    deps.togglePeopleDrawerEl.setAttribute('aria-label', ui(deps.state.peopleDrawerOpen ? '收起成员面板' : '打开成员面板'))
    deps.togglePeopleDrawerEl.setAttribute('aria-expanded', String(deps.state.peopleDrawerOpen))
    deps.openOrchestrationEl.hidden = chat.mode !== 'collaborative'

    if (!manualMentionToggle) {
      manualMentionToggle = document.createElement('button')
      manualMentionToggle.type = 'button'
      manualMentionToggle.className = 'btn drawer-summary manual-mention-toggle'
      manualMentionToggle.setAttribute('role', 'switch')
      manualMentionToggle.addEventListener('click', async () => {
        const current = deps.getCurrentChat()
        if (!current) return
        const plainMessagesReplyAll = current.requireManualMention === false
        await deps.runCommand('GROUP_CHAT_UPDATE', { chatId: current.id, requireManualMention: plainMessagesReplyAll ? true : false })
      })
      deps.togglePeopleDrawerEl.parentElement?.insertBefore(manualMentionToggle, deps.togglePeopleDrawerEl)
    }
    manualMentionToggle.hidden = chat.mode !== 'collaborative'
    manualMentionToggle.disabled = false
    const plainMessagesReplyAll = chat.requireManualMention === false
    const ruleHint = '开启后，普通消息也会触发所有成员回复；关闭后，只有 @ 成员或 @所有人才触发回复'
    manualMentionToggle.textContent = ui('免@')
    manualMentionToggle.title = ui(ruleHint)
    manualMentionToggle.setAttribute('aria-label', ui(ruleHint))
    manualMentionToggle.setAttribute('aria-pressed', String(plainMessagesReplyAll))
    manualMentionToggle.setAttribute('aria-checked', String(plainMessagesReplyAll))
    renderDiscussionToggle(chat, manualMentionToggle)
  }

  // 轮流讨论: messages to several members start a turn-by-turn discussion (协作 groups only).
  function renderDiscussionToggle(chat: GroupChat, before: HTMLElement): void {
    if (!discussionToggle) {
      discussionToggle = document.createElement('button')
      discussionToggle.type = 'button'
      discussionToggle.className = 'btn drawer-summary manual-mention-toggle discussion-toggle'
      discussionToggle.setAttribute('role', 'switch')
      discussionToggle.addEventListener('click', async () => {
        const current = deps.getCurrentChat()
        if (!current) return
        await deps.runCommand('GROUP_CHAT_UPDATE', { chatId: current.id, discussionMode: current.discussionMode !== true })
      })
      before.parentElement?.insertBefore(discussionToggle, before)
    }
    const on = chat.discussionMode === true
    const hint = '开启后，@ 两位以上成员时，他们会一个接一个发言，每人都能看到前面说了什么，也可以 @ 别人接着说'
    discussionToggle.hidden = chat.mode !== 'collaborative'
    discussionToggle.disabled = false
    discussionToggle.textContent = ui('轮流讨论')
    discussionToggle.title = ui(hint)
    discussionToggle.setAttribute('aria-label', ui(hint))
    discussionToggle.setAttribute('aria-pressed', String(on))
    discussionToggle.setAttribute('aria-checked', String(on))
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
