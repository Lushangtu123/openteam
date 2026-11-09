// @vitest-environment jsdom

import { describe, expect, it } from 'vitest'
import { AI_PAGES_SHOWN_CLASS, createAiPagesView } from './aiPagesView'

function setup() {
  document.body.className = ''
  const appShellEl = document.createElement('main')
  const returnEl = document.createElement('button')
  const showPagesEl = document.createElement('button')
  returnEl.hidden = true
  const view = createAiPagesView({ appShellEl, returnEl, showPagesEl })
  view.registerAiPagesControls()
  return { appShellEl, returnEl, showPagesEl, view }
}

describe('AI pages view', () => {
  it('keeps OpenTeam in front until the pages are asked for', () => {
    const { appShellEl, returnEl, view } = setup()

    expect(view.isShowingAiPages()).toBe(false)
    expect(appShellEl.classList.contains(AI_PAGES_SHOWN_CLASS)).toBe(false)
    expect(returnEl.hidden).toBe(true)
  })

  it('shows the pages with a way back, and comes back from the button', () => {
    const { appShellEl, returnEl, showPagesEl, view } = setup()

    showPagesEl.click()

    expect(view.isShowingAiPages()).toBe(true)
    expect(appShellEl.classList.contains(AI_PAGES_SHOWN_CLASS)).toBe(true)
    expect(document.body.classList.contains(AI_PAGES_SHOWN_CLASS)).toBe(true)
    expect(returnEl.hidden).toBe(false)

    returnEl.click()

    expect(view.isShowingAiPages()).toBe(false)
    expect(document.body.classList.contains(AI_PAGES_SHOWN_CLASS)).toBe(false)
    expect(returnEl.hidden).toBe(true)
  })

  it('hides the pages from assistive technology only while OpenTeam covers them', () => {
    const { appShellEl, returnEl, view } = setup()
    const pagesHostEl = document.createElement('div')
    pagesHostEl.setAttribute('aria-hidden', 'true')
    const hostView = createAiPagesView({ appShellEl, returnEl, pagesHostEl })

    hostView.showAiPages(true)
    expect(pagesHostEl.hasAttribute('aria-hidden')).toBe(false)

    hostView.showAiPages(false)
    expect(pagesHostEl.getAttribute('aria-hidden')).toBe('true')
    expect(view.isShowingAiPages()).toBe(false)
  })

  it('gives the focus back to OpenTeam when coming back from the pages', () => {
    document.body.replaceChildren()
    const appShellEl = document.createElement('main')
    const returnEl = document.createElement('button')
    const searchEl = document.createElement('input')
    const messageInputEl = document.createElement('textarea')
    const pageFrameEl = document.createElement('button')
    appShellEl.append(searchEl, messageInputEl)
    document.body.append(appShellEl, returnEl, pageFrameEl)
    const view = createAiPagesView({ appShellEl, returnEl, homeFocusEl: messageInputEl })

    searchEl.focus()
    view.showAiPages(true)
    pageFrameEl.focus()
    view.showAiPages(false)
    expect(document.activeElement).toBe(searchEl)

    // The element focused before is gone: the message box takes the focus.
    searchEl.focus()
    view.showAiPages(true)
    searchEl.remove()
    pageFrameEl.focus()
    view.showAiPages(false)
    expect(document.activeElement).toBe(messageInputEl)
  })

  it('comes back on Escape only while the pages are shown', () => {
    const { view } = setup()

    const ignored = new KeyboardEvent('keydown', { key: 'Escape', cancelable: true })
    document.dispatchEvent(ignored)
    expect(ignored.defaultPrevented).toBe(false)

    view.showAiPages(true)
    const handled = new KeyboardEvent('keydown', { key: 'Escape', cancelable: true })
    document.dispatchEvent(handled)

    expect(handled.defaultPrevented).toBe(true)
    expect(view.isShowingAiPages()).toBe(false)
  })
})
