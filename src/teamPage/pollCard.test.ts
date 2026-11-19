// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest'
import type { PollTally } from '../group/poll'
import { renderPollCard } from './pollCard'

function tally(fields: Partial<PollTally> = {}): PollTally {
  const message = { id: 'p1', chatId: 'c', seq: 1, type: 'user' as const, content: '', createdAt: 1, status: 'received' as const }
  return {
    message,
    poll: { question: '选哪个方案？', options: ['方案一', '方案二', '方案三'], round: 1 },
    options: [
      { letter: 'A', text: '方案一', votes: [{ roleId: 'r1', name: '研究员', choice: 0, reason: '便宜' }] },
      { letter: 'B', text: '方案二', votes: [{ roleId: 'r2', name: '校对', choice: 1, reason: '稳' }, { roleId: 'r3', name: '分析师', choice: 1, reason: '' }] },
      { letter: 'C', text: '方案三', votes: [] },
    ],
    invalid: [],
    missing: [],
    waiting: [],
    done: true,
    voted: 3,
    leaders: [1],
    ...fields,
  }
}

describe('a vote\'s card', () => {
  it('shows each option\'s votes and voters, the winner, and everyone\'s reasons', () => {
    const card = renderPollCard(tally(), { english: false })
    expect(card.querySelector('.poll-card-title')?.textContent).toBe('投票结果')
    expect(card.querySelector('.poll-card-progress')?.textContent).toBe('已投 3/3')
    const rows = [...card.querySelectorAll('.poll-card-option')]
    expect(rows.map(row => [row.querySelector('.poll-card-letter')?.textContent, row.querySelector('.poll-card-count')?.textContent, row.querySelector('.poll-card-voters')?.textContent ?? ''])).toEqual([['A', '1 票', '研究员'], ['B', '2 票', '校对、分析师'], ['C', '0 票', '']])
    expect(rows[1].classList.contains('poll-card-leading')).toBe(true)
    expect(rows[1].querySelector<HTMLElement>('.poll-card-bar span')?.style.width).toBe('67%')
    expect(card.querySelector('.poll-card-result')?.textContent).toBe('B. 方案二 胜出')
    expect([...card.querySelectorAll('.poll-card-reasons li')].map(item => item.textContent)).toEqual(['研究员 投 A：便宜', '校对 投 B：稳', '分析师 投 B'])
  })

  it('says it is a tie, and who did not vote in the format or did not answer', () => {
    const card = renderPollCard(tally({ leaders: [0, 1], invalid: [{ roleId: 'r4', name: '工程师' }], missing: [{ roleId: 'r5', name: '设计师' }] }), { english: false })
    expect(card.querySelector('.poll-card-result')?.textContent).toBe('平票：A. 方案一、B. 方案二')
    expect(card.querySelector('.poll-card-note')?.textContent).toBe('没有按格式投票：工程师；没有回答：设计师')
    expect(card.querySelector('.poll-card-progress')?.textContent).toBe('已投 3/5')
  })

  it('shows progress, and no result, while members are still voting', () => {
    const card = renderPollCard(tally({ done: false, waiting: [{ roleId: 'r4', name: '工程师' }] }), { english: false })
    expect(card.querySelector('.poll-card-title')?.textContent).toBe('投票中')
    expect(card.querySelector('.poll-card-result')).toBeNull()
    expect(card.querySelector('.poll-card-leading')).toBeNull()
    expect(card.querySelector('.poll-card-note')?.textContent).toBe('还在投：工程师')
    expect(card.querySelector('.poll-card-revote')).toBeNull()
  })

  it('offers one second round once the first is done', async () => {
    const revote = vi.fn(async () => undefined)
    const button = renderPollCard(tally(), { english: false, revote }).querySelector<HTMLButtonElement>('.poll-card-revote')!
    expect(button.textContent).toBe('再投一轮')
    button.click()
    expect(revote).toHaveBeenCalledTimes(1)
    expect(button.disabled).toBe(true)
    const message = { id: 'p2', chatId: 'c', seq: 2, type: 'user' as const, content: '', createdAt: 2, status: 'received' as const }
    expect(renderPollCard(tally({ secondRound: message }), { english: false, revote }).querySelector('.poll-card-revote')).toBeNull()
  })

  it('in a second round, says who changed their vote', () => {
    const second = tally({ poll: { question: 'q', options: ['x', 'y'], round: 2, of: 'p0' }, options: [
      { letter: 'A', text: 'x', votes: [] },
      { letter: 'B', text: 'y', votes: [{ roleId: 'r1', name: '研究员', choice: 1, reason: '被说服了', previousChoice: 0 }, { roleId: 'r2', name: '校对', choice: 1, reason: '', previousChoice: 1 }] },
    ], voted: 2 })
    const card = renderPollCard(second, { english: false, revote: vi.fn() })
    expect(card.querySelector('.poll-card-round')?.textContent).toBe('第二轮')
    expect([...card.querySelectorAll('.poll-card-reasons li')].map(item => item.textContent)).toEqual(['研究员 投 B（第一轮投 A，改投）：被说服了', '校对 投 B（没有改）'])
    expect(card.querySelector('.poll-card-revote')).toBeNull()
  })

  it('reads in English', () => {
    const card = renderPollCard(tally(), { english: true })
    expect(card.querySelector('.poll-card-result')?.textContent).toBe('B. 方案二 wins')
    expect(card.querySelector('.poll-card-progress')?.textContent).toBe('3 of 3 voted')
  })
})
