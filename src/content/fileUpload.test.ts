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

  it('picks the file input made for images over one for documents', async () => {
    const { form, editor } = composer(`
      <input id="docs" type="file" accept=".txt,.pdf,.docx" multiple hidden>
      <input id="single" type="file" accept="image/*" hidden>
      <input id="images" type="file" accept="image/*,video/*" multiple hidden>`)
    const chosen = new Map<string, File[]>()
    for (const input of form.querySelectorAll<HTMLInputElement>('input[type="file"]')) {
      let files: FileList | undefined
      Object.defineProperty(input, 'files', { get: () => files, set: value => { files = value; chosen.set(input.id, [...value]) } })
      input.addEventListener('change', () => { for (const file of [...(files ?? [])]) showPreview(form, file) })
    }

    await attachFilesToComposer({ editor, files: [PNG, { ...PNG, fileName: 'second.png' }], ...FAST })

    expect([...chosen.keys()]).toEqual(['images'])
    expect(chosen.get('images')?.map(file => file.name)).toEqual(['chart.png', 'second.png'])
  })

  it("opens a site's upload menu to reach its file input, before trying a paste, and closes it again", async () => {
    const { form, editor } = composer()
    const pasted = vi.fn()
    editor.addEventListener('paste', pasted)
    let chosen: FileList | undefined
    const close = vi.fn()
    const revealFileInputs = vi.fn(async () => {
      const input = document.createElement('input')
      input.type = 'file'
      input.accept = 'image/*,video/*'
      Object.defineProperty(input, 'files', { get: () => chosen, set: value => { chosen = value } })
      input.addEventListener('change', () => { for (const file of [...(chosen ?? [])]) showPreview(form, file) })
      document.body.append(input)
      return close
    })

    await attachFilesToComposer({ editor, files: [PNG], revealFileInputs, ...FAST })

    expect(revealFileInputs).toHaveBeenCalledTimes(1)
    expect([...(chosen ?? [])].map(file => file.name)).toEqual(['chart.png'])
    expect(close).toHaveBeenCalledTimes(1)
    expect(pasted).not.toHaveBeenCalled()
  })

  it('still pastes when the upload menu shows no file input', async () => {
    const { form, editor } = composer()
    editor.addEventListener('paste', event => {
      event.preventDefault()
      showPreview(form, new File(['x'], 'chart.png'))
    })
    const close = vi.fn()

    await attachFilesToComposer({ editor, files: [PNG], revealFileInputs: async () => close, ...FAST })

    expect(close).toHaveBeenCalledTimes(1)
    expect(form.querySelectorAll('img')).toHaveLength(1)
  })

  it('sees a preview anywhere in the fieldset around the input box, as on Gemini', async () => {
    document.body.innerHTML = `
      <fieldset><div class="previews"></div>
        <div><div><div><div><div><div id="editor" contenteditable="true"></div></div></div></div></div></div>
      </fieldset>`
    const editor = document.querySelector<HTMLElement>('#editor')!
    editor.addEventListener('paste', event => {
      event.preventDefault()
      const image = document.createElement('img')
      image.src = 'blob:https://gemini.google.com/preview'
      document.querySelector('.previews')!.append(image)
    })

    await expect(attachFilesToComposer({ editor, files: [PNG], ...FAST })).resolves.toBeUndefined()
  })

  it('refuses to go on when the site takes the files in no way', async () => {
    const { editor } = composer()

    await expect(attachFilesToComposer({ editor, files: [PNG], ...FAST })).rejects.toThrow('图片没有上传成功：网站没有接收文件')
  })
})
