// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { attachFilesToComposer } from './fileUpload'

// jsdom has neither DataTransfer nor ClipboardEvent with clipboardData; these do what the browser does.
class FakeDataTransfer {
  private readonly list: File[] = []
  readonly items = { add: (file: File) => this.list.push(file) }
  get files(): FileList {
    return this.list as unknown as FileList
  }
}

class FakeClipboardEvent extends Event {
  readonly clipboardData: FakeDataTransfer
  constructor(type: string, init: EventInit & { clipboardData: FakeDataTransfer }) {
    super(type, init)
    this.clipboardData = init.clipboardData
  }
}

const PNG = { fileName: 'chart.png', mimeType: 'image/png', data: btoa('png-bytes') }
const FAST = { attachTimeoutMs: 400, failureSettleMs: 300 }

function composer(html = ''): { form: HTMLFormElement; editor: HTMLElement } {
  document.body.innerHTML = `<form><div class="attachments"></div><div id="editor" contenteditable="true"></div><button type="submit">Send</button>${html}</form>`
  return { form: document.querySelector('form')!, editor: document.querySelector<HTMLElement>('#editor')! }
}

function showPreview(form: HTMLFormElement, file: File): void {
  const image = document.createElement('img')
  image.src = `blob:https://site.example/${file.name}`
  form.querySelector('.attachments')!.append(image)
}

beforeEach(() => {
  vi.stubGlobal('DataTransfer', FakeDataTransfer)
  vi.stubGlobal('ClipboardEvent', FakeClipboardEvent)
})

afterEach(() => {
  vi.unstubAllGlobals()
  document.body.replaceChildren()
})

describe('attaching files to an AI site composer', () => {
  it('pastes images into the input box when the site takes pasted files', async () => {
    const { form, editor } = composer()
    const pasted: File[] = []
    editor.addEventListener('paste', event => {
      const files = [...(event as unknown as FakeClipboardEvent).clipboardData.files]
      pasted.push(...files)
      event.preventDefault()
      for (const file of files) showPreview(form, file)
    })

    await attachFilesToComposer({ editor, files: [PNG], ...FAST })

    expect(pasted.map(file => [file.name, file.type])).toEqual([['chart.png', 'image/png']])
    expect(await pasted[0].text()).toBe('png-bytes')
  })

  it('falls back to the file input when pasting does nothing', async () => {
    const { form, editor } = composer('<input type="file" accept="image/*" multiple hidden>')
    const input = form.querySelector<HTMLInputElement>('input[type="file"]')!
    let chosen: FileList | undefined
    Object.defineProperty(input, 'files', { get: () => chosen, set: value => { chosen = value } })
    input.addEventListener('change', () => {
      for (const file of [...(chosen ?? [])]) showPreview(form, file)
    })

    await attachFilesToComposer({ editor, files: [PNG], ...FAST })

    expect([...(chosen ?? [])].map(file => file.name)).toEqual(['chart.png'])
  })

  it('reports the site saying the upload failed, even after it showed the file', async () => {
    const { form, editor } = composer()
    editor.addEventListener('paste', event => {
      event.preventDefault()
      showPreview(form, new File(['x'], 'chart.png'))
      setTimeout(() => form.insertAdjacentHTML('beforeend', '<p>Failed to upload file.</p>'), 100)
    })

    await expect(attachFilesToComposer({ editor, files: [PNG], ...FAST })).rejects.toThrow('图片没有上传成功：Failed to upload')
  })

  it('refuses to go on when the site takes the files in no way', async () => {
    const { editor } = composer()

    await expect(attachFilesToComposer({ editor, files: [PNG], ...FAST })).rejects.toThrow('图片没有上传成功：网站没有接收文件')
  })
})
