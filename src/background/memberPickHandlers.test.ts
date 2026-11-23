import { describe, expect, it, vi } from 'vitest'
import { createDefaultStore } from '../group/store'
import type { OpenTeamStore } from '../group/types'
import { createMemberPickHandlers, MEMBER_PICK_ROUTE_TYPES } from './memberPickHandlers'

function setup(answers: Array<string | { content: string; answeredBy?: string } | Error>, fields: (store: OpenTeamStore) => void = () => undefined) {
  const store = createDefaultStore()
  store.settings.language = 'zh-CN'
  store.settings.externalModelOrder = ['api']
  store.settings.externalModelsById = { api: { id: 'api', name: 'Gemini', format: 'openai', baseUrl: 'https://x', apiKey: 'k', modelName: 'g', createdAt: 1, updatedAt: 1 } }
  store.chatsById.c = { id: 'c', name: '群', mode: 'collaborative', roleIds: ['r1'], messageIds: [], nextMessageSeq: 1, status: 'ready', createdAt: 1, updatedAt: 1 }
  store.rolesById.r1 = { id: 'r1', chatId: 'c', name: '工程师', chatSite: 'deepseek', status: 'ready', contextCursor: 0, createdAt: 1, updatedAt: 1 }
  fields(store)
  const complete = vi.fn(async (_input: { prompt: string }) => {
    const next = answers.shift() ?? ''
    if (next instanceof Error) throw next
    return typeof next === 'string' ? { content: next } : next
  })
  const warn = vi.fn()
  const [route] = createMemberPickHandlers({ loadStore: async () => store, externalModelClient: { complete: complete as never }, log: { info: vi.fn(), warn } })
  const ask = (fields: Record<string, unknown> = {}) => Promise.resolve(route.handler({ type: 'GROUP_MEMBERS_SUGGEST', chatId: 'c', task: '做一个记账小程序', models: ['site:kimi', 'external:api'], ...fields }, {})) as Promise<Record<string, unknown>>
  return { ask, complete, warn }
}

function busy(message: string, status: number): Error {
  return Object.assign(new Error(message), { status })
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

  it('tells the planner how roles did before on the ticked models, and answers those records for the window', async () => {
    const history = (store: OpenTeamStore) => {
      store.chatsById.old = { id: 'old', name: '旧群', mode: 'collaborative', roleIds: ['s1', 'w1'], messageIds: [], nextMessageSeq: 1, status: 'ready', createdAt: 1, updatedAt: 1 }
      store.chatOrder.push('old')
      store.rolesById.s1 = { id: 's1', chatId: 'old', name: '芒格', templateId: 'builtin-munger', chatSite: 'kimi', status: 'ready', contextCursor: 0, createdAt: 1, updatedAt: 1 }
      store.rolesById.w1 = { id: 'w1', chatId: 'old', name: '文案', chatSite: 'kimi', status: 'ready', contextCursor: 0, createdAt: 1, updatedAt: 1 }
      for (const [index, roleId] of ['s1', 's1', 's1', 'w1', 'w1', 'w1'].entries()) {
        store.messagesById[`m${index}`] = { id: `m${index}`, chatId: 'old', seq: index + 1, type: 'assistant', roleId, content: '回答', createdAt: 1, status: 'received' }
        store.chatsById.old.messageIds.push(`m${index}`)
      }
      store.messageHighlightsById = { m0: [{ id: 'h', messageId: 'm0', text: '好', startOffset: 0, endOffset: 1, createdAt: 2 }] }
    }
    const answer = JSON.stringify({ members: [{ templateId: 'builtin-munger', model: 'site:kimi' }] })
    const ctx = setup([answer], history)
    const response = await ctx.ask()
    const prompt = ctx.complete.mock.calls[0][0].prompt
    expect(prompt).toContain('· Kimi：3 次回答，留用 1 次')
    expect(prompt).toContain('- 文案 · Kimi：3 次回答，留用 0 次')
    expect(response.records).toEqual(expect.arrayContaining([expect.objectContaining({ templateId: 'builtin-munger', model: 'site:kimi', replies: 3, kept: 1 })]))
    // Roles written fresh are not library roles: the planner is told only about roles by name.
    const fresh = setup([JSON.stringify({ members: [{ name: '新角色', systemPrompt: 'x', model: 'site:kimi' }] })], history)
    await fresh.ask({ source: 'new' })
    expect(fresh.complete.mock.calls[0][0].prompt).not.toContain('id=builtin-munger')
    expect(fresh.complete.mock.calls[0][0].prompt).toContain('- 文案 · Kimi')
    // Nothing on a model not ticked.
    const other = setup([answer], history)
    await other.ask({ models: ['external:api'] })
    expect(other.complete.mock.calls[0][0].prompt).not.toContain('以前在这些模型上的表现')
  })

  it('says when the backup model answered, and what to do when the model is busy or limited', async () => {
    const list = JSON.stringify({ members: [{ name: '财务顾问', systemPrompt: 'x', model: 'site:kimi' }] })
    expect(await setup([{ content: list, answeredBy: 'gemini-lite' }]).ask()).toMatchObject({ ok: true, planner: 'Gemini（备用模型 gemini-lite）' })

    const busyNow = setup([busy('HTTP 503：This model is currently experiencing high demand.', 503)])
    expect(await busyNow.ask({ plannerModelId: 'api' })).toEqual({ ok: true, error: 'HTTP 503：This model is currently experiencing high demand.。可以稍后再试，或在「由哪个模型来挑」里换一个模型。' })
    // Logged, so it can be looked up afterwards.
    expect(busyNow.warn).toHaveBeenCalledWith('member-pick:failed', { chatId: 'c', planner: 'api', reason: 'HTTP 503：This model is currently experiencing high demand.' })
    expect(await setup([busy('Invalid API key', 401)]).ask()).toEqual({ ok: true, error: 'Invalid API key' })
  })

  it('says what is missing: the task, a ticked model, or an API model to plan with', async () => {
    expect(await setup([]).ask({ task: ' ' })).toEqual({ ok: true, error: '先写下要做的事' })
    expect(await setup([]).ask({ models: [] })).toEqual({ ok: true, error: '至少勾选一个可以用的模型' })
    const noApi = setup([], store => { store.settings.externalModelOrder = []; store.settings.externalModelsById = {} })
    expect(await noApi.ask({ models: ['site:kimi'] })).toEqual({ ok: true, error: '让 AI 挑成员需要一个 API 模型：请先在「设置 → 模型」里添加' })
  })
})
