import { describe, expect, it } from 'vitest'
import type { GroupChat } from '../group/types'
import { orderChatsForList, shouldShowChatSearch } from './chatListOrder'

const chat = (id: string, name: string, pinned?: boolean): GroupChat => ({ id, name, mode: 'independent', roleIds: [], messageIds: [], nextMessageSeq: 1, status: 'ready', createdAt: 0, updatedAt: 0, ...(pinned ? { pinned } : {}) })
const summaries: Record<string, string> = { a: '最近在讨论 Launch 计划', b: '暂无消息', c: '周报已写好', d: '' }

describe('group list order and search', () => {
  it('puts pinned groups first and keeps the list order inside each part', () => {
    const chats = [chat('a', '产品评审'), chat('b', '读书会', true), chat('c', '周报'), chat('d', '旅行计划', true)]
    expect(orderChatsForList(chats, '', item => summaries[item.id]).map(item => item.id)).toEqual(['b', 'd', 'a', 'c'])
  })

  it('finds groups by name or last message, ignoring case and spaces', () => {
    const chats = [chat('a', '产品评审'), chat('b', '读书会', true), chat('c', '周报'), chat('d', '旅行计划', true)]
    expect(orderChatsForList(chats, 'launch', item => summaries[item.id]).map(item => item.id)).toEqual(['a'])
    expect(orderChatsForList(chats, ' 周 报 ', item => summaries[item.id]).map(item => item.id)).toEqual(['c'])
    expect(orderChatsForList(chats, '计划', item => summaries[item.id]).map(item => item.id)).toEqual(['d', 'a'])
    expect(orderChatsForList(chats, '没有的词', item => summaries[item.id])).toEqual([])
  })

  it('shows the search box for long lists, or while it holds a query', () => {
    expect(shouldShowChatSearch(3, '')).toBe(false)
    expect(shouldShowChatSearch(6, '')).toBe(true)
    expect(shouldShowChatSearch(2, '周')).toBe(true)
  })
})
