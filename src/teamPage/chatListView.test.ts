import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('team page chat list view boundary', () => {
  it('wires chat export and deletion through the chat menu', () => {
    const viewSource = readFileSync(resolve(process.cwd(), 'src/teamPage/chatListView.ts'), 'utf8')

    expect(viewSource).toContain("exportRecord.textContent = ui('导出记录')")
    expect(viewSource).toContain("runCommand('GROUP_CHAT_UPDATE'")
    expect(viewSource).toContain('formatChatExportMarkdown')
    expect(viewSource).toContain('safeChatExportFilename')
    expect(viewSource).toContain("sendRuntimeMessage('GROUP_CHAT_DELETE'")
    expect(viewSource).toContain('chat-delete:fallback-local-store')
  })
})
