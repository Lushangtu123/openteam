// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { createQwenAdapter } from './qwen'

afterEach(() => {
  document.body.replaceChildren()
  window.history.replaceState(null, '', '/')
})

// The structure of a finished turn on chat.qwen.ai, as recorded from the live site: a collapsed
// thinking card, the answer (with a Monaco code block and a table), and the footer.
const COMPOSER = `
  <div class="message-input">
    <div class="message-input-container">
      <div class="message-input-container-area"><textarea class="message-input-textarea" placeholder="How can I help you today?"></textarea></div>
      <div class="mode-select-open" aria-label="Select Mode"></div>
      <button class="send-button" aria-label="Send"></button>
    </div>
  </div>`

const FINISHED_TURN = `
  <div class="qwen-chat-message qwen-chat-message-user"><div class="chat-user-message"><p class="user-message-content">你好</p></div></div>
  <div class="qwen-chat-message qwen-chat-message-assistant">
    <div id="chat-response-message-1" class="chat-response-message">
      <div class="chat-response-message-right">
        <div class="chat-response-message-render-flow">
          <div class="qwen-chat-thinking-tool-status-card-wraper">
            <div class="qwen-chat-tool-status-card qwen-chat-thinking-status-card-completed">
              <div class="qwen-chat-thinking-status-card-title">Thinking completed</div>
            </div>
          </div>
          <div>
            <div class="response-message-content t2t phase-answer">
              <div class="custom-qwen-markdown"><div class="qwen-markdown qwen-markdown-loose">
                <div dir="ltr"><span><span>我是 Qwen。</span></span></div>
                <ul dir="ltr"><li dir="ltr"><strong dir="ltr"><span><span>推理</span></span></strong><span><span>：逐步思考</span></span></li></ul>
                <pre class="qwen-markdown-code">
                  <div class="qwen-markdown-code-header-wrapper qwen-markdown-code-header-wrapper-sticky">
                    <div class="qwen-markdown-code-header"><div>python</div><div class="qwen-markdown-code-header-actions"><button>复制</button></div></div>
                  </div>
                  <div class="qwen-markdown-code-body python"><div class="qwen-markdown-code-editor-viewport"><section><div><div class="monaco-editor">
                    <div class="overflow-guard"><textarea></textarea><div class="view-lines">
                      <div class="view-line" style="top: 20px;">    return sum(x for x in lst)</div>
                      <div class="view-line" style="top: 0px;">def total(lst):</div>
                    </div></div>
                  </div></div></section></div></div>
                </pre>
                <div class="qwen-markdown-table-wrapper"><div class="qwen-markdown-table-scroll-wrapper"><table>
                  <thead><tr><th>list</th><th>tuple</th></tr></thead>
                  <tbody><tr><td>可变</td><td>不可变</td></tr></tbody>
                </table></div></div>
              </div></div>
            </div>
          </div>
        </div>
        <div class="message-hoc-container"><div class="response-message-footer">
          <button class="qwen-chat-v2-btn" aria-label="Copy"></button>
          <button class="qwen-chat-v2-btn" aria-label="Regenerate"></button>
        </div></div>
      </div>
    </div>
  </div>`

const THINKING_TURN = `
  <div class="qwen-chat-message qwen-chat-message-assistant">
    <div class="chat-response-message"><div class="chat-response-message-right">
      <div class="qwen-chat-status-card"><div class="qwen-chat-status-card-title">梳理当前思维状态</div><div class="qwen-chat-status-card-answer-now">Skip</div></div>
      <div class="response-message-content phase-think"><div class="qwen-markdown">先想一想用户要什么</div></div>
      <div class="message-hoc-container"></div>
    </div></div>
  </div>`

// The dialog Qwen shows a guest on their first send, as recorded from the live site.
const AGE_MODAL = `
  <div class="ant-modal-root qwen-chat-v2-modal-root"><div class="ant-modal-wrap ant-modal-centered">
    <div class="ant-modal qwen-chat-v2-modal age-confirmation-modal" role="dialog" aria-modal="true">
      <div class="ant-modal-content"><div class="ant-modal-title">Confirm your age to continue</div>
      <p>What year were you born?</p> <button>Continue</button></div>
    </div>
  </div></div>`

describe('Qwen site adapter', () => {
  it('reads the conversation id from chat.qwen.ai links only', () => {
    expect(createQwenAdapter({ href: 'https://chat.qwen.ai/c/baa37efc-84a7-40fc-8be7-7dd6bcfd6447' }).getConversationSnapshot()).toEqual({
      conversationId: 'baa37efc-84a7-40fc-8be7-7dd6bcfd6447',
      conversationUrl: 'https://chat.qwen.ai/c/baa37efc-84a7-40fc-8be7-7dd6bcfd6447',
    })
    expect(createQwenAdapter({ href: 'https://chat.qwen.ai/' }).getConversationId()).toBe('__default__')
    expect(createQwenAdapter({ href: 'https://chat.qwen.ai.evil.example/c/abc' }).getConversationSnapshot()).toEqual({})
    expect(createQwenAdapter({ href: 'http://chat.qwen.ai/c/abc' }).getConversationSnapshot()).toEqual({})
  })

  it('reads only the answer: no thinking card, footer or code block header, with code lines in order', () => {
    document.body.innerHTML = COMPOSER + FINISHED_TURN
    const adapter = createQwenAdapter()
    const [turn] = adapter.getResponseContainers()

    expect(adapter.readResponseMarkdown?.(turn)).toBe([
      '我是 Qwen。',
      '',
      '- **推理**：逐步思考',
      '',
      '```',
      'def total(lst):',
      '    return sum(x for x in lst)',
      '```',
      '',
      'list | tuple',
      ' --- | ---',
      '可变 | 不可变',
    ].join('\n'))
    const text = adapter.readResponseText(turn)
    expect(text).toContain('我是 Qwen。')
    expect(text).toContain('def total(lst):\n    return sum(x for x in lst)')
    expect(text).not.toMatch(/Thinking completed|python|复制/)
    expect(adapter.getAllAssistantReplies()).toEqual([text])
  })

  it('reports nothing for a turn that is still thinking', () => {
    document.body.innerHTML = COMPOSER + THINKING_TURN
    const adapter = createQwenAdapter()

    expect(adapter.getResponseContainers()).toHaveLength(1)
    expect(adapter.readResponseText(adapter.getResponseContainers()[0])).toBe('')
    expect(adapter.getAllAssistantReplies()).toEqual([])
  })

  it('finds the turn a streamed text change belongs to', () => {
    document.body.innerHTML = COMPOSER + FINISHED_TURN
    const adapter = createQwenAdapter()
    const span = document.querySelector('.qwen-markdown span')!

    expect(adapter.findResponseContainer(span)).toBe(document.querySelector('.qwen-chat-message-assistant'))
    expect(adapter.findResponseContainer(document.querySelector('.user-message-content'))).toBeNull()
  })

  it('fills the React textarea through the prototype setter and clicks send', async () => {
    document.body.innerHTML = COMPOSER
    const textarea = document.querySelector<HTMLTextAreaElement>('textarea')!
    // React tracks the value with its own property on the element; a plain assignment would only
    // update that tracker, so the adapter must not rely on it.
    let trackedValue = ''
    Object.defineProperty(textarea, 'value', {
      configurable: true,
      get: () => Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.get!.call(textarea),
      set: (value: string) => { trackedValue = value },
    })
    const inputs: string[] = []
    textarea.addEventListener('input', () => inputs.push(textarea.value))
    const send = vi.fn(() => Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea, ''))
    document.querySelector('.send-button')!.addEventListener('click', send)

    await createQwenAdapter().fillAndSend('第一行\n第二行')

    expect(inputs).toEqual(['第一行\n第二行'])
    expect(trackedValue).toBe('')
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('fails the send with the dialog\'s text when a modal opens instead of sending', async () => {
    document.body.innerHTML = COMPOSER
    document.querySelector('.send-button')!.addEventListener('click', () => {
      document.body.insertAdjacentHTML('beforeend', AGE_MODAL)
    })

    await expect(createQwenAdapter().fillAndSend('你好')).rejects.toThrow('Qwen 页面上有弹窗挡住了发送：「Confirm your age to continue What year were you born? Continue」')
    // Already open: nothing is typed or clicked.
    const click = vi.fn()
    document.querySelector('.send-button')!.addEventListener('click', click)
    await expect(createQwenAdapter().fillAndSend('再试一次')).rejects.toThrow('Qwen 页面上有弹窗挡住了发送')
    expect(click).not.toHaveBeenCalled()
  })

  it('waits for an enabled send button and fails clearly when there is none', async () => {
    document.body.innerHTML = COMPOSER
    document.querySelector<HTMLButtonElement>('.send-button')!.disabled = true

    await expect(createQwenAdapter({ inputTimeoutMs: 60 }).fillAndSend('你好')).rejects.toThrow('Qwen 发送按钮暂不可用')
  })

  it('treats the stop button as generating and clicks it to stop', async () => {
    document.body.innerHTML = COMPOSER.replace('<button class="send-button" aria-label="Send"></button>', '<button class="stop-button" aria-label="Stop"></button>')
    const adapter = createQwenAdapter()
    const stop = vi.fn()
    document.querySelector('.stop-button')!.addEventListener('click', stop)

    expect(adapter.isGenerating()).toBe(true)
    await expect(adapter.stopGenerating()).resolves.toBe(true)
    expect(stop).toHaveBeenCalledTimes(1)

    document.body.innerHTML = COMPOSER
    expect(adapter.isGenerating()).toBe(false)
    await expect(adapter.stopGenerating()).resolves.toBe(false)
  })

  it('reads the Markdown the footer copy button puts on the clipboard, then restores the clipboard', async () => {
    let clipboardText = '用户原来的剪贴板'
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        readText: vi.fn(async () => clipboardText),
        writeText: vi.fn(async (text: string) => { clipboardText = text }),
      },
    })
    document.body.innerHTML = COMPOSER + FINISHED_TURN
    document.querySelector('.response-message-footer [aria-label="Copy"]')!.addEventListener('click', () => {
      clipboardText = '```python\ndef total(lst):\n    return sum(x for x in lst)\n```'
    })
    const adapter = createQwenAdapter({ clipboardPollMs: 5, clipboardTimeoutMs: 50 })

    const copied = await adapter.readResponseTextFromCopy?.(adapter.getResponseContainers()[0])

    expect(copied).toBe('```python\ndef total(lst):\n    return sum(x for x in lst)\n```')
    expect(clipboardText).toBe('用户原来的剪贴板')
  })

  it('reports the page as ready, generating, or on the login page', () => {
    const adapter = createQwenAdapter()
    document.body.innerHTML = COMPOSER
    expect(adapter.checkStatus?.({ pageAgeMs: 1000, now: 5 })).toEqual({ status: 'ready', timestamp: 5 })

    document.body.innerHTML = COMPOSER + '<button class="stop-button"></button>'
    expect(adapter.checkStatus?.({ pageAgeMs: 1000, now: 5 })).toEqual({ status: 'generating', timestamp: 5 })

    document.body.innerHTML = COMPOSER + '<button>Log in</button>' + AGE_MODAL
    expect(adapter.checkStatus?.({ pageAgeMs: 1000, now: 5 })).toEqual({ status: 'blocked', reason: 'overlay', detail: 'Confirm your age to continue What year were you born? Continue', timestamp: 5 })

    // A closed modal stays in the page with its wrapper hidden.
    document.querySelector<HTMLElement>('.ant-modal-wrap')!.style.display = 'none'
    expect(adapter.checkStatus?.({ pageAgeMs: 1000, now: 5 })).toEqual({ status: 'ready', reason: 'guest', timestamp: 5 })

    document.body.innerHTML = '<button>Log in</button>'
    window.history.replaceState(null, '', '/auth?action=signin')
    expect(adapter.checkStatus?.({ pageAgeMs: 1000, now: 5 })).toEqual({ status: 'unauthorized', reason: 'login', timestamp: 5 })
  })
})
