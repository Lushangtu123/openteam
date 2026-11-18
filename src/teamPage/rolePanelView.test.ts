// @vitest-environment jsdom

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { createDefaultStore } from '../group/store'
import type { GroupChat, GroupRole, OpenTeamStore } from '../group/types'
import { createTeamPageState } from './appState'
import { createRolePanelView, roleHealthAdvice } from './rolePanelView'
import type { RolePageHealth } from './roleHealth'

describe('team page role panel view boundary', () => {
  it('tells Claude web members that Claude refuses to run here and points to the API', () => {
    const claudeWeb = { chatSite: 'claude', modelSource: 'site' } as const
    const blocked = roleHealthAdvice({ status: 'blocked', reason: 'embed-blocked' }, claudeWeb)
    expect(blocked).toContain('把这个成员移出群聊，再重新添加')
    expect(blocked).toContain('Anthropic 格式')
    expect(roleHealthAdvice({ status: 'unresponsive' }, claudeWeb)).toBe(blocked)
    expect(roleHealthAdvice({ status: 'unresponsive' }, { chatSite: 'grok', modelSource: 'site' })).toContain('20 秒内没有连上')
    expect(roleHealthAdvice({ status: 'blocked', reason: 'embed-blocked' }, { chatSite: 'kimi', modelSource: 'site' })).toContain('改用这个模型的 API')
  })

  it('labels member state plainly and wires the card menu actions', () => {
    const viewSource = readFileSync(resolve(process.cwd(), 'src/teamPage/rolePanelView.ts'), 'utf8')

    expect(viewSource).toContain("deps.iframeHost.recoverRole(role)")
    expect(viewSource).toContain("deps.runCommand('GROUP_ROLE_RECOVER'")
    expect(viewSource).toContain("deps.focusRoleFrame(role.chatId, role.id)")
    expect(viewSource).toContain('deps.state.roleActionMenuRoleId')
    expect(viewSource).toContain("roleMenuItem('role-delete', 'trash'")
    expect(viewSource).toContain('button.dataset.roleDelete = role.id')
    expect(viewSource).toContain("ready: '在线'")
    expect(viewSource).not.toContain("ready: '就绪'")
    expect(viewSource).toContain("`已读 ${role.contextCursor} 条`")
    expect(viewSource).toContain("'通过 API 回复'")
    expect(viewSource).toContain("'网页已连接'")
    expect(viewSource).not.toContain("'API 模型'")
    expect(viewSource).not.toContain('cursor ${role.contextCursor}')
    expect(viewSource).not.toContain("'已有会话'")
    expect(viewSource).not.toContain("'未绑定会话'")
    expect(viewSource).toContain("deps.runCommand('GROUP_ROLE_DELETE'")
    expect(roleSiteMenuSource(viewSource)).not.toContain('GROUP_ROLE_DELETE')
    expect(roleSiteMenuSource(viewSource)).not.toContain('删除成员')
  })

  it('renders a refresh action on each member card and rebuilds only that iframe', async () => {
    const store = makeStoreWithRole()
    const rolePanelEl = document.createElement('aside')
    const roleSummaryEl = document.createElement('p')
    const roleListEl = document.createElement('div')
    const iframeHost = { recoverRole: vi.fn() }
    const runCommand = vi.fn(async () => undefined)
    rolePanelEl.append(roleSummaryEl, roleListEl)

    const view = createRolePanelView({
      state: createTeamPageState(),
      getStore: () => store,
      rolePanelEl,
      roleSummaryEl,
      roleListEl,
      iframeHost,
      getCurrentChat: () => store.chatsById['chat-1'],
      getCurrentRoles: () => [store.rolesById['role-1']],
      emptyCard: (title, body) => {
        const card = document.createElement('div')
        card.textContent = `${title}${body}`
        return card
      },
      insertMention: vi.fn(),
      refreshCurrentChat: vi.fn(async () => undefined),
      focusRoleFrame: vi.fn(),
      runCommand,
      showError: vi.fn(),
    })

    view.renderRolePanel()
    expect(roleListEl.querySelector('[data-role-list-refresh]')).toBeNull()
    // The card's actions are in its ⋯ menu.
    expect(roleListEl.querySelector('[data-role-refresh="role-1"]')).toBeNull()
    roleListEl.querySelector<HTMLButtonElement>('[data-role-more="role-1"]')?.click()
    const refresh = roleListEl.querySelector<HTMLButtonElement>('[data-role-refresh="role-1"]')
    expect(refresh?.getAttribute('aria-label')).toBe('刷新网页：产品经理')
    refresh?.click()
    await Promise.resolve()

    expect(iframeHost.recoverRole).toHaveBeenCalledWith(store.rolesById['role-1'])
    expect(runCommand).toHaveBeenCalledWith('GROUP_ROLE_RECOVER', { chatId: 'chat-1', roleId: 'role-1' })
  })

  it('tells whoever asked when a member card is chosen (the side panel shows its page)', () => {
    const store = makeStoreWithRole()
    const rolePanelEl = document.createElement('aside')
    const roleListEl = document.createElement('div')
    const roleSummaryEl = document.createElement('p')
    rolePanelEl.append(roleSummaryEl, roleListEl)
    const onSelectRole = vi.fn()
    const state = createTeamPageState()
    const view = createRolePanelView({
      state,
      getStore: () => store,
      rolePanelEl,
      roleSummaryEl,
      roleListEl,
      iframeHost: { recoverRole: vi.fn() },
      getCurrentChat: () => store.chatsById['chat-1'],
      getCurrentRoles: () => [store.rolesById['role-1']],
      emptyCard: () => document.createElement('div'),
      insertMention: vi.fn(),
      refreshCurrentChat: vi.fn(async () => undefined),
      focusRoleFrame: vi.fn(),
      runCommand: vi.fn(async () => undefined),
      showError: vi.fn(),
      onSelectRole,
    })

    view.renderRolePanel()
    roleListEl.querySelector<HTMLElement>('.role-card')!.click()
    expect(state.selectedRoleId).toBe('role-1')
    expect(onSelectRole).toHaveBeenCalledWith(store.rolesById['role-1'])
  })

  it('shows live page health and offers fixes when the page cannot take messages', async () => {
    const store = makeStoreWithRole()
    const rolePanelEl = document.createElement('aside')
    const roleSummaryEl = document.createElement('p')
    const roleListEl = document.createElement('div')
    const iframeHost = { recoverRole: vi.fn() }
    const runCommand = vi.fn(async () => undefined)
    const openRoleSite = vi.fn()
    let health: RolePageHealth = { status: 'login-required', reason: 'login' }
    rolePanelEl.append(roleSummaryEl, roleListEl)
    const view = createRolePanelView({
      state: createTeamPageState(),
      getStore: () => store,
      rolePanelEl,
      roleSummaryEl,
      roleListEl,
      iframeHost,
      getCurrentChat: () => store.chatsById['chat-1'],
      getCurrentRoles: () => [store.rolesById['role-1']],
      emptyCard: () => document.createElement('div'),
      insertMention: vi.fn(),
      refreshCurrentChat: vi.fn(async () => undefined),
      focusRoleFrame: vi.fn(),
      runCommand,
      showError: vi.fn(),
      getRoleHealth: () => health,
      openRoleSite,
    })

    view.renderRolePanel()
    expect(roleListEl.querySelector('.role-health')?.textContent).toBe('需要登录')
    const actions = [...roleListEl.querySelectorAll<HTMLButtonElement>('.role-health-action')]
    expect(actions.map(button => button.textContent)).toEqual(['打开网站', '重新加载'])
    // The page's own help replaces the generic "member error" note.
    expect(roleListEl.textContent).not.toContain('人员异常')

    actions[0].click()
    actions[1].click()
    await Promise.resolve()
    expect(openRoleSite).toHaveBeenCalledWith(store.rolesById['role-1'])
    expect(iframeHost.recoverRole).toHaveBeenCalledWith(store.rolesById['role-1'])
    expect(runCommand).toHaveBeenCalledWith('GROUP_ROLE_RECOVER', { chatId: 'chat-1', roleId: 'role-1' })

    health = { status: 'blocked', reason: 'http-error', detail: 'ERROR: The request could not be satisfied' }
    view.renderRolePanel()
    expect(roleListEl.querySelector('.role-health')?.textContent).toBe('网站拒绝访问')
    expect(roleListEl.querySelector('.role-health-detail')?.textContent).toBe('ERROR: The request could not be satisfied')
    expect([...roleListEl.querySelectorAll('.role-health-action')].map(button => button.textContent)).toEqual(['重新加载'])

    health = { status: 'ready', reason: 'guest' }
    view.renderRolePanel()
    expect(roleListEl.querySelector('.role-health')?.textContent).toBe('可以发送（未登录）')
    expect(roleListEl.querySelector('.role-health-help')).toBeNull()
  })

  it('puts removing a member last in its card menu, and confirms before removing', async () => {
    const store = makeStoreWithRole()
    const rolePanelEl = document.createElement('aside')
    const roleSummaryEl = document.createElement('p')
    const roleListEl = document.createElement('div')
    const iframeHost = { recoverRole: vi.fn() }
    const runCommand = vi.fn(async () => undefined)
    rolePanelEl.append(roleSummaryEl, roleListEl)
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true)

    const view = createRolePanelView({
      state: createTeamPageState(),
      getStore: () => store,
      rolePanelEl,
      roleSummaryEl,
      roleListEl,
      iframeHost,
      getCurrentChat: () => store.chatsById['chat-1'],
      getCurrentRoles: () => [store.rolesById['role-1']],
      emptyCard: (title, body) => {
        const card = document.createElement('div')
        card.textContent = `${title}${body}`
        return card
      },
      insertMention: vi.fn(),
      refreshCurrentChat: vi.fn(async () => undefined),
      focusRoleFrame: vi.fn(),
      runCommand,
      showError: vi.fn(),
    })

    view.renderRolePanel()
    roleListEl.querySelector<HTMLButtonElement>('[data-role-more="role-1"]')?.click()
    const items = [...roleListEl.querySelectorAll<HTMLButtonElement>('.role-action-menu [role="menuitem"]')]
    expect(items.map(item => item.textContent)).toEqual(['编辑名字和头像', '查看提示词', '刷新网页', '查看网页', '移出群聊'])
    const remove = roleListEl.querySelector<HTMLButtonElement>('[data-role-delete="role-1"]')
    expect(items[items.length - 1]).toBe(remove)
    expect(remove?.querySelector('svg')).not.toBeNull()
    expect(remove?.getAttribute('aria-label')).toBe('移出群聊：产品经理')
    remove?.click()
    await Promise.resolve()

    expect(confirm).toHaveBeenCalledWith('确定将「产品经理」移出当前群聊吗？历史聊天记录会保留。')
    expect(runCommand).toHaveBeenCalledWith('GROUP_ROLE_DELETE', { roleId: 'role-1' })
    confirm.mockRestore()
  })

  it('says how many memory items go with a removed member, in the page\'s language', async () => {
    const remove = async (language: 'zh-CN' | 'en', count: number): Promise<string> => {
      const store = makeStoreWithRole()
      store.settings.language = language
      const items = Array.from({ length: count }, (_, index) => ({ id: `mem-${index}`, scope: 'role' as const, scopeId: 'role-1', kind: 'fact' as const, content: `第 ${index} 条`, source: { origin: 'user' as const }, createdAt: 1, updatedAt: 1 }))
      // Kept for the group from its reply, in an independent group: stays, and nobody will read it.
      const groupItem = { id: 'mem-group', scope: 'chat' as const, scopeId: 'chat-1', kind: 'fact' as const, content: '群的', source: { origin: 'member' as const, roleId: 'role-1' }, createdAt: 1, updatedAt: 1 }
      store.memoryItemsById = Object.fromEntries([...items, groupItem].map(item => [item.id, item]))
      store.memoryOrder = Object.keys(store.memoryItemsById)
      const rolePanelEl = document.createElement('aside')
      const roleSummaryEl = document.createElement('p')
      const roleListEl = document.createElement('div')
      rolePanelEl.append(roleSummaryEl, roleListEl)
      const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
      const runCommand = vi.fn(async () => undefined)
      const view = createRolePanelView({
        state: createTeamPageState(),
        getStore: () => store,
        rolePanelEl,
        roleSummaryEl,
        roleListEl,
        iframeHost: { recoverRole: vi.fn() },
        getCurrentChat: () => store.chatsById['chat-1'],
        getCurrentRoles: () => [store.rolesById['role-1']],
        emptyCard: () => document.createElement('div'),
        insertMention: vi.fn(),
        refreshCurrentChat: vi.fn(async () => undefined),
        focusRoleFrame: vi.fn(),
        runCommand,
        showError: vi.fn(),
      })
      view.renderRolePanel()
      roleListEl.querySelector<HTMLButtonElement>('[data-role-more="role-1"]')?.click()
      roleListEl.querySelector<HTMLButtonElement>('[data-role-delete="role-1"]')?.click()
      await Promise.resolve()
      const question = confirm.mock.calls[0][0] as string
      // Refused: nothing is removed.
      expect(runCommand).not.toHaveBeenCalled()
      confirm.mockRestore()
      return question
    }

    expect(await remove('zh-CN', 2)).toBe('确定将「产品经理」移出当前群聊吗？历史聊天记录会保留。只为这位成员保存的 2 条记忆会一并删除。另有出自它的回复、存为本群的 1 条记忆，之后没有成员会读到：独立模式的群里只有写它的成员读得到。')
    expect(await remove('en', 1)).toBe('Remove "产品经理" from this group? The chat history stays. The 1 memory item saved for this member alone will be deleted. The 1 memory item saved for the group from its replies will be read by no one: in an independent group only the member who wrote them reads them.')
    expect(await remove('en', 0)).toBe('Remove "产品经理" from this group? The chat history stays. The 1 memory item saved for the group from its replies will be read by no one: in an independent group only the member who wrote them reads them.')
  })

  it('says nothing about memory when removing a member leaves none behind, and nothing about unread items in a shared group', async () => {
    const remove = async (mode: 'independent' | 'collaborative', withGroupItem: boolean) => {
      const store = makeStoreWithRole()
      store.chatsById['chat-1'].mode = mode
      const item = { id: 'g', scope: 'chat' as const, scopeId: 'chat-1', kind: 'fact' as const, content: '群的', source: { origin: 'member' as const, roleId: 'role-1' }, createdAt: 1, updatedAt: 1 }
      store.memoryItemsById = withGroupItem ? { g: item } : {}
      store.memoryOrder = withGroupItem ? ['g'] : []
      const rolePanelEl = document.createElement('aside')
      const roleSummaryEl = document.createElement('p')
      const roleListEl = document.createElement('div')
      rolePanelEl.append(roleSummaryEl, roleListEl)
      const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
      const view = createRolePanelView({
        state: createTeamPageState(), getStore: () => store, rolePanelEl, roleSummaryEl, roleListEl, iframeHost: { recoverRole: vi.fn() },
        getCurrentChat: () => store.chatsById['chat-1'], getCurrentRoles: () => [store.rolesById['role-1']], emptyCard: () => document.createElement('div'),
        insertMention: vi.fn(), refreshCurrentChat: vi.fn(async () => undefined), focusRoleFrame: vi.fn(), runCommand: vi.fn(async () => undefined), showError: vi.fn(),
      })
      view.renderRolePanel()
      roleListEl.querySelector<HTMLButtonElement>('[data-role-more="role-1"]')?.click()
      roleListEl.querySelector<HTMLButtonElement>('[data-role-delete="role-1"]')?.click()
      await Promise.resolve()
      const question = confirm.mock.calls[0][0] as string
      confirm.mockRestore()
      return question
    }
    expect(await remove('independent', false)).toBe('确定将「产品经理」移出当前群聊吗？历史聊天记录会保留。')
    // In a shared group the others read it already.
    expect(await remove('collaborative', true)).toBe('确定将「产品经理」移出当前群聊吗？历史聊天记录会保留。')
  })

  it('opens a member prompt detail dialog from the member card', () => {
    const store = makeStoreWithRole()
    store.rolesById['role-1'].description = '拆解需求和验收标准'
    store.rolesById['role-1'].systemPrompt = '你是产品经理。请先澄清目标，再输出可执行方案。'
    const rolePanelEl = document.createElement('aside')
    const roleSummaryEl = document.createElement('p')
    const roleListEl = document.createElement('div')
    rolePanelEl.append(roleSummaryEl, roleListEl)

    const view = createRolePanelView({
      state: createTeamPageState(),
      getStore: () => store,
      rolePanelEl,
      roleSummaryEl,
      roleListEl,
      iframeHost: { recoverRole: vi.fn() },
      getCurrentChat: () => store.chatsById['chat-1'],
      getCurrentRoles: () => [store.rolesById['role-1']],
      emptyCard: (title, body) => {
        const card = document.createElement('div')
        card.textContent = `${title}${body}`
        return card
      },
      insertMention: vi.fn(),
      refreshCurrentChat: vi.fn(async () => undefined),
      focusRoleFrame: vi.fn(),
      runCommand: vi.fn(async () => undefined),
      showError: vi.fn(),
    })

    view.renderRolePanel()
    roleListEl.querySelector<HTMLButtonElement>('[data-role-more="role-1"]')?.click()
    const detail = roleListEl.querySelector<HTMLButtonElement>('[data-role-prompt-detail="role-1"]')
    expect(detail?.getAttribute('aria-label')).toBe('查看提示词：产品经理')
    expect(detail?.querySelector('svg')).not.toBeNull()
    expect(detail?.textContent?.trim()).toBe('查看提示词')
    detail?.click()

    const modal = document.querySelector<HTMLElement>('.role-prompt-modal')
    expect(modal?.hidden).toBe(false)
    expect(modal?.querySelector('h2')?.textContent).toBe('产品经理')
    expect(modal?.textContent).toContain('拆解需求和验收标准')
    expect(modal?.querySelector('pre')?.textContent).toBe('你是产品经理。请先澄清目标，再输出可执行方案。')

    modal?.querySelector<HTMLButtonElement>('.role-prompt-close')?.click()
    expect(document.querySelector('.role-prompt-modal')).toBeNull()
  })

  it('opens the name and avatar window from the card menu, draws the chosen avatar, and returns focus after', async () => {
    const store = makeStoreWithRole()
    Object.assign(store.rolesById['role-1'], { avatarColor: 'tone-3', avatarText: '产品' })
    const rolePanelEl = document.createElement('aside')
    const roleSummaryEl = document.createElement('p')
    const roleListEl = document.createElement('div')
    rolePanelEl.append(roleSummaryEl, roleListEl)
    document.body.append(rolePanelEl)
    const runCommand = vi.fn(async () => undefined)
    const view = createRolePanelView({
      state: createTeamPageState(),
      getStore: () => store,
      rolePanelEl,
      roleSummaryEl,
      roleListEl,
      iframeHost: { recoverRole: vi.fn() },
      getCurrentChat: () => store.chatsById['chat-1'],
      getCurrentRoles: () => [store.rolesById['role-1']],
      emptyCard: () => document.createElement('div'),
      insertMention: vi.fn(),
      refreshCurrentChat: vi.fn(async () => undefined),
      focusRoleFrame: vi.fn(),
      runCommand,
      showError: vi.fn(),
    })

    view.renderRolePanel()
    const avatar = roleListEl.querySelector('.role-avatar')!
    expect(avatar.className).toContain('role-tone-3')
    expect(avatar.querySelector('.avatar-text-pair')?.textContent).toBe('产品')

    roleListEl.querySelector<HTMLButtonElement>('[data-role-more="role-1"]')?.click()
    const edit = roleListEl.querySelector<HTMLButtonElement>('[data-role-edit-profile="role-1"]')!
    expect(edit.getAttribute('aria-label')).toBe('编辑名字和头像：产品经理')
    expect(edit.querySelector('svg')).not.toBeNull()
    edit.click()

    const name = document.querySelector<HTMLInputElement>('#role-profile-name')!
    expect(name.value).toBe('产品经理')
    name.value = '小P'
    name.dispatchEvent(new Event('input'))
    document.querySelector<HTMLFormElement>('.role-profile-form')!.requestSubmit()
    await vi.waitFor(() => expect(document.querySelector('.role-profile-modal')).toBeNull())
    expect(runCommand).toHaveBeenCalledWith('GROUP_ROLE_PROFILE_UPDATE', { roleId: 'role-1', patch: { name: '小P' } })
    expect(document.activeElement).toBe(roleListEl.querySelector('[data-role-more="role-1"]'))
  })

  it('renders the latest AI page health detail on the member card', () => {
    const store = makeStoreWithRole()
    Object.assign(store.rolesById['role-1'], {
      siteHealth: {
        siteId: 'chatgpt',
        status: 'blocked',
        detail: 'Access Denied',
        updatedAt: 100,
      },
    })
    const rolePanelEl = document.createElement('aside')
    const roleSummaryEl = document.createElement('p')
    const roleListEl = document.createElement('div')
    rolePanelEl.append(roleSummaryEl, roleListEl)

    const view = createRolePanelView({
      state: createTeamPageState(),
      getStore: () => store,
      rolePanelEl,
      roleSummaryEl,
      roleListEl,
      iframeHost: { recoverRole: vi.fn() },
      getCurrentChat: () => store.chatsById['chat-1'],
      getCurrentRoles: () => [store.rolesById['role-1']],
      emptyCard: (title, body) => {
        const card = document.createElement('div')
        card.textContent = `${title}${body}`
        return card
      },
      insertMention: vi.fn(),
      refreshCurrentChat: vi.fn(async () => undefined),
      focusRoleFrame: vi.fn(),
      runCommand: vi.fn(async () => undefined),
      showError: vi.fn(),
    })

    view.renderRolePanel()

    expect(roleListEl.querySelector('.role-meta')?.textContent).toContain('页面被阻止：Access Denied')
  })
})

describe('moving a member that is replying to another model', () => {
  async function pick(answer: boolean) {
    const store = makeStoreWithRole()
    Object.assign(store.rolesById['role-1'], { status: 'thinking', lastPromptMessageId: 'q1' })
    const rolePanelEl = document.createElement('aside')
    const roleSummaryEl = document.createElement('p')
    const roleListEl = document.createElement('div')
    rolePanelEl.append(roleSummaryEl, roleListEl)
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(answer)
    const commands: string[] = []
    const runCommand = vi.fn(async (type: string) => { commands.push(type) })
    const iframeHost = { recoverRole: vi.fn() }
    const view = createRolePanelView({
      state: createTeamPageState(), getStore: () => store, rolePanelEl, roleSummaryEl, roleListEl, iframeHost,
      getCurrentChat: () => store.chatsById['chat-1'], getCurrentRoles: () => [store.rolesById['role-1']], emptyCard: () => document.createElement('div'),
      insertMention: vi.fn(), refreshCurrentChat: vi.fn(async () => undefined), focusRoleFrame: vi.fn(), runCommand, showError: vi.fn(),
    })
    view.renderRolePanel()
    roleListEl.querySelector<HTMLButtonElement>('.site-pill')!.click()
    const option = [...roleListEl.querySelectorAll<HTMLButtonElement>('.role-site-option')].find(button => button.textContent?.includes('Gemini'))!
    option.click()
    await vi.waitFor(() => expect(confirm).toHaveBeenCalled())
    await new Promise(resolve => setTimeout(resolve, 0))
    const question = confirm.mock.calls[0][0] as string
    confirm.mockRestore()
    return { question, commands }
  }

  it('asks first, then ends the reply and moves it', async () => {
    const { question, commands } = await pick(true)
    expect(question).toBe('「产品经理」还在回复。换模型会结束这条回复，已写的部分会保留，之后可以用新模型重新回复。继续吗？')
    expect(commands.slice(0, 2)).toEqual(['GROUP_ROLE_REPLY_END', 'GROUP_ROLE_UPDATE'])
  })

  it('leaves everything as it is when the user says no', async () => {
    const { commands } = await pick(false)
    expect(commands).toEqual([])
  })
})

function makeStoreWithRole(): OpenTeamStore {
  const store = createDefaultStore()
  store.settings.language = 'zh-CN'
  const chat: GroupChat = {
    id: 'chat-1',
    name: '产品会',
    mode: 'independent',
    roleIds: ['role-1'],
    messageIds: [],
    nextMessageSeq: 1,
    status: 'ready',
    createdAt: 1,
    updatedAt: 1,
  }
  const role: GroupRole = {
    id: 'role-1',
    chatId: chat.id,
    name: '产品经理',
    status: 'error',
    contextCursor: 0,
    chatSite: 'chatgpt',
    createdAt: 1,
    updatedAt: 1,
  }
  store.currentChatId = chat.id
  store.chatOrder = [chat.id]
  store.chatsById[chat.id] = chat
  store.rolesById[role.id] = role
  return store
}

function roleSiteMenuSource(source: string): string {
  const match = source.match(/function roleSiteMenu\(role: GroupRole\): HTMLElement \{(?<body>[\s\S]*?)\n  async function kickRoleFromChat/)
  return match?.groups?.body ?? ''
}
