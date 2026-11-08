import { describe, expect, it } from 'vitest'
import { misreadReplyReason } from './misreadReply'

describe('misread replies', () => {
  it("takes text with two of OpenTeam's prompt sentences for the prompt, not a reply", () => {
    const prompt = '你正在一个 AI 群聊中。\n群聊成员：……\n请以「工程师」身份回复。请使用中文回复。'
    expect(misreadReplyReason(prompt)).toBe('读到的是 OpenTeam 发给它的提示词')
    // The writing block that got the review prompt typed into it.
    expect(misreadReplyReason('需求文档……请对照完成标准逐条检查这些新结果：t1。……只回复一个 JSON 代码块，格式如下：```json {} ```')).toBe('读到的是 OpenTeam 发给它的提示词')
    expect(misreadReplyReason('You are in an AI group chat.\nReply with only one JSON code block, in this form:')).toBe('读到的是 OpenTeam 发给它的提示词')
  })

  it('accepts a reply that quotes one instruction while it reasons', () => {
    expect(misreadReplyReason('用户要求我只回复一个 JSON 代码块，格式如下：所以我这样写。\n```json\n{"decisions":[]}\n```')).toBeUndefined()
    expect(misreadReplyReason('选 Go：部署简单。')).toBeUndefined()
  })

  it('takes a long reply equal to the previous one for the older turn read again', () => {
    const long = '方案对比：' + '先做原型，再决定要不要重写。'.repeat(20)
    expect(misreadReplyReason(long, long)).toBe('和它上一条回复一模一样')
    expect(misreadReplyReason(long + '\n', ` ${long}`)).toBe('和它上一条回复一模一样')
    // Short answers may well repeat.
    expect(misreadReplyReason('收到。', '收到。')).toBeUndefined()
  })
})
