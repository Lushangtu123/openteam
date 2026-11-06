// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createKimiAdapter, kimiPasteChunks } from './kimi'

// jsdom has neither DataTransfer nor ClipboardEvent with clipboardData; these do what the browser does.
class FakeDataTransfer {
  private readonly data = new Map<string, string>()
  setData(type: string, value: string): void { this.data.set(type, value) }
  getData(type: string): string { return this.data.get(type) ?? '' }
}

class FakeClipboardEvent extends Event {
  readonly clipboardData: FakeDataTransfer
  constructor(type: string, init: EventInit & { clipboardData: FakeDataTransfer }) {
    super(type, init)
    this.clipboardData = init.clipboardData
  }
}

beforeEach(() => {
  vi.stubGlobal('DataTransfer', FakeDataTransfer)
  vi.stubGlobal('ClipboardEvent', FakeClipboardEvent)
})

afterEach(() => {
  vi.unstubAllGlobals()
  document.body.replaceChildren()
})

const COMPOSER = `
  <div class="chat-editor">
    <div class="chat-editor-attachment-area"></div>
    <div class="chat-input"><div class="chat-input-editor-container">
      <div class="chat-input-editor" role="textbox" contenteditable="true" data-lexical-editor="true"><p><br></p></div>
    </div></div>
    <div class="send-button-container disabled"><svg name="Send"></svg></div>
  </div>
  <div class="chat-content-list"></div>`

// Stands in for Kimi's Lexical editor, as it behaved on the live site: deleteContentBackward on a
// full selection empties it, a paste appends its text, and a paste over 1,500 characters becomes a
// .txt attachment instead. The send button is enabled while there is something to send.
function installKimiComposer(): { editor: HTMLElement; sendButton: HTMLElement; pastes: string[]; text(): string } {
  document.body.innerHTML = COMPOSER
  const editor = document.querySelector<HTMLElement>('.chat-input-editor')!
  const sendButton = document.querySelector<HTMLElement>('.send-button-container')!
  const pastes: string[] = []
  let value = ''
  const render = () => {
    editor.replaceChildren(...value.split('\n').map(line => Object.assign(document.createElement('p'), { textContent: line })))
    sendButton.classList.toggle('disabled', !value && !document.querySelector('.file-card-container'))
  }
  editor.addEventListener('beforeinput', event => {
    if ((event as InputEvent).inputType === 'deleteContentBackward') value = ''
    event.preventDefault()
    render()
  })
  editor.addEventListener('paste', event => {
    const text = (event as unknown as FakeClipboardEvent).clipboardData.getData('text/plain')
    pastes.push(text)
    event.preventDefault()
    if (text.length > 1500) {
      document.querySelector('.chat-editor-attachment-area')!.insertAdjacentHTML('beforeend', '<div class="file-card-container normal success"><div class="file-card-delete"></div></div>')
    } else {
      value += text
    }
    render()
  })
  return { editor, sendButton, pastes, text: () => value }
}

const TIPS_MODAL = `
  <div class="modal-mask"><div class="modal-container">
    <div class="header"><div class="title">Tips</div></div>
    <div class="content">Too many people are chatting with Kimi; a subscription will grant you priority access.</div>
    <div class="bottom"><button class="km-button">Got it</button> <button class="km-button">Upgrade</button></div>
  </div></div>`

// A finished turn, as recorded from the live site: the answer sits in a tool-call rollup next to a
// thinking part, and the actions row has the Copy icon.
const FINISHED_TURN = `
  <div class="chat-content-item chat-content-item-user"><div class="segment segment-user"><div class="segment-content-box">你好</div></div></div>
  <div class="chat-content-item chat-content-item-assistant">
    <div class="segment segment-assistant"><div class="segment-container"><div class="segment-content">
      <div class="segment-content-box"><div class="toolcall-rollup">
        <div class="toolcall-rollup__part toolcall-container"><div class="markdown-container toolcall-content-text"><div class="markdown"><p>先想一想</p></div></div></div>
        <div class="toolcall-rollup__part toolcall-rollup__flat"><div class="markdown-container"><div class="markdown">
          <h2>结论</h2>
          <div class="paragraph">我是 <strong>Kimi</strong>。</div>
          <ul><li>长文本</li><li>搜索</li></ul>
          <div class="segment-code">
            <div class="sticky-release"><div class="sticky-release-rail"><div class="sticky-release-header">
              <header class="segment-code-header"><div class="segment-code-header-content"><span>Python</span><div class="icon-button">Copy</div></div></header>
            </div></div></div>
            <div class="syntax-highlighter light segment-code-content"><pre class="language-python"><code class="language-python"><span class="token keyword">print</span><span class="token punctuation">(</span>"hi"<span class="token punctuation">)</span></code></pre></div>
          </div>
        </div></div></div>
        <div class="toolcall-rollup__tail"></div>
      </div></div>
      <div class="segment-assistant-actions"><div class="segment-assistant-actions-content">
        <div class="icon-button"><svg name="Copy"></svg></div>
        <div class="icon-button"><svg name="Refresh"></svg></div>
      </div></div>
    </div></div></div>
  </div>`

describe('Kimi site adapter', () => {
  it('reads the conversation id from www.kimi.com links only', () => {
    expect(createKimiAdapter({ href: 'https://www.kimi.com/chat/d0ilaujof8jjl1c6u7vg?chat_enter_method=history' }).getConversationSnapshot()).toEqual({
      conversationId: 'd0ilaujof8jjl1c6u7vg',
      conversationUrl: 'https://www.kimi.com/chat/d0ilaujof8jjl1c6u7vg?chat_enter_method=history',
    })
    expect(createKimiAdapter({ href: 'https://www.kimi.com/' }).getConversationId()).toBe('__default__')
    expect(createKimiAdapter({ href: 'https://www.kimi.com.evil.example/chat/abc' }).getConversationSnapshot()).toEqual({})
  })

  it('splits a prompt into pastes under Kimi\'s attachment cutoff without breaking an emoji', () => {
    const prompt = `${'a'.repeat(999)}😀${'b'.repeat(1500)}\r\nend`
    const chunks = kimiPasteChunks(prompt)

    expect(chunks.every(chunk => chunk.length <= 1000)).toBe(true)
    expect(chunks[0]).toBe('a'.repeat(999))
    expect(chunks[1].startsWith('😀')).toBe(true)
    expect(chunks.join('')).toBe(prompt.replace('\r\n', '\n'))
    expect(kimiPasteChunks('')).toEqual([])
  })

  it('types a long prompt in as text, clicks send and waits for the new turn', async () => {
    const composer = installKimiComposer()
    composer.editor.insertAdjacentHTML('afterbegin', '<p>旧草稿</p>')
    const prompt = Array.from({ length: 300 }, (_, index) => `第 ${index + 1} 行：讨论内容`).join('\n')
    const send = vi.fn(() => {
      composer.editor.replaceChildren()
      document.querySelector('.chat-content-list')!.insertAdjacentHTML('beforeend', '<div class="chat-content-item chat-content-item-user"></div><div class="chat-content-item chat-content-item-assistant"></div>')
    })
    composer.sendButton.addEventListener('click', send)

    await createKimiAdapter().fillAndSend(prompt)

    expect(prompt.length).toBeGreaterThan(1500)
    expect(composer.pastes.length).toBeGreaterThan(1)
    expect(composer.pastes.every(paste => paste.length <= 1000)).toBe(true)
    expect(composer.text()).toBe(prompt)
    expect(document.querySelector('.file-card-container')).toBeNull()
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('leaves the prompt in the box without sending when asked to', async () => {
    const composer = installKimiComposer()
    const send = vi.fn()
    composer.sendButton.addEventListener('click', send)

    await createKimiAdapter().fillAndSend('第一行\n\n第三行', false)

    expect(composer.text()).toBe('第一行\n\n第三行')
    expect(send).not.toHaveBeenCalled()
  })

  it('fails with the dialog\'s text when Kimi refuses the message', async () => {
    const composer = installKimiComposer()
    // Kimi empties the box on click and then shows its "too many people" tip instead of sending.
    composer.sendButton.addEventListener('click', () => {
      composer.editor.replaceChildren()
      document.body.insertAdjacentHTML('beforeend', TIPS_MODAL)
    })

    await expect(createKimiAdapter().fillAndSend('你好')).rejects.toThrow('Kimi 页面上有弹窗挡住了发送：「Tips Too many people are chatting with Kimi; a subscription will grant you priority access. Got it Upgrade」')

    // With the dialog still open, nothing is typed.
    const pastesBefore = composer.pastes.length
    await expect(createKimiAdapter().fillAndSend('再试一次')).rejects.toThrow('Kimi 页面上有弹窗挡住了发送')
    expect(composer.pastes.length).toBe(pastesBefore)
  })

  it('fails when Kimi shows the question, then goes back and puts the prompt in the box again', async () => {
    const composer = installKimiComposer()
    // A usage limit, as seen on the live site: the box empties and the question shows as a turn,
    // then the page goes back to the start with the prompt in the box and no reply.
    composer.sendButton.addEventListener('click', () => {
      composer.editor.replaceChildren()
      document.querySelector('.chat-content-list')!.insertAdjacentHTML('beforeend', '<div class="chat-content-item chat-content-item-user"></div>')
      window.setTimeout(() => {
        document.querySelector('.chat-content-list')!.replaceChildren()
        composer.editor.replaceChildren(Object.assign(document.createElement('p'), { textContent: '你好' }))
      }, 300)
    })

    await expect(createKimiAdapter().fillAndSend('你好')).rejects.toThrow('Kimi 没有发出这条消息')
  })

  it('counts the message as sent once Kimi starts generating', async () => {
    const composer = installKimiComposer()
    // As on the live site: the box empties and the send button switches to its stop state.
    composer.sendButton.addEventListener('click', () => {
      composer.editor.replaceChildren()
      window.setTimeout(() => {
        composer.sendButton.classList.add('disabled', 'stop')
        composer.sendButton.querySelector('svg')!.setAttribute('name', 'stop')
      }, 50)
    })
    const startedAt = Date.now()

    await createKimiAdapter().fillAndSend('你好')

    expect(Date.now() - startedAt).toBeLessThan(2000)
  })

  it('fails when the click on Send changes nothing, and says to sign in on a signed-out page', async () => {
    installKimiComposer()

    await expect(createKimiAdapter({ sendConfirmMs: 300 }).fillAndSend('你好')).rejects.toThrow('Kimi 没有发出这条消息（可能是使用额度用完或排队人数太多）')

    document.body.insertAdjacentHTML('beforeend', '<button>Log in</button>')
    await expect(createKimiAdapter({ sendConfirmMs: 300 }).fillAndSend('你好')).rejects.toThrow('Kimi 没有发出这条消息：这个页面还没有登录 Kimi')
  })

  it('reports a prompt that Kimi turned into an attachment', async () => {
    const composer = installKimiComposer()
    // Should Kimi lower its cutoff below the chunk size, the first paste becomes a file.
    composer.editor.addEventListener('paste', event => {
      event.stopImmediatePropagation()
      event.preventDefault()
      document.querySelector('.chat-editor-attachment-area')!.insertAdjacentHTML('beforeend', '<div class="file-card-container"></div>')
    }, { capture: true, once: true })

    await expect(createKimiAdapter().fillAndSend('x'.repeat(2500), false)).rejects.toThrow('Kimi 把输入的内容转成了附件')
  })

  it('reads only the answer, without the thinking part', () => {
    document.body.innerHTML = COMPOSER + FINISHED_TURN
    const adapter = createKimiAdapter()
    const [turn] = adapter.getResponseContainers()

    expect(adapter.readResponseMarkdown?.(turn)).toBe('## 结论\n\n我是 **Kimi**。\n\n- 长文本\n- 搜索\n\n```\nprint("hi")\n```')
    expect(adapter.readResponseText(turn)).not.toContain('先想一想')
    expect(adapter.readResponseText(turn)).not.toMatch(/Python|Copy/)
    expect(adapter.getAllAssistantReplies()).toHaveLength(1)
    expect(adapter.findResponseContainer(turn.querySelector('strong'))).toBe(turn)
    expect(adapter.findResponseContainer(document.querySelector('.segment-user'))).toBeNull()
  })

  it('reads the Markdown the Copy icon puts on the clipboard, then restores the clipboard', async () => {
    let clipboardText = '用户原来的剪贴板'
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        readText: vi.fn(async () => clipboardText),
        writeText: vi.fn(async (text: string) => { clipboardText = text }),
      },
    })
    document.body.innerHTML = COMPOSER + FINISHED_TURN
    document.querySelector('svg[name="Copy"]')!.closest('.icon-button')!.addEventListener('click', () => {
      clipboardText = '## 结论\n\n我是 **Kimi**。'
    })
    const adapter = createKimiAdapter({ clipboardPollMs: 5, clipboardTimeoutMs: 50 })

    await expect(adapter.readResponseTextFromCopy?.(adapter.getResponseContainers()[0])).resolves.toBe('## 结论\n\n我是 **Kimi**。')
    expect(clipboardText).toBe('用户原来的剪贴板')
  })

  it('treats the send button\'s stop state as generating and clicks it to stop', async () => {
    // As on the live site while Kimi writes: "disabled" (the box is empty) plus "stop", and a
    // lowercase stop icon.
    document.body.innerHTML = COMPOSER.replace('<div class="send-button-container disabled"><svg name="Send"></svg></div>', '<div class="send-button-container disabled stop"><svg name="stop"></svg></div>')
    const adapter = createKimiAdapter()
    const stop = vi.fn()
    document.querySelector('.send-button-container')!.addEventListener('click', stop)

    expect(adapter.isGenerating()).toBe(true)
    expect(adapter.checkStatus?.({ pageAgeMs: 1000, now: 5 })).toEqual({ status: 'generating', timestamp: 5 })
    await expect(adapter.stopGenerating()).resolves.toBe(true)
    expect(stop).toHaveBeenCalledTimes(1)

    document.body.innerHTML = COMPOSER
    expect(adapter.isGenerating()).toBe(false)
  })

  it('reports the page as ready, or blocked by an open dialog', () => {
    const adapter = createKimiAdapter()
    document.body.innerHTML = COMPOSER
    expect(adapter.checkStatus?.({ pageAgeMs: 1000, now: 5 })).toEqual({ status: 'ready', timestamp: 5 })

    document.body.insertAdjacentHTML('beforeend', TIPS_MODAL)
    expect(adapter.checkStatus?.({ pageAgeMs: 1000, now: 5 })).toMatchObject({ status: 'blocked', reason: 'overlay', detail: expect.stringContaining('Too many people are chatting with Kimi') })

    document.querySelector<HTMLElement>('.modal-mask')!.style.display = 'none'
    expect(adapter.checkStatus?.({ pageAgeMs: 1000, now: 5 })).toEqual({ status: 'ready', timestamp: 5 })
  })
})
