// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest'
import { readFactCheck } from '../group/sources'
import type { GroupMessage } from '../group/types'
import { renderFactCheckCard, renderSourcesBlock } from './sourcesView'

function reply(linkChecks: GroupMessage['linkChecks'] = {}): GroupMessage {
  return {
    id: 'a1', chatId: 'c', seq: 2, type: 'assistant', roleId: 'r1', roleName: '研究员', sourceMessageId: 'q', createdAt: 2, status: 'received',
    content: '约 1700 万辆 [1]，增长 25% [2]。电池降价 90%。\n\n来源：\n[1] IEA 报告 https://www.iea.org/report\n[2] https://made-up.example/ev\n[3] https://slow.example/page',
    linkChecks,
  }
}

describe('the sources under an answer', () => {
  it('lists each link with what opening it found, and the claims without a source', () => {
    const block = renderSourcesBlock(reply({
      'https://www.iea.org/report': { status: 'ok', httpStatus: 200, title: 'Global EV Outlook', checkedAt: 1 },
      'https://made-up.example/ev': { status: 'unreachable', checkedAt: 1 },
    }), { english: false })
    const items = [...block.querySelectorAll('.reply-source')]
    expect(items.map(item => [item.querySelector('.reply-source-n')?.textContent, item.querySelector('a')?.textContent, item.querySelector('.reply-source-status')?.textContent])).toEqual([
      ['[1]', 'Global EV Outlook', '能打开'],
      ['[2]', 'made-up.example', '连不上，网站可能不存在'],
      ['[3]', 'slow.example', '检查中'],
    ])
    expect(items.map(item => item.className)).toEqual(['reply-source reply-source-good', 'reply-source reply-source-bad', 'reply-source reply-source-unknown'])
    const link = block.querySelector('a')!
    expect([link.getAttribute('href'), link.target, link.rel]).toEqual(['https://www.iea.org/report', '_blank', 'noopener noreferrer'])
    expect(block.querySelector('.reply-sources-head')?.textContent).toBe('来源 31 个有问题无来源的说法 1')
    expect([...block.querySelectorAll('.reply-sources-unsourced li')].map(item => item.textContent)).toEqual(['电池降价 90%。'])
  })

  it('offers to check closely the links only known to respond, with their sites', async () => {
    const checkClosely = vi.fn(async () => undefined)
    const block = renderSourcesBlock(reply({
      'https://www.iea.org/report': { status: 'reachable', checkedAt: 1 },
      'https://made-up.example/ev': { status: 'unreachable', checkedAt: 1 },
      'https://slow.example/page': { status: 'reachable', checkedAt: 1 },
    }), { english: false, checkClosely })
    const button = block.querySelector<HTMLButtonElement>('.reply-sources-check')!
    expect(button.textContent).toBe('细查链接')
    button.click()
    expect(checkClosely).toHaveBeenCalledWith(expect.objectContaining({ id: 'a1' }), ['https://www.iea.org/report', 'https://slow.example/page'])
    expect(renderSourcesBlock(reply({ 'https://www.iea.org/report': { status: 'ok', checkedAt: 1 } }), { english: false, checkClosely }).querySelector('.reply-sources-check')).toBeNull()
  })

  it('says when an answer gives no links', () => {
    const block = renderSourcesBlock({ ...reply(), content: '我不确定。' }, { english: false })
    expect(block.textContent).toContain('这条回答没有给出来源链接。')
  })
})

describe('the fact-check card', () => {
  it('counts the verdicts and lists each claim with who said it and the basis, then the conclusion', () => {
    const check = readFactCheck('- 【已核实】研究员：1700 万辆 —— IEA 报告\n- 【有误】分析师：增长 25% —— 实际约 20%\n- 【已核实】研究员：中国占六成 —— 中汽协\n结论：研究员可信。')!
    const card = renderFactCheckCard(check, false)
    expect([...card.querySelectorAll('.fact-check-counts .fact-verdict')].map(node => node.textContent)).toEqual(['已核实 2', '有误 1'])
    const rows = [...card.querySelectorAll('.fact-check-item')]
    expect(rows.map(row => [row.querySelector('.fact-verdict')?.textContent, row.querySelector('.fact-check-who')?.textContent, row.querySelector('.fact-check-claim')?.textContent, row.querySelector('.fact-check-basis')?.textContent])).toEqual([
      ['已核实', '研究员', '1700 万辆', 'IEA 报告'],
      ['有误', '分析师', '增长 25%', '实际约 20%'],
      ['已核实', '研究员', '中国占六成', '中汽协'],
    ])
    expect(card.querySelector('.fact-check-conclusion')?.textContent).toBe('结论：研究员可信。')
    expect(renderFactCheckCard(check, true).querySelector('.fact-verdict')?.textContent).toBe('Verified 2')
  })
})
