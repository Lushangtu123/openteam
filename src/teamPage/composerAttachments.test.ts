// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { createComposerAttachments } from './composerAttachments'

afterEach(() => {
  document.body.replaceChildren()
  vi.unstubAllGlobals()
})

function setup() {
  vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: vi.fn(() => 'blob:preview'), revokeObjectURL: vi.fn() }))
  const trayEl = document.createElement('div')
  const attachButtonEl = document.createElement('button')
  const fileInputEl = document.createElement('input')
  fileInputEl.type = 'file'
  const pasteTargetEl = document.createElement('textarea')
  const dropTargetEl = document.createElement('form')
  dropTargetEl.append(trayEl, pasteTargetEl)
  document.body.append(dropTargetEl)
  const showError = vi.fn()
  const onChange = vi.fn()
  const attachments = createComposerAttachments({ trayEl, attachButtonEl, fileInputEl, pasteTargetEl, dropTargetEl, ui: source => source, showError, onChange })
  attachments.register()
  const choose = (files: File[]) => {
    Object.defineProperty(fileInputEl, 'files', { configurable: true, get: () => files })
    fileInputEl.dispatchEvent(new Event('change'))
  }
  return { attachments, trayEl, fileInputEl, pasteTargetEl, showError, onChange, choose }
}

function sized(file: File, size: number): File {
  Object.defineProperty(file, 'size', { value: size })
  return file
}

describe('composer attachments', () => {
  it('adds chosen images and text files and shows them in the tray', () => {
    const { attachments, trayEl, fileInputEl, choose, onChange } = setup()

    choose([new File(['png'], 'chart.png', { type: 'image/png' }), new File(['# 目标'], 'notes.md', { type: '' })])

    expect(fileInputEl.accept).toContain('image/png')
    expect(attachments.list().map(item => [item.file.name, item.kind])).toEqual([['chart.png', 'image'], ['notes.md', 'text']])
    expect(trayEl.hidden).toBe(false)
    expect(trayEl.querySelector('.attachment-chip-image img')?.getAttribute('src')).toBe('blob:preview')
    expect(trayEl.querySelector('.attachment-chip-text .attachment-chip-icon')?.textContent).toBe('MD')
    expect(trayEl.querySelector('.attachment-tray-hint')?.textContent).toBe('附件只在发送时上传给对应的 AI 网站或模型。')
    expect(onChange).toHaveBeenCalled()
  })

  it('turns down unsupported, oversized and surplus files with a reason', () => {
    const { attachments, choose, showError } = setup()

    choose([
      new File(['x'], 'report.pdf', { type: 'application/pdf' }),
      sized(new File(['x'], 'huge.png', { type: 'image/png' }), 11 * 1024 * 1024),
      ...Array.from({ length: 5 }, (_, index) => new File(['x'], `${index}.txt`, { type: 'text/plain' })),
    ])

    expect(attachments.list()).toHaveLength(4)
    const message = showError.mock.calls[0][0] as string
    expect(message).toContain('不支持这种文件：report.pdf')
    expect(message).toContain('图片太大：huge.png（最大 10 MB）')
    expect(message).toContain('一条消息最多 4 个附件')
  })

  it('takes pasted files and lets ordinary text paste through', () => {
    const { attachments, pasteTargetEl } = setup()
    const withFile = new Event('paste', { cancelable: true }) as Event & { clipboardData: unknown }
    withFile.clipboardData = { files: [new File(['png'], 'screenshot.png', { type: 'image/png' })] }
    const plainText = new Event('paste', { cancelable: true }) as Event & { clipboardData: unknown }
    plainText.clipboardData = { files: [] }

    pasteTargetEl.dispatchEvent(withFile)
    pasteTargetEl.dispatchEvent(plainText)

    expect(withFile.defaultPrevented).toBe(true)
    expect(plainText.defaultPrevented).toBe(false)
    expect(attachments.list().map(item => item.file.name)).toEqual(['screenshot.png'])
  })

  it('removes a file from its chip', () => {
    const { attachments, trayEl, choose } = setup()
    choose([new File(['a'], 'a.txt', { type: 'text/plain' }), new File(['b'], 'b.txt', { type: 'text/plain' })])

    trayEl.querySelector<HTMLButtonElement>('.attachment-chip-remove')?.click()

    expect(attachments.list().map(item => item.file.name)).toEqual(['b.txt'])
  })

  it('reads files for sending and refuses a binary file that looks like text', async () => {
    const { attachments, choose } = setup()
    choose([new File([new Uint8Array([1, 2, 3])], 'chart.png', { type: 'image/png' }), new File(['季度目标'], 'notes.txt', { type: 'text/plain' })])

    expect(await attachments.readUploads()).toEqual([
      { kind: 'image', fileName: 'chart.png', mimeType: 'image/png', size: 3, data: btoa(String.fromCharCode(1, 2, 3)) },
      { kind: 'text', fileName: 'notes.txt', mimeType: 'text/plain', size: 12, text: '季度目标' },
    ])

    const taken = attachments.take()
    expect(attachments.list()).toEqual([])
    attachments.restore(taken)
    expect(attachments.list()).toHaveLength(2)

    attachments.take()
    choose([new File([new Uint8Array([0, 159, 146, 150, 0, 255])], 'data.txt', { type: 'text/plain' })])
    await expect(attachments.readUploads()).rejects.toThrow('无法读取文本文件：data.txt（不是 UTF-8 文本）')
  })
})
