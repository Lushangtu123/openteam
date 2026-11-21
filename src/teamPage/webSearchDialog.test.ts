// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createDefaultStore } from '../group/store'
import type { OpenTeamStore } from '../group/types'
import { currentWebSearchDialog, openWebSearchDialog } from './webSearchDialog'

const KEY = 'tvly-dev-0123456789abcd'

function setup(saved?: string) {
  const store: OpenTeamStore = createDefaultStore()
  store.settings.language = 'zh-CN'
  if (saved) store.settings.webSearch = { provider: 'tavily', apiKey: saved }
  const runCommand = vi.fn(async (type: string, payload?: Record<string, unknown>) => {
    if (type === 'WEB_SEARCH_SAVE') {
      if (payload?.remove) delete store.settings.webSearch
      else store.settings.webSearch = { provider: 'tavily', apiKey: String(payload?.apiKey) }
    }
  })
  const request = vi.fn(async (_type: string, _payload?: Record<string, unknown>) => ({ ok: true, results: 1 } as Record<string, unknown>))
  const requestHostAccess = vi.fn(async (_url: string) => true)
  const confirm = vi.fn(() => true)
  const dialog = openWebSearchDialog({ getStore: () => store, runCommand, request, requestHostAccess, confirm })
  const $ = <T extends HTMLElement>(selector: string) => document.querySelector<T>(selector)!
  const button = (label: string) => [...document.querySelectorAll<HTMLButtonElement>('.web-search-dialog button')].find(node => node.textContent?.trim() === label)
  return { store, runCommand, request, requestHostAccess, confirm, dialog, $, button }
}

afterEach(() => currentWebSearchDialog()?.close())

describe('the 联网搜索 window', () => {
  it('saves a pasted key, asking for api.tavily.com from the click, and says so', async () => {
    const ctx = setup()
    expect(ctx.$('#web-search-title').textContent).toBe('联网搜索')
    expect(ctx.$('.web-search-state').textContent).toBe('还没有设置 Key，API 成员不会搜索。')
    expect(ctx.button('移除')!.hidden).toBe(true)
    expect(ctx.$<HTMLAnchorElement>('.web-search-dialog a').href).toBe('https://tavily.com/')
    ctx.$<HTMLInputElement>('#web-search-key').value = KEY
    ctx.button('保存')!.click()
    expect(ctx.requestHostAccess).toHaveBeenCalledWith('https://api.tavily.com/search')
    await vi.waitFor(() => expect(ctx.runCommand).toHaveBeenCalledWith('WEB_SEARCH_SAVE', { apiKey: KEY }))
    await vi.waitFor(() => expect(ctx.$('.web-search-saved').textContent).toBe('已保存。允许联网搜索的 API 成员回答时就能搜索了。'))
    expect(ctx.$<HTMLInputElement>('#web-search-key').value).toBe('')
    ctx.dialog.refresh()
    expect(ctx.$('.web-search-state').textContent).toBe('已设置：tvly-…abcd')
    expect(ctx.button('移除')!.hidden).toBe(false)
  })

  it('wants a key before saving, and warns when the site was not allowed', async () => {
    const ctx = setup()
    ctx.button('保存')!.click()
    expect(ctx.$('.team-form-error').textContent).toBe('填上 Tavily 的 API Key')
    expect(ctx.runCommand).not.toHaveBeenCalled()

    ctx.requestHostAccess.mockResolvedValueOnce(false)
    ctx.$<HTMLInputElement>('#web-search-key').value = KEY
    ctx.button('保存')!.click()
    await vi.waitFor(() => expect(ctx.$('.team-form-error').textContent).toBe('已保存，但没有允许 OpenTeam 访问 api.tavily.com，搜索会失败。点「测试」可以再允许一次。'))
  })

  it('tests the key being typed, or the saved one, and says why it failed', async () => {
    const ctx = setup(KEY)
    ctx.button('测试')!.click()
    expect(ctx.requestHostAccess).toHaveBeenCalledWith('https://api.tavily.com/search')
    expect(ctx.$('.web-search-test-status').textContent).toBe('正在搜索…')
    await vi.waitFor(() => expect(ctx.$('.web-search-test-status').textContent).toBe('能用：搜到了结果。'))
    expect(ctx.request).toHaveBeenCalledWith('WEB_SEARCH_TEST', {})

    ctx.$<HTMLInputElement>('#web-search-key').value = 'tvly-other'
    ctx.request.mockRejectedValueOnce(new Error('Tavily 的 API Key 不对或已失效'))
    ctx.button('测试')!.click()
    await vi.waitFor(() => expect(ctx.$('.web-search-test-status').textContent).toBe('Tavily 的 API Key 不对或已失效'))
    expect(ctx.request).toHaveBeenLastCalledWith('WEB_SEARCH_TEST', { apiKey: 'tvly-other' })

    ctx.requestHostAccess.mockResolvedValueOnce(false)
    ctx.button('测试')!.click()
    await vi.waitFor(() => expect(ctx.$('.web-search-test-status').textContent).toBe('需要你允许 OpenTeam 访问 api.tavily.com，搜索才能用。'))
  })

  it('removes the key after asking, and closes with Esc', async () => {
    const ctx = setup(KEY)
    ctx.confirm.mockReturnValueOnce(false)
    ctx.button('移除')!.click()
    expect(ctx.runCommand).not.toHaveBeenCalled()
    ctx.button('移除')!.click()
    expect(ctx.confirm).toHaveBeenLastCalledWith('移除 Tavily 的 API Key 吗？API 成员将不再搜索。')
    await vi.waitFor(() => expect(ctx.runCommand).toHaveBeenCalledWith('WEB_SEARCH_SAVE', { remove: true }))
    await vi.waitFor(() => expect(ctx.$('.web-search-state').textContent).toBe('还没有设置 Key，API 成员不会搜索。'))
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    expect(currentWebSearchDialog()).toBeUndefined()
  })
})
