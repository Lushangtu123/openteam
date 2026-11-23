// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import axe from 'axe-core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createErrorPresenter, createSuccessPresenter } from './teamPageServices'

// The toast as team.html has it, beside the page's main content.
function toast(): HTMLElement {
  const html = readFileSync('public/team.html', 'utf8')
  const markup = html.match(/<div id="error"[^>]*><\/div>/)?.[0]
  if (!markup) throw new Error('no toast in team.html')
  document.body.innerHTML = `<main><h1>OpenTeam</h1><p>群聊</p></main>${markup}`
  return document.getElementById('error')!
}

describe('the toast', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('is read out: errors at once, success politely', () => {
    const element = toast()
    expect(element.getAttribute('role')).toBe('status')
    expect(element.getAttribute('aria-atomic')).toBe('true')
    createErrorPresenter(element)('HTTP 500: upstream overloaded')
    expect(element.getAttribute('aria-live')).toBe('assertive')
    expect(element.hidden).toBe(false)
    expect(element.textContent).toBe('HTTP 500: upstream overloaded')
    createSuccessPresenter(element)('已加入 2 位成员')
    expect(element.getAttribute('aria-live')).toBe('polite')
    expect(element.classList.contains('toast-success')).toBe(true)
  })

  it('keeps a message for its whole time when another came just before it', () => {
    const element = toast()
    const showError = createErrorPresenter(element)
    showError('第一条')
    vi.advanceTimersByTime(4_000)
    showError('第二条')
    vi.advanceTimersByTime(2_000)
    expect(element.hidden).toBe(false)
    expect(element.textContent).toBe('第二条')
    vi.advanceTimersByTime(3_300)
    expect(element.hidden).toBe(true)

    const showSuccess = createSuccessPresenter(element)
    showError('出错了')
    showSuccess('已保存')
    vi.advanceTimersByTime(2_300)
    expect(element.hidden).toBe(true)
    expect(element.classList.contains('toast-success')).toBe(false)
  })

  it('passes the accessibility check while it shows (every content in a landmark or live region)', async () => {
    vi.useRealTimers()
    const element = toast()
    createErrorPresenter(element)('HTTP 500: upstream overloaded')
    const result = await axe.run(document, { runOnly: ['region'] })
    expect(result.violations).toEqual([])
  })
})
