// The window where the user saves a memory item: from a message ("记住这条"), new, or an existing
// one to edit. It says who the item will be sent to before anything is saved, because an item kept
// for every group goes into prompts on third-party sites too (docs/MEMORY_STORE.zh-CN.md, section 6).
import { MAX_MEMORY_CONTENT_CHARS, MAX_MEMORY_TAGS, memoryContentLength } from '../group/memoryStore'
import type { GroupChat, GroupMessage, MemoryItem, MemoryKind, MemoryProposal, MemoryScope, MemorySource, OpenTeamStore } from '../group/types'
import { normalizeLanguage, translateUi } from '../shared/i18n'
import { adoptedSummaryText } from '../group/roundSummary'
import { createIcon } from './icons'

export interface MemoryDialogDependencies {
  getStore(): OpenTeamStore
  runCommand(type: string, payload?: Record<string, unknown>): Promise<void>
  // Puts the focus back where the window was opened from, and lets a list behind it redraw.
  onClose?(saved: boolean): void
}

export interface MemoryDialogInput {
  // Saving from this message; its text is offered and its writer recorded.
  message?: GroupMessage
  // Saving what the member proposed at the end of that message: the proposal's text and kind are
  // offered instead of the whole reply, and saving answers the proposal.
  proposal?: MemoryProposal
  // Adopting this round summary as a decision: its agreed points are offered, and the item is the
  // user's, so every member of the group gets it.
  adopt?: boolean
  // Editing this item.
  item?: MemoryItem
  // The group the window was opened in, offered as "this group".
  chatId?: string
}

export const MEMORY_KIND_LABELS: Record<MemoryKind, [zh: string, en: string]> = {
  fact: ['事实', 'Fact'],
  decision: ['决定', 'Decision'],
  preference: ['偏好', 'Preference'],
  note: ['备注', 'Note'],
}

// Who an item with this scope is sent to, in words. `chat` is the group for 'chat' and 'role'.
export function memoryRecipientsText(store: OpenTeamStore, scope: MemoryScope, chat: GroupChat | undefined, roleId: string | undefined, source: Pick<MemorySource, 'origin' | 'roleId'>, english: boolean): string {
  const t = (zh: string, en: string): string => english ? en : zh
  const members = chat ? chat.roleIds.map(id => store.rolesById[id]).filter(Boolean) : []
  const writer = source.origin === 'member' && source.roleId ? store.rolesById[source.roleId]?.name : undefined
  const parts: string[] = []
  if (scope === 'global') {
    parts.push(t(
      '会发给：所有群聊里的所有成员，包括 ChatGPT、Gemini 等第三方站点上的成员，以及能读写本地文件的本地智能体。',
      'Sent to: every member of every group, including members on third-party sites such as ChatGPT and Gemini, and local agents that can read and write local files.',
    ))
    if (source.origin === 'member') {
      parts.push(t('它出自一位成员的回复：如果那个群是独立模式，同群的其他成员读不到。', 'It comes from a member\'s reply: if that group is independent, its other members do not get it.'))
    }
  } else if (scope === 'chat') {
    const names = members.map(member => `「${member.name}」`).join(english ? ', ' : '、')
    if (!chat) {
      parts.push(t('这个群聊已经不存在，不会发给任何成员。', 'This group no longer exists; it is sent to nobody.'))
    } else if (chat.mode === 'independent' && source.origin === 'member') {
      // In an independent group a member never reads another member's reply, saved or not: only
      // the one who wrote it gets the item (isMemoryItemVisible in memoryRetrieval).
      parts.push(writer && chat.roleIds.includes(source.roleId ?? '')
        ? t(`只发给：「${chat.name}」里的「${writer}」。这个群是独立模式，这段文字出自「${writer}」的回复，其他成员读不到。`, `Sent only to: "${writer}" in "${chat.name}". This group is independent and the text comes from "${writer}"'s reply, so the other members do not get it.`)
        : t('不会发给任何成员：这个群是独立模式，这段文字出自一位已不在群里的成员的回复。', 'Sent to nobody: this group is independent and the text comes from the reply of a member who is no longer in it.'))
    } else {
      parts.push(t(`会发给：「${chat.name}」的成员${names ? `：${names}` : ''}。`, `Sent to: the members of "${chat.name}"${names ? `: ${names}` : ''}.`))
    }
  } else {
    const member = roleId ? store.rolesById[roleId] : undefined
    parts.push(member && chat
      ? t(`只发给：「${chat.name}」里的「${member.name}」。别的群里同名的成员收不到。`, `Sent only to: "${member.name}" in "${chat.name}". A member of the same name in another group does not get it.`)
      : t('这位成员已经不存在，不会发给任何成员。', 'This member no longer exists; it is sent to nobody.'))
  }
  if (chat?.memoryDisabled && scope !== 'global') parts.push(t('这个群已关闭记忆，现在不会发送。', 'Memory is switched off for this group, so nothing is sent for now.'))
  return parts.join(english ? ' ' : '')
}

export function openMemoryDialog(input: MemoryDialogInput, deps: MemoryDialogDependencies): void {
  document.querySelector('.memory-dialog-modal')?.remove()
  const store = deps.getStore()
  const english = normalizeLanguage(store.settings.language) === 'en'
  const t = (zh: string, en: string): string => english ? en : zh
  const editing = input.item
  // The group offered as "this group": the item's own when editing, else the one it was opened in.
  const itemChatId = editing?.scope === 'chat' ? editing.scopeId : editing?.scope === 'role' ? store.rolesById[editing.scopeId ?? '']?.chatId : undefined
  const chat = store.chatsById[itemChatId ?? input.message?.chatId ?? input.chatId ?? '']
  const members = chat ? chat.roleIds.map(id => store.rolesById[id]).filter(Boolean) : []
  const adopting = Boolean(input.adopt && input.message && !editing)
  const source: Pick<MemorySource, 'origin' | 'roleId'> = editing?.source
    ?? (input.message?.type === 'assistant' && !adopting ? { origin: 'member', roleId: input.message.roleId } : { origin: 'user' })
  const summaryRequest = adopting ? store.messagesById[input.message?.sourceMessageId ?? ''] : undefined
  const asked = summaryRequest?.roundSummaryOf ? store.messagesById[summaryRequest.roundSummaryOf] : undefined
  const offered = [...(adopting
    ? adoptedSummaryText(asked?.content, input.message?.content ?? '', store.settings.language)
    : input.proposal?.content ?? input.message?.content.trim() ?? '')]
  const cut = offered.length > MAX_MEMORY_CONTENT_CHARS

  const draft = {
    content: editing?.content ?? offered.slice(0, MAX_MEMORY_CONTENT_CHARS).join(''),
    kind: editing?.kind ?? input.proposal?.kind ?? (adopting ? 'decision' : 'fact') as MemoryKind,
    scope: editing?.scope ?? (chat ? 'chat' : 'global') as MemoryScope,
    roleId: (editing?.scope === 'role' ? editing.scopeId : undefined) ?? (input.message?.type === 'assistant' ? input.message.roleId : undefined) ?? members[0]?.id,
    pinned: editing ? Boolean(editing.pinned) : false,
    tags: (editing?.tags ?? []).join(english ? ', ' : '，'),
  }
  // Until the user decides, a preference is kept in every prompt: no question finds it by its words.
  let pinnedChosen = Boolean(editing)
  let busy = false

  const backdrop = element('div', 'modal-backdrop memory-dialog-modal')
  backdrop.addEventListener('click', event => {
    if (event.target === backdrop) close(false)
  })
  const dialog = element('section', 'modal team-setup-dialog memory-dialog')
  dialog.setAttribute('role', 'dialog')
  dialog.setAttribute('aria-modal', 'true')
  dialog.setAttribute('aria-labelledby', 'memory-dialog-title')

  const header = element('div', 'modal-header')
  const heading = element('div')
  const title = element('h2', '', editing ? t('编辑记忆', 'Edit memory') : adopting ? t('采纳为决定', 'Adopt as a decision') : t('保存到记忆库', 'Save to memory'))
  title.id = 'memory-dialog-title'
  heading.append(title, element('p', 'tiny', adopting
    ? t('把汇总里大家同意的结论存成你的决定，成员在相关的问题里会读到它。分歧要你来定的，可以直接改写下面的内容。', 'Save what everyone agreed on as your decision; members read it when a question brings it up. Where they disagreed and it is yours to decide, rewrite the text below.')
    : t('成员在相关的问题里会读到它。只有你保存的内容才会进记忆库。', 'Members read it when a question brings it up. Only what you save goes into memory.')))
  const closeButton = element('button', 'icon-btn modal-close')
  closeButton.type = 'button'
  closeButton.setAttribute('aria-label', t('关闭', 'Close'))
  closeButton.append(createIcon('close'))
  closeButton.addEventListener('click', () => close(false))
  header.append(heading, closeButton)

  const form = element('form', 'team-setup-form memory-dialog-form')
  form.noValidate = true

  const contentField = element('div', 'field')
  const contentLabel = element('label', '', t('内容', 'Content'))
  contentLabel.htmlFor = 'memory-content'
  const contentInput = element('textarea')
  contentInput.id = 'memory-content'
  contentInput.rows = 5
  contentInput.value = draft.content
  contentInput.setAttribute('aria-describedby', 'memory-content-hint')
  const contentHint = element('p', 'tiny')
  contentHint.id = 'memory-content-hint'
  contentField.append(contentLabel, contentInput, contentHint)

  const kindField = element('div', 'field memory-dialog-kind')
  const kindLabel = element('label', '', t('类型', 'Kind'))
  kindLabel.htmlFor = 'memory-kind'
  const kindSelect = element('select')
  kindSelect.id = 'memory-kind'
  for (const kind of Object.keys(MEMORY_KIND_LABELS) as MemoryKind[]) {
    const option = element('option', '', MEMORY_KIND_LABELS[kind][english ? 1 : 0])
    option.value = kind
    kindSelect.append(option)
  }
  kindSelect.value = draft.kind
  kindField.append(kindLabel, kindSelect)

  const scopeField = element('fieldset', 'field memory-dialog-scope')
  scopeField.append(element('legend', '', t('给谁看', 'Who gets it')))
  const scopeOptions: Array<[MemoryScope, string]> = [['global', t('全部群聊', 'Every group')]]
  if (chat) scopeOptions.push(['chat', t(`本群「${chat.name}」`, `This group, "${chat.name}"`)])
  if (chat && members.length > 0) scopeOptions.push(['role', t('仅本群的这位成员', 'One member of this group')])
  const scopeRadios = scopeOptions.map(([scope, label]) => {
    const wrap = element('label', 'memory-dialog-option')
    const radio = element('input')
    radio.type = 'radio'
    radio.name = 'memory-scope'
    radio.value = scope
    radio.checked = scope === draft.scope
    radio.addEventListener('change', () => {
      draft.scope = scope
      render()
    })
    wrap.append(radio, element('span', '', label))
    scopeField.append(wrap)
    return radio
  })
  const memberSelect = element('select', 'memory-dialog-member')
  memberSelect.setAttribute('aria-label', t('成员', 'Member'))
  for (const member of members) {
    const option = element('option', '', member.name)
    option.value = member.id
    memberSelect.append(option)
  }
  if (draft.roleId) memberSelect.value = draft.roleId
  memberSelect.addEventListener('change', () => {
    draft.roleId = memberSelect.value
    render()
  })
  scopeField.append(memberSelect)
  const recipients = element('p', 'tiny memory-dialog-recipients')
  recipients.id = 'memory-recipients'
  recipients.setAttribute('aria-live', 'polite')
  scopeField.append(recipients)

  const pinnedWrap = element('label', 'memory-dialog-option memory-dialog-pinned')
  const pinnedInput = element('input')
  pinnedInput.type = 'checkbox'
  pinnedInput.id = 'memory-pinned'
  pinnedInput.addEventListener('change', () => {
    draft.pinned = pinnedInput.checked
    pinnedChosen = true
  })
  pinnedWrap.append(pinnedInput, element('span', '', t('常驻：每次都带上，不用等问题提到它', 'Always include it, without waiting for a question to bring it up')))

  const tagsField = element('div', 'field')
  const tagsLabel = element('label', '', t('标签（选填）', 'Tags (optional)'))
  tagsLabel.htmlFor = 'memory-tags'
  const tagsInput = element('input')
  tagsInput.id = 'memory-tags'
  tagsInput.type = 'text'
  tagsInput.autocomplete = 'off'
  tagsInput.value = draft.tags
  tagsInput.setAttribute('aria-describedby', 'memory-tags-hint')
  const tagsHint = element('p', 'tiny', t(`用逗号分开，最多 ${MAX_MEMORY_TAGS} 个。问题里出现标签时，更容易带上这条记忆。`, `Separate with commas, up to ${MAX_MEMORY_TAGS}. A question that contains a tag brings this item up more readily.`))
  tagsHint.id = 'memory-tags-hint'
  tagsField.append(tagsLabel, tagsInput, tagsHint)

  const error = element('p', 'team-form-error')
  error.setAttribute('role', 'alert')
  const actions = element('div', 'team-setup-actions')
  const cancel = element('button', 'btn', t('取消', 'Cancel'))
  cancel.type = 'button'
  cancel.addEventListener('click', () => close(false))
  const submit = element('button', 'btn btn-primary', t('保存', 'Save'))
  submit.type = 'submit'
  actions.append(cancel, submit)
  form.append(contentField, kindField, scopeField, pinnedWrap, tagsField, error, actions)

  contentInput.addEventListener('input', () => {
    draft.content = contentInput.value
    contentInput.removeAttribute('aria-invalid')
    error.textContent = ''
    render()
  })
  kindSelect.addEventListener('change', () => {
    draft.kind = kindSelect.value as MemoryKind
    render()
  })
  tagsInput.addEventListener('input', () => {
    draft.tags = tagsInput.value
  })
  form.addEventListener('submit', event => {
    event.preventDefault()
    void save()
  })

  dialog.append(header, form)
  backdrop.append(dialog)
  document.body.append(backdrop)
  document.addEventListener('keydown', handleEscape)
  render()
  contentInput.focus()

  function render(): void {
    const length = memoryContentLength(draft.content.trim())
    contentHint.textContent = [
      t(`${length} / ${MAX_MEMORY_CONTENT_CHARS} 字`, `${length} / ${MAX_MEMORY_CONTENT_CHARS} characters`),
      cut && !editing ? t('原文较长，只取了开头，建议改写成要点。', 'The message is long; only its start was taken. Rewriting it as key points works better.') : '',
    ].filter(Boolean).join(english ? ' · ' : '　')
    contentHint.classList.toggle('memory-dialog-over', length > MAX_MEMORY_CONTENT_CHARS)
    if (!pinnedChosen) draft.pinned = draft.kind === 'preference'
    pinnedInput.checked = draft.pinned
    for (const radio of scopeRadios) radio.checked = radio.value === draft.scope
    memberSelect.hidden = draft.scope !== 'role'
    recipients.textContent = memoryRecipientsText(store, draft.scope, chat, draft.roleId, source, english)
    submit.disabled = busy
  }

  async function save(): Promise<void> {
    if (busy) return
    const content = draft.content.trim()
    const length = memoryContentLength(content)
    if (!content) return showProblem(t('请写下要记住的内容。', 'Write what should be remembered.'))
    if (length > MAX_MEMORY_CONTENT_CHARS) return showProblem(t(`内容有 ${length} 字，最多 ${MAX_MEMORY_CONTENT_CHARS} 字。请删短一些。`, `The content has ${length} characters; the limit is ${MAX_MEMORY_CONTENT_CHARS}. Please shorten it.`))
    const tags = draft.tags.split(/[,，、]/).map(tag => tag.trim()).filter(Boolean)
    if (tags.length > MAX_MEMORY_TAGS) return showProblem(t(`标签有 ${tags.length} 个，最多 ${MAX_MEMORY_TAGS} 个。`, `There are ${tags.length} tags; the limit is ${MAX_MEMORY_TAGS}.`), tagsInput)
    const scopeId = draft.scope === 'chat' ? chat?.id : draft.scope === 'role' ? draft.roleId : undefined
    const fields = { scope: draft.scope, ...(scopeId ? { scopeId } : {}), kind: draft.kind, content, tags, pinned: draft.pinned }

    busy = true
    render()
    try {
      if (editing) {
        const patch = changedFields(editing, fields)
        if (Object.keys(patch).length > 0) await deps.runCommand('GROUP_MEMORY_UPDATE', { itemId: editing.id, patch })
      } else {
        await deps.runCommand('GROUP_MEMORY_ADD', { item: { ...fields, ...(input.message ? { messageId: input.message.id } : {}), ...(input.message && input.proposal ? { proposalId: input.proposal.id } : {}), ...(adopting ? { adopted: true } : {}) } })
      }
      close(true)
    } catch (caught) {
      busy = false
      // The background answers in Chinese; the page shows it in the user's language.
      error.textContent = translateUi(caught instanceof Error ? caught.message : String(caught), english ? 'en' : 'zh-CN')
      render()
    }
  }

  function showProblem(text: string, field: HTMLElement = contentInput): void {
    error.textContent = text
    field.setAttribute('aria-invalid', 'true')
    field.focus()
  }

  function handleEscape(event: KeyboardEvent): void {
    if (event.key !== 'Escape') return
    event.preventDefault()
    close(false)
  }

  function close(saved: boolean): void {
    backdrop.remove()
    document.removeEventListener('keydown', handleEscape)
    deps.onClose?.(saved)
  }
}

interface MemoryFields {
  scope: MemoryScope
  scopeId?: string
  kind: MemoryKind
  content: string
  tags: string[]
  pinned: boolean
}

// Only what the user changed is sent, so an item whose group can no longer be found can still have
// its text corrected.
function changedFields(item: MemoryItem, fields: MemoryFields): Partial<MemoryFields> {
  const patch: Partial<MemoryFields> = {}
  if (fields.scope !== item.scope || fields.scopeId !== item.scopeId) {
    patch.scope = fields.scope
    if (fields.scopeId) patch.scopeId = fields.scopeId
  }
  if (fields.kind !== item.kind) patch.kind = fields.kind
  if (fields.content !== item.content) patch.content = fields.content
  if (fields.tags.join('\n') !== (item.tags ?? []).join('\n')) patch.tags = fields.tags
  if (fields.pinned !== Boolean(item.pinned)) patch.pinned = fields.pinned
  return patch
}

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}
