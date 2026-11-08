// How the next message is answered, chosen next to the input box (协作 groups only): 不@也回复 makes
// a message without @ reach every member, and the style says how several members answer one
// message: 互相审 (each answers, then reviews the others), 轮流讨论 (turn by turn) or 各自回答. Both
// are settings of the group; the placeholder says what a plain message does.
import { collaborationStyleOf, isCollaborationStyle } from '../group/collaboration'
import { defaultMentionTargetForMessage } from '../group/mentionParser'
import type { CollaborationStyle, GroupChat } from '../group/types'
import { normalizeLanguage, translateUi } from '../shared/i18n'

export interface ComposerModesViewDependencies {
  // The input box, hidden while no group is open.
  composerFormEl?: HTMLElement
  modesEl: HTMLElement
  replyAllToggleEl: HTMLButtonElement
  // The chip showing the group's style, and its menu of styles (opened by registerHeaderMenus).
  styleToggleEl: HTMLButtonElement
  styleMenuEl: HTMLElement
  messageInputEl: HTMLTextAreaElement | HTMLInputElement
  getLanguage(): unknown
  getCurrentChat(): GroupChat | undefined
  runCommand(type: string, payload?: Record<string, unknown>): Promise<void>
  showError(message: string): void
}

export const PLACEHOLDER_MENTION_ONLY = '输入消息，@成员 让他回复；不 @ 只记在群里'
export const PLACEHOLDER_REPLY_ALL = '输入消息，所有成员都会回复；@成员 只问他'

export const COLLABORATION_STYLE_LABELS: Record<CollaborationStyle, string> = {
  review: '互相审',
  turns: '轮流讨论',
  parallel: '各自回答',
}

export function createComposerModesView(deps: ComposerModesViewDependencies) {
  function ui(source: string): string {
    return translateUi(source, normalizeLanguage(deps.getLanguage()))
  }

  function update(patch: Record<string, unknown>): void {
    const chat = deps.getCurrentChat()
    if (!chat) return
    deps.runCommand('GROUP_CHAT_UPDATE', { chatId: chat.id, ...patch })
      .catch(error => deps.showError(error instanceof Error ? error.message : String(error)))
  }

  function styleItems(): HTMLButtonElement[] {
    return [...deps.styleMenuEl.querySelectorAll<HTMLButtonElement>('[data-collaboration-style]')]
  }

  function register(): void {
    deps.replyAllToggleEl.addEventListener('click', () => {
      const chat = deps.getCurrentChat()
      if (chat) update({ requireManualMention: chat.requireManualMention === false })
    })
    for (const item of styleItems()) {
      item.addEventListener('click', () => {
        const style = item.dataset.collaborationStyle
        const chat = deps.getCurrentChat()
        if (chat && isCollaborationStyle(style) && style !== collaborationStyleOf(chat)) update({ collaborationStyle: style })
      })
    }
  }

  function setSwitch(button: HTMLButtonElement, on: boolean, label: string, hint: string): void {
    button.setAttribute('aria-checked', String(on))
    button.setAttribute('aria-label', ui(label))
    button.title = ui(hint)
    const text = button.querySelector('span')
    if (text) text.textContent = ui(label)
  }

  function render(): void {
    const chat = deps.getCurrentChat()
    const collaborative = chat?.mode === 'collaborative'
    deps.composerFormEl?.classList.toggle('no-chat', !chat)
    deps.modesEl.hidden = !collaborative
    setSwitch(deps.replyAllToggleEl, chat?.requireManualMention === false, '不@也回复', '开启后，不 @ 的消息也会让所有成员回复；@ 了谁就只问谁')
    const style = collaborationStyleOf(chat)
    const label = deps.styleToggleEl.querySelector('span')
    if (label) label.textContent = ui(COLLABORATION_STYLE_LABELS[style])
    for (const item of styleItems()) item.setAttribute('aria-checked', String(item.dataset.collaborationStyle === style))
    deps.messageInputEl.placeholder = ui(chat && defaultMentionTargetForMessage('', chat) === 'all' ? PLACEHOLDER_REPLY_ALL : PLACEHOLDER_MENTION_ONLY)
  }

  return { register, render }
}
