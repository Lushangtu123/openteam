import { describe, expect, it } from 'vitest'
import { createDefaultStore } from './store'
import {
  buildTeamInvitation,
  buildTeamKickoff,
  buildTeamBrief,
  buildTeamFlowInstruction,
  collectTeamMembers,
  normalizeTeamTemplates,
  parseTeamClaim,
  planTeamRounds,
  cleanPosition,
  readTeamFormation,
  resolveTeamPositions,
  splitPositions,
  teamLabels,
  teamMemberNames,
  teamMemberResponsibility,
  teamTemplateFromChat,
  type TeamClaim,
} from './teamFormation'
import type { GroupMessage } from './types'

const claim = (firstChoice: string, secondChoice?: string, neededPositions: string[] = []): TeamClaim => ({ firstChoice, ...(secondChoice ? { secondChoice } : {}), neededPositions })

describe('team formation', () => {
  it('asks one member at a time, one copy of every model first', () => {
    const rounds = planTeamRounds([
      { roleId: 'c1', modelKey: 'site:claude' },
      { roleId: 'g1', modelKey: 'site:chatgpt' },
      { roleId: 'c2', modelKey: 'site:claude' },
      { roleId: 'c3', modelKey: 'site:claude' },
      { roleId: 'k1', modelKey: 'site:kimi' },
    ])

    expect(rounds).toEqual([['c1'], ['g1'], ['k1'], ['c2'], ['c3']])
  })

  it('reads a claim from a ```json block, with Chinese keys or trailing commas', () => {
    const reply = '好的，这是我的选择：\n```json\n{\n  "first_choice": "后端工程师",\n  "second_choice": "测试工程师",\n  "why": "擅长数据建模",\n  "responsibility": "接口和数据库",\n  "not_responsible": "界面设计",\n  "first_deliverable": "数据模型草案",\n  "needed_positions": ["产品经理", "前端", "后端", "测试"],\n}\n```'

    expect(parseTeamClaim(reply)).toEqual({
      firstChoice: '后端工程师',
      secondChoice: '测试工程师',
      why: '擅长数据建模',
      responsibility: '接口和数据库',
      notResponsible: '界面设计',
      firstDeliverable: '数据模型草案',
      neededPositions: ['产品经理', '前端', '后端', '测试'],
    })
    expect(parseTeamClaim('{"职位": "设计师", "第二选择": "设计师", "需要的职位": "设计、开发"}')).toEqual({ firstChoice: '设计师', neededPositions: ['设计', '开发'] })
    expect(parseTeamClaim('我想当产品经理。')).toBeUndefined()
    expect(parseTeamClaim('```json\n{"why": "没有职位"}\n```')).toBeUndefined()
  })

  it('reads positions as names: without the model in brackets or a description after a colon', () => {
    const reply = '```json\n' + JSON.stringify({
      first_choice: '技术架构与全栈开发负责人（DeepSeek）',
      second_choice: '用户反馈与迭代建议负责人（上线后，不替代产品与测试职责）',
      needed_positions: ['测试与质量保障负责人（Kimi）：负责测试计划、测试用例、功能验证、边界条件检查和上线质量评估。', '产品负责人：核心功能定义', '运维。'],
    }) + '\n```'
    expect(parseTeamClaim(reply)).toMatchObject({
      firstChoice: '技术架构与全栈开发负责人',
      // Not a model's name: kept.
      secondChoice: '用户反馈与迭代建议负责人（上线后，不替代产品与测试职责）',
      neededPositions: ['测试与质量保障负责人', '产品负责人：核心功能定义', '运维'],
    })
    expect(cleanPosition('产品经理与项目协调负责人（ChatGPT）')).toBe('产品经理与项目协调负责人')
    expect(cleanPosition('Frontend engineer (Claude)')).toBe('Frontend engineer')
  })

  it('gives everyone their first choice when nobody overlaps', () => {
    const resolution = resolveTeamPositions([
      { roleId: 'a', claim: claim('产品负责人') },
      { roleId: 'b', claim: claim('后端工程师') },
    ])

    expect(resolution.assignments).toEqual({ a: { position: '产品负责人', from: 'first' }, b: { position: '后端工程师', from: 'first' } })
    expect(resolution.conflicts).toEqual([])
  })

  it('moves one of two clashing members to a free second choice', () => {
    const resolution = resolveTeamPositions([
      { roleId: 'a', claim: claim('前端工程师', '测试工程师') },
      { roleId: 'b', claim: claim('前端 工程师', '设计师') },
      { roleId: 'c', claim: claim('设计师') },
    ])

    // b's second choice is c's first choice, so b has nowhere to go and keeps the position.
    expect(resolution.assignments).toEqual({
      a: { position: '测试工程师', from: 'second' },
      b: { position: '前端工程师', from: 'first' },
      c: { position: '设计师', from: 'first' },
    })
    expect(resolution.conflicts).toEqual([])
  })

  it('reports a clash that second choices cannot settle', () => {
    const resolution = resolveTeamPositions([
      { roleId: 'a', claim: claim('架构师') },
      { roleId: 'b', claim: claim('架构师') },
      { roleId: 'c', claim: claim('架构师', '运维') },
    ])

    expect(resolution.conflicts).toEqual([{ position: '架构师', roleIds: ['a', 'b'] }])
    expect(resolution.assignments).toEqual({ c: { position: '运维', from: 'second' } })
  })

  it('keeps a position the user typed and moves claimants away from it', () => {
    const resolution = resolveTeamPositions([
      { roleId: 'a', position: '产品经理' },
      { roleId: 'b', claim: claim('产品经理', '数据分析师') },
      { roleId: 'c', claim: claim('产品经理') },
    ])

    expect(resolution.assignments).toEqual({ a: { position: '产品经理', from: 'first' }, b: { position: '数据分析师', from: 'second' } })
    expect(resolution.conflicts).toEqual([{ position: '产品经理', roleIds: ['c'], holderRoleId: 'a' }])
  })

  it('lets an earlier claim keep the position, and asks only the latecomer to change', () => {
    const resolution = resolveTeamPositions([
      { roleId: 'a', claim: claim('产品负责人', '测试工程师'), claimOrder: 0 },
      { roleId: 'b', claim: claim('产品负责人'), claimOrder: 1 },
      { roleId: 'c', claim: claim('产品负责人', '设计师'), claimOrder: 1 },
    ])

    expect(resolution.assignments).toEqual({ a: { position: '产品负责人', from: 'first' }, c: { position: '设计师', from: 'second' } })
    expect(resolution.conflicts).toEqual([{ position: '产品负责人', roleIds: ['b'], holderRoleId: 'a' }])
  })

  it('lists positions the task needs that nobody holds, required ones first', () => {
    const resolution = resolveTeamPositions([
      { roleId: 'a', claim: claim('前端开发', undefined, ['前端', '后端', '测试']) },
      { roleId: 'b', claim: claim('后端工程师', undefined, ['后端', '测试', '运维']) },
    ], ['安全审计'])

    expect(resolution.uncovered).toEqual([
      { position: '安全审计', mentions: 0, required: true },
      { position: '测试', mentions: 2, required: false },
      { position: '运维', mentions: 1, required: false },
    ])
  })

  it('writes the invitation with the team, required and taken positions, and the reply format', () => {
    const invitation = buildTeamInvitation({
      task: '做一个记账小程序',
      teamLabels: ['Claude ×2', 'Kimi'],
      requiredPositions: ['测试'],
      taken: [{ position: '产品负责人', holder: 'Claude' }],
      open: ['测试', '后端'],
      language: 'zh-CN',
    })

    expect(invitation).toContain('做一个记账小程序')
    expect(invitation).toContain('团队成员：Claude ×2、Kimi')
    expect(invitation).toContain('团队必须有的职位：测试。')
    expect(invitation).toContain('这些职位已经有人了。请选一个职责和它们不重叠的职位（名字不同但做同样的事，也算重叠）：\n- 产品负责人（Claude）')
    expect(invitation).toContain('团队还缺这些职位（优先从中选）：测试、后端。')
    expect(invitation).toContain('"second_choice"')
    expect(invitation).toContain('"needed_positions"')
    expect(buildTeamInvitation({ task: 'Ship it', teamLabels: ['Claude'], requiredPositions: [], repick: true, language: 'en' })).toMatch(/^Some of you picked the same position/)
  })

  it('turns a claim into a persona, member names and the kickoff message', () => {
    const own = { ...claim('后端工程师', '运维'), responsibility: '接口', notResponsible: '界面', firstDeliverable: '数据模型' }
    expect(buildTeamBrief('后端 工程师', own, 'zh-CN')).toEqual({
      description: '接口',
      persona: '你在这个项目中担任「后端 工程师」，这是你自己在组队时选的职位。\n你负责：接口\n你不负责：界面\n你会先交付：数据模型',
      responsibility: '接口',
    })
    // What it wrote is about the backend, so a member moved to its fallback gets the position alone.
    expect(buildTeamBrief('运维', own, 'zh-CN')).toEqual({ description: '运维', persona: '你在这个项目中担任「运维」，这是你的第二选择：「后端工程师」已经有人了。请按这个职位安排你的工作。' })
    expect(buildTeamBrief('安全', own, 'zh-CN').persona).toBe('你在这个项目中担任「安全」，这是组队时用户给你定的职位。请按这个职位安排你的工作。')
    expect(teamMemberNames([{ roleId: 'a', position: '前端' }, { roleId: 'b', position: '前端 ' }, { roleId: 'c', position: '' }, { roleId: 'd', position: 'QA @ lead' }])).toEqual({ a: '前端', b: '前端2', c: 'member', d: 'QAlead' })
    expect(buildTeamKickoff({ task: '做记账', members: [{ name: '前端', modelLabel: 'Kimi', responsibility: '页面' }], language: 'zh-CN' }))
      .toBe('@所有人 分工已经确定，开始工作吧。\n\n任务：\n做记账\n\n分工：\n- 前端（Kimi）：页面\n\n请先完成你说的第一份交付。需要别人配合时，直接点名对方。')
    expect(splitPositions('测试，运维、 测试; 安全')).toEqual(['测试', '运维', '安全'])
  })

  it('names members after positions around the names the user gave, and puts a named member\'s position first', () => {
    expect(teamMemberNames([{ roleId: 'a', position: '前端' }, { roleId: 'b', position: '设计' }, { roleId: 'c', position: '所有人' }], ['前端', '小D'])).toEqual({ a: '前端2', b: '设计', c: 'member' })
    const named = { name: '小D', userNamed: true, teamPosition: '产品经理' }
    expect(teamMemberResponsibility(named, '需求文档', 'zh-CN')).toBe('产品经理：需求文档')
    expect(teamMemberResponsibility(named, '需求文档', 'en')).toBe('产品经理: 需求文档')
    expect(teamMemberResponsibility(named, '产品经理', 'zh-CN')).toBe('产品经理')
    expect(teamMemberResponsibility(named, undefined, 'zh-CN')).toBe('产品经理')
    expect(teamMemberResponsibility({ name: '产品经理', teamPosition: '产品经理' }, '需求文档', 'zh-CN')).toBe('需求文档')
  })

  it('collects each member\'s latest answer and where it stands', () => {
    const store = createDefaultStore()
    store.settings.language = 'zh-CN'
    for (const [id, site] of [['r1', 'claude'], ['r2', 'chatgpt'], ['r3', 'claude'], ['r4', 'kimi']] as const) {
      store.rolesById[id] = { id, chatId: 'c1', name: site, status: 'ready', contextCursor: 0, chatSite: site, createdAt: 1, updatedAt: 1 }
    }
    const messages: GroupMessage[] = [
      { id: 'inv1', chatId: 'c1', seq: 1, type: 'user', content: '邀请', targetRoleIds: ['r1', 'r2', 'r4'], createdAt: 1, status: 'pending', deliveryStatus: { r1: 'received', r2: 'received', r4: 'error' } },
      { id: 'a1', chatId: 'c1', seq: 2, type: 'assistant', roleId: 'r1', sourceMessageId: 'inv1', content: '```json\n{"first_choice":"产品负责人"}\n```', createdAt: 2, status: 'received' },
      { id: 'a2', chatId: 'c1', seq: 3, type: 'assistant', roleId: 'r2', sourceMessageId: 'inv1', content: '我想做前端', createdAt: 3, status: 'received' },
    ]
    store.chatsById.c1 = {
      id: 'c1', name: '记账', mode: 'collaborative', roleIds: ['r1', 'r2', 'r3', 'r4'], messageIds: messages.map(message => message.id), nextMessageSeq: 4, status: 'ready', createdAt: 1, updatedAt: 1,
      teamFormation: { task: '记账', requiredPositions: [], status: 'claiming', rounds: [['r1', 'r2', 'r4'], ['r3']], nextRound: 1, invitationIds: ['inv1'], createdAt: 1 },
    }
    for (const message of messages) store.messagesById[message.id] = message

    const members = collectTeamMembers(store, store.chatsById.c1)

    expect(members.map(member => [member.roleId, member.modelLabel, member.status, member.claim?.firstChoice ?? member.replyText ?? null])).toEqual([
      ['r1', 'Claude', 'claimed', '产品负责人'],
      ['r2', 'ChatGPT', 'unreadable', '我想做前端'],
      ['r3', 'Claude', 'not-invited', null],
      ['r4', 'Kimi', 'failed', null],
    ])
    expect(teamLabels(store, Object.values(store.rolesById))).toEqual(['Claude ×2', 'ChatGPT', 'Kimi'])
  })

  it('saves a team as its members\' positions, personas and models, and reads saved teams back safely', () => {
    const store = createDefaultStore()
    store.rolesById.r1 = { id: 'r1', chatId: 'c1', name: '产品负责人', description: '需求', systemPrompt: '你担任产品负责人', status: 'ready', contextCursor: 0, chatSite: 'claude', createdAt: 1, updatedAt: 1 }
    store.rolesById.r2 = { id: 'r2', chatId: 'c1', name: '后端工程师', status: 'ready', contextCursor: 0, modelSource: 'external', externalModelId: 'm1', createdAt: 1, updatedAt: 1 }
    store.chatsById.c1 = { id: 'c1', name: '记账', mode: 'collaborative', roleIds: ['r1', 'r2'], messageIds: [], nextMessageSeq: 1, status: 'ready', createdAt: 1, updatedAt: 1, teamFormation: { task: '做记账', requiredPositions: [], status: 'confirmed', rounds: [['r1', 'r2']], nextRound: 1, invitationIds: [], createdAt: 1 } }

    const template = teamTemplateFromChat(store, store.chatsById.c1, '  ', 'team-1', 9)

    expect(template).toEqual({ id: 'team-1', name: '记账', task: '做记账', createdAt: 9, members: [
      { name: '产品负责人', description: '需求', systemPrompt: '你担任产品负责人', modelSource: 'site', chatSite: 'claude' },
      { name: '后端工程师', modelSource: 'external', externalModelId: 'm1' },
    ] })
    expect(normalizeTeamTemplates([template, { id: 'bad', name: 'x', members: [{ name: 'a', modelSource: 'site', chatSite: 'nope' }] }, 'junk'])).toEqual([template])
    expect(normalizeTeamTemplates(undefined)).toEqual([])
  })

  it('keeps the names and avatars the user gave members in a saved team, and drops unsafe ones when reading it back', () => {
    const png = 'data:image/png;base64,iVBORw0KGgo='
    const store = createDefaultStore()
    store.rolesById.r1 = { id: 'r1', chatId: 'c1', name: '小D', userNamed: true, teamPosition: '产品负责人', avatarColor: 'tone-2', avatarText: 'D', avatarImage: png, status: 'ready', contextCursor: 0, chatSite: 'claude', createdAt: 1, updatedAt: 1 }
    store.rolesById.r2 = { id: 'r2', chatId: 'c1', name: '后端工程师', avatarColor: '#123456', status: 'ready', contextCursor: 0, chatSite: 'kimi', createdAt: 1, updatedAt: 1 }
    store.chatsById.c1 = { id: 'c1', name: '记账', mode: 'collaborative', roleIds: ['r1', 'r2'], messageIds: [], nextMessageSeq: 1, status: 'ready', createdAt: 1, updatedAt: 1 }

    const template = teamTemplateFromChat(store, store.chatsById.c1, '记账', 'team-1', 9)

    expect(template.members).toEqual([
      { name: '小D', modelSource: 'site', chatSite: 'claude', avatarColor: 'tone-2', avatarText: 'D', avatarImage: png, userNamed: true, teamPosition: '产品负责人' },
      { name: '后端工程师', modelSource: 'site', chatSite: 'kimi' },
    ])
    expect(normalizeTeamTemplates([template])).toEqual([template])
    const tampered = { ...template, members: template.members.map(member => ({ ...member, avatarImage: 'https://tracker.test/a.png', avatarText: '太长的字', userNamed: 'yes' })) }
    expect(normalizeTeamTemplates([tampered])[0].members[0]).toEqual({ name: '小D', modelSource: 'site', chatSite: 'claude', avatarColor: 'tone-2', teamPosition: '产品负责人' })
  })

  it('asks the planner for a flow that keeps the team as it is', () => {
    expect(buildTeamFlowInstruction([{ name: '产品负责人', modelLabel: 'Claude', description: '需求' }, { name: '前端', modelLabel: 'Kimi', description: '前端' }], 'en')).toBe([
      'Use only the 2 existing people in this chat. They have already divided the work by position:',
      '- 产品负责人 (Claude): 需求',
      '- 前端 (Kimi)',
      'Do not create new people and do not change their personas. Give each node to the person whose position fits it, let work that depends on other work wait for it, and end with a review by the person best placed to judge the result.',
    ].join('\n'))
    expect(buildTeamInvitation({ task: 'Phase two', teamLabels: ['Claude'], requiredPositions: [], previous: [{ position: 'PM', holder: 'Claude' }], language: 'en' })).toContain('This is a new phase. The positions so far (keep yours or change it):\n- PM (Claude)')
  })

  it('accepts only a well-formed formation', () => {
    expect(readTeamFormation({ task: '  ' }, 5)).toBeUndefined()
    expect(readTeamFormation({ task: '记账', rounds: [['r1', 3], []], nextRound: 9, requiredPositions: ['测试', '测试 '], status: 'weird' }, 5)).toEqual({
      task: '记账', requiredPositions: ['测试'], status: 'checking', rounds: [['r1']], nextRound: 1, invitationIds: [], createdAt: 5,
    })
    expect(readTeamFormation({ task: '记账', preset: true, previousPositions: [{ position: 'PM', holder: 'Claude' }, { position: 3 }], confirmedAt: null }, 5)).toMatchObject({ preset: true, previousPositions: [{ position: 'PM', holder: 'Claude' }] })
    expect(readTeamFormation({ task: '记账', preset: false, confirmedAt: null }, 5)).not.toHaveProperty('preset')
  })
})
