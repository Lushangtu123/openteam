import { createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { buildSendRequest, collectRoundResult, normalizeResultDestinations, readDestinationInput, readSendResponse, type ResultDestination, type RoundResult } from './resultDestinations'
import { createDefaultStore } from './store'
import type { GroupMessage, OpenTeamStore } from './types'

const NOW = new Date(2026, 10, 20, 9, 5).getTime()

describe('a destination as entered', () => {
  it('takes each kind\'s own address, and any https address for a plain webhook', () => {
    expect(readDestinationInput({ kind: 'feishu', name: ' 晨报群 ', url: 'https://open.feishu.cn/open-apis/bot/v2/hook/abc', secret: ' s1 ' })).toEqual({ kind: 'feishu', name: '晨报群', url: 'https://open.feishu.cn/open-apis/bot/v2/hook/abc', secret: 's1' })
    expect(readDestinationInput({ kind: 'feishu', name: '', url: 'https://open.larksuite.com/open-apis/bot/v2/hook/abc' })).toEqual({ kind: 'feishu', name: '飞书群机器人', url: 'https://open.larksuite.com/open-apis/bot/v2/hook/abc' })
    expect(readDestinationInput({ kind: 'wecom', url: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=k' }).name).toBe('企业微信群机器人')
    expect(readDestinationInput({ kind: 'dingtalk', url: 'https://oapi.dingtalk.com/robot/send?access_token=t', secret: 'SEC' }).secret).toBe('SEC')
    expect(readDestinationInput({ kind: 'webhook', url: 'https://hooks.example.com/openteam' }).name).toBe('通用 Webhook')
  })

  it('refuses an address that is not that kind\'s, or not https', () => {
    expect(() => readDestinationInput({ kind: 'feishu', url: 'https://example.com/hook' })).toThrow('飞书机器人的地址应以 https://open.feishu.cn/open-apis/bot/v2/hook/ 开头')
    expect(() => readDestinationInput({ kind: 'wecom', url: 'https://qyapi.weixin.qq.com/other' })).toThrow('企业微信机器人的地址应以 https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key= 开头')
    expect(() => readDestinationInput({ kind: 'dingtalk', url: 'http://oapi.dingtalk.com/robot/send?access_token=t' })).toThrow('钉钉机器人的地址应以 https://oapi.dingtalk.com/robot/send?access_token= 开头')
    expect(() => readDestinationInput({ kind: 'webhook', url: 'http://hooks.example.com/x' })).toThrow('Webhook 地址要以 https:// 开头')
    expect(() => readDestinationInput({ kind: 'email', url: 'https://x' })).toThrow('不认识这种推送方式')
  })

  it('keeps only well-formed destinations when loaded', () => {
    const kept: ResultDestination = { id: 'd1', kind: 'wecom', name: '群', url: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=k', createdAt: 1 }
    expect(normalizeResultDestinations([kept, { id: 'd2', kind: 'nope', name: 'x', url: 'https://x', createdAt: 1 }, 'junk'])).toEqual([kept])
    // A backup without keys keeps the destination, without its address.
    expect(normalizeResultDestinations([{ ...kept, url: '' }])).toEqual([{ ...kept, url: '' }])
  })
})

function roundStore(options: { summary?: boolean; failed?: boolean } = {}): OpenTeamStore {
  const store = createDefaultStore()
  store.settings.language = 'zh-CN'
  store.chatsById.c = { id: 'c', name: '晨报', mode: 'collaborative', roleIds: ['a', 'b'], messageIds: [], nextMessageSeq: 1, status: 'ready', createdAt: 0, updatedAt: 0, scheduledTasks: [{ id: 't', content: '@所有人 总结今天的 AI 新闻', days: [1, 2, 3, 4, 5], time: '09:00', enabled: true, armedAt: 0, createdAt: 0, updatedAt: 0 }] }
  store.chatOrder = ['c']
  const add = (message: Partial<GroupMessage> & Pick<GroupMessage, 'id' | 'type' | 'content'>) => {
    store.messagesById[message.id] = { chatId: 'c', seq: store.chatsById.c.messageIds.length + 1, createdAt: NOW, status: 'received', ...message } as GroupMessage
    store.chatsById.c.messageIds.push(message.id)
  }
  add({ id: 'q', type: 'user', content: '@所有人 总结今天的 AI 新闻', targetRoleIds: ['a', 'b'], scheduledTaskId: 't' })
  add({ id: 'ra', type: 'assistant', roleId: 'a', roleName: '分析师', content: '一、模型发布\n二、融资', sourceMessageId: 'q' })
  add({ id: 'rb', type: 'assistant', roleId: 'b', roleName: '记者', content: options.failed ? '回复失败：超时' : '今天最重要的是芯片出口。', sourceMessageId: 'q', status: options.failed ? 'error' : 'received' })
  if (options.summary) {
    add({ id: 'sq', type: 'user', content: '请汇总', targetRoleIds: ['a'], roundSummaryOf: 'q' })
    add({ id: 'sr', type: 'assistant', roleId: 'a', roleName: '分析师', content: '**共识**\n- 模型发布最重要', sourceMessageId: 'sq' })
  }
  return store
}

describe('a scheduled round\'s result', () => {
  it('is the group, the task, the question and each member\'s answer, and the summary when there is one', () => {
    expect(collectRoundResult(roundStore(), 'c', 'q', false)).toEqual({
      chatName: '晨报',
      schedule: '工作日 09:00',
      question: '@所有人 总结今天的 AI 新闻',
      answers: [{ member: '分析师', text: '一、模型发布\n二、融资' }, { member: '记者', text: '今天最重要的是芯片出口。' }],
    })
    expect(collectRoundResult(roundStore({ summary: true, failed: true }), 'c', 'q', false)).toMatchObject({
      answers: [{ member: '分析师', text: '一、模型发布\n二、融资' }, { member: '记者', text: '', failed: true }],
      summary: { member: '分析师', text: '**共识**\n- 模型发布最重要' },
    })
  })
})

const result: RoundResult = {
  chatName: '晨报',
  schedule: '工作日 09:00',
  question: '@所有人 总结今天的 AI 新闻',
  answers: [{ member: '分析师', text: '一、模型发布' }, { member: '记者', text: '', failed: true }],
}
const withSummary: RoundResult = { ...result, summary: { member: '分析师', text: '**共识**\n- 模型发布最重要' } }
const destination = (kind: ResultDestination['kind'], fields: Partial<ResultDestination> = {}): ResultDestination => ({ id: 'd', kind, name: 'n', url: { feishu: 'https://open.feishu.cn/open-apis/bot/v2/hook/abc', wecom: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=k', dingtalk: 'https://oapi.dingtalk.com/robot/send?access_token=t', webhook: 'https://hooks.example.com/x' }[kind], createdAt: 1, ...fields })

describe('what is sent', () => {
  it('is the summary when there is one, with who answered; otherwise every answer', async () => {
    const summarised = JSON.parse((await buildSendRequest(destination('wecom'), withSummary, NOW, false)).body)
    expect(summarised).toEqual({ msgtype: 'markdown', markdown: { content: '**「晨报」定时任务**（工作日 09:00）\n> @所有人 总结今天的 AI 新闻\n\n**汇总（分析师）**\n**共识**\n- 模型发布最重要\n\n回答了：分析师；没回答：记者' } })
    const answers = JSON.parse((await buildSendRequest(destination('wecom'), result, NOW, false)).body)
    expect(answers.markdown.content).toBe('**「晨报」定时任务**（工作日 09:00）\n> @所有人 总结今天的 AI 新闻\n\n**分析师**\n一、模型发布\n\n**记者**\n（没有回答）')
  })

  it('is plain text for Feishu, signed when it has a secret', async () => {
    const request = await buildSendRequest(destination('feishu', { secret: 'sec' }), withSummary, NOW, false)
    const body = JSON.parse(request.body)
    const timestamp = String(Math.floor(NOW / 1000))
    expect(request.url).toBe('https://open.feishu.cn/open-apis/bot/v2/hook/abc')
    expect(body).toEqual({
      timestamp,
      sign: createHmac('sha256', `${timestamp}\nsec`).update('').digest('base64'),
      msg_type: 'text',
      content: { text: '「晨报」定时任务（工作日 09:00）\n问题：@所有人 总结今天的 AI 新闻\n\n汇总（分析师）\n**共识**\n- 模型发布最重要\n\n回答了：分析师；没回答：记者' },
    })
    expect(JSON.parse((await buildSendRequest(destination('feishu'), result, NOW, false)).body).sign).toBeUndefined()
  })

  it('is Markdown for DingTalk, with its signature in the address', async () => {
    const request = await buildSendRequest(destination('dingtalk', { secret: 'SEC' }), result, NOW, false)
    const sign = encodeURIComponent(createHmac('sha256', 'SEC').update(`${NOW}\nSEC`).digest('base64'))
    expect(request.url).toBe(`https://oapi.dingtalk.com/robot/send?access_token=t&timestamp=${NOW}&sign=${sign}`)
    expect(JSON.parse(request.body)).toMatchObject({ msgtype: 'markdown', markdown: { title: '「晨报」定时任务' } })
  })

  it('is the whole result as JSON for a plain webhook', async () => {
    expect(JSON.parse((await buildSendRequest(destination('webhook'), withSummary, NOW, false)).body)).toEqual({
      source: 'openteam',
      group: '晨报',
      schedule: '工作日 09:00',
      question: '@所有人 总结今天的 AI 新闻',
      summary: { member: '分析师', text: '**共识**\n- 模型发布最重要' },
      answers: [{ member: '分析师', text: '一、模型发布', status: 'answered' }, { member: '记者', text: '', status: 'failed' }],
      sentAt: new Date(NOW).toISOString(),
    })
  })

  it('is shortened to fit WeCom\'s 4096 bytes, saying the rest is in OpenTeam', async () => {
    const long: RoundResult = { ...result, answers: [{ member: '甲', text: '长'.repeat(3000) }, { member: '乙', text: '文'.repeat(3000) }] }
    const content = JSON.parse((await buildSendRequest(destination('wecom'), long, NOW, false)).body).markdown.content as string
    expect(new TextEncoder().encode(content).length).toBeLessThanOrEqual(4096)
    expect(content).toContain('**甲**')
    expect(content).toContain('**乙**')
    expect(content).toContain('…（完整内容在 OpenTeam 里）')
  })
})

describe('the destination\'s answer', () => {
  it('counts as sent only when the service says so', () => {
    expect(readSendResponse('feishu', 200, '{"code":0,"msg":"success"}')).toBeUndefined()
    expect(readSendResponse('feishu', 200, '{"code":19021,"msg":"sign match fail or timestamp is not within one hour from current time"}')).toBe('sign match fail or timestamp is not within one hour from current time（19021）')
    expect(readSendResponse('wecom', 200, '{"errcode":0,"errmsg":"ok"}')).toBeUndefined()
    expect(readSendResponse('dingtalk', 200, '{"errcode":310000,"errmsg":"keywords not in content"}')).toBe('keywords not in content（310000）')
    expect(readSendResponse('webhook', 204, '')).toBeUndefined()
    expect(readSendResponse('webhook', 500, 'boom')).toBe('HTTP 500')
  })
})
