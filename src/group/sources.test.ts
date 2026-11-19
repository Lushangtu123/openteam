import { describe, expect, it } from 'vitest'
import { createDefaultStore } from './store'
import type { GroupChat, GroupMessage, GroupRole } from './types'
import { buildFactCheckPrompt, linkCheckLabel, readCheckableRound, readFactCheck, readReplySources, sourcesInstruction } from './sources'

describe('the sources in a reply', () => {
  const reply = [
    '2024 年全球电动车销量约 1700 万辆 [1]，中国占六成以上 [2]。',
    '电池价格十年下降了 90% [无来源]。',
    '我认为这个趋势还会继续。',
    '欧洲的销量在 2023 年增长了 14%。',
    '',
    '**来源：**',
    '[1] IEA Global EV Outlook 2025 https://www.iea.org/reports/global-ev-outlook-2025',
    '[2] [中汽协数据](https://www.caam.org.cn/data/2024)',
  ].join('\n')

  it('lists the numbered sources with their titles, and links written in the text', () => {
    const sources = readReplySources(reply + '\n另见 https://example.com/extra。')
    expect(sources.links).toEqual([
      { n: 1, url: 'https://www.iea.org/reports/global-ev-outlook-2025', title: 'IEA Global EV Outlook 2025' },
      { n: 2, url: 'https://www.caam.org.cn/data/2024', title: '中汽协数据' },
      { url: 'https://example.com/extra' },
    ])
  })

  it('finds the claims without a source: those marked so, and those with numbers or dates but no citation', () => {
    expect(readReplySources(reply).unsourced).toEqual(['电池价格十年下降了 90% [无来源]。', '欧洲的销量在 2023 年增长了 14%。'])
  })

  it('counts English source sections and markers too, and nothing in a reply without any', () => {
    const english = readReplySources('Sales rose 25% in 2024 [1]. Prices fell by half [no source].\n\nSources:\n1. https://example.org/report')
    expect(english.links).toEqual([{ n: 1, url: 'https://example.org/report' }])
    expect(english.unsourced).toEqual(['Prices fell by half [no source].'])
    expect(readReplySources('我觉得都可以。')).toEqual({ links: [], unsourced: [] })
  })

  it('reads sources as ChatGPT writes them: the title above the link, a site name linked first, tracking added (seen live)', () => {
    const twoLines = readReplySources([
      '全球超过 1,700 万辆。[1]',
      '',
      '来源：',
      '',
      '[1] IEA — Global EV Outlook 2025: Trends in electric car markets',
      '[https://www.iea.org/reports/global-ev-outlook-2025/trends-in-electric-car-markets-2](https://www.iea.org/reports/global-ev-outlook-2025/trends-in-electric-car-markets-2?utm_source=chatgpt.com)',
      '',
      '[2] Yahoo Finance — Global EV sales surge 25% in 2024',
      '[https://finance.yahoo.com/news/a.html](https://finance.yahoo.com/news/a.html?utm_source=chatgpt.com)',
    ].join('\n'))
    expect(twoLines.links).toEqual([
      { n: 1, url: 'https://www.iea.org/reports/global-ev-outlook-2025/trends-in-electric-car-markets-2', title: 'IEA — Global EV Outlook 2025: Trends in electric car markets' },
      { n: 2, url: 'https://finance.yahoo.com/news/a.html', title: 'Yahoo Finance — Global EV sales surge 25% in 2024' },
    ])
    expect(readReplySources('- 2024年全球电动车销量超过1,700万辆。[1]\n- 中国占比约64%–65%。[1][2]\n- 欧洲增长 14%。').unsourced).toEqual(['欧洲增长 14%。'])
    expect(readReplySources('IEA 给出约 1700 万辆 [-1](https://www.iea.org/x)。').links).toEqual([{ url: 'https://www.iea.org/x' }])
    const siteFirst = readReplySources('销量 1,710 万。[3]\n\n来源：\n[3] [EV.com](https://ev.com/) “2024 Saw 17.1 Million EVs Sold” [https://ev.com/news/2024-saw](https://ev.com/news/2024-saw)')
    expect(siteFirst.links).toEqual([{ n: 3, url: 'https://ev.com/news/2024-saw', title: 'EV.com “2024 Saw 17.1 Million EVs Sold”' }])
  })

  it('counts a paragraph citing at its end as sourced, does not cut a sentence inside a link, and leaves tables out (seen live)', () => {
    const reply = [
      'IEA 明确全球销量超过 1,700 万辆。Rho Motion 给出 1,710 万辆。[-1](https://www.iea.org/x?a=1&b=2#1)[-8](https://www.rti.org.tw/news?uid=3&pid=119280)',
      '',
      '统计指标 | 2024年数据',
      '全球销量 | 超过1,700万辆',
      '',
      '欧洲 2024 年增长 14%。',
    ].join('\n')
    expect(readReplySources(reply).unsourced).toEqual(['欧洲 2024 年增长 14%。'])
  })

  it('keeps at most 10 links, without repeats', () => {
    const many = Array.from({ length: 14 }, (_, index) => `[${index + 1}] https://example.com/${index % 12}`).join('\n')
    const links = readReplySources(`事实 [1]。\n\n来源：\n${many}`).links
    expect(links).toHaveLength(10)
    expect(new Set(links.map(link => link.url)).size).toBe(10)
  })
})

describe('what members are asked when the user wants sources', () => {
  it('is to number each fact\'s source, list the links, mark what has none, and invent nothing', () => {
    const text = sourcesInstruction(false)
    expect(text).toContain('[1]、[2]')
    expect(text).toContain('「来源：」')
    expect(text).toContain('[无来源]')
    expect(text).toContain('不要编造')
    expect(sourcesInstruction(true)).toContain('[no source]')
  })
})

describe('what a link check says', () => {
  it('reads plainly for each outcome', () => {
    expect(linkCheckLabel({ status: 'ok', httpStatus: 200, title: 'Report', checkedAt: 1 }, false)).toBe('能打开')
    expect(linkCheckLabel({ status: 'missing', httpStatus: 404, checkedAt: 1 }, false)).toBe('页面不存在（404）')
    expect(linkCheckLabel({ status: 'refused', httpStatus: 403, checkedAt: 1 }, false)).toBe('网站拒绝自动访问（403）')
    expect(linkCheckLabel({ status: 'error', httpStatus: 500, checkedAt: 1 }, false)).toBe('网站报错（500）')
    expect(linkCheckLabel({ status: 'reachable', checkedAt: 1 }, false)).toBe('网站能连上，没细查页面')
    expect(linkCheckLabel({ status: 'no-response', checkedAt: 1 }, false)).toBe('没有响应：网站可能不存在，也可能拦了自动访问')
    expect(linkCheckLabel({ status: 'unreachable', checkedAt: 1 }, false)).toBe('细查也连不上，网站可能不存在')
    expect(linkCheckLabel({ status: 'unchecked', checkedAt: 1 }, false)).toBe('没有检查（不是 https 链接）')
    expect(linkCheckLabel(undefined, false)).toBe('检查中')
    expect(linkCheckLabel({ status: 'missing', httpStatus: 404, checkedAt: 1 }, true)).toBe('Page not found (404)')
  })
})

// 研究员 and 分析师 answered a question asked with sources; 校对 sat it out.
function setup() {
  const store = createDefaultStore()
  const role = (id: string, name: string): GroupRole => ({ id, chatId: 'c', name, status: 'ready', contextCursor: 0, createdAt: 0, updatedAt: 0 })
  for (const item of [role('r1', '研究员'), role('r2', '分析师'), role('r3', '校对')]) store.rolesById[item.id] = item
  const chat: GroupChat = { id: 'c', name: '调研', mode: 'collaborative', roleIds: ['r1', 'r2', 'r3'], messageIds: [], nextMessageSeq: 1, status: 'ready', createdAt: 0, updatedAt: 0 }
  store.chatsById.c = chat
  const add = (message: Partial<GroupMessage> & Pick<GroupMessage, 'id' | 'type' | 'content'>) => {
    const full = { chatId: 'c', seq: chat.nextMessageSeq, createdAt: chat.nextMessageSeq, status: 'received', ...message } as GroupMessage
    chat.nextMessageSeq += 1
    store.messagesById[full.id] = full
    chat.messageIds.push(full.id)
    return full
  }
  const question = add({ id: 'q', type: 'user', content: '2024 年电动车卖了多少？', wantsSources: true, targetRoleIds: ['r1', 'r2'], deliveryStatus: { r1: 'received', r2: 'received' } })
  add({ id: 'a1', type: 'assistant', roleId: 'r1', roleName: '研究员', sourceMessageId: 'q', content: '约 1700 万辆 [1]。\n\n来源：\n[1] https://www.iea.org/report', linkChecks: { 'https://www.iea.org/report': { status: 'ok', httpStatus: 200, title: 'Global EV Outlook', checkedAt: 5 } } })
  add({ id: 'a2', type: 'assistant', roleId: 'r2', roleName: '分析师', sourceMessageId: 'q', content: '大约 1500 万辆，增长 25%。\n\n来源：\n[1] https://made-up.example/ev', linkChecks: { 'https://made-up.example/ev': { status: 'unreachable', checkedAt: 5 } } })
  return { store, chat, question, add }
}

describe('a round asked with sources', () => {
  it('can be checked once everyone it went to is done and one has answered', () => {
    const { store, chat, question } = setup()
    expect(readCheckableRound(store, chat, question)?.replies.map(reply => reply.role.name)).toEqual(['研究员', '分析师'])
    expect(readCheckableRound(store, chat, { ...question, deliveryStatus: { r1: 'received', r2: 'sent' } })).toBeUndefined()
    expect(readCheckableRound(store, chat, { ...question, wantsSources: undefined })).toBeUndefined()
  })

  it('is checked by a member given every answer, the link checks and the claims without a source', () => {
    const { store, chat, question } = setup()
    const round = readCheckableRound(store, chat, question)!
    const prompt = buildFactCheckPrompt({ round, checker: store.rolesById.r3, language: 'zh-CN' })
    expect(prompt).toContain('你是「校对」，这次请你担任事实核查员。')
    expect(prompt).toContain('2024 年电动车卖了多少？')
    expect(prompt).toContain('【研究员】\n约 1700 万辆 [1]。')
    expect(prompt).toContain('- 【研究员】https://www.iea.org/report：能打开，标题「Global EV Outlook」')
    expect(prompt).toContain('- 【分析师】https://made-up.example/ev：细查也连不上，网站可能不存在')
    expect(prompt).toContain('- 【分析师】大约 1500 万辆，增长 25%。')
    expect(prompt).toContain('- 【已核实】成员名：说法 —— 依据')
    expect(prompt).toContain('结论：')
  })
})

describe('a fact check, read from the checker\'s reply', () => {
  it('is a verdict per claim, with who said it, the claim and the basis, and the conclusion', () => {
    const check = readFactCheck([
      '核查如下：',
      '- 【已核实】研究员：2024 年全球电动车销量约 1700 万辆 —— IEA 报告第 2 页给出 1720 万辆',
      '2. **【有误】** 分析师：增长 25% —— 实际增长约 25%~26%，但 1500 万辆偏低',
      '- [存疑] 分析师: 来源链接 —— 域名打不开',
      '- 【无法核实】中国占六成以上 —— 没有找到可靠数据',
      '',
      '**结论：** 研究员的数字可信，分析师的数字偏低。',
    ].join('\n'))!
    expect(check.items).toEqual([
      { verdict: 'verified', who: '研究员', claim: '2024 年全球电动车销量约 1700 万辆', basis: 'IEA 报告第 2 页给出 1720 万辆' },
      { verdict: 'wrong', who: '分析师', claim: '增长 25%', basis: '实际增长约 25%~26%，但 1500 万辆偏低' },
      { verdict: 'doubtful', who: '分析师', claim: '来源链接', basis: '域名打不开' },
      { verdict: 'unverifiable', claim: '中国占六成以上', basis: '没有找到可靠数据' },
    ])
    expect(check.conclusion).toBe('研究员的数字可信，分析师的数字偏低。')
  })

  it('reads English verdicts, and is none for a reply with no verdict lines', () => {
    expect(readFactCheck('- [Verified] Researcher: 17 million cars -- IEA report')!.items[0]).toEqual({ verdict: 'verified', who: 'Researcher', claim: '17 million cars', basis: 'IEA report' })
    expect(readFactCheck('我看了一下，大体没问题。')).toBeUndefined()
  })
})
