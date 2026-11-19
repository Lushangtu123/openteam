// The window that sets up a vote (投票, src/group/poll.ts): the question, two to six options, and
// the members who vote (all of the group's, to start with). Sending it posts the vote to the group.
import { roleMentionLabel, roleMentionLabelOptionsFromSettings } from '../group/mentionParser'
import { POLL_MAX_OPTIONS, POLL_MIN_OPTIONS, POLL_OPTION_MAX, POLL_QUESTION_MAX, pollLetter, readPollInput } from '../group/poll'
import type { GroupRole, OpenTeamStore } from '../group/types'
import { normalizeLanguage } from '../shared/i18n'
import { createIcon } from './icons'

export interface PollDialogDependencies {
  getStore(): OpenTeamStore
  runCommand(type: string, payload?: Record<string, unknown>): Promise<void>
  // An error that comes after the window has closed.
  showError?(message: string): void
  // How long to wait for the group to refuse the vote before closing the window.
  refusalWaitMs?: number
  // Puts the focus back where the window was opened from.
  onClose?(): void
}

export function openPollDialog(chatId: string, deps: PollDialogDependencies): { close(): void } {
  document.querySelector('.poll-modal')?.remove()
  const store = deps.getStore()
  const english = normalizeLanguage(store.settings.language) === 'en'
  const t = (zh: string, en: string): string => english ? en : zh
  const roles = (store.chatsById[chatId]?.roleIds ?? []).map(id => store.rolesById[id]).filter((role): role is GroupRole => Boolean(role))
  let busy = false

  const backdrop = element('div', 'modal-backdrop poll-modal')
  backdrop.addEventListener('click', event => {
    if (event.target === backdrop) close()
  })
  const dialog = element('section', 'modal team-setup-dialog poll-dialog')
  dialog.setAttribute('role', 'dialog')
  dialog.setAttribute('aria-modal', 'true')
  dialog.setAttribute('aria-labelledby', 'poll-title')

  const header = element('div', 'modal-header')
  const heading = element('div')
  const title = element('h2', '', t('发起投票', 'Start a vote'))
  title.id = 'poll-title'
  heading.append(title, element('p', 'tiny', t(
    '每位成员各自从选项里选一个并写理由，互相看不到别人的票。投完后群里会显示计票，并请一位成员总结分歧；之后可以让大家看过彼此的理由再投一轮。',
    'Each member picks one option and gives a reason, without seeing the others\' votes. Then the group shows the count and one member sums up where they differ; after that you can have everyone vote again having read each other\'s reasons.',
  )))
  const closeButton = element('button', 'icon-btn modal-close')
  closeButton.type = 'button'
  closeButton.setAttribute('aria-label', t('关闭', 'Close'))
  closeButton.append(createIcon('close'))
  closeButton.addEventListener('click', () => close())
  header.append(heading, closeButton)

  const form = element('form', 'team-setup-form poll-form')
  form.noValidate = true

  const questionField = element('div', 'field')
  const questionLabel = element('label', '', t('问题', 'Question'))
  questionLabel.htmlFor = 'poll-question'
  const question = element('textarea')
  question.id = 'poll-question'
  question.rows = 2
  question.maxLength = POLL_QUESTION_MAX
  question.placeholder = t('例如：这个项目的前端用哪个框架？', 'For example: which framework for this project\'s front end?')
  questionField.append(questionLabel, question)

  const optionsField = element('fieldset', 'field poll-options')
  optionsField.append(element('legend', '', t(`选项（${POLL_MIN_OPTIONS}–${POLL_MAX_OPTIONS} 个）`, `Options (${POLL_MIN_OPTIONS}–${POLL_MAX_OPTIONS})`)))
  const optionList = element('ol', 'poll-option-list')
  const addOption = element('button', 'btn btn-ghost btn-small poll-add-option')
  addOption.type = 'button'
  addOption.append(createIcon('plus'), element('span', '', t('添加选项', 'Add an option')))
  addOption.addEventListener('click', () => {
    const input = appendOption('')
    input.focus()
  })
  optionsField.append(optionList, addOption)

  const membersField = element('fieldset', 'field poll-members')
  membersField.append(element('legend', '', t('谁来投票', 'Who votes')))
  const memberRow = element('div', 'poll-member-row')
  const memberBoxes = roles.map(role => {
    const label = element('label', 'poll-member')
    const box = element('input')
    box.type = 'checkbox'
    box.value = role.id
    box.checked = true
    label.append(box, element('span', '', role.name))
    memberRow.append(label)
    return box
  })
  membersField.append(memberRow)

  const error = element('p', 'team-form-error')
  error.setAttribute('role', 'alert')
  const actions = element('div', 'team-setup-actions')
  const cancel = element('button', 'btn', t('取消', 'Cancel'))
  cancel.type = 'button'
  cancel.addEventListener('click', () => close())
  const submit = element('button', 'btn btn-primary', t('发起投票', 'Start the vote'))
  submit.type = 'submit'
  actions.append(cancel, submit)
  form.append(questionField, optionsField, membersField, error, actions)
  form.addEventListener('submit', event => {
    event.preventDefault()
    void send()
  })
  form.addEventListener('input', () => { error.textContent = '' })

  for (let index = 0; index < POLL_MIN_OPTIONS; index += 1) appendOption('')
  dialog.append(header, form)
  backdrop.append(dialog)
  document.body.append(backdrop)
  document.addEventListener('keydown', handleEscape)
  question.focus()

  function optionInputs(): HTMLInputElement[] {
    return [...optionList.querySelectorAll<HTMLInputElement>('.poll-option-input')]
  }

  function appendOption(value: string): HTMLInputElement {
    const item = element('li', 'poll-option')
    const input = element('input', 'poll-option-input')
    input.type = 'text'
    input.value = value
    input.maxLength = POLL_OPTION_MAX
    const remove = element('button', 'icon-btn poll-remove-option')
    remove.type = 'button'
    remove.append(createIcon('minus'))
    remove.addEventListener('click', () => {
      item.remove()
      renderOptions()
      optionInputs()[optionInputs().length - 1]?.focus()
    })
    item.append(element('span', 'poll-option-letter'), input, remove)
    optionList.append(item)
    renderOptions()
    return input
  }

  // Letters, labels, and whether options can be added or removed.
  function renderOptions(): void {
    const inputs = optionInputs()
    inputs.forEach((input, index) => {
      const item = input.closest('.poll-option')!
      item.querySelector('.poll-option-letter')!.textContent = pollLetter(index)
      input.setAttribute('aria-label', t(`选项 ${pollLetter(index)}`, `Option ${pollLetter(index)}`))
      const remove = item.querySelector<HTMLButtonElement>('.poll-remove-option')!
      remove.hidden = inputs.length <= POLL_MIN_OPTIONS
      remove.setAttribute('aria-label', t(`删除选项 ${pollLetter(index)}`, `Remove option ${pollLetter(index)}`))
    })
    addOption.hidden = inputs.length >= POLL_MAX_OPTIONS
  }

  async function send(): Promise<void> {
    if (busy) return
    const voters = memberBoxes.filter(box => box.checked).map(box => store.rolesById[box.value]).filter((role): role is GroupRole => Boolean(role))
    let poll: { question: string; options: string[] }
    try {
      poll = readPollInput({ question: question.value, options: optionInputs().map(input => input.value) })
    } catch (caught) {
      error.textContent = translate(caught instanceof Error ? caught.message : String(caught))
      ;(question.value.trim() ? optionInputs().find(input => !input.value.trim()) ?? optionInputs()[0] : question).focus()
      return
    }
    if (voters.length < 2) {
      error.textContent = t('至少选两位成员来投票', 'Pick at least two members to vote')
      memberBoxes[0]?.focus()
      return
    }
    busy = true
    submit.disabled = true
    const mentions = voters.map(role => `@${roleMentionLabel(role, roleMentionLabelOptionsFromSettings(deps.getStore().settings))}`).join(' ')
    // The send answers only once its API members have voted. A refusal (a project running, members
    // unavailable) comes at once and is shown here; after that the window closes, and a later error
    // is shown on the page.
    const sending = deps.runCommand('GROUP_MESSAGE_SEND', { chatId, raw: `${mentions} ${poll.question}`, poll })
      .then(() => undefined, (caught: unknown) => caught instanceof Error ? caught.message : String(caught))
    const early = await Promise.race([sending, new Promise<'waiting'>(resolve => setTimeout(() => resolve('waiting'), deps.refusalWaitMs ?? 1500))])
    if (typeof early === 'string' && early !== 'waiting') {
      error.textContent = early
      busy = false
      submit.disabled = false
      return
    }
    close()
    if (early === 'waiting') {
      void sending.then(message => {
        if (message) deps.showError?.(message)
      })
    }
  }

  // readPollInput's messages are in Chinese; these are the English ones.
  function translate(message: string): string {
    if (!english) return message
    const known: Record<string, string> = {
      写下要投票的问题: 'Write the question to vote on',
      至少要两个选项: 'Give at least two options',
      选项不能重复: 'Each option must be different',
    }
    return known[message] ?? message
  }

  function handleEscape(event: KeyboardEvent): void {
    if (event.key !== 'Escape') return
    event.preventDefault()
    close()
  }

  function close(): void {
    backdrop.remove()
    document.removeEventListener('keydown', handleEscape)
    deps.onClose?.()
  }

  return { close }
}

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}
