import { describe, expect, it } from 'vitest'
import { buildSnippet, markdownToPlainText, searchMessages } from './messageSearch'
import { createDefaultStore } from './store'
import type { GroupMessage, OpenTeamStore } from './types'

const speakerName = (message: GroupMessage) => message.type === 'user' ? '我' : message.roleName ?? 'AI 人员'

function storeWith(chats: Record<string, Array<Partial<GroupMessage> & { content: string }>>): OpenTeamStore {
  const store = createDefaultStore()
  let time = 0
  for (const [chatId, messages] of Object.entries(chats)) {
    store.chatOrder.push(chatId)
    const messageIds = messages.map((_, index) => `${chatId}-${index}`)
    store.chatsById[chatId] = { id: chatId, name: `群聊${chatId}`, mode: 'independent', roleIds: [], messageIds, nextMessageSeq: messages.length + 1, status: 'ready', createdAt: 1, updatedAt: 1 }
    messages.forEach((message, index) => {
      time += 1
      store.messagesById[messageIds[index]] = { id: messageIds[index], chatId, seq: index + 1, type: 'assistant', roleName: '工程师', createdAt: time, status: 'received', ...message }
    })
  }
  return store
}

describe('message search', () => {
  it('finds messages in every chat that contain all the words, newest first', () => {
    const store = storeWith({
      a: [{ content: '缓存方案的性能风险' }, { content: '只谈性能' }],
      b: [{ content: 'Performance and 缓存 trade-offs', type: 'user' }],
    })

    const outcome = searchMessages(store, '缓存  性能', { speakerName })
    expect(outcome.results.map(result => result.messageId)).toEqual(['a-0'])

    const english = searchMessages(store, 'PERFORMANCE', { speakerName })
    expect(english.results.map(result => [result.chatName, result.messageId])).toEqual([['群聊b', 'b-0']])

    const both = searchMessages(store, '缓存', { speakerName })
    expect(both.results.map(result => result.messageId)).toEqual(['b-0', 'a-0'])
    expect(both.total).toBe(2)
  })

  it('matches attachment names and speakers, and can stay in one chat', () => {
    const store = storeWith({
      a: [{ content: '看附件', type: 'user', attachments: [{ id: 'f', type: 'file', status: 'ready', fileName: '季度目标.md', mimeType: 'text/markdown', size: 1, text: '' }] }],
      b: [{ content: '增长要看留存', roleName: '增长专家' }],
    })

    expect(searchMessages(store, '季度目标', { speakerName }).results.map(result => result.messageId)).toEqual(['a-0'])
    expect(searchMessages(store, '增长专家 留存', { speakerName }).results.map(result => result.messageId)).toEqual(['b-0'])
    expect(searchMessages(store, '看', { speakerName, chatId: 'a' }).results.map(result => result.messageId)).toEqual(['a-0'])
  })

  it('stops at the limit but reports how many matched', () => {
    const store = storeWith({ a: Array.from({ length: 30 }, (_, index) => ({ content: `第 ${index} 条测试` })) })

    const outcome = searchMessages(store, '测试', { speakerName, limit: 10 })

    expect(outcome.results).toHaveLength(10)
    expect(outcome.total).toBe(30)
    expect(outcome.results[0].messageId).toBe('a-29')
  })

  it('ignores an empty query', () => {
    expect(searchMessages(storeWith({ a: [{ content: 'x' }] }), '   ', { speakerName })).toEqual({ results: [], total: 0 })
  })

  it('shows the words of a Markdown reply in its excerpt, not the marks', () => {
    const reply = '## 要点\n- 选 **Go**：单个二进制\n- 用 `go build` 打包\n\n| 语言 | 理由 |\n| --- | --- |\n| Go | 部署省事 |\n\n详见[文档](https://example.com)'
    expect(markdownToPlainText(reply).replace(/\s+/g, ' ').trim()).toBe('要点 选 Go：单个二进制 用 go build 打包 语言 理由 Go 部署省事 详见文档')
    expect(buildSnippet(markdownToPlainText(reply), ['go']).map(part => part.text).join('')).not.toMatch(/[#*`|]/)
  })

  it('cuts an excerpt around the first match and marks every match', () => {
    const text = `${'前文'.repeat(30)}这里提到缓存，后面又说缓存。${'后文'.repeat(80)}`

    const snippet = buildSnippet(text, ['缓存'])

    expect(snippet[0].text.startsWith('…前文')).toBe(true)
    expect(snippet[snippet.length - 1].text.endsWith('后文…')).toBe(true)
    expect(snippet.map(part => part.text).join('').length).toBeLessThanOrEqual(112)
    expect(snippet.filter(part => part.match).map(part => part.text)).toEqual(['缓存', '缓存'])
    expect(buildSnippet('Short NOTE here', ['note'])).toEqual([{ text: 'Short ', match: false }, { text: 'NOTE', match: true }, { text: ' here', match: false }])
  })
})
