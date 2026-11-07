// @vitest-environment jsdom

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { createDefaultStore } from '../group/store'
import type { GroupChat, GroupMessage, GroupRole } from '../group/types'
import { createTeamPageState } from './appState'
import { applyTeamLanguage } from './languageController'
import { createComposerView, editableMessageText, type ComposerViewDependencies } from './composerView'

describe('team page composer view boundary', () => {
  it('keeps composer rendering, references, mentions, and send flow outside the entrypoint', () => {
    const entrySource = readFileSync(resolve(process.cwd(), 'src/teamPage/index.ts'), 'utf8')
    const viewSource = readFileSync(resolve(process.cwd(), 'src/teamPage/composerView.ts'), 'utf8')

    expect(viewSource).toContain('function renderComposerState(): void')
    expect(viewSource).toContain('function renderReferenceDraft(): void')
    expect(viewSource).toContain('function renderMentionPanel(): void')
    expect(viewSource).toContain('function submitComposerMessage(): Promise<void>')
    expect(viewSource).toContain('function setReference(message: GroupMessage): void')
    expect(viewSource).toContain('function shouldShowMentionPanel(value: string): boolean')
    expect(viewSource).toContain('function insertMention(role: GroupRole): void')
    expect(viewSource).toContain('function registerComposerEvents(): void')
    expect(entrySource).not.toContain('function renderComposerState(): void')
    expect(entrySource).not.toContain('function renderReferenceDraft(): void')
    expect(entrySource).not.toContain('function renderMentionPanel(): void')
    expect(entrySource).not.toContain('function submitComposerMessage(): Promise<void>')
    expect(entrySource).not.toContain('function setReference(message: GroupMessage): void')
    expect(entrySource).not.toContain('function shouldShowMentionPanel(value: string): boolean')
    expect(entrySource).not.toContain('function insertMention(role: GroupRole): void')
  })
})

describe('team page composer targeting', () => {
  it('offers an all-members mention option when the mention panel opens', () => {
    const { view, deps } = createComposerHarness()
    deps.messageInputEl.value = '@'

    view.renderComposerState()

    const options = [...deps.mentionPanelEl.querySelectorAll<HTMLButtonElement>('.mention-option')]
    expect(deps.mentionPanelEl.hidden).toBe(false)
    expect(options.map(option => option.querySelector('.mention-name')?.textContent)).toEqual(['所有人', '工程师'])
    expect(options.map(option => option.querySelector('.mention-site-badge')?.textContent)).toEqual(['全员', 'DeepSeek'])

    options[0].click()

    expect(deps.messageInputEl.value).toBe('@所有人 ')
    deps.messageInputEl.value = '@所有人 请一起看'
    view.renderComposerState()
    expect(deps.targetPreviewEl.textContent).toBe('将发送给：工程师（DeepSeek）')
  })

  it('puts a sent message back in the input box with its mentions, to send again', () => {
    const { view, deps } = createComposerHarness()
    const message: GroupMessage = { id: 'msg-1', chatId: 'chat-1', seq: 1, type: 'user', content: '再评审一次', targetRoleIds: ['role-1'], createdAt: 1, status: 'sent' }

    view.editMessage(message)

    expect(deps.messageInputEl.value).toBe('@工程师（DeepSeek） 再评审一次')
    expect(deps.messageInputEl.selectionStart).toBe(deps.messageInputEl.value.length)
    expect(deps.targetPreviewEl.textContent).toContain('工程师')
  })

  it('sends a clicked choice to its member, or adds it to a waiting draft', async () => {
    const { view, deps, runCommand } = createComposerHarness()
    const [role] = deps.getCurrentRoles()

    await view.sendToRole(role, '我选 B：先灰度')
    expect(runCommand).toHaveBeenCalledWith('GROUP_MESSAGE_SEND', expect.objectContaining({ chatId: 'chat-1', raw: '@工程师（DeepSeek） 我选 B：先灰度' }))

    runCommand.mockClear()
    deps.messageInputEl.value = '还有个问题'
    await view.sendToRole(role, '我选 A：先压测')
    expect(runCommand).not.toHaveBeenCalled()
    expect(deps.messageInputEl.value).toBe('还有个问题\n@工程师（DeepSeek） 我选 A：先压测')
  })

  it('writes a sent message back as it was typed', () => {
    const roles = [makeRole('chat-1', 'role-1', '工程师', 'ready'), makeRole('chat-1', 'role-2', '设计师', 'ready')]
    const base: Omit<GroupMessage, 'content'> = { id: 'msg', chatId: 'chat-1', seq: 1, type: 'user', createdAt: 1, status: 'sent' }
    const label = (role: GroupRole) => role.name

    expect(editableMessageText({ ...base, content: '大家看看', mentionsAll: true, targetRoleIds: ['role-1', 'role-2'] }, roles, label)).toBe('@所有人 大家看看')
    expect(editableMessageText({ ...base, content: '你们俩看看', targetRoleIds: ['role-1', 'role-2'] }, roles, label)).toBe('@工程师 @设计师 你们俩看看')
    // A member who has since left the group is dropped.
    expect(editableMessageText({ ...base, content: '记一下', targetRoleIds: ['role-gone'] }, roles, label)).toBe('记一下')
  })

  it('confirms the default all-members mention with Enter from the keyboard', () => {
    const { view, deps, runCommand } = createComposerHarness()
    view.registerComposerEvents()
    deps.messageInputEl.value = '@'
    deps.messageInputEl.setSelectionRange(1, 1)

    const event = pressKey(deps.messageInputEl, 'Enter')

    expect(event.defaultPrevented).toBe(true)
    expect(deps.messageInputEl.value).toBe('@所有人 ')
    expect(runCommand).not.toHaveBeenCalled()
  })

  it('moves mention selection with arrow keys before confirming a role', () => {
    const { view, deps } = createComposerHarness({
      roles: [
        makeRole('chat-1', 'role-1', '工程师', 'ready'),
        makeRole('chat-1', 'role-2', '产品经理', 'ready'),
      ],
    })
    view.registerComposerEvents()
    deps.messageInputEl.value = '@'
    deps.messageInputEl.setSelectionRange(1, 1)

    const downEvent = pressKey(deps.messageInputEl, 'ArrowDown')

    expect(downEvent.defaultPrevented).toBe(true)
    expect(deps.state.mentionIndex).toBe(1)
    expect(deps.mentionPanelEl.hidden).toBe(false)
    expect(activeMentionName(deps.mentionPanelEl)).toBe('工程师')

    const upEvent = pressKey(deps.messageInputEl, 'ArrowUp')

    expect(upEvent.defaultPrevented).toBe(true)
    expect(deps.state.mentionIndex).toBe(0)
    expect(activeMentionName(deps.mentionPanelEl)).toBe('所有人')

    pressKey(deps.messageInputEl, 'ArrowDown')
    pressKey(deps.messageInputEl, 'Enter')

    expect(deps.messageInputEl.value).toBe('@工程师（DeepSeek） ')
  })

  it('warns when a message targets a page that cannot receive it', () => {
    const roles = [makeRole('chat-1', 'role-1', '工程师', 'ready'), makeRole('chat-1', 'role-2', '设计师', 'ready')]
    const { view, deps } = createComposerHarness({ roles })
    deps.getRoleHealth = role => role.id === 'role-1' ? { status: 'login-required', reason: 'login' } : { status: 'ready' }
    deps.messageInputEl.value = '@工程师 @设计师 评估一下'

    view.renderComposerState()

    const warning = () => deps.composerFormEl.querySelector<HTMLElement>('.composer-health-warning')
    expect(warning()?.textContent).toBe('网页暂时无法接收：工程师（DeepSeek） 需要登录')
    expect(warning()?.hidden).toBe(false)
    expect(deps.sendButtonEl.disabled).toBe(false)

    deps.getRoleHealth = () => ({ status: 'ready' })
    view.renderComposerState()
    expect(warning()?.hidden).toBe(true)
  })

  it('translates its own re-renders while the user types', () => {
    const { view, deps } = createComposerHarness()
    deps.composerFormEl.append(deps.targetPreviewEl, deps.busyPreviewEl)
    deps.getRoleHealth = () => ({ status: 'login-required', reason: 'login' })
    deps.localize = root => applyTeamLanguage('en', root)
    deps.messageInputEl.value = '@工程师 评估一下'

    view.renderComposerState()

    expect(deps.targetPreviewEl.textContent).toBe('Will send to: 工程师（DeepSeek）')
    expect(deps.composerFormEl.querySelector('.composer-health-warning')?.textContent).toBe('Pages that cannot receive messages right now: 工程师（DeepSeek）: Login required')
  })

  it('previews no-mention messages as chat records without requiring ready roles', () => {
    const { view, deps } = createComposerHarness({ roleStatus: 'thinking', requireManualMention: true })
    deps.messageInputEl.value = '先记录这个背景'

    view.renderComposerState()

    expect(deps.targetPreviewEl.textContent).toBe('将作为群消息记录，不触发 AI；@ 成员可触发回复')
    expect(deps.sendButtonEl.disabled).toBe(false)
  })

  it('previews no-mention collaborative messages as chat records by default', () => {
    const { view, deps } = createComposerHarness({ mode: 'collaborative' })
    deps.messageInputEl.value = '先记录这个背景'

    view.renderComposerState()

    expect(deps.targetPreviewEl.textContent).toBe('将作为群消息记录，不触发 AI；@ 成员可触发回复')
    expect(deps.sendButtonEl.disabled).toBe(false)
  })

  it('previews no-mention collaborative messages as all-member replies when manual mention routing is off', () => {
    const { view, deps } = createComposerHarness({ mode: 'collaborative', requireManualMention: false })
    deps.messageInputEl.value = '请一起评估'

    view.renderComposerState()

    expect(deps.targetPreviewEl.textContent).toBe('将发送给：工程师（DeepSeek）')
    expect(deps.sendButtonEl.disabled).toBe(false)
  })

  it('submits no-mention messages without reconnecting or blocking on thinking roles', async () => {
    const { view, deps, runCommand, reconnectRolesForSend, showError } = createComposerHarness({ roleStatus: 'thinking', requireManualMention: true })
    deps.messageInputEl.value = '先记录这个背景'

    await view.submitComposerMessage()

    expect(showError).not.toHaveBeenCalled()
    expect(reconnectRolesForSend).not.toHaveBeenCalled()
    expect(runCommand).toHaveBeenCalledWith('GROUP_MESSAGE_SEND', {
      chatId: 'chat-1',
      raw: '先记录这个背景',
      reference: undefined,
    })
  })

  it('sends attachments with the message and puts them back when sending fails', async () => {
    const { view, deps, runCommand } = createComposerHarness()
    const uploads = [{ kind: 'text' as const, fileName: 'notes.md', mimeType: 'text/markdown', size: 4, text: '目标' }]
    const taken = [{ key: 'attachment-1', file: new File(['目标'], 'notes.md'), kind: 'text' as const }]
    const attachments = { register: vi.fn(), list: vi.fn(() => taken), readUploads: vi.fn(async () => uploads), take: vi.fn(() => taken), restore: vi.fn() }
    deps.attachments = attachments
    deps.messageInputEl.value = '先记录这个背景'

    await view.submitComposerMessage()

    expect(runCommand).toHaveBeenCalledWith('GROUP_MESSAGE_SEND', { chatId: 'chat-1', raw: '先记录这个背景', reference: undefined, uploads })
    expect(attachments.take).toHaveBeenCalled()
    expect(attachments.restore).not.toHaveBeenCalled()

    runCommand.mockRejectedValueOnce(new Error('发送失败'))
    deps.messageInputEl.value = '再发一次'
    await expect(view.submitComposerMessage()).rejects.toThrow('发送失败')
    expect(attachments.restore).toHaveBeenCalledWith(taken)
    expect(deps.messageInputEl.value).toBe('再发一次')
  })

  it('submits all-member messages when at least one targeted role can receive them', async () => {
    const { view, deps, runCommand, reconnectRolesForSend, showError } = createComposerHarness({
      roles: [
        makeRole('chat-1', 'role-1', '工程师', 'ready'),
        makeRole('chat-1', 'role-2', '产品经理', 'thinking', Date.now()),
      ],
    })
    deps.messageInputEl.value = '@all 请一起评估'

    await view.submitComposerMessage()

    expect(showError).not.toHaveBeenCalled()
    expect(reconnectRolesForSend).not.toHaveBeenCalled()
    expect(runCommand).toHaveBeenCalledWith('GROUP_MESSAGE_SEND', {
      chatId: 'chat-1',
      raw: '@all 请一起评估',
      reference: undefined,
    })
  })
})

function createComposerHarness(options: { roleStatus?: GroupRole['status']; roles?: GroupRole[]; mode?: GroupChat['mode']; requireManualMention?: boolean } = {}) {
  const store = createDefaultStore()
  const roles = options.roles ?? [makeRole('chat-1', 'role-1', '工程师', options.roleStatus ?? 'ready')]
  const chat: GroupChat = {
    id: 'chat-1',
    name: '讨论',
    mode: options.mode ?? 'independent',
    roleIds: roles.map(role => role.id),
    messageIds: [],
    nextMessageSeq: 1,
    status: 'ready',
    requireManualMention: options.requireManualMention,
    createdAt: 0,
    updatedAt: 0,
  }
  store.currentChatId = chat.id
  store.chatOrder = [chat.id]
  store.chatsById[chat.id] = chat
  for (const role of roles) store.rolesById[role.id] = role

  const state = createTeamPageState()
  state.store = store
  const runCommand = vi.fn(async () => undefined)
  const reconnectRolesForSend = vi.fn(async () => undefined)
  const showError = vi.fn()
  const mentionPanelEl = document.createElement('div')
  mentionPanelEl.hidden = true
  const deps: ComposerViewDependencies = {
    state,
    composerFormEl: document.createElement('form'),
    targetPreviewEl: document.createElement('div'),
    busyPreviewEl: document.createElement('div'),
    sendButtonEl: document.createElement('button'),
    messageInputEl: document.createElement('textarea'),
    referenceDraftEl: document.createElement('div'),
    mentionPanelEl,
    getStore: () => store,
    getCurrentChat: () => chat,
    getCurrentRoles: () => roles,
    roleToneClass: () => 'tone-test',
    roleAvatarLabel: () => '工',
    reconnectRolesForSend,
    runCommand,
    showError,
  }

  return {
    view: createComposerView(deps),
    deps,
    runCommand,
    reconnectRolesForSend,
    showError,
  }
}

function makeRole(chatId: string, id: string, name: string, status: GroupRole['status'], updatedAt = 0): GroupRole {
  return {
    id,
    chatId,
    name,
    systemPrompt: `从${name}角度分析`,
    status,
    contextCursor: 0,
    createdAt: 0,
    updatedAt,
  }
}

function pressKey(target: HTMLElement, key: string): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })
  target.dispatchEvent(event)
  return event
}

function activeMentionName(panel: HTMLElement): string | undefined {
  return panel.querySelector('.mention-option.active .mention-name')?.textContent ?? undefined
}
