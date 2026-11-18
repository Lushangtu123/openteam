// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest'
import { WEB_PAGE_OFFER_TTL_MS, type WebPageOffer } from '../group/webPage'
import { createWebPageOfferView } from './webPageOfferView'

const NOW = 1_800_000_000_000
const OFFER: WebPageOffer = { tabId: 7, url: 'https://example.com/post', title: 'Rust 发布说明', offeredAt: NOW - 1000 }

function setup(saved: unknown, options: { readFails?: string; language?: 'en' | 'zh-CN' } = {}) {
  document.body.innerHTML = '<div id="web-page-offer" hidden></div>'
  let listener: ((value: unknown) => void) | undefined
  const addFile = vi.fn()
  const showError = vi.fn()
  const dismiss = vi.fn(async () => undefined)
  const readPage = vi.fn(async () => {
    if (options.readFails) throw new Error(options.readFails)
    return { fileName: '网页-Rust 发布说明.md', mimeType: 'text/markdown', text: '# Rust 发布说明\n' }
  })
  const view = createWebPageOfferView({
    element: document.getElementById('web-page-offer')!,
    ui: source => options.language === 'en' ? ({ '刚才的网页': 'The page you were on', '附上': 'Attach', '不附上': 'Don’t attach' } as Record<string, string>)[source] ?? source : source,
    storage: { get: async () => saved, onChange: next => { listener = next } },
    readPage,
    dismiss,
    addFile,
    showError,
    now: () => NOW,
  })
  const element = () => document.getElementById('web-page-offer')!
  const buttons = () => [...element().querySelectorAll('button')]
  return { view, element, buttons, addFile, showError, dismiss, readPage, push: (value: unknown) => listener?.(value) }
}

describe('the page the user was on, offered in the composer', () => {
  it('shows the page’s title and site, and reads nothing yet', async () => {
    const { view, element, buttons, readPage } = setup(OFFER)
    await view.start()
    expect(element().hidden).toBe(false)
    expect(element().textContent).toContain('刚才的网页')
    expect(element().textContent).toContain('Rust 发布说明')
    expect(element().textContent).toContain('example.com')
    expect(buttons().map(button => button.textContent || button.getAttribute('aria-label'))).toEqual(['附上', '不附上'])
    expect(buttons()[1].querySelector('svg')).not.toBeNull()
    expect(readPage).not.toHaveBeenCalled()
  })

  it('attaches the page as a file when asked, and goes away', async () => {
    const { view, element, buttons, addFile } = setup(OFFER)
    await view.start()
    buttons()[0].click()
    await vi.waitFor(() => expect(addFile).toHaveBeenCalled())
    const file = addFile.mock.calls[0][0] as File
    expect(file.name).toBe('网页-Rust 发布说明.md')
    expect(file.type).toBe('text/markdown')
    expect(await file.text()).toBe('# Rust 发布说明\n')
    expect(element().hidden).toBe(true)
  })

  it('says why when the page cannot be read', async () => {
    const { view, element, buttons, showError, addFile } = setup(OFFER, { readFails: '那个网页已经关掉了' })
    await view.start()
    buttons()[0].click()
    await vi.waitFor(() => expect(showError).toHaveBeenCalledWith('那个网页已经关掉了'))
    expect(addFile).not.toHaveBeenCalled()
    expect(element().hidden).toBe(true)
  })

  it('can be turned down', async () => {
    const { view, element, buttons, dismiss } = setup(OFFER)
    await view.start()
    buttons()[1].click()
    await vi.waitFor(() => expect(dismiss).toHaveBeenCalled())
    expect(element().hidden).toBe(true)
  })

  it('follows a new offer while the page is open, and keeps its buttons while it is the same', async () => {
    const { view, element, push } = setup(undefined)
    await view.start()
    expect(element().hidden).toBe(true)
    push(OFFER)
    const attach = element().querySelector('button')!
    view.render()
    push({ ...OFFER })
    expect(element().querySelector('button')).toBe(attach)
    push({ ...OFFER, title: '另一个网页', offeredAt: NOW })
    expect(element().textContent).toContain('另一个网页')
    push(undefined)
    expect(element().hidden).toBe(true)
  })

  it('shows nothing for an old or broken offer', async () => {
    for (const saved of [{ ...OFFER, offeredAt: NOW - WEB_PAGE_OFFER_TTL_MS - 1 }, { title: 'x' }, 'junk']) {
      const { view, element } = setup(saved)
      await view.start()
      expect(element().hidden).toBe(true)
    }
  })

  it('speaks the page’s language', async () => {
    const { view, element, buttons } = setup(OFFER, { language: 'en' })
    await view.start()
    expect(element().textContent).toContain('The page you were on')
    expect(buttons()[0].textContent).toBe('Attach')
  })
})
