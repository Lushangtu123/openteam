// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest'
import { applyTeamLanguage, createLanguageSettingsController } from './languageController'

describe('team page language controller', () => {
  it('renders English by default and can restore Chinese copy', () => {
    document.body.innerHTML = `
      <button id="settings-button" aria-label="设置" data-tooltip="设置">⚙</button>
      <button id="agent-control-toggle">本机智能体控制：关闭</button>
      <p id="agent-control-status">端口 19305，仅允许本机连接。开启后本机工具可创建群聊并发送任务。</p>
      <textarea id="message-input" placeholder="输入消息，@成员 让他回复；不 @ 只记在群里"></textarea>
    `

    applyTeamLanguage('en')

    expect(document.documentElement.lang).toBe('en')
    expect(document.querySelector<HTMLButtonElement>('#settings-button')?.ariaLabel).toBe('Settings')
    expect(document.querySelector<HTMLButtonElement>('#agent-control-toggle')?.textContent).toBe('Local agent control: Off')
    expect(document.querySelector<HTMLTextAreaElement>('#message-input')?.placeholder).toBe('Message the group; @ a member to get a reply, or it is only recorded')

    applyTeamLanguage('zh-CN')

    expect(document.documentElement.lang).toBe('zh-CN')
    expect(document.querySelector<HTMLButtonElement>('#settings-button')?.ariaLabel).toBe('设置')
    expect(document.querySelector<HTMLButtonElement>('#agent-control-toggle')?.textContent).toBe('本机智能体控制：关闭')
  })

  it('translates an attribute the page changed after an earlier pass, instead of putting the old one back', () => {
    document.body.innerHTML = `<textarea id="message-input" placeholder="输入消息，@成员 让他回复；不 @ 只记在群里"></textarea>`
    const input = document.querySelector<HTMLTextAreaElement>('#message-input')!
    applyTeamLanguage('zh-CN')
    input.placeholder = '输入消息，所有成员都会回复；@成员 只问他'
    applyTeamLanguage('zh-CN')
    expect(input.placeholder).toBe('输入消息，所有成员都会回复；@成员 只问他')
    applyTeamLanguage('en')
    expect(input.placeholder).toBe('Message the group; every member replies, or @ one to ask only them')
    applyTeamLanguage('zh-CN')
    expect(input.placeholder).toBe('输入消息，所有成员都会回复；@成员 只问他')
  })

  it('does not touch the page when the language pass has nothing to change', () => {
    document.body.innerHTML = `
      <button id="settings-button" aria-label="设置" title="设置">设置</button>
      <span class="site-pill">ChatGPT</span>
    `
    for (const language of ['en', 'zh-CN'] as const) {
      applyTeamLanguage(language)
      const observer = new MutationObserver(() => undefined)
      observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true })

      applyTeamLanguage(language)

      expect(observer.takeRecords()).toEqual([])
      observer.disconnect()
    }
  })

  it('persists language changes from the settings switch', () => {
    document.body.innerHTML = `
      <button id="language-en" aria-pressed="false">English</button>
      <button id="language-zh" aria-pressed="true">中文</button>
    `
    const runCommand = vi.fn(async () => undefined)
    const controller = createLanguageSettingsController({
      englishButton: document.querySelector<HTMLButtonElement>('#language-en')!,
      chineseButton: document.querySelector<HTMLButtonElement>('#language-zh')!,
      getLanguage: () => 'zh-CN',
      runCommand,
      showError: vi.fn(),
    })

    controller.render()
    controller.registerEvents()
    document.querySelector<HTMLButtonElement>('#language-en')!.click()

    expect(runCommand).toHaveBeenCalledWith('GROUP_SETTINGS_UPDATE', { language: 'en' })
  })

  it('applies the selected language immediately while the setting is being saved', () => {
    document.body.innerHTML = `
      <button id="language-en" aria-pressed="true">English</button>
      <button id="language-zh" aria-pressed="false">中文</button>
      <button id="agent-control-toggle">本机智能体控制：关闭</button>
    `
    const runCommand = vi.fn(() => new Promise<void>(() => undefined))
    const controller = createLanguageSettingsController({
      englishButton: document.querySelector<HTMLButtonElement>('#language-en')!,
      chineseButton: document.querySelector<HTMLButtonElement>('#language-zh')!,
      getLanguage: () => 'en',
      runCommand,
      showError: vi.fn(),
    })

    controller.render()
    expect(document.querySelector<HTMLButtonElement>('#agent-control-toggle')?.textContent).toBe('Local agent control: Off')

    controller.registerEvents()
    document.querySelector<HTMLButtonElement>('#language-zh')!.click()

    expect(document.documentElement.lang).toBe('zh-CN')
    expect(document.querySelector<HTMLButtonElement>('#language-zh')?.getAttribute('aria-pressed')).toBe('true')
    expect(document.querySelector<HTMLButtonElement>('#agent-control-toggle')?.textContent).toBe('本机智能体控制：关闭')
    expect(runCommand).toHaveBeenCalledWith('GROUP_SETTINGS_UPDATE', { language: 'zh-CN' })
  })

  it('translates dynamically rendered role panel status copy', () => {
    document.body.innerHTML = `
      <aside>
        <span>尚未读取消息</span>
        <span>等待连接</span>
        <span>已读 3 条</span>
        <span>网页已连接</span>
        <span>连接 API</span>
        <span>在线</span>
        <span>进行中</span>
        <span>协作群聊模式 · 2 位成员 · 3 条消息</span>
      </aside>
    `

    applyTeamLanguage('en')

    expect(document.body.textContent).toContain('No messages read yet')
    expect(document.body.textContent).toContain('Waiting to connect')
    expect(document.body.textContent).toContain('Read 3 messages')
    expect(document.body.textContent).toContain('Web connected')
    expect(document.body.textContent).toContain('API connected')
    expect(document.body.textContent).toContain('Online')
    expect(document.body.textContent).toContain('Active')
    expect(document.body.textContent).toContain('Collaborative mode · 2 members · 3 messages')

    applyTeamLanguage('zh-CN')

    expect(document.body.textContent).toContain('尚未读取消息')
    expect(document.body.textContent).toContain('等待连接')
  })

  it('translates message controls without translating message bodies', () => {
    document.body.innerHTML = `
      <section id="messages">
        <article>
          <div class="message-body">进行中</div>
          <div class="message-tools">
            <button aria-label="重新回复">↻</button>
          </div>
        </article>
      </section>
    `

    applyTeamLanguage('en')

    expect(document.querySelector('.message-body')?.textContent).toBe('进行中')
    expect(document.querySelector<HTMLButtonElement>('.message-tools button')?.ariaLabel).toBe('Retry reply')
  })

  it('leaves everything inside skipped regions alone except form field placeholders', () => {
    document.body.innerHTML = `
      <section id="messages">
        <div class="message-body" title="设置">进行中<span aria-label="重新回复">设置</span></div>
        <button aria-label="重新回复">设置</button>
      </section>
      <div class="notes-editor">
        <p title="设置">进行中</p>
        <textarea placeholder="输入消息，@成员 让他回复；不 @ 只记在群里"></textarea>
      </div>
    `

    applyTeamLanguage('en')

    const body = document.querySelector<HTMLElement>('.message-body')!
    expect(body.textContent).toBe('进行中设置')
    expect(body.title).toBe('设置')
    expect(body.querySelector('span')?.getAttribute('aria-label')).toBe('重新回复')
    expect(document.querySelector('#messages > button')?.getAttribute('aria-label')).toBe('Retry reply')
    expect(document.querySelector('#messages > button')?.textContent).toBe('Settings')
    expect(document.querySelector<HTMLElement>('.notes-editor p')?.title).toBe('设置')
    expect(document.querySelector<HTMLTextAreaElement>('.notes-editor textarea')?.placeholder).toBe('Message the group; @ a member to get a reply, or it is only recorded')

    applyTeamLanguage('en', body.querySelector('span')!)
    expect(body.querySelector('span')?.textContent).toBe('设置')
    expect(body.querySelector('span')?.getAttribute('aria-label')).toBe('重新回复')
  })
})
