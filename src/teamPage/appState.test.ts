import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('team page app state', () => {
  it('initializes mutable UI state with a default store and empty selections', async () => {
    const { createTeamPageState } = await import('./appState')
    const state = createTeamPageState()

    expect(state.store.version).toBeGreaterThan(0)
    expect(state.selectedChatId).toBeUndefined()
    expect(state.selectedReference).toBeUndefined()
    expect(state.mentionIndex).toBe(0)
    expect(state.peopleDrawerOpen).toBe(false)
    expect(state.messageNodeCache.size).toBe(0)
    expect(state.temporaryPersonDrafts).toEqual([])
  })

  it('prefers the store current chat when choosing the selected chat after commands', async () => {
    const { createTeamPageState, pickSelectedChatId } = await import('./appState')
    const state = createTeamPageState()
    state.store.chatOrder = ['chat-old', 'chat-new']
    state.store.chatsById = {
      'chat-old': {
        id: 'chat-old',
        name: '旧群聊',
        mode: 'independent',
        roleIds: [],
        messageIds: [],
        nextMessageSeq: 1,
        status: 'ready',
        createdAt: 1,
        updatedAt: 1,
      },
      'chat-new': {
        id: 'chat-new',
        name: '新群聊',
        mode: 'independent',
        roleIds: [],
        messageIds: [],
        nextMessageSeq: 1,
        status: 'ready',
        createdAt: 2,
        updatedAt: 2,
      },
    }
    state.store.currentChatId = 'chat-new'
    state.selectedChatId = 'chat-old'

    expect(pickSelectedChatId(state)).toBe('chat-new')
  })

  it('keeps a group the user just clicked while the switch is on its way, so the old one does not flash back (seen live)', async () => {
    const { createTeamPageState, pickSelectedChatId } = await import('./appState')
    const state = createTeamPageState()
    const chat = (id: string) => ({ id, name: id, mode: 'independent' as const, roleIds: [], messageIds: [], nextMessageSeq: 1, status: 'ready' as const, createdAt: 1, updatedAt: 1 })
    state.store.chatOrder = ['chat-old', 'chat-new']
    state.store.chatsById = { 'chat-old': chat('chat-old'), 'chat-new': chat('chat-new') }
    // The click: the page shows the new group; a store update sent before the switch still names the old.
    state.selectedChatId = 'chat-new'
    state.pendingChatSwitchId = 'chat-new'
    state.store.currentChatId = 'chat-old'
    expect(pickSelectedChatId(state)).toBe('chat-new')
    // The switch has landed: the store names it, and the store leads again.
    state.store.currentChatId = 'chat-new'
    expect(pickSelectedChatId(state)).toBe('chat-new')
    expect(state.pendingChatSwitchId).toBeUndefined()
    state.store.currentChatId = 'chat-old'
    expect(pickSelectedChatId(state)).toBe('chat-old')
    // A group deleted before its switch landed is not kept.
    state.pendingChatSwitchId = 'chat-gone'
    expect(pickSelectedChatId(state)).toBe('chat-old')
    expect(state.pendingChatSwitchId).toBeUndefined()
  })

  it('keeps mutable page state declarations out of the team page entrypoint', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/teamPage/index.ts'), 'utf8')
    const messagesSource = readFileSync(resolve(process.cwd(), 'src/teamPage/messagesView.ts'), 'utf8')
    const localStateDeclarations = [
      'let selectedChatId',
      'let selectedRoleId',
      'let selectedTemplateId',
      'let selectedReference',
      'let mentionIndex',
      'let peopleDrawerOpen',
      'let chatMenuChatId',
      'let roleSiteMenuRoleId',
      'let roleActionMenuRoleId',
      'let addPersonSiteMenuId',
      'let pendingSwitchAnimationFrame',
      'let thinkingTimeoutTimers',
      'const loggedThinkingTimeoutRoleIds',
      'const messageNodeCache',
      'const reconnectingRoleKeys',
      'const roleReadyWaiters',
      'const temporaryPersonDrafts',
      'const addPersonSiteByKey',
    ]

    for (const declaration of localStateDeclarations) {
      expect(source).not.toContain(declaration)
    }
    expect(source).toContain('appState.selectedChatId')
    expect(messagesSource).toContain('deps.state.messageNodeCache')
  })
})
