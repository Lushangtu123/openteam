import { describe, expect, it } from 'vitest'
import { createDefaultStore } from '../group/store'
import type { GroupChat, OpenTeamStore } from '../group/types'
import { buildDiagnosticsReport, diagnosticsFileName } from './diagnostics'

const NOW = Date.UTC(2026, 10, 17, 9, 30)

function storeWithData(): OpenTeamStore {
  const store = createDefaultStore()
  store.settings.language = 'zh-CN'
  store.settings.externalModelOrder = ['m-1']
  store.settings.externalModelsById['m-1'] = { id: 'm-1', name: 'Gemini', format: 'openai', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai?key=abc', apiKey: 'my-very-secret-key-123', modelName: 'gemini-flash-latest', fallbackModelName: 'gemini-flash-lite-latest', createdAt: 1, updatedAt: 1 }
  const chat: GroupChat = { id: 'chat-1', name: '我的私人项目', mode: 'collaborative', roleIds: ['r-ds', 'r-api'], messageIds: ['q', 'a1', 'a2'], nextMessageSeq: 4, status: 'ready', createdAt: 1, updatedAt: 1 }
  store.chatOrder = ['chat-1']
  store.chatsById['chat-1'] = chat
  store.currentChatId = 'chat-1'
  store.rolesById['r-ds'] = { id: 'r-ds', chatId: 'chat-1', name: '工程师', chatSite: 'deepseek', modelSource: 'site', status: 'ready', contextCursor: 0, createdAt: 1, updatedAt: 1, siteHealth: { siteId: 'deepseek', status: 'unauthorized', reason: 'login', updatedAt: NOW - 1000 } }
  store.rolesById['r-api'] = { id: 'r-api', chatId: 'chat-1', name: '分析师', modelSource: 'external', externalModelId: 'm-1', status: 'ready', contextCursor: 0, createdAt: 1, updatedAt: 1 }
  store.messagesById.q = { id: 'q', chatId: 'chat-1', seq: 1, type: 'user', content: '这是我的机密问题', createdAt: NOW - 5000, status: 'received' }
  store.messagesById.a1 = { id: 'a1', chatId: 'chat-1', seq: 2, type: 'assistant', content: '回复失败：HTTP 503：This model is busy (key my-very-secret-key-123)\n\n可以点击下方的重新回复按钮再试一次。', roleId: 'r-api', sourceMessageId: 'q', createdAt: NOW - 4000, status: 'error' }
  store.messagesById.a2 = { id: 'a2', chatId: 'chat-1', seq: 3, type: 'assistant', content: '这是一个机密回答', roleId: 'r-ds', sourceMessageId: 'q', createdAt: NOW - 3000, status: 'received' }
  return store
}

function build(store = storeWithData()) {
  return buildDiagnosticsReport({
    now: NOW,
    extensionVersion: '1.5.0',
    userAgent: 'Mozilla/5.0 Chrome/156',
    store,
    updateCheck: { enabled: true, latest: { version: '1.5.0', url: 'https://github.com/x' } },
    backgroundLogs: [{ at: NOW - 100, level: 'warn', scope: 'background', event: 'external-model:retry-scheduled', details: { reason: 'HTTP 503 my-very-secret-key-123' } }],
    pageLogs: [],
  })
}

describe('the diagnostics report', () => {
  it('says which OpenTeam and browser this is, and how much there is', () => {
    const report = build()
    expect(report).toMatchObject({
      kind: 'openteam-diagnostics',
      generatedAt: '2026-11-17T09:30:00.000Z',
      extensionVersion: '1.5.0',
      browser: 'Mozilla/5.0 Chrome/156',
      settings: { language: 'zh-CN' },
      counts: { chats: 1, members: 2, messages: 3 },
      updateCheck: { enabled: true, latestVersion: '1.5.0' },
    })
  })

  it('describes API models by format, host and model name only', () => {
    expect(build().apiModels).toEqual([{ format: 'openai', host: 'generativelanguage.googleapis.com', modelName: 'gemini-flash-latest', fallbackModelName: 'gemini-flash-lite-latest', hasKey: true }])
  })

  it('gives each AI site’s latest page health', () => {
    expect(build().siteHealth).toEqual([{ site: 'deepseek', status: 'unauthorized', reason: 'login', updatedAt: '2026-11-17T09:29:59.000Z' }])
  })

  it('lists recent failed replies with who failed and why, not what was asked', () => {
    const report = build()
    expect(report.recentFailures).toEqual([{ at: '2026-11-17T09:29:56.000Z', member: 'api:openai', reason: 'HTTP 503：This model is busy (key [secret])' }])
  })

  it('reports the latest site check, site by site', () => {
    const store = storeWithData()
    store.chatsById['chat-1'].siteCheck = { startedAt: NOW - 6000 }
    const check = build(store).lastSiteCheck
    expect(check).toMatchObject({ startedAt: '2026-11-17T09:29:54.000Z' })
    expect(check?.results).toEqual([{ site: 'deepseek', outcome: 'ok' }])
  })

  it('carries the recent logs', () => {
    expect(build().backgroundLogs[0]).toMatchObject({ event: 'external-model:retry-scheduled', level: 'warn' })
  })

  it('holds no message text, group or member names, and no API key anywhere', () => {
    const text = JSON.stringify(build())
    for (const secret of ['机密', '我的私人项目', '工程师', '分析师', 'my-very-secret-key-123', 'key=abc']) expect(text).not.toContain(secret)
  })
})

describe('the file name', () => {
  it('says what it is and when, in the computer’s own time', () => {
    expect(diagnosticsFileName(new Date(2026, 10, 17, 9, 5).getTime())).toBe('openteam-diagnostics-20261117-0905.json')
  })
})
