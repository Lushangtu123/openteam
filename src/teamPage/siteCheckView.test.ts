// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { createDefaultStore } from '../group/store'
import { SITE_CHECK_TIMEOUT_MS } from '../group/siteCheck'
import type { GroupChat, OpenTeamStore } from '../group/types'
import { createSiteCheckView } from './siteCheckView'

const START = 1_000_000

function setup(language: 'zh-CN' | 'en' = 'zh-CN') {
  const store: OpenTeamStore = createDefaultStore()
  store.settings.language = language
  const chat: GroupChat = { id: 'chat-check', name: '网站自检', mode: 'independent', roleIds: ['role-gemini', 'role-deepseek'], messageIds: ['q', 'a'], nextMessageSeq: 3, status: 'ready', createdAt: START, updatedAt: START, siteCheck: { startedAt: START } }
  store.chatsById[chat.id] = chat
  store.rolesById['role-gemini'] = { id: 'role-gemini', chatId: chat.id, name: 'Gemini', chatSite: 'gemini', modelSource: 'site', status: 'ready', contextCursor: 0, createdAt: START, updatedAt: START }
  store.rolesById['role-deepseek'] = { id: 'role-deepseek', chatId: chat.id, name: 'DeepSeek', chatSite: 'deepseek', modelSource: 'site', status: 'ready', contextCursor: 0, createdAt: START, updatedAt: START, siteHealth: { siteId: 'deepseek', status: 'unauthorized', reason: 'login', updatedAt: START } }
  store.messagesById.q = { id: 'q', chatId: chat.id, seq: 1, type: 'user', content: '@所有人 只回复 OK', createdAt: START, status: 'sent', deliveryStatus: { 'role-gemini': 'received', 'role-deepseek': 'pending' } }
  store.messagesById.a = { id: 'a', chatId: chat.id, seq: 2, type: 'assistant', content: 'OK', roleId: 'role-gemini', sourceMessageId: 'q', createdAt: START + 1000, status: 'received' }
  let now = START + 5000
  const requestRender = vi.fn()
  const view = createSiteCheckView({ getStore: () => store, now: () => now, requestRender })
  return { store, chat, view, requestRender, setNow: (value: number) => { now = value } }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('site check card', () => {
  it('shows nothing in an ordinary group', () => {
    const { chat, view } = setup()
    delete chat.siteCheck
    expect(view.renderBoard(chat)).toBeUndefined()
  })

  it('lists each site with what happened and what to do, under a summary', () => {
    const { chat, view } = setup()
    const board = view.renderBoard(chat)!
    expect(board.querySelector('.project-board-title')?.textContent).toContain('检查完成：1 个正常，1 个需要处理')
    const rows = [...board.querySelectorAll<HTMLElement>('.project-task')]
    expect(rows.map(row => row.querySelector('.project-task-status')?.textContent)).toEqual(['正常', '需登录'])
    expect(rows[0].className).toContain('project-task-done')
    expect(rows[1].className).toContain('project-task-blocked')
    expect(rows[1].textContent).toContain('DeepSeek')
    expect(rows[1].textContent).toContain('打开网站')
  })

  it("says why the question could not be sent", () => {
    const { chat, view } = setup()
    chat.siteCheck = { startedAt: START, error: '没有一个网站的页面打开了。' }
    const board = view.renderBoard(chat)!
    expect(board.querySelector('.site-check-error')?.textContent).toBe('没有一个网站的页面打开了。')
  })

  it('is in English when the page is', () => {
    const { chat, view } = setup('en')
    const board = view.renderBoard(chat)!
    expect(board.querySelector('.project-board-title')?.textContent).toContain('Check finished: 1 working, 1 needs attention')
    expect([...board.querySelectorAll('.project-task-status')].map(status => status.textContent)).toEqual(['OK', 'Sign in'])
  })

  it('draws itself again when a site that is still waiting runs out of time', () => {
    vi.useFakeTimers()
    const { store, chat, view, requestRender } = setup()
    delete store.rolesById['role-deepseek'].siteHealth
    store.messagesById.q.deliveryStatus!['role-deepseek'] = 'sent'
    expect([...view.renderBoard(chat)!.querySelectorAll('.project-task-status')].map(status => status.textContent)).toEqual(['正常', '等待中'])
    view.renderBoard(chat)

    vi.advanceTimersByTime(SITE_CHECK_TIMEOUT_MS)
    expect(requestRender).toHaveBeenCalledTimes(1)
  })
})
