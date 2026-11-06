import { describe, expect, it } from 'vitest'
import { extractReplyChoices, replyChoiceAnswer } from './replyChoices'

describe('choices at the end of a reply', () => {
  it('reads lettered options in their common forms', () => {
    expect(extractReplyChoices('嵌页这次有动静吗？\n\nA. 有打字，但群里没回\nB. 还是完全没打字\nC. Apple Events 已勾上，再探')).toEqual([
      { label: 'A', text: '有打字，但群里没回' },
      { label: 'B', text: '还是完全没打字' },
      { label: 'C', text: 'Apple Events 已勾上，再探' },
    ])
    expect(extractReplyChoices('选一个方向：\n- **A）** 先压测\n- **B）** 先灰度\n')).toEqual([{ label: 'A', text: '先压测' }, { label: 'B', text: '先灰度' }])
    expect(extractReplyChoices('Pick one:\n(a) Ship now\n(b) Wait a week')).toEqual([{ label: 'A', text: 'Ship now' }, { label: 'B', text: 'Wait a week' }])
  })

  it('reads numbered options only after a line that asks to choose', () => {
    expect(extractReplyChoices('你想先做哪一步？\n1. 招募用户\n2. 写问卷\n3. 约访谈')).toHaveLength(3)
    expect(extractReplyChoices('我建议先做一轮可用性测试：\n1. 招募 5 位目标用户\n2. 观察他们完成记账的路径\n3. 记录卡住的步骤')).toBeUndefined()
  })

  it('leaves ordinary text, long items, broken sequences and code alone', () => {
    expect(extractReplyChoices('结论：可以上线。')).toBeUndefined()
    expect(extractReplyChoices('A. 只有一个选项')).toBeUndefined()
    expect(extractReplyChoices('选哪个？\nA. 先做\nC. 后做')).toBeUndefined()
    expect(extractReplyChoices(`选哪个？\nA. ${'很长'.repeat(80)}\nB. 短`)).toBeUndefined()
    expect(extractReplyChoices('选择：\nA. 一\nB. 二\n\n以上两种都可以，看你的时间。')).toBeUndefined()
    expect(extractReplyChoices('```\nA. one\nB. two')).toBeUndefined()
  })

  it('words the answer in the chosen language', () => {
    expect(replyChoiceAnswer({ label: 'B', text: '先灰度' }, 'zh-CN')).toBe('我选 B：先灰度')
    expect(replyChoiceAnswer({ label: 'B', text: 'Wait a week' }, 'en')).toBe('I choose B: Wait a week')
  })
})
