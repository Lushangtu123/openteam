// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest'
import { createClaudeAdapter, findClaudeEmbedBlock } from './claude'
import { isEmbeddedFrame } from '../frameEnvironment'

vi.mock('../frameEnvironment', () => ({ isEmbeddedFrame: vi.fn(() => false), isDirectEmbeddedFrame: vi.fn(() => false) }))

const EMBED_NOTICE_PAGE = `
  <div><main><div data-cds="Banner" role="alert"><span><span aria-hidden="true"></span></span><div><div>This page can’t run in an embedded view. Open it in its own tab to continue.</div></div></div></main></div>
  <footer><a href="/login">Log in</a></footer>`

describe('Claude site adapter', () => {
  it("recognizes Claude's notice that it refuses to run inside another page", () => {
    document.body.innerHTML = EMBED_NOTICE_PAGE
    expect(findClaudeEmbedBlock(document, true)).toBe('This page can’t run in an embedded view. Open it in its own tab to continue.')
    // The same banner in a normal tab, or a page that still has its input box, is not the block.
    expect(findClaudeEmbedBlock(document, false)).toBeUndefined()
    document.body.insertAdjacentHTML('beforeend', '<div data-testid="chat-input" contenteditable="true"></div>')
    expect(findClaudeEmbedBlock(document, true)).toBeUndefined()
    // An alert next to other page content is an ordinary banner.
    document.body.innerHTML = '<main><div role="alert">Something went wrong</div><section>Recent chats</section></main>'
    expect(findClaudeEmbedBlock(document, true)).toBeUndefined()
  })

  it('reports the embed block as the page status inside an OpenTeam frame', () => {
    document.body.innerHTML = EMBED_NOTICE_PAGE
    vi.mocked(isEmbeddedFrame).mockReturnValue(true)
    try {
      const adapter = createClaudeAdapter({ href: 'https://claude.ai/logout?involuntary=1' })
      expect(adapter.checkStatus?.({ pageAgeMs: 30000, now: 5 })).toEqual({
        status: 'blocked',
        reason: 'embed-blocked',
        detail: 'This page can’t run in an embedded view. Open it in its own tab to continue.',
        timestamp: 5,
      })
    } finally {
      vi.mocked(isEmbeddedFrame).mockReturnValue(false)
    }
  })

  it('reads assistant prose in the new transcript without the message heading or user prompt', () => {
    document.body.innerHTML = `
      <div data-testid="user-message"><div data-perf-reply-text>Question</div></div>
      <div data-reply-scope>
        <div data-testid="assistant-message" data-is-streaming="false">
          <h3 data-find-omitted>Claude responded: First part</h3>
          <div data-transcript-engine-root>
            <div data-cds="Prose"><div data-perf-reply-text><p>First part</p></div></div>
            <div data-cds="Prose"><div data-perf-reply-text><p>Second part</p></div></div>
          </div>
        </div>
        <button aria-label="Copy">Copy</button>
      </div>
    `

    const adapter = createClaudeAdapter()
    const [reply] = adapter.getResponseContainers()
    expect(adapter.getAllAssistantReplies()).toEqual(['First part\n\nSecond part'])
    expect(adapter.findResponseContainer(document.querySelector('[data-testid="assistant-message"] p'))).toBe(reply)
    expect(adapter.findResponseContainer(document.querySelector('[data-testid="user-message"] div'))).toBeNull()
  })

  it('extracts Claude conversation ids and normalized safe urls', () => {
    const adapter = createClaudeAdapter({ href: 'https://claude.ai/chat/abc-123?model=sonnet' })

    expect(adapter.getConversationSnapshot()).toEqual({
      conversationId: 'abc-123',
      conversationUrl: 'https://claude.ai/chat/abc-123?model=sonnet',
    })
  })

  it('does not report non-Claude urls', () => {
    const adapter = createClaudeAdapter({ href: 'https://claude.ai.evil.example/chat/abc-123' })

    expect(adapter.getConversationSnapshot()).toEqual({
      conversationId: undefined,
      conversationUrl: undefined,
    })
  })

  it('writes prompt text into the Claude composer', async () => {
    document.body.innerHTML = `
      <div contenteditable="true" data-testid="chat-input" role="textbox" aria-label="Write your prompt to Claude">
        <p data-placeholder="Write a message…" class="is-empty is-editor-empty"><br></p>
      </div>
    `
    const editor = document.querySelector<HTMLElement>('[data-testid="chat-input"]')!
    const inputListener = vi.fn()
    editor.addEventListener('input', inputListener)

    await createClaudeAdapter().fillAndSend('你好 <claude>', false)

    expect(editor.textContent).toBe('你好 <claude>')
    expect(editor.querySelector('claude')).toBeNull()
    expect(inputListener).toHaveBeenCalledTimes(1)
  })

  // Should the input box lose its own selectors (as ChatGPT's did), the generic ones must not find
  // an editor inside a reply first.
  it('types into the input box, not into an editor inside a reply', async () => {
    document.body.innerHTML = `
      <div data-testid="assistant-message"><div class="font-claude-response">
        <div class="ProseMirror" contenteditable="true" role="textbox"><p>草稿</p></div>
      </div></div>
      <fieldset><div class="ProseMirror" contenteditable="true" role="textbox" aria-label="Reply"><p><br></p></div></fieldset>
    `
    const adapter = createClaudeAdapter()
    const input = document.querySelector<HTMLElement>('fieldset [contenteditable]')!

    expect(adapter.findEditor?.()).toBe(input)
    await adapter.fillAndSend('下一步', false)

    expect(input.textContent).toBe('下一步')
    expect(document.querySelector('.font-claude-response')?.textContent?.trim()).toBe('草稿')
  })

  it('waits for the Claude send button before clicking', async () => {
    document.body.innerHTML = `
      <div contenteditable="true" data-testid="chat-input" role="textbox"></div>
      <button type="button" aria-label="Use voice mode" disabled>Voice</button>
    `
    const sendButton = document.querySelector<HTMLButtonElement>('button')!
    const clickListener = vi.fn()
    sendButton.addEventListener('click', clickListener)
    window.setTimeout(() => {
      sendButton.disabled = false
      sendButton.setAttribute('aria-label', 'Send message')
    }, 20)

    await createClaudeAdapter({ inputTimeoutMs: 250 }).fillAndSend('hello', true)

    expect(clickListener).toHaveBeenCalledTimes(1)
  })

  it('reads Claude markdown replies without action button text', () => {
    document.body.innerHTML = `
      <div class="group">
        <div class="font-claude-response">
          <div class="standard-markdown">
            <p>我能做很多事情！</p>
            <ul><li>写作</li><li>编程</li></ul>
          </div>
        </div>
        <div role="group" aria-label="Message actions"><button aria-label="Copy">Copy</button></div>
      </div>
    `

    expect(createClaudeAdapter().getAllAssistantReplies()).toEqual(['我能做很多事情！\n\n写作\n编程'])
  })

  it('uses the Claude copy action to read markdown replies and restores the clipboard', async () => {
    let clipboardText = '用户原来的剪贴板'
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        readText: vi.fn(async () => clipboardText),
        writeText: vi.fn(async (text: string) => {
          clipboardText = text
        }),
      },
    })
    document.body.innerHTML = `
      <div class="group">
        <div class="font-claude-response">
          <div class="standard-markdown">
            <p>标题</p>
            <pre><code>const answer = 42</code></pre>
          </div>
        </div>
        <div role="group" aria-label="Message actions">
          <button type="button" data-testid="action-bar-copy" aria-label="Copy">Copy</button>
        </div>
      </div>
    `
    document.querySelector<HTMLButtonElement>('[data-testid="action-bar-copy"]')?.addEventListener('click', () => {
      clipboardText = '标题\n\n```ts\nconst answer = 42\n```'
    })
    const response = document.querySelector('.font-claude-response')!

    const copied = await createClaudeAdapter({ clipboardPollMs: 5, clipboardTimeoutMs: 50 }).readResponseTextFromCopy?.(response)

    expect(copied).toBe('标题\n\n```ts\nconst answer = 42\n```')
    expect(clipboardText).toBe('用户原来的剪贴板')
  })

  it('converts Claude reply DOM to markdown when copy output is unavailable', () => {
    document.body.innerHTML = `
      <div class="font-claude-response">
        <div class="standard-markdown">
          <h2>方案</h2>
          <p><strong>结论</strong>：可以做</p>
          <ul><li>先做复制</li><li>再做兜底</li></ul>
          <pre><code>const ok = true</code></pre>
        </div>
      </div>
    `
    const response = document.querySelector('.font-claude-response')!

    expect(createClaudeAdapter().readResponseMarkdown?.(response)).toBe('## 方案\n\n**结论**：可以做\n\n- 先做复制\n- 再做兜底\n\n```\nconst ok = true\n```')
  })
})
