// The window for a group's 群资料库 (src/group/groupLibrary.ts): its documents, each to open or
// delete, and the ways to add one: files read into text, a pasted note, web pages open in this
// window. Replies and attachments are saved into it from the chat. The background keeps the text;
// the page has the list.
import type { LibraryDoc, LibraryDocKind } from '../group/groupLibrary'
import type { OpenTeamStore } from '../group/types'
import { normalizeLanguage } from '../shared/i18n'
import { createIcon } from './icons'

export interface LibraryDialogDependencies {
  getStore(): OpenTeamStore
  runCommand(type: string, payload?: Record<string, unknown>): Promise<void>
  // A command whose answer is needed (the text of a document).
  request(type: string, payload?: Record<string, unknown>): Promise<Record<string, unknown>>
  // A file's text: a text file as it is, PDF and Office files read (documentText.ts).
  readFile(file: File): Promise<string>
  // Web pages chosen from the open tabs, as one document; undefined when none were chosen.
  pickPages?(): Promise<{ title: string; source: string; text: string } | undefined>
  previewText(title: string, text: string): void
  confirm?(message: string): boolean
  now?(): number
  onClose?(): void
}

export interface LibraryDialog {
  refresh(): void
  close(): void
}

const FILE_ACCEPT = '.txt,.md,.markdown,.csv,.json,.html,.xml,.yaml,.yml,.log,.pdf,.docx,.pptx,.xlsx,.js,.ts,.py,.java,.go,.rs,.c,.cpp,.sql'

let openDialog: LibraryDialog | undefined

export function currentLibraryDialog(): LibraryDialog | undefined {
  return openDialog
}

export function openLibraryDialog(chatId: string, deps: LibraryDialogDependencies): LibraryDialog {
  openDialog?.close()
  const confirm = deps.confirm ?? (message => window.confirm(message))
  const english = () => normalizeLanguage(deps.getStore().settings.language) === 'en'
  const t = (zh: string, en: string): string => english() ? en : zh
  let drawn = ''

  const backdrop = element('div', 'modal-backdrop library-modal')
  backdrop.addEventListener('click', event => {
    if (event.target === backdrop) close()
  })
  const dialog = element('section', 'modal team-setup-dialog library-dialog')
  dialog.setAttribute('role', 'dialog')
  dialog.setAttribute('aria-modal', 'true')
  dialog.setAttribute('aria-labelledby', 'library-title')

  const header = element('div', 'modal-header')
  const heading = element('div')
  const title = element('h2')
  title.id = 'library-title'
  heading.append(title, element('p', 'tiny', t(
    '成员回答时，会自动带上资料里与问题相关的片段（网页成员同一段只发一次）。适合放需求文档、调研报告、会议纪要这类要反复引用的材料；回答和附件可以在聊天里点「存入资料库」。',
    'When members answer, the passages of this material that bear on the question go with it (a web member gets each passage once). For material used again and again: specs, reports, meeting notes. Replies and attachments are saved here with Save to library in the chat.',
  )))
  const closeButton = element('button', 'icon-btn modal-close')
  closeButton.type = 'button'
  closeButton.setAttribute('aria-label', t('关闭', 'Close'))
  closeButton.append(createIcon('close'))
  closeButton.addEventListener('click', () => close())
  header.append(heading, closeButton)

  const summary = element('p', 'tiny library-summary')
  const list = element('ul', 'library-doc-list')

  const addRow = element('div', 'library-add-row')
  const fileInput = element('input')
  fileInput.id = 'library-file-input'
  fileInput.type = 'file'
  fileInput.multiple = true
  fileInput.accept = FILE_ACCEPT
  fileInput.hidden = true
  fileInput.addEventListener('change', () => void addFiles([...(fileInput.files ?? [])]))
  const uploadButton = addButton('file', t('上传文件', 'Upload files'), () => fileInput.click())
  const noteButton = addButton('note', t('粘贴文字', 'Paste text'), () => {
    noteForm.hidden = !noteForm.hidden
    if (!noteForm.hidden) noteTitle.focus()
  })
  const pagesButton = addButton('pages', t('打开的网页', 'Open web pages'), () => void addPages())
  pagesButton.hidden = !deps.pickPages
  addRow.append(uploadButton, noteButton, pagesButton, fileInput)

  const noteForm = element('form', 'team-setup-form library-note-form')
  noteForm.noValidate = true
  noteForm.hidden = true
  const noteTitle = element('input')
  noteTitle.id = 'library-note-title'
  noteTitle.placeholder = t('标题', 'Title')
  noteTitle.setAttribute('aria-label', t('标题', 'Title'))
  const noteText = element('textarea')
  noteText.id = 'library-note-text'
  noteText.rows = 6
  noteText.placeholder = t('粘贴或输入资料内容', 'Paste or type the material')
  noteText.setAttribute('aria-label', t('资料内容', 'Material'))
  const noteActions = element('div', 'team-setup-actions')
  const noteCancel = element('button', 'btn', t('取消', 'Cancel'))
  noteCancel.type = 'button'
  noteCancel.addEventListener('click', () => {
    noteForm.hidden = true
  })
  const noteSave = element('button', 'btn btn-primary', t('存入资料库', 'Save to library'))
  noteSave.type = 'submit'
  noteActions.append(noteCancel, noteSave)
  noteForm.append(noteTitle, noteText, noteActions)
  noteForm.addEventListener('submit', event => {
    event.preventDefault()
    void addNote()
  })

  const status = element('p', 'tiny library-status')
  status.setAttribute('role', 'status')

  dialog.append(header, summary, list, addRow, noteForm, status)
  backdrop.append(dialog)
  document.body.append(backdrop)
  document.addEventListener('keydown', handleEscape)

  const controller: LibraryDialog = { refresh: render, close }
  openDialog = controller
  render()
  uploadButton.focus()
  return controller

  function docs(): LibraryDoc[] {
    return deps.getStore().libraryByChatId?.[chatId] ?? []
  }

  function render(): void {
    const chat = deps.getStore().chatsById[chatId]
    if (!chat) return close()
    title.textContent = t(`「${chat.name}」的资料库`, `Library of "${chat.name}"`)
    const all = docs()
    // Drawn again only when the documents changed: the page redraws on every store update.
    const key = JSON.stringify([english(), all.map(doc => [doc.id, doc.title, doc.kind, doc.chars])])
    if (key === drawn) return
    drawn = key
    const total = all.reduce((sum, doc) => sum + doc.chars, 0)
    summary.textContent = all.length === 0
      ? t('还没有资料。上传文件、粘贴文字或附上打开的网页，成员回答时会带上相关片段。', 'No material yet. Upload files, paste text or add open web pages; members get the passages that bear on each question.')
      : t(`${all.length} 份资料，约 ${size(total)}`, `${all.length} ${all.length === 1 ? 'document' : 'documents'}, about ${size(total)}`)
    list.replaceChildren(...all.map(renderDoc))
    list.hidden = all.length === 0
  }

  function renderDoc(doc: LibraryDoc): HTMLLIElement {
    const item = element('li', 'library-doc')
    const text = element('div', 'library-doc-text')
    text.append(element('span', 'library-doc-title', doc.title), element('span', 'tiny library-doc-meta', [kindName(doc.kind), size(doc.chars), formatDate(doc.addedAt)].join(' · ')))
    const view = element('button', 'btn btn-ghost btn-small', t('查看', 'View'))
    view.type = 'button'
    view.dataset.libraryAction = 'view'
    view.setAttribute('aria-label', t(`查看：${doc.title}`, `View: ${doc.title}`))
    view.addEventListener('click', () => void viewDoc(doc))
    const remove = element('button', 'btn btn-ghost btn-small', t('删除', 'Delete'))
    remove.type = 'button'
    remove.dataset.libraryAction = 'delete'
    remove.setAttribute('aria-label', t(`删除：${doc.title}`, `Delete: ${doc.title}`))
    remove.addEventListener('click', () => {
      if (!confirm(t(`从资料库删除「${doc.title}」吗？`, `Delete "${doc.title}" from the library?`))) return
      void command('LIBRARY_REMOVE', { chatId, docId: doc.id }, t('已删除。', 'Deleted.'))
    })
    item.append(text, view, remove)
    return item
  }

  async function viewDoc(doc: LibraryDoc): Promise<void> {
    try {
      const response = await deps.request('LIBRARY_TEXT_GET', { chatId, docId: doc.id })
      deps.previewText(String(response.title ?? doc.title), String(response.text ?? ''))
    } catch (error) {
      status.textContent = error instanceof Error ? error.message : String(error)
    }
  }

  async function addFiles(files: File[]): Promise<void> {
    fileInput.value = ''
    if (files.length === 0) return
    status.textContent = t('读取中…', 'Reading…')
    const added: string[] = []
    const failed: string[] = []
    for (const file of files) {
      try {
        const text = await deps.readFile(file)
        await deps.runCommand('LIBRARY_ADD', { chatId, doc: { title: file.name, kind: 'file', source: file.name, text } })
        added.push(file.name)
      } catch (error) {
        failed.push(error instanceof Error ? error.message : String(error))
      }
    }
    status.textContent = [
      added.length ? t(`已加入 ${added.length} 份：${added.join('、')}。`, `Added ${added.length}: ${added.join(', ')}.`) : '',
      failed.length ? t(`没加入：${failed.join('；')}`, `Not added: ${failed.join('; ')}`) : '',
    ].filter(Boolean).join('')
    render()
  }

  async function addNote(): Promise<void> {
    const text = noteText.value.trim()
    if (!text) {
      status.textContent = t('写下或粘贴资料内容', 'Write or paste the material')
      noteText.focus()
      return
    }
    const name = noteTitle.value.trim() || text.split('\n')[0].slice(0, 30)
    const saved = await command('LIBRARY_ADD', { chatId, doc: { title: name, kind: 'note', text } }, t(`已加入「${name}」。`, `Added "${name}".`))
    if (!saved) return
    noteTitle.value = ''
    noteText.value = ''
    noteForm.hidden = true
  }

  async function addPages(): Promise<void> {
    try {
      const pages = await deps.pickPages?.()
      if (!pages) return
      await command('LIBRARY_ADD', { chatId, doc: { title: pages.title, kind: 'page', source: pages.source, text: pages.text } }, t(`已加入「${pages.title}」。`, `Added "${pages.title}".`))
    } catch (error) {
      status.textContent = error instanceof Error ? error.message : String(error)
    }
  }

  async function command(type: string, payload: Record<string, unknown>, done: string): Promise<boolean> {
    try {
      await deps.runCommand(type, payload)
      status.textContent = done
      return true
    } catch (error) {
      status.textContent = error instanceof Error ? error.message : String(error)
      return false
    } finally {
      if (openDialog === controller) render()
    }
  }

  function addButton(name: string, label: string, run: () => void): HTMLButtonElement {
    const button = element('button', 'btn btn-small', label)
    button.type = 'button'
    button.dataset.libraryAdd = name
    button.addEventListener('click', run)
    return button
  }

  function kindName(kind: LibraryDocKind): string {
    return { file: t('文件', 'File'), note: t('文字', 'Note'), page: t('网页', 'Web page'), message: t('聊天', 'From the chat') }[kind]
  }

  function size(chars: number): string {
    if (english()) return chars >= 1000 ? `${(chars / 1000).toFixed(1)}k characters` : `${chars} characters`
    return chars >= 10_000 ? `${(chars / 10_000).toFixed(1)} 万字` : `${chars} 字`
  }

  function formatDate(value: number): string {
    return new Date(value).toLocaleDateString(english() ? 'en-US' : 'zh-CN', { month: 'numeric', day: 'numeric' })
  }

  function handleEscape(event: KeyboardEvent): void {
    if (event.key !== 'Escape') return
    event.preventDefault()
    close()
  }

  function close(): void {
    if (openDialog === controller) openDialog = undefined
    backdrop.remove()
    document.removeEventListener('keydown', handleEscape)
    deps.onClose?.()
  }
}

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}
