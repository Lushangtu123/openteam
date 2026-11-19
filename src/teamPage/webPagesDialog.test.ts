// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { openWebPagesDialog, type OpenTab } from './webPagesDialog'

afterEach(() => {
  document.body.innerHTML = ''
})

const TABS: OpenTab[] = [
  { id: 1, url: 'https://a.com/intro', title: '产品 A 介绍' },
  { id: 2, url: 'https://b.com/intro', title: '产品 B 介绍' },
  { id: 3, url: 'http://old.example/page', title: '老网站' },
  { id: 4, url: 'chrome-extension://abc/team.html', title: 'OpenTeam' },
  { id: 5, url: 'https://a.com/pricing', title: '产品 A 价格' },
  { id: 6, url: 'https://c.com/', title: 'C' },
  { id: 7, url: 'https://d.com/', title: 'D' },
  { id: 8, url: 'https://e.com/', title: 'E' },
]

async function setup(options: { tabs?: OpenTab[]; granted?: boolean; failed?: Array<{ title: string; reason: string }>; readError?: string } = {}) {
  const deps = {
    english: false,
    listTabs: vi.fn(async () => options.tabs ?? TABS),
    requestAccess: vi.fn(async (_patterns: string[]) => options.granted ?? true),
    readPages: vi.fn(async (_tabs: Array<{ tabId: number; url: string }>) => {
      if (options.readError) throw new Error(options.readError)
      return { upload: { fileName: '网页对比-2个网页.md', mimeType: 'text/markdown', text: '# 网页对比' }, failed: options.failed ?? [] }
    }),
    addFile: vi.fn(),
    showError: vi.fn(),
  }
  await openWebPagesDialog(deps)
  const boxes = () => [...document.querySelectorAll<HTMLInputElement>('.web-page-choice input')]
  const tick = (...indexes: number[]) => { for (const index of indexes) { boxes()[index].checked = true } ; document.querySelector('.web-pages-form')!.dispatchEvent(new Event('change')) }
  const submit = () => document.querySelector<HTMLFormElement>('.web-pages-form')!.dispatchEvent(new Event('submit', { cancelable: true }))
  return { deps, boxes, tick, submit }
}

describe('the window that attaches open pages', () => {
  it('lists the readable pages of this window, an http one shown but not tickable', async () => {
    const { boxes } = await setup()
    const titles = [...document.querySelectorAll('.web-page-choice-title')].map(node => node.textContent)
    expect(titles).toEqual(['产品 A 介绍', '产品 B 介绍', '老网站', '产品 A 价格', 'C', 'D', 'E'])
    expect(boxes()[2].disabled).toBe(true)
    expect(document.querySelectorAll('.web-page-choice-note')).toHaveLength(1)
    expect(document.querySelector('.web-pages-count')?.textContent).toBe('已选 0/5')
  })

  it('takes at most five', async () => {
    const { boxes, tick } = await setup()
    tick(0, 1, 3, 4, 5)
    expect(document.querySelector('.web-pages-count')?.textContent).toBe('已选 5/5')
    expect(boxes()[6].disabled).toBe(true)
  })

  it('asks for the ticked pages\' sites once, reads them, and adds the file to the message', async () => {
    const { deps, tick, submit } = await setup()
    tick(0, 1, 3)
    submit()
    await vi.waitFor(() => expect(deps.addFile).toHaveBeenCalled())
    expect(deps.requestAccess).toHaveBeenCalledWith(['https://a.com/*', 'https://b.com/*'])
    expect(deps.readPages).toHaveBeenCalledWith([{ tabId: 1, url: 'https://a.com/intro' }, { tabId: 2, url: 'https://b.com/intro' }, { tabId: 5, url: 'https://a.com/pricing' }])
    const file = deps.addFile.mock.calls[0][0] as File
    expect([file.name, file.type]).toEqual(['网页对比-2个网页.md', 'text/markdown'])
    expect(document.querySelector('.web-pages-modal')).toBeNull()
  })

  it('reads nothing when access is not given, and says what was left out', async () => {
    const refused = await setup({ granted: false })
    refused.tick(0)
    refused.submit()
    await vi.waitFor(() => expect(document.querySelector('.team-form-error')?.textContent).toBe('没有得到访问这些网站的许可，网页没有附上。'))
    expect(refused.deps.readPages).not.toHaveBeenCalled()
    document.body.innerHTML = ''

    const partly = await setup({ failed: [{ title: '产品 B 介绍', reason: '已经关掉了' }] })
    partly.tick(0, 1)
    partly.submit()
    await vi.waitFor(() => expect(partly.deps.showError).toHaveBeenCalledWith('有 1 个网页没附上：「产品 B 介绍」已经关掉了'))
  })

  it('shows a read error in the window, and says when nothing can be attached', async () => {
    const failing = await setup({ readError: '没有读到网页：「A」读不了' })
    failing.tick(0)
    failing.submit()
    await vi.waitFor(() => expect(document.querySelector('.team-form-error')?.textContent).toBe('没有读到网页：「A」读不了'))
    document.body.innerHTML = ''
    await setup({ tabs: [{ id: 4, url: 'chrome-extension://abc/team.html', title: 'OpenTeam' }] })
    expect(document.querySelector<HTMLElement>('.web-pages-empty')?.hidden).toBe(false)
  })
})
