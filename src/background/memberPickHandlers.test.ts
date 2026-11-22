import { describe, expect, it, vi } from 'vitest'
import { createDefaultStore } from '../group/store'
import type { OpenTeamStore } from '../group/types'
import { createMemberPickHandlers, MEMBER_PICK_ROUTE_TYPES } from './memberPickHandlers'

function setup(answers: string[], fields: (store: OpenTeamStore) => void = () => undefined) {
  const store = createDefaultStore()
  store.settings.language = 'zh-CN'
  store.settings.externalModelOrder = ['api']
  store.settings.externalModelsById = { api: { id: 'api', name: 'Gemini', format: 'openai', baseUrl: 'https://x', apiKey: 'k', modelName: 'g', createdAt: 1, updatedAt: 1 } }
  store.chatsById.c = { id: 'c', name: '群', mode: 'collaborative', roleIds: ['r1'], messageIds: [], nextMessageSeq: 1, status: 'ready', createdAt: 1, updatedAt: 1 }
  store.rolesById.r1 = { id: 'r1', chatId: 'c', name: '工程师', chatSite: 'deepseek', status: 'ready', contextCursor: 0, createdAt: 1, updatedAt: 1 }
  fields(store)
  const complete = vi.fn(async (_input: { prompt: string }) => ({ content: answers.shift() ?? '' }))
  const warn = vi.fn()
  const [route] = createMemberPickHandlers({ loadStore: async () => store, externalModelClient: { complete: complete as never }, log: { info: vi.fn(), warn } })
  const ask = (fields: Record<string, unknown> = {}) => Promise.resolve(route.handler({ type: 'GROUP_MEMBERS_SUGGEST', chatId: 'c', task: '做一个记账小程序', models: ['site:kimi', 'external:api'], ...fields }, {})) as Promise<Record<string, unknown>>
  return { ask, complete, warn }
}

describe('asking an AI which members to add', () => {
  it('asks the API model with the task and the ticked models, and answers its list', async () => {
    const ctx = setup([JSON.stringify({ members: [{ name: '财务顾问', systemPrompt: '你熟悉记账。', model: 'site:kimi', why: '核对记账规则' }] })])
    expect(MEMBER_PICK_ROUTE_TYPES).toEqual(['GROUP_MEMBERS_SUGGEST'])
    expect(await ctx.ask({ source: 'new' })).toEqual({ ok: true, planner: 'Gemini', picks: [{ kind: 'new', name: '财务顾问', systemPrompt: '你熟悉记账。', model: 'site:kimi', why: '核对记账规则' }] })
    const prompt = ctx.complete.mock.calls[0][0].prompt
    expect(prompt).toContain('做一个记账小程序')
    expect(prompt).toContain('- 工程师')
    expect(prompt).toContain('key=site:kimi')
    expect(prompt).not.toContain('key=site:chatgpt')
  })

  it('asks once more when the answer is not the list, and says why when it still is not', async () => {
    const twice = setup(['我建议加一个财务顾问。', JSON.stringify({ members: [{ name: '财务顾问', systemPrompt: 'x', model: 'site:kimi' }] })])
    expect(await twice.ask()).toMatchObject({ ok: true, picks: [{ name: '财务顾问' }] })
    expect(twice.complete).toHaveBeenCalledTimes(2)
    expect(twice.complete.mock.calls[1][0].prompt).toContain('请只回答 JSON')
    expect(await setup(['不知道', '还是不知道']).ask()).toEqual({ ok: true, error: '模型没有按格式给出成员名单' })
  })

  it('says what is missing: the task, a ticked model, or an API model to plan with', async () => {
    expect(await setup([]).ask({ task: ' ' })).toEqual({ ok: true, error: '先写下要做的事' })
    expect(await setup([]).ask({ models: [] })).toEqual({ ok: true, error: '至少勾选一个可以用的模型' })
    const noApi = setup([], store => { store.settings.externalModelOrder = []; store.settings.externalModelsById = {} })
    expect(await noApi.ask({ models: ['site:kimi'] })).toEqual({ ok: true, error: '让 AI 挑成员需要一个 API 模型：请先在「设置 → 模型」里添加' })
  })
})
