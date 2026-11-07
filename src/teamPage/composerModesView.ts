// How the next message is answered, chosen next to the input box (协作 groups only): 不@也回复 makes
// a message without @ reach every member, 轮流讨论 makes a message to several members a turn-by-turn
// discussion. Both are settings of the group; the placeholder says what a plain message does.
import { defaultMentionTargetForMessage } from '../group/mentionParser'
import type { GroupChat } from '../group/types'
import { normalizeLanguage, translateUi } from '../shared/i18n'

export interface ComposerModesViewDependencies {
  // The input box, hidden while no group is open.
  composerFormEl?: HTMLElement
  modesEl: HTMLElement
  replyAllToggleEl: HTMLButtonElement
  discussionToggleEl: HTMLButtonElement
  messageInputEl: HTMLTextAreaElement | HTMLInputElement
  getLanguage(): unknown
  getCurrentChat(): GroupChat | undefined
  runCommand(type: string, payload?: Record<string, unknown>): Promise<void>
  showError(message: string): void
}

export const PLACEHOLDER_MENTION_ONLY = '输入消息，@成员 让他回复；不 @ 只记在群里'
export const PLACEHOLDER_REPLY_ALL = '输入消息，所有成员都会回复；@成员 只问他'

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

  function register(): void {
    deps.replyAllToggleEl.addEventListener('click', () => {
      const chat = deps.getCurrentChat()
      if (chat) update({ requireManualMention: chat.requireManualMention === false })
    })
    deps.discussionToggleEl.addEventListener('click', () => {
      const chat = deps.getCurrentChat()
      if (chat) update({ discussionMode: chat.discussionMode !== true })
    })
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
    setSwitch(deps.discussionToggleEl, chat?.discussionMode === true, '轮流讨论', '开启后，@ 两位以上成员时，他们会一个接一个发言，每人都能看到前面说了什么，也可以 @ 别人接着说')
    deps.messageInputEl.placeholder = ui(chat && defaultMentionTargetForMessage('', chat) === 'all' ? PLACEHOLDER_REPLY_ALL : PLACEHOLDER_MENTION_ONLY)
  }

  return { register, render }
}
