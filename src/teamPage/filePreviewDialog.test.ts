// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { isMarkdownFile, openFilePreview } from './filePreviewDialog'

afterEach(() => {
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

const PAGES = '# 网页对比（2 个网页）\n\n## 1. 产品 A\n\n网址：https://a.com/\n\n**价格** 99 元\n\n## 2. 产品 B\n\n正文'

describe('previewing an attached text file', () => {
  it('lays out Markdown as it reads, with the file name and size', () => {
    openFilePreview({ fileName: '网页对比-2个网页.md', text: PAGES, mimeType: 'text/markdown' }, { english: false })
    expect(document.querySelector('#file-preview-title')?.textContent).toBe('网页对比-2个网页.md')
    expect(document.querySelector('.file-preview-size')?.textContent).toBe(`${new TextEncoder().encode(PAGES).length} B · ${[...PAGES].length} 字`)
    const body = document.querySelector('.file-preview-body')!
    expect(body.querySelector('h1')?.textContent).toBe('网页对比（2 个网页）')
    expect([...body.querySelectorAll('h2')].map(node => node.textContent)).toEqual(['1. 产品 A', '2. 产品 B'])
    expect(body.querySelector('strong')?.textContent).toBe('价格')
    expect(document.activeElement).toBe(body)
  })

  it('shows other text as it is', () => {
    openFilePreview({ fileName: 'data.csv', text: 'a,b\n1,2', mimeType: 'text/csv' }, { english: false })
    expect(document.querySelector('.file-preview-text')?.textContent).toBe('a,b\n1,2')
    expect(isMarkdownFile({ fileName: 'notes.MD' })).toBe(true)
    expect(isMarkdownFile({ fileName: 'x.txt', mimeType: 'text/markdown' })).toBe(true)
  })

  it('downloads the file, and closes on Esc or the button', () => {
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined)
    URL.createObjectURL = vi.fn(() => 'blob:x')
    URL.revokeObjectURL = vi.fn()
    const onClose = vi.fn()
    openFilePreview({ fileName: 'a.md', text: '# A' }, { english: false, onClose })
    const buttons = [...document.querySelectorAll<HTMLButtonElement>('.file-preview-actions button')]
    expect(buttons.map(button => button.textContent)).toEqual(['下载', '关闭'])
    buttons[0].click()
    expect(click).toHaveBeenCalledTimes(1)
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    expect(document.querySelector('.file-preview-modal')).toBeNull()
    expect(onClose).toHaveBeenCalled()
  })
})
