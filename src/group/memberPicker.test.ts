import { describe, expect, it } from 'vitest'
import { buildMemberPickPrompt, latestTaskText, memberPickModels, memberPickPlanners, parseMemberPicks, type MemberPickModel } from './memberPicker'
import { createDefaultStore } from './store'
import type { GroupChat, GroupRole, RoleTemplate } from './types'

const library: RoleTemplate[] = [
  { id: 'pm', type: 'custom', name: '产品经理', description: '关注用户需求、优先级', systemPrompt: '你是产品经理。', createdAt: 1, updatedAt: 1 },
  { id: 'builtin-security', type: 'builtin', name: '安全审计员', description: '找出安全漏洞', systemPrompt: '你是安全审计员。', createdAt: 1, updatedAt: 1 },
]
const models: MemberPickModel[] = [{ key: 'site:deepseek', label: 'DeepSeek' }, { key: 'external:api', label: 'API · Gemini' }]
const engineer: GroupRole = { id: 'r1', chatId: 'c', name: '工程师', description: '负责实现', chatSite: 'deepseek', status: 'ready', contextCursor: 0, createdAt: 1, updatedAt: 1 }

describe('the prompt that asks an AI to pick members for a task', () => {
  it('gives the task, the members there, the library and the models, and the rule for the chosen source', () => {
    const prompt = buildMemberPickPrompt({ task: '做一个记账小程序', members: [engineer], library, models, source: 'library-first', language: 'zh-CN' })
    expect(prompt).toContain('任务:\n做一个记账小程序')
    expect(prompt).toContain('- 工程师: 负责实现')
    expect(prompt).toContain('- id=builtin-security | 安全审计员 | 找出安全漏洞')
    expect(prompt).toContain('- key=external:api | API · Gemini')
    expect(prompt).toContain('优先从角色库里选，用 id。没有合适的再新写')
    expect(prompt).toContain('建议 1 到 6 位成员')
    const fresh = buildMemberPickPrompt({ task: 't', members: [], library, models, source: 'new', count: 3, language: 'zh-CN' })
    expect(fresh).not.toContain('角色库（用 id 选用）')
    expect(fresh).toContain('每个角色都按这个任务新写')
    expect(fresh).toContain('建议 1 到 3 位成员')
    expect(buildMemberPickPrompt({ task: 't', members: [], library, models, source: 'library-only', language: 'en' })).toContain('Pick only from the role library, by id.')
  })

  it('tells how roles did before on the models, when it is known, and to weigh it', () => {
    const lines = ['- 安全审计员（角色库 id=builtin-security）· DeepSeek：6 次回答，留用 4 次']
    const prompt = buildMemberPickPrompt({ task: 't', members: [], library, models, source: 'library-first', records: lines, language: 'zh-CN' })
    expect(prompt).toContain('这些角色以前在这些模型上的表现（来自用户留用或要求重答的回答）:\n- 安全审计员（角色库 id=builtin-security）· DeepSeek：6 次回答，留用 4 次')
    expect(prompt).toContain('用户留用过回答的角色和模型组合更可靠')
    const english = buildMemberPickPrompt({ task: 't', members: [], library, models, source: 'library-first', records: ['- x'], language: 'en' })
    expect(english).toContain('How these roles did before on these models')
    expect(english).toContain('replies the user kept')
    const none = buildMemberPickPrompt({ task: 't', members: [], library, models, source: 'library-first', records: [], language: 'zh-CN' })
    expect(none).not.toContain('以前在这些模型上的表现')
    expect(none).not.toContain('更可靠')
  })
})

describe('reading the members the AI picked', () => {
  const answer = (members: unknown[]) => '好的：\n```json\n' + JSON.stringify({ members }) + '\n```'

  it('keeps library roles by id (or exact name) and new roles with a persona, each with a ticked model', () => {
    const picks = parseMemberPicks(answer([
      { templateId: 'pm', model: 'site:deepseek', why: '把需求理清' },
      { templateId: 'wrong-id', name: '安全审计员', model: 'external:api' },
      { name: '财务 顾问', description: '记账规则', systemPrompt: '你熟悉记账。', model: 'site:chatgpt', why: '核对规则' },
      { name: '没有人设的', model: 'site:deepseek' },
      { templateId: 'pm', model: 'site:deepseek' },
    ]), { library, models, source: 'library-first', takenNames: ['工程师'] })
    expect(picks).toEqual([
      { kind: 'library', templateId: 'pm', name: '产品经理', description: '关注用户需求、优先级', model: 'site:deepseek', why: '把需求理清' },
      { kind: 'library', templateId: 'builtin-security', name: '安全审计员', description: '找出安全漏洞', model: 'external:api' },
      // A model that was not ticked is replaced by one that was.
      { kind: 'new', name: '财务顾问', systemPrompt: '你熟悉记账。', description: '记账规则', model: 'site:deepseek', why: '核对规则' },
    ])
  })

  it('follows the chosen source, numbers a name the group has, and stops at the limit', () => {
    const asNew = parseMemberPicks(answer([{ templateId: 'pm', name: '产品经理', systemPrompt: '新写的人设', model: 'site:deepseek' }]), { library, models, source: 'new', takenNames: ['产品经理'] })
    expect(asNew).toEqual([{ kind: 'new', name: '产品经理2', systemPrompt: '新写的人设', model: 'site:deepseek' }])
    expect(() => parseMemberPicks(answer([{ name: '新角色', systemPrompt: 'x', model: 'site:deepseek' }]), { library, models, source: 'library-only', takenNames: [] })).toThrow('角色库里没有模型挑中的角色')
    const many = Array.from({ length: 9 }, (_, index) => ({ name: `角色${index}`, systemPrompt: 'x', model: 'site:deepseek' }))
    expect(parseMemberPicks(answer(many), { library, models, source: 'new', takenNames: [], count: 2 })).toHaveLength(2)
    expect(() => parseMemberPicks('我觉得可以加一个产品经理', { library, models, source: 'new', takenNames: [] })).toThrow('模型没有按格式给出成员名单')
  })
})

describe('what the window starts with', () => {
  it('offers every site and model, plans with API models only, and starts from the latest thing the user asked', () => {
    const store = createDefaultStore()
    store.settings.externalModelOrder = ['api', 'agent']
    store.settings.externalModelsById = {
      api: { id: 'api', name: 'Gemini', format: 'openai', baseUrl: 'https://x', apiKey: 'k', modelName: 'g', createdAt: 1, updatedAt: 1 },
      agent: { id: 'agent', name: 'Claude Code', format: 'local-agent', baseUrl: '', apiKey: '', modelName: 'cc', localAgentId: 'cc', workspace: '/x', createdAt: 1, updatedAt: 1 },
    }
    expect(memberPickModels(store).map(model => model.key)).toEqual(expect.arrayContaining(['site:kimi', 'external:api', 'external:agent']))
    expect(memberPickModels(store, ['external:api'])).toEqual([{ key: 'external:api', label: 'API · Gemini' }])
    expect(memberPickPlanners(store).map(model => model.id)).toEqual(['api'])
    const chat: GroupChat = { id: 'c', name: '群', mode: 'collaborative', roleIds: [], messageIds: ['m1', 'm2', 'm3'], nextMessageSeq: 4, status: 'ready', createdAt: 1, updatedAt: 1 }
    store.messagesById = {
      m1: { id: 'm1', chatId: 'c', seq: 1, type: 'user', content: '@工程师 做一个记账小程序', createdAt: 1, status: 'received' },
      m2: { id: 'm2', chatId: 'c', seq: 2, type: 'assistant', roleId: 'r1', content: '好的', createdAt: 2, status: 'received' },
      m3: { id: 'm3', chatId: 'c', seq: 3, type: 'user', content: '总结一下', roundSummaryOf: 'm1', createdAt: 3, status: 'received' },
    }
    expect(latestTaskText(store, chat)).toBe('做一个记账小程序')
    expect(latestTaskText(store, { ...chat, messageIds: [], description: '群的说明' })).toBe('群的说明')
  })
})
