// How the members of a new group will answer a message to several of them (互相审 / 轮流讨论 /
// 各自回答) and whether a message without @ reaches all of them, chosen when the group is made: in the
// blank-group form, the template window and the team setup. Starts on the last choice.
import type { CollaborationStyle, NewChatCollaboration } from '../group/types'

type Translate = (zh: string, en: string) => string

const STYLES: Array<{ style: CollaborationStyle; label: [string, string]; help: [string, string] }> = [
  { style: 'review', label: ['互相审', 'Answer, then review'], help: ['先各自回答，再看彼此的回答、互相审阅并修正。', "Each answers, then reviews the others' answers and revises its own."] },
  { style: 'turns', label: ['轮流讨论', 'Take turns'], help: ['一个接一个发言，每人先回应前面的人。', 'One after another, each responding to those before it.'] },
  { style: 'parallel', label: ['各自回答', 'Answer separately'], help: ['各答各的，不互相审阅，最快。', 'Each answers on its own, with no review; fastest.'] },
]

export interface CollaborationChoice {
  element: HTMLElement
  value(): NewChatCollaboration
  reset(value: NewChatCollaboration): void
}

export function createCollaborationChoice(idPrefix: string, t: Translate, initial: NewChatCollaboration): CollaborationChoice {
  const root = document.createElement('div')
  root.className = 'field collaboration-choice'

  const label = document.createElement('label')
  label.htmlFor = `${idPrefix}-style`
  label.textContent = t('成员怎么回答', 'How members answer')
  const select = document.createElement('select')
  select.id = `${idPrefix}-style`
  for (const { style, label: [zh, en] } of STYLES) {
    const option = document.createElement('option')
    option.value = style
    option.textContent = t(zh, en)
    select.append(option)
  }
  const help = document.createElement('p')
  help.className = 'tiny collaboration-choice-help'

  const replyAll = document.createElement('label')
  replyAll.className = 'settings-checkbox collaboration-choice-reply-all'
  const checkbox = document.createElement('input')
  checkbox.type = 'checkbox'
  checkbox.id = `${idPrefix}-reply-all`
  const replyAllText = document.createElement('span')
  replyAllText.textContent = t('不@也回复：不 @ 的消息也会让所有成员回复', 'Reply without @: a message without @ goes to every member')
  replyAll.append(checkbox, replyAllText)

  const showHelp = () => {
    const entry = STYLES.find(item => item.style === select.value) ?? STYLES[0]
    help.textContent = t(...entry.help)
  }
  select.addEventListener('change', showHelp)
  root.append(label, select, help, replyAll)

  function reset(value: NewChatCollaboration): void {
    select.value = value.style
    checkbox.checked = value.replyAll
    showHelp()
  }
  reset(initial)

  return {
    element: root,
    value: () => ({ style: (STYLES.find(item => item.style === select.value) ?? STYLES[0]).style, replyAll: checkbox.checked }),
    reset,
  }
}
