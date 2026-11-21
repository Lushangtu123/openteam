// 更多 → 改成协作群聊 / 改成独立专家: the open group's mode, changed after it was made
// (src/group/chatMode.ts), after asking. A 网站自检 group too, once its check is over (while members
// answer the mode does not change).
import type { GroupChat } from '../group/types'
import { normalizeLanguage, translateUi } from '../shared/i18n'

export interface ChatModeSwitchDependencies {
  buttonEl: HTMLButtonElement | null
  getLanguage(): unknown
  getCurrentChat(): GroupChat | undefined
  runCommand(type: string, payload?: Record<string, unknown>): Promise<void>
  confirm?(message: string): boolean
  showError(message: string): void
}

export function createChatModeSwitch(deps: ChatModeSwitchDependencies) {
  const confirm = deps.confirm ?? (message => window.confirm(message))
  const english = () => normalizeLanguage(deps.getLanguage()) === 'en'
  const ui = (source: string) => translateUi(source, normalizeLanguage(deps.getLanguage()))

  function render(): void {
    const button = deps.buttonEl
    if (!button) return
    const chat = deps.getCurrentChat()
    button.hidden = !chat
    if (!chat) return
    const toCollaborative = chat.mode !== 'collaborative'
    const label = button.querySelector('.header-menu-label')
    const hint = button.querySelector('.header-menu-hint')
    if (label) label.textContent = ui(toCollaborative ? '改成协作群聊' : '改成独立专家')
    if (hint) hint.textContent = ui(toCollaborative ? '成员能看到彼此的回复' : '成员各自回答，看不到彼此')
  }

  function register(): void {
    deps.buttonEl?.addEventListener('click', () => {
      const chat = deps.getCurrentChat()
      if (!chat) return
      const mode = chat.mode === 'collaborative' ? 'independent' : 'collaborative'
      const question = mode === 'collaborative'
        ? (english()
          ? `Make "${chat.name}" a collaborative group? From now on the members read one another's replies, and "Reply without @" and "Take turns" can be used. What they answered on their own before is not sent to the others.`
          : `把「${chat.name}」改成协作群聊吗？之后成员能看到彼此的回复，可以用「不@也回复」和「轮流讨论」。之前各自的回答不会发给其他成员。`)
        : (english()
          ? `Make "${chat.name}" an independent group? From now on each member answers on its own without reading the others; "Reply without @", "Take turns" and orchestration are only in collaborative groups.`
          : `把「${chat.name}」改成独立专家吗？之后成员各自回答，看不到彼此的回复；「不@也回复」「轮流讨论」和编排只在协作群聊里有。`)
      if (!confirm(question)) return
      deps.runCommand('GROUP_CHAT_UPDATE', { chatId: chat.id, mode })
        .catch(error => deps.showError(error instanceof Error ? error.message : String(error)))
    })
  }

  return { render, register }
}
