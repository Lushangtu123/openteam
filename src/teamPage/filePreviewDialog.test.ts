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

describe('editing an attached file before it is sent', () => {
  it('is offered only when the file can still change', () => {
    openFilePreview({ fileName: 'a.md', text: '# A' }, { english: false })
    expect([...document.querySelectorAll('.file-preview-actions button')].map(node => node.textContent)).toEqual(['下载', '关闭'])
    document.body.innerHTML = ''
    openFilePreview({ fileName: 'a.md', text: '# A' }, { english: false, onSave: () => undefined })
    expect([...document.querySelectorAll('.file-preview-actions button')].map(node => node.textContent)).toEqual(['下载', '编辑', '关闭'])
  })

  it('edits the text, keeps it on 保存 and shows the new version', async () => {
    const onSave = vi.fn(() => undefined)
    openFilePreview({ fileName: '网页对比.md', text: PAGES }, { english: false, onSave })
    const action = (label: string) => [...document.querySelectorAll<HTMLButtonElement>('.file-preview-actions button')].find(node => node.textContent === label)!
    action('编辑').click()
    const editor = document.querySelector<HTMLTextAreaElement>('.file-preview-editor')!
    expect(editor.hidden).toBe(false)
    expect(editor.value).toBe(PAGES)
    expect(document.activeElement).toBe(editor)
    expect([...document.querySelectorAll('.file-preview-actions button')].map(node => node.textContent)).toEqual(['取消编辑', '保存'])
    editor.value = '# 只留产品 A\n\n价格 99 元'
    editor.dispatchEvent(new Event('input'))
    expect(document.querySelector('.file-preview-size')?.textContent).toContain('17 字')
    action('保存').click()
    await vi.waitFor(() => expect(onSave).toHaveBeenCalledWith('# 只留产品 A\n\n价格 99 元'))
    expect(editor.hidden).toBe(true)
    expect(document.querySelector('.file-preview-body h1')?.textContent).toBe('只留产品 A')
  })

  it('keeps the file as it was on 取消编辑 or Esc, and refuses an empty file or what the owner refuses', async () => {
    const onSave = vi.fn((text: string) => text.length > 20 ? '文本文件太大' : undefined)
    openFilePreview({ fileName: 'a.md', text: '# A' }, { english: false, onSave })
    const action = (label: string) => [...document.querySelectorAll<HTMLButtonElement>('.file-preview-actions button')].find(node => node.textContent === label)!
    const editor = document.querySelector<HTMLTextAreaElement>('.file-preview-editor')!
    action('编辑').click()
    editor.value = '# B'
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    expect(editor.hidden).toBe(true)
    expect(document.querySelector('.file-preview-body h1')?.textContent).toBe('A')
    expect(document.querySelector('.file-preview-modal')).not.toBeNull()

    action('编辑').click()
    editor.value = '   '
    action('保存').click()
    expect(document.querySelector('.team-form-error')?.textContent).toContain('内容不能为空')
    editor.value = 'x'.repeat(30)
    action('保存').click()
    await vi.waitFor(() => expect(document.querySelector('.team-form-error')?.textContent).toBe('文本文件太大'))
    expect(editor.hidden).toBe(false)
  })
})
