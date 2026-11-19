// 附上网页 from the open tabs: the window lists the readable pages open in this window; the user
// ticks up to MAX_WEB_PAGES, the browser is asked once for access to their sites (sites allowed
// before are not asked about again, and access to every site is never asked for), and the pages
// are read into one file for the message (src/group/webPage.ts, webPageOffers.ts).
import { isReadablePageUrl, MAX_WEB_PAGES } from '../group/webPage'
import { hostAccessPattern } from '../shared/hostAccess'
import { createIcon } from './icons'

export interface OpenTab {
  id: number
  url: string
  title: string
}

export interface WebPagesDialogDependencies {
  english: boolean
  // The tabs open in this window.
  listTabs(): Promise<OpenTab[]>
  // Asks the browser for access to these sites (match patterns); resolves to whether it was given.
  requestAccess(patterns: string[]): Promise<boolean>
  readPages(tabs: Array<{ tabId: number; url: string }>): Promise<{ upload: { fileName: string; mimeType: string; text: string }; failed?: Array<{ title: string; reason: string }> }>
  addFile(file: File): void
  showError(message: string): void
  // Puts the focus back where the window was opened from.
  onClose?(): void
}

export async function openWebPagesDialog(deps: WebPagesDialogDependencies): Promise<{ close(): void }> {
  document.querySelector('.web-pages-modal')?.remove()
  const t = (zh: string, en: string): string => deps.english ? en : zh
  const tabs = (await deps.listTabs().catch(() => [] as OpenTab[])).filter(tab => isReadablePageUrl(tab.url))
  let busy = false

  const backdrop = element('div', 'modal-backdrop web-pages-modal')
  backdrop.addEventListener('click', event => {
    if (event.target === backdrop) close()
  })
  const dialog = element('section', 'modal team-setup-dialog web-pages-dialog')
  dialog.setAttribute('role', 'dialog')
  dialog.setAttribute('aria-modal', 'true')
  dialog.setAttribute('aria-labelledby', 'web-pages-title')
  const header = element('div', 'modal-header')
  const heading = element('div')
  const title = element('h2', '', t('附上网页', 'Attach web pages'))
  title.id = 'web-pages-title'
  heading.append(title, element('p', 'tiny', t(
    `勾选这个窗口里要附上的网页（最多 ${MAX_WEB_PAGES} 个），它们会合成一个文件，随下一条消息发给成员。第一次读某个网站时，浏览器会询问能否访问它；允许过的网站以后不再询问。`,
    `Tick the pages open in this window to attach (up to ${MAX_WEB_PAGES}); they go together as one file with your next message. The first time a site is read, the browser asks whether OpenTeam may visit it; sites allowed once are not asked about again.`,
  )))
  const closeButton = element('button', 'icon-btn modal-close')
  closeButton.type = 'button'
  closeButton.setAttribute('aria-label', t('关闭', 'Close'))
  closeButton.append(createIcon('close'))
  closeButton.addEventListener('click', () => close())
  header.append(heading, closeButton)

  const form = element('form', 'team-setup-form web-pages-form')
  form.noValidate = true
  const list = element('ul', 'web-pages-list')
  const boxes: Array<{ box: HTMLInputElement; tab: OpenTab }> = []
  for (const tab of tabs) {
    const item = element('li', 'web-page-choice')
    const label = element('label')
    const box = element('input')
    box.type = 'checkbox'
    box.value = String(tab.id)
    const https = tab.url.startsWith('https://')
    box.disabled = !https
    const text = element('span', 'web-page-choice-text')
    text.append(element('span', 'web-page-choice-title', tab.title.trim() || hostOf(tab.url)), element('span', 'web-page-choice-host tiny', hostOf(tab.url)))
    if (!https) text.append(element('span', 'web-page-choice-note tiny', t('不是 https 网页，这里读不了；可以在那个网页上点 OpenTeam 图标附上', 'Not an https page, so it cannot be read from here; click the OpenTeam icon on that page instead')))
    label.append(box, text)
    item.append(label)
    list.append(item)
    if (https) boxes.push({ box, tab })
  }
  const empty = element('p', 'web-pages-empty', t('这个窗口里没有可以附上的网页。', 'No pages to attach are open in this window.'))
  empty.hidden = tabs.length > 0
  const count = element('p', 'web-pages-count tiny')
  count.setAttribute('aria-live', 'polite')
  const error = element('p', 'team-form-error')
  error.setAttribute('role', 'alert')
  const actions = element('div', 'team-setup-actions')
  const cancel = element('button', 'btn', t('取消', 'Cancel'))
  cancel.type = 'button'
  cancel.addEventListener('click', () => close())
  const submit = element('button', 'btn btn-primary', t('附上', 'Attach'))
  submit.type = 'submit'
  actions.append(cancel, submit)
  form.append(list, empty, count, error, actions)
  form.addEventListener('change', () => {
    error.textContent = ''
    render()
  })
  form.addEventListener('submit', event => {
    event.preventDefault()
    void attach()
  })
  dialog.append(header, form)
  backdrop.append(dialog)
  document.body.append(backdrop)
  document.addEventListener('keydown', handleEscape)
  render()
  ;(boxes[0]?.box ?? cancel).focus()

  function chosen(): OpenTab[] {
    return boxes.filter(item => item.box.checked).map(item => item.tab)
  }

  // The count, and no more boxes to tick once MAX_WEB_PAGES are.
  function render(): void {
    const picked = chosen().length
    count.textContent = t(`已选 ${picked}/${MAX_WEB_PAGES}`, `${picked} of ${MAX_WEB_PAGES} chosen`)
    for (const { box } of boxes) box.disabled = !box.checked && picked >= MAX_WEB_PAGES
    submit.disabled = busy || picked === 0
  }

  async function attach(): Promise<void> {
    const picked = chosen()
    if (busy || picked.length === 0) return
    busy = true
    render()
    try {
      // First, while the click still counts: the browser asks only from a click.
      const patterns = [...new Set(picked.map(tab => hostAccessPattern(tab.url)).filter((pattern): pattern is string => Boolean(pattern)))]
      if (!await deps.requestAccess(patterns)) {
        error.textContent = t('没有得到访问这些网站的许可，网页没有附上。', 'Access to these sites was not given, so nothing was attached.')
        return
      }
      const result = await deps.readPages(picked.map(tab => ({ tabId: tab.id, url: tab.url })))
      deps.addFile(new File([result.upload.text], result.upload.fileName, { type: result.upload.mimeType }))
      close()
      if (result.failed?.length) deps.showError(t(`有 ${result.failed.length} 个网页没附上：`, `${result.failed.length} page(s) were not attached: `) + result.failed.map(item => `「${item.title}」${item.reason}`).join(t('；', '; ')))
    } catch (caught) {
      error.textContent = caught instanceof Error ? caught.message : String(caught)
    } finally {
      busy = false
      if (backdrop.isConnected) render()
    }
  }

  function handleEscape(event: KeyboardEvent): void {
    if (event.key !== 'Escape') return
    event.preventDefault()
    close()
  }

  function close(): void {
    backdrop.remove()
    document.removeEventListener('keydown', handleEscape)
    deps.onClose?.()
  }

  return { close }
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname
  } catch {
    return url
  }
}

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}
