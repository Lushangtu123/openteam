// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { createDefaultStore } from '../group/store'
import { readTeamFormation } from '../group/teamFormation'
import type { GroupMessage, OpenTeamStore } from '../group/types'
import type { RolePageHealth } from './roleHealth'
import { createTeamFormationView } from './teamFormationView'

afterEach(() => {
  document.body.replaceChildren()
})

const claimReply = (first: string, second?: string, extra: Record<string, unknown> = {}) => `\`\`\`json\n${JSON.stringify({ first_choice: first, ...(second ? { second_choice: second } : {}), responsibility: `${first}的工作`, needed_positions: ['测试'], ...extra })}\n\`\`\``

function makeStore(): OpenTeamStore {
  const store = createDefaultStore()
  store.settings.language = 'zh-CN'
  for (const [id, name, site] of [['r1', 'Claude', 'claude'], ['r2', 'ChatGPT', 'chatgpt'], ['r3', 'Claude2', 'claude']] as const) {
    store.rolesById[id] = { id, chatId: 'c1', name, status: 'ready', contextCursor: 0, chatSite: site, createdBy: 'team-formation', createdAt: 1, updatedAt: 1 }
  }
  store.chatOrder = ['c1']
  store.currentChatId = 'c1'
  store.chatsById.c1 = {
    id: 'c1', name: '记账', mode: 'collaborative', roleIds: ['r1', 'r2', 'r3'], messageIds: [], nextMessageSeq: 1, status: 'ready', createdAt: 1, updatedAt: 1,
    teamFormation: { task: '做一个记账小程序', requiredPositions: [], status: 'checking', rounds: [['r1', 'r2'], ['r3']], nextRound: 0, invitationIds: [], createdAt: 1 },
  }
  return store
}

function addMessage(store: OpenTeamStore, message: Omit<GroupMessage, 'chatId' | 'seq' | 'createdAt'>): void {
  const chat = store.chatsById.c1
  store.messagesById[message.id] = { ...message, chatId: 'c1', seq: chat.nextMessageSeq, createdAt: chat.nextMessageSeq } as GroupMessage
  chat.messageIds.push(message.id)
  chat.nextMessageSeq += 1
}

function setup(store = makeStore(), health: Record<string, RolePageHealth> = {}) {
  const runCommand = vi.fn(async (type: string, payload?: Record<string, unknown>) => {
    if (type === 'GROUP_MESSAGE_SEND' && payload?.teamInvitation) {
      const id = `inv${store.chatsById.c1.teamFormation!.invitationIds.length + 1}`
      const targets = String(payload.raw).match(/@[^（\s]+/g)?.map(mention => Object.values(store.rolesById).find(role => role.name === mention.slice(1))!.id) ?? []
      addMessage(store, { id, type: 'user', content: String(payload.raw), targetRoleIds: targets, status: 'pending', deliveryStatus: Object.fromEntries(targets.map(roleId => [roleId, 'sent'])) })
      const formation = store.chatsById.c1.teamFormation!
      formation.invitationIds.push(id)
      formation.status = 'claiming'
      if (typeof payload.teamRound === 'number') formation.nextRound = payload.teamRound + 1
    }
    // What the background does with the other commands, so the card renders from real state.
    if (type === 'GROUP_CHAT_UPDATE') {
      const patch = (payload?.patch as Record<string, unknown>).teamFormation as Record<string, unknown>
      store.chatsById.c1.teamFormation = readTeamFormation({ ...store.chatsById.c1.teamFormation, ...patch }, 1)
    }
    if (type === 'GROUP_ROLE_UPDATE') {
      const role = store.rolesById[String(payload?.roleId)]
      Object.assign(role, payload?.patch)
    }
  })
  const openAutoPlan = vi.fn()
  const showSuccess = vi.fn()
  const showError = vi.fn()
  const view = createTeamFormationView({
    getStore: () => store,
    getCurrentChatId: () => 'c1',
    runCommand,
    getRoleHealth: role => health[role.id] ?? { status: 'ready' },
    focusRoleFrame: vi.fn(),
    showError,
    showSuccess,
    openAutoPlan,
  })
  return { store, view, runCommand, showSuccess, showError, openAutoPlan }
}

const reply = (store: OpenTeamStore, id: string, roleId: string, invitationId: string, content: string) =>
  addMessage(store, { id, type: 'assistant', roleId, sourceMessageId: invitationId, content, status: 'received' })

const rowState = () => [...document.querySelectorAll('.team-card-row')].map(row => ({
  name: row.querySelector('.team-card-name')?.textContent,
  state: row.querySelector('.team-card-state')?.textContent ?? null,
  position: row.querySelector<HTMLInputElement>('.team-card-position input')?.value ?? null,
  tags: [...row.querySelectorAll('.team-card-tag')].map(tag => tag.textContent),
}))

const settle = () => new Promise(resolve => setTimeout(resolve, 0))

const footerButton = (label: string) => [...document.querySelectorAll<HTMLButtonElement>('.team-card-footer button')].find(button => button.textContent === label)!

describe('team formation view', () => {
  it('asks for the task and at least two members, then creates the team', async () => {
    const { view, runCommand } = setup()
    view.openSetup()
    const form = document.querySelector<HTMLFormElement>('.team-setup-form')!

    form.dispatchEvent(new Event('submit', { cancelable: true }))
    expect(document.querySelector('.team-form-error')?.textContent).toBe('先写下要做的事。')

    document.querySelector<HTMLTextAreaElement>('#team-setup-task')!.value = '做一个记账小程序'
    const plus = (key: string) => document.querySelector<HTMLButtonElement>(`.team-setup-member[data-key="${key}"] .team-setup-step:last-child`)!
    plus('site:claude').click()
    form.dispatchEvent(new Event('submit', { cancelable: true }))
    expect(document.querySelector('.team-form-error')?.textContent).toBe('至少选 2 位队员。')

    plus('site:claude').click()
    plus('site:kimi').click()
    document.querySelector<HTMLInputElement>('#team-setup-required')!.value = '测试、运维'
    form.dispatchEvent(new Event('submit', { cancelable: true }))

    await vi.waitFor(() => expect(runCommand).toHaveBeenCalled())
    expect(runCommand.mock.calls[0]).toEqual(['GROUP_TEAM_CREATE', {
      task: '做一个记账小程序',
      members: [{ modelSource: 'site', chatSite: 'claude' }, { modelSource: 'site', chatSite: 'claude' }, { modelSource: 'site', chatSite: 'kimi' }],
      requiredPositions: ['测试', '运维'],
    }])
    await vi.waitFor(() => expect(document.querySelector('.team-setup-dialog')).toBeNull())
    // The store's current chat has a formation, so its card opens.
    expect(document.querySelector('#team-card-title')?.textContent).toBe('检查队员')
  })

  it('invites only once every member\'s page can send', async () => {
    const { view } = setup(makeStore(), { r2: { status: 'login-required', reason: 'login' } })
    view.openCard('c1')

    expect(rowState().map(row => [row.name, row.state])).toEqual([['Claude', '可以发送'], ['ChatGPT', '需要登录'], ['Claude2', '可以发送']])
    expect(footerButton('邀请它们自荐').disabled).toBe(true)
    expect(document.querySelector('.team-card-hint')?.textContent).toBe('等所有队员的网页都显示“可以发送”。')
  })

  it('sends the first round, then the twin once the first round answered, and resolves clashes', async () => {
    const { store, view, runCommand } = setup()
    view.openCard('c1')
    footerButton('邀请它们自荐').click()
    await vi.waitFor(() => expect(store.chatsById.c1.teamFormation!.invitationIds).toEqual(['inv1']))
    await settle()
    const firstInvitation = runCommand.mock.calls.find(call => call[0] === 'GROUP_MESSAGE_SEND')![1]!
    expect(firstInvitation.raw).toMatch(/^@Claude（Claude） @ChatGPT（ChatGPT） 我们要组队完成这件事：/)
    expect(firstInvitation.teamRound).toBe(0)

    view.refresh()
    expect(rowState().map(row => [row.name, row.state])).toEqual([['Claude', '等待回复'], ['ChatGPT', '等待回复'], ['Claude2', '等同款 AI 先选，再轮到它']])

    reply(store, 'a1', 'r1', 'inv1', claimReply('产品负责人', '测试工程师'))
    reply(store, 'a2', 'r2', 'inv1', claimReply('前端工程师'))
    view.refresh()
    // The second Claude is invited with what the first round took.
    await vi.waitFor(() => expect(store.chatsById.c1.teamFormation!.invitationIds).toEqual(['inv1', 'inv2']))
    await settle()
    const second = runCommand.mock.calls.filter(call => call[0] === 'GROUP_MESSAGE_SEND')[1][1]!
    expect(second.raw).toMatch(/^@Claude2（Claude） /)
    expect(second.raw).toContain('- 产品负责人（Claude）')
    expect(second.raw).toContain('- 前端工程师（ChatGPT）')

    // It wants the product lead's position anyway, which the first Claude claimed a round earlier.
    reply(store, 'a3', 'r3', 'inv2', claimReply('产品负责人'))
    view.refresh()
    expect(rowState().map(row => [row.name, row.position, row.tags])).toEqual([
      ['Claude', '产品负责人', ['第一选择']],
      ['ChatGPT', '前端工程师', ['第一选择']],
      ['Claude2', '产品负责人', ['和别人重复']],
    ])
    expect(document.querySelector('.team-card-note-conflict')?.textContent).toBe('「产品负责人」已经是 Claude 的了，Claude2 也想要。改 Claude2 的职位，或让它重选。')
    expect(footerButton('确认分工，开工').disabled).toBe(true)

    // Only the latecomer is asked again.
    footerButton('让重复的重选').click()
    await vi.waitFor(() => expect(store.chatsById.c1.teamFormation!.invitationIds).toEqual(['inv1', 'inv2', 'inv3']))
    expect(String(runCommand.mock.calls.filter(call => call[0] === 'GROUP_MESSAGE_SEND')[2][1]!.raw)).toMatch(/^@Claude2（Claude） 有几位选了同一个职位/)
    await settle()
    reply(store, 'a4', 'r3', 'inv3', claimReply('测试工程师'))
    view.refresh()
    expect(rowState().map(row => row.position)).toEqual(['产品负责人', '前端工程师', '测试工程师'])
    expect(footerButton('确认分工，开工').disabled).toBe(false)
  })

  it('reports a clash, asks the clashing members again, and lets the user type a position', async () => {
    const store = makeStore()
    store.chatsById.c1.teamFormation = { ...store.chatsById.c1.teamFormation!, status: 'claiming', nextRound: 2, invitationIds: ['inv1'], rounds: [['r1', 'r2', 'r3']] }
    addMessage(store, { id: 'inv1', type: 'user', content: '邀请', targetRoleIds: ['r1', 'r2', 'r3'], status: 'pending', deliveryStatus: { r1: 'received', r2: 'received', r3: 'received' } })
    reply(store, 'a1', 'r1', 'inv1', claimReply('架构师'))
    reply(store, 'a2', 'r2', 'inv1', claimReply('架构师'))
    reply(store, 'a3', 'r3', 'inv1', '我觉得我适合做测试')
    const { view, runCommand } = setup(store)
    view.openCard('c1')

    expect(document.querySelector('.team-card-note-conflict')?.textContent).toBe('「架构师」有 2 位想要：Claude、ChatGPT。改其中一位的职位，或让它们重选。')
    expect(rowState()[2]).toMatchObject({ name: 'Claude2', state: '没按格式回答，请手动填写', position: '' })
    expect(footerButton('确认分工，开工').disabled).toBe(true)

    footerButton('让重复的重选').click()
    await vi.waitFor(() => expect(runCommand).toHaveBeenCalledWith('GROUP_MESSAGE_SEND', expect.objectContaining({ teamInvitation: true })))
    const repick = runCommand.mock.calls.find(call => call[0] === 'GROUP_MESSAGE_SEND')![1]!
    expect(repick.raw).toMatch(/^@Claude（Claude） @ChatGPT（ChatGPT） 有几位选了同一个职位，请重新选择。/)
    expect(repick.teamRound).toBeUndefined()
    await settle()

    // The user settles it by hand instead.
    const input = (name: string) => [...document.querySelectorAll('.team-card-row')].find(row => row.querySelector('.team-card-name')?.textContent === name)!.querySelector<HTMLInputElement>('.team-card-position input')!
    reply(store, 'a4', 'r1', 'inv2', claimReply('架构师'))
    reply(store, 'a5', 'r2', 'inv2', claimReply('架构师'))
    view.refresh()
    input('ChatGPT').value = '后端工程师'
    input('ChatGPT').dispatchEvent(new Event('change'))
    input('Claude2').value = '测试 工程师'
    input('Claude2').dispatchEvent(new Event('change'))
    expect(document.querySelector('.team-card-note-conflict')).toBeNull()
    expect(footerButton('确认分工，开工').disabled).toBe(false)
  })

  it('renames everyone to their position, records the persona, and sends the kickoff with personas', async () => {
    const store = makeStore()
    store.chatsById.c1.teamFormation = { ...store.chatsById.c1.teamFormation!, status: 'claiming', nextRound: 1, invitationIds: ['inv1'], rounds: [['r1', 'r2']] }
    store.chatsById.c1.roleIds = ['r1', 'r2']
    addMessage(store, { id: 'inv1', type: 'user', content: '邀请', targetRoleIds: ['r1', 'r2'], status: 'pending', deliveryStatus: { r1: 'received', r2: 'received' } })
    reply(store, 'a1', 'r1', 'inv1', claimReply('产品 负责人', undefined, { not_responsible: '写代码', first_deliverable: '需求文档' }))
    reply(store, 'a2', 'r2', 'inv1', claimReply('前端工程师'))
    const { view, runCommand, showSuccess } = setup(store)
    view.openCard('c1')

    footerButton('确认分工，开工').click()
    await vi.waitFor(() => expect(showSuccess).toHaveBeenCalledWith('分工已确认，开工消息已发出'))

    const calls = runCommand.mock.calls.map(([type, payload]) => [type, payload])
    expect(calls[0]).toEqual(['GROUP_ROLE_UPDATE', { roleId: 'r1', patch: { name: '产品负责人', description: '产品 负责人的工作', systemPrompt: '你在这个项目中担任「产品 负责人」，这是你自己在组队时选的职位。\n你负责：产品 负责人的工作\n你不负责：写代码\n你会先交付：需求文档' } }])
    expect(calls[1]).toEqual(['GROUP_ROLE_UPDATE', { roleId: 'r2', patch: { name: '前端工程师', description: '前端工程师的工作', systemPrompt: '你在这个项目中担任「前端工程师」，这是你自己在组队时选的职位。\n你负责：前端工程师的工作' } }])
    expect(calls[2]).toEqual(['GROUP_CHAT_UPDATE', { chatId: 'c1', patch: { teamFormation: { status: 'confirmed', confirmedAt: expect.any(Number) } } }])
    expect(calls[3][0]).toBe('GROUP_MESSAGE_SEND')
    expect(calls[3][1]).toMatchObject({ chatId: 'c1', refreshPersona: true })
    expect(String((calls[3][1] as Record<string, unknown>).raw)).toMatch(/^@所有人 分工已经确定，开始工作吧。\n\n任务：\n做一个记账小程序/)
    // The card stays open on the next steps, showing what each member was told.
    expect(document.querySelector('#team-card-title')?.textContent).toBe('分工已确认')
    expect([...document.querySelectorAll('.team-card-row .team-card-detail')].map(detail => detail.textContent?.split('\n')[0])).toEqual(['你在这个项目中担任「产品 负责人」，这是你自己在组队时选的职位。', '你在这个项目中担任「前端工程师」，这是你自己在组队时选的职位。'])
    expect([...document.querySelectorAll('.team-card-footer button')].map(button => button.textContent)).toEqual(['按分工生成流程', '存为群聊模板', '重新分工', '关闭'])
  })

  it('plans a flow from the confirmed roles, saves the team, and divides the work again', async () => {
    const store = makeStore()
    store.chatsById.c1.roleIds = ['r1', 'r2']
    store.chatsById.c1.teamFormation = { ...store.chatsById.c1.teamFormation!, status: 'confirmed', rounds: [['r1', 'r2']], nextRound: 1, invitationIds: ['inv1'], confirmedAt: 5 }
    Object.assign(store.rolesById.r1, { name: '产品负责人', description: '需求和验收' })
    Object.assign(store.rolesById.r2, { name: '前端工程师', description: '前端工程师' })
    const { view, runCommand, openAutoPlan } = setup(store)

    view.openCard('c1')
    footerButton('按分工生成流程').click()
    expect(openAutoPlan).toHaveBeenCalledWith('做一个记账小程序', '只使用群聊里现有的 2 位人员，他们已经按职位分好工：\n- 产品负责人（Claude）：需求和验收\n- 前端工程师（ChatGPT）\n不要新建人员，也不要改他们的人设。每个节点交给职位最合适的人；依赖别人产出的工作排在后面；最后由最适合把关的人审核结果。')
    expect(document.querySelector('.team-card-dialog')).toBeNull()

    view.openCard('c1')
    footerButton('存为群聊模板').click()
    const name = document.querySelector<HTMLInputElement>('.team-card-panel input')!
    expect(name.value).toBe('记账')
    name.value = '记账团队'
    footerButton('保存').click()
    await vi.waitFor(() => expect(runCommand).toHaveBeenCalledWith('GROUP_TEAM_TEMPLATE_SAVE', { chatId: 'c1', name: '记账团队' }))

    await vi.waitFor(() => expect(footerButton('重新分工')).toBeTruthy())
    footerButton('重新分工').click()
    const phase = document.querySelector<HTMLTextAreaElement>('.team-card-panel textarea')!
    expect(phase.value).toBe('做一个记账小程序')
    phase.value = '第二阶段：上线前的测试和推广'
    footerButton('重新分工').click()
    await vi.waitFor(() => expect(store.chatsById.c1.teamFormation).toMatchObject({
      task: '第二阶段：上线前的测试和推广',
      status: 'checking',
      rounds: [['r1', 'r2']],
      nextRound: 0,
      invitationIds: [],
      previousPositions: [{ position: '产品负责人', holder: 'Claude' }, { position: '前端工程师', holder: 'ChatGPT' }],
    }))
    expect(store.chatsById.c1.teamFormation!.confirmedAt).toBeUndefined()
    await settle()
    expect(document.querySelector('#team-card-title')?.textContent).toBe('检查队员')
    expect(document.querySelector('.team-card-task')?.textContent).toBe('第二阶段：上线前的测试和推广')

    // The new invitation shows where everyone stands.
    footerButton('邀请它们自荐').click()
    await vi.waitFor(() => expect(store.chatsById.c1.teamFormation!.invitationIds).toEqual(['inv1']))
    const invitation = String(runCommand.mock.calls.find(call => call[0] === 'GROUP_MESSAGE_SEND')![1]!.raw)
    expect(invitation).toContain('第二阶段：上线前的测试和推广')
    expect(invitation).toContain('这是新阶段。到目前为止的分工（可以保持，也可以换）：\n- 产品负责人（Claude）\n- 前端工程师（ChatGPT）')
  })

  it('starts a saved team right away, or uses it from the setup window', async () => {
    const store = makeStore()
    store.chatsById.c1.roleIds = ['r1', 'r2']
    store.chatsById.c1.teamFormation = { ...store.chatsById.c1.teamFormation!, preset: true, rounds: [['r1', 'r2']] }
    Object.assign(store.rolesById.r1, { name: '产品负责人', description: '需求和验收' })
    Object.assign(store.rolesById.r2, { name: '前端工程师', description: '前端工程师' })
    store.settings.teamTemplates = [{ id: 'team-1', name: '记账团队', task: '做记账', createdAt: 1, members: [
      { name: '产品负责人', modelSource: 'site', chatSite: 'claude' },
      { name: '前端工程师', modelSource: 'site', chatSite: 'chatgpt' },
    ] }]
    const { view, runCommand } = setup(store)

    view.openCard('c1')
    expect([...document.querySelectorAll('.team-card-footer button')].map(button => button.textContent)).toEqual(['让它们重新自荐', '开工'])
    footerButton('开工').click()
    await vi.waitFor(() => expect(runCommand).toHaveBeenCalledWith('GROUP_MESSAGE_SEND', expect.objectContaining({ refreshPersona: true })))
    expect(runCommand.mock.calls[0]).toEqual(['GROUP_CHAT_UPDATE', { chatId: 'c1', patch: { teamFormation: { status: 'confirmed', confirmedAt: expect.any(Number) } } }])
    expect(String(runCommand.mock.calls[1][1]!.raw)).toContain('- 产品负责人（Claude）：需求和验收\n- 前端工程师（ChatGPT）\n')
    await settle()
    expect(document.querySelector('#team-card-title')?.textContent).toBe('分工已确认')

    view.openSetup()
    expect(document.querySelector('.team-setup-saved-row .team-card-name')?.textContent).toBe('记账团队')
    document.querySelector<HTMLTextAreaElement>('#team-setup-task')!.value = '新任务'
    document.querySelector<HTMLButtonElement>('.team-setup-saved-row .btn-small')!.click()
    await vi.waitFor(() => expect(runCommand).toHaveBeenCalledWith('GROUP_TEAM_CREATE', { templateId: 'team-1', task: '新任务' }))
  })

  it('shows a banner while members choose, and marks invitations', () => {
    const store = makeStore()
    const { view } = setup(store)

    expect(view.statusBanner(store.chatsById.c1)?.textContent).toBe('组队中：先检查队员的网页，再邀请它们自荐职位。查看分工')
    store.chatsById.c1.teamFormation!.invitationIds = ['inv1']
    expect(view.isInvitation(store.chatsById.c1, 'inv1')).toBe(true)
    store.chatsById.c1.teamFormation!.status = 'confirmed'
    expect(view.statusBanner(store.chatsById.c1)).toBeUndefined()
  })
})
