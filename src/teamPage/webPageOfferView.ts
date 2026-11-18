// 附上网页 in the composer: after the OpenTeam icon (or 发到 OpenTeam) was used on a page, a bar
// over the message box names that page, with 附上 and a close button. The page is read only on
// 附上, and then joins the message's attachments as a Markdown file. See webPageOffers.ts.
import { WEB_PAGE_OFFER_TTL_MS, type WebPageOffer } from '../group/webPage'
import { createIcon } from './icons'

export interface WebPageOfferViewDependencies {
  element: HTMLElement
  ui(source: string): string
  storage: {
    get(): Promise<unknown>
    onChange(listener: (value: unknown) => void): void
  }
  // Throws with the reason when the page could not be read.
  readPage(): Promise<{ fileName: string; mimeType: string; text: string }>
  dismiss(): Promise<void>
  addFile(file: File): void
  showError(message: string): void
  now(): number
}

export interface WebPageOfferView {
  start(): Promise<void>
  // In the language chosen now.
  render(): void
}

export function createWebPageOfferView(deps: WebPageOfferViewDependencies): WebPageOfferView {
  let offer: WebPageOffer | undefined
  // What the bar shows now: it is built again only when that changes, so its buttons keep focus.
  let shown: string | undefined
  let expiry: ReturnType<typeof setTimeout> | undefined

  function set(value: unknown): void {
    offer = readOffer(value, deps.now())
    render()
  }

  function render(): void {
    const element = deps.element
    if (expiry !== undefined) clearTimeout(expiry)
    expiry = undefined
    if (!offer || deps.now() - offer.offeredAt > WEB_PAGE_OFFER_TTL_MS) {
      offer = undefined
      element.hidden = true
      element.replaceChildren()
      shown = undefined
      return
    }
    expiry = setTimeout(render, offer.offeredAt + WEB_PAGE_OFFER_TTL_MS - deps.now() + 1)
    const key = JSON.stringify([offer.tabId, offer.offeredAt, offer.title, deps.ui('附上')])
    element.hidden = false
    if (key === shown) return
    shown = key
    const current = offer

    const text = document.createElement('span')
    text.className = 'web-page-offer-text'
    const label = document.createElement('span')
    label.className = 'web-page-offer-label'
    label.textContent = deps.ui('刚才的网页')
    const title = document.createElement('span')
    title.className = 'web-page-offer-title'
    title.textContent = current.title
    title.title = current.url
    const host = document.createElement('span')
    host.className = 'web-page-offer-host'
    host.textContent = hostOf(current.url)
    text.append(label, title, host)

    const attach = document.createElement('button')
    attach.type = 'button'
    attach.className = 'btn btn-primary web-page-offer-attach'
    attach.textContent = deps.ui('附上')
    attach.title = deps.ui('网页的标题、网址和正文会作为附件，随这条消息发给成员')
    attach.addEventListener('click', () => void attachPage(attach))

    const close = document.createElement('button')
    close.type = 'button'
    close.className = 'web-page-offer-close'
    close.setAttribute('aria-label', deps.ui('不附上'))
    close.append(createIcon('close'))
    close.addEventListener('click', () => {
      hide()
      deps.dismiss().catch(() => undefined)
    })

    const icon = createIcon('globe')
    icon.classList.add('web-page-offer-icon')
    element.replaceChildren(icon, text, attach, close)
  }

  async function attachPage(button: HTMLButtonElement): Promise<void> {
    button.disabled = true
    button.textContent = deps.ui('读取中…')
    try {
      const upload = await deps.readPage()
      deps.addFile(new File([upload.text], upload.fileName, { type: upload.mimeType }))
    } catch (error) {
      deps.showError(error instanceof Error ? error.message : String(error))
    } finally {
      // The offer is used up either way (the background forgets it too).
      hide()
    }
  }

  function hide(): void {
    offer = undefined
    render()
  }

  return {
    async start() {
      deps.storage.onChange(set)
      let saved: unknown
      try {
        saved = await deps.storage.get()
      } catch {
        saved = undefined
      }
      // An offer pushed while this was reading is the newer one.
      if (!offer) set(saved)
    },
    render,
  }
}

function readOffer(value: unknown, now: number): WebPageOffer | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const offer = value as Partial<WebPageOffer>
  if (typeof offer.tabId !== 'number' || typeof offer.url !== 'string' || typeof offer.title !== 'string' || typeof offer.offeredAt !== 'number') return undefined
  if (now - offer.offeredAt > WEB_PAGE_OFFER_TTL_MS) return undefined
  return offer as WebPageOffer
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname
  } catch {
    return ''
  }
}
