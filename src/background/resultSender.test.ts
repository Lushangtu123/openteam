import { describe, expect, it, vi } from 'vitest'
import { createDefaultStore } from '../group/store'
import type { GroupMessage, OpenTeamStore } from '../group/types'
import { createResultSender } from './resultSender'

const NOW = new Date(2026, 10, 20, 9, 5).getTime()
const WECOM = 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=k'

function setup(options: { roundSummary?: boolean; answered?: number; access?: boolean; reply?: { status: number; body: string } } = {}) {
  let store: OpenTeamStore = createDefaultStore()
  store.settings.language = 'zh-CN'
  if (options.roundSummary === false) store.settings.roundSummary = false
  store.settings.resultDestinations = [{ id: 'd1', kind: 'wecom', name: '晨报群', url: WECOM, createdAt: 1 }]
  store.chatsById.c = { id: 'c', name: '晨报', mode: 'collaborative', roleIds: ['a', 'b'], messageIds: [], nextMessageSeq: 1, status: 'ready', createdAt: 0, updatedAt: 0, scheduledTasks: [{ id: 't', content: '@所有人 总结', days: [1, 2, 3, 4, 5], time: '09:00', enabled: true, armedAt: 0, destinationId: 'd1', lastRun: { at: NOW, status: 'sent', messageId: 'q' }, createdAt: 0, updatedAt: 0 }] }
  store.chatOrder = ['c']
  const add = (message: Partial<GroupMessage> & Pick<GroupMessage, 'id' | 'type' | 'content'>) => {
    store.messagesById[message.id] = { chatId: 'c', seq: store.chatsById.c.messageIds.length + 1, createdAt: NOW, status: 'received', ...message } as GroupMessage
    store.chatsById.c.messageIds.push(message.id)
  }
  const answered = options.answered ?? 2
  add({ id: 'q', type: 'user', content: '@所有人 总结', targetRoleIds: ['a', 'b'], scheduledTaskId: 't', deliveryStatus: { a: answered >= 1 ? 'received' : 'pending', b: answered >= 2 ? 'received' : 'pending' } })
  add({ id: 'ra', type: 'assistant', roleId: 'a', roleName: '分析师', content: '一、模型发布', sourceMessageId: 'q' })
  if (answered >= 2) add({ id: 'rb', type: 'assistant', roleId: 'b', roleName: '记者', content: '二、芯片', sourceMessageId: 'q' })

  const fetch = vi.fn(async (_url: string, _init: RequestInit) => new Response(options.reply?.body ?? '{"errcode":0,"errmsg":"ok"}', { status: options.reply?.status ?? 200 }))
  // Stands for the wait for a round's summary; the test adds the summary while it waits, if it likes.
  let duringWait = () => {}
  const wait = vi.fn(async () => { duringWait() })
  const broadcastStoreUpdated = vi.fn()
  const sender = createResultSender({
    loadStore: async () => structuredClone(store),
    mutateStore: async <T>(mutator: (current: OpenTeamStore) => T | Promise<T>) => {
      const next = structuredClone(store)
      const result = await mutator(next)
      store = next
      return { store, result }
    },
    broadcastStoreUpdated,
    fetch,
    hasAccess: async () => options.access !== false,
    now: () => NOW,
    wait,
    newId: prefix => `${prefix}-1`,
    log: { warn: vi.fn() },
  })
  const settle = (promptId: string) => sender.onPromptSettled(structuredClone(store), 'c', promptId)
  const delivery = () => store.chatsById.c.scheduledTasks![0].lastRun?.delivery
  return { sender, settle, fetch, wait, delivery, add, store: () => store, onWait: (run: () => void) => { duringWait = run }, broadcastStoreUpdated }
}

const sentText = (fetch: ReturnType<typeof setup>['fetch'], call = 0) => JSON.parse(String(fetch.mock.calls[call][1].body)).markdown.content as string

describe('a scheduled task\'s result', () => {
  it('is sent once every member has answered, when no summary is coming, and the run says so', async () => {
    const { settle, fetch, delivery } = setup({ roundSummary: false })
    await settle('q')
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(fetch.mock.calls[0][0]).toBe(WECOM)
    expect(fetch.mock.calls[0][1]).toMatchObject({ method: 'POST', headers: { 'content-type': 'application/json' }, credentials: 'omit' })
    expect(sentText(fetch)).toContain('**分析师**\n一、模型发布')
    expect(delivery()).toEqual({ status: 'sent', at: NOW, destination: '晨报群' })
    // A second report of the same round sends nothing more.
    await settle('q')
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('is not sent before every member has answered, or for a message no task sent', async () => {
    const early = setup({ answered: 1 })
    await early.settle('q')
    expect(early.fetch).not.toHaveBeenCalled()
    const other = setup({ roundSummary: false })
    other.store().chatsById.c.scheduledTasks![0].destinationId = undefined
    await other.settle('q')
    expect(other.fetch).not.toHaveBeenCalled()
  })

  it('waits for the round\'s summary and sends it, when the group sums rounds up', async () => {
    const { settle, fetch, wait, add, onWait, delivery } = setup()
    onWait(() => add({ id: 'sq', type: 'user', content: '请汇总', targetRoleIds: ['a'], roundSummaryOf: 'q', status: 'pending' }))
    await settle('q')
    expect(wait).toHaveBeenCalledWith(20_000)
    // The summary was asked for: its answer is what is sent.
    expect(fetch).not.toHaveBeenCalled()
    add({ id: 'sr', type: 'assistant', roleId: 'a', roleName: '分析师', content: '**共识**\n- 模型发布', sourceMessageId: 'sq' })
    await settle('sq')
    expect(sentText(fetch)).toContain('**汇总（分析师）**\n**共识**\n- 模型发布')
    expect(sentText(fetch)).toContain('回答了：分析师、记者')
    expect(delivery()?.status).toBe('sent')
  })

  it('sends the answers when no summary was asked for after all', async () => {
    const { settle, fetch, wait } = setup()
    await settle('q')
    expect(wait).toHaveBeenCalled()
    expect(sentText(fetch)).toContain('**记者**\n二、芯片')
  })

  it('records why it could not be sent: the service refused it, or OpenTeam may not reach it', async () => {
    const refused = setup({ roundSummary: false, reply: { status: 200, body: '{"errcode":93000,"errmsg":"invalid webhook url"}' } })
    await refused.settle('q')
    expect(refused.delivery()).toEqual({ status: 'failed', at: NOW, destination: '晨报群', detail: 'invalid webhook url（93000）' })
    const blocked = setup({ roundSummary: false, access: false })
    await blocked.settle('q')
    expect(blocked.fetch).not.toHaveBeenCalled()
    expect(blocked.delivery()).toMatchObject({ status: 'failed', detail: '没有访问 qyapi.weixin.qq.com 的权限：点定时任务窗口里推送地址旁的「测试」，或定时自检的「测试推送」，重新允许' })
  })
})

describe('the destinations', () => {
  it('are added, tested with a message, and deleted (tasks using one send nowhere after)', async () => {
    const { sender, fetch, store } = setup()
    const add = sender.routes.find(route => route.type === 'RESULT_DESTINATION_ADD')!
    await add.handler({ type: 'RESULT_DESTINATION_ADD', destination: { kind: 'feishu', name: '飞书', url: 'https://open.feishu.cn/open-apis/bot/v2/hook/x' } }, {})
    expect(store().settings.resultDestinations?.map(item => item.name)).toEqual(['晨报群', '飞书'])

    const test = sender.routes.find(route => route.type === 'RESULT_DESTINATION_TEST')!
    await test.handler({ type: 'RESULT_DESTINATION_TEST', destinationId: 'd1' }, {})
    expect(sentText(fetch)).toContain('能看到这条，定时任务的结果就会发到这里。')

    const remove = sender.routes.find(route => route.type === 'RESULT_DESTINATION_DELETE')!
    await remove.handler({ type: 'RESULT_DESTINATION_DELETE', destinationId: 'd1' }, {})
    expect(store().settings.resultDestinations?.map(item => item.id)).toEqual(['result-destination-1'])
    expect(store().chatsById.c.scheduledTasks![0].destinationId).toBeUndefined()
  })

  it('sends 定时自检\'s report to a destination by its id, and lets it go nowhere once deleted', async () => {
    const { sender, fetch, store } = setup()
    store().settings.siteCheckSchedule = { days: [1], time: '09:00', enabled: true, armedAt: 0, destinationId: 'd1' }
    const report = { chatName: '网站自检', schedule: '每周一 09:00', question: '7 个网站里有 1 个需要处理，其余正常。', answers: [{ member: 'Kimi', text: '没读到回复', failed: true }] }
    expect(await sender.sendTo('d1', report, false)).toEqual({ destination: '晨报群' })
    expect(sentText(fetch)).toContain('7 个网站里有 1 个需要处理')
    expect(await sender.sendTo('nosuch', report, false)).toBeUndefined()
    await sender.routes.find(route => route.type === 'RESULT_DESTINATION_DELETE')!.handler({ type: 'RESULT_DESTINATION_DELETE', destinationId: 'd1' }, {})
    expect(store().settings.siteCheckSchedule?.destinationId).toBeUndefined()
  })

  it('says why a test did not arrive', async () => {
    const { sender } = setup({ reply: { status: 200, body: '{"errcode":93000,"errmsg":"invalid webhook url"}' } })
    const test = sender.routes.find(route => route.type === 'RESULT_DESTINATION_TEST')!
    await expect(test.handler({ type: 'RESULT_DESTINATION_TEST', destinationId: 'd1' }, {})).rejects.toThrow('没发出去：invalid webhook url（93000）')
  })
})
