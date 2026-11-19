// 附上网页: the page the user was on when they clicked the OpenTeam icon or chose 发到 OpenTeam,
// sent with a message as a Markdown file, so it reaches members the way any text file does.
import type { OpenTeamLanguage } from './types'

export interface CapturedWebPage {
  title: string
  url: string
  // What the user had selected on the page.
  selection?: string
  text: string
}

// The page offered to the composer, kept in session storage under this key (webPageOffers.ts).
export const WEB_PAGE_OFFER_KEY = 'openteamWebPageOffer'
// An offer older than this is not shown: the user has long moved on.
export const WEB_PAGE_OFFER_TTL_MS = 30 * 60 * 1000

export interface WebPageOffer {
  tabId: number
  url: string
  title: string
  // Selected when 发到 OpenTeam was chosen from the menu.
  selection?: string
  offeredAt: number
}

// A page's text past this is cut: an AI site's message box takes about this much comfortably.
export const WEB_PAGE_TEXT_MAX_CHARS = 30000
const FILE_TITLE_MAX_CHARS = 40

// Chrome lets no extension read its own pages or the Web Store, and OpenTeam reads only the web.
export function isReadablePageUrl(url: string | undefined): boolean {
  if (!url) return false
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return false
  if (parsed.hostname === 'chromewebstore.google.com') return false
  if (parsed.hostname === 'chrome.google.com' && parsed.pathname.startsWith('/webstore')) return false
  return true
}

export function webPageUpload(page: CapturedWebPage, language: OpenTeamLanguage): { fileName: string; mimeType: string; text: string } {
  const en = language === 'en'
  const title = page.title.replace(/\s+/g, ' ').trim()
  const fileTitle = [...(title.replace(/[/\\:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim() || hostOf(page.url))].slice(0, FILE_TITLE_MAX_CHARS).join('').trim()
  const text = tidy(page.text)
  const cut = [...text].length > WEB_PAGE_TEXT_MAX_CHARS
  const body = cut ? [...text].slice(0, WEB_PAGE_TEXT_MAX_CHARS).join('') : text
  const selection = tidy(page.selection ?? '')
  const sections = [
    `# ${title || hostOf(page.url)}`,
    en ? `Address: ${page.url}` : `网址：${page.url}`,
    ...(selection ? [`## ${en ? 'Selected text' : '选中的文字'}`, selection] : []),
    `## ${en ? 'Page text' : '网页正文'}`,
    body + (cut ? (en ? `\n\n(The page is long; only its first ${WEB_PAGE_TEXT_MAX_CHARS} characters are attached.)` : `\n\n（网页较长，只附上了前 ${WEB_PAGE_TEXT_MAX_CHARS} 字）`) : ''),
  ]
  return {
    fileName: `${en ? 'web-page-' : '网页-'}${fileTitle}.md`,
    mimeType: 'text/markdown',
    text: `${sections.join('\n\n')}\n`,
  }
}

// 附上网页 from several open tabs: at most this many, in one file whose page texts share this length.
export const MAX_WEB_PAGES = 5
export const WEB_PAGES_TEXT_MAX_CHARS = 60000

// Several pages as one Markdown file, a section each (title, address, selected text, text). One page
// is the usual single-page file.
export function webPagesUpload(pages: CapturedWebPage[], language: OpenTeamLanguage): { fileName: string; mimeType: string; text: string } {
  if (pages.length === 1) return webPageUpload(pages[0], language)
  const en = language === 'en'
  const share = Math.min(WEB_PAGE_TEXT_MAX_CHARS, Math.floor(WEB_PAGES_TEXT_MAX_CHARS / Math.max(1, pages.length)))
  const sections = pages.map((page, index) => {
    const title = page.title.replace(/\s+/g, ' ').trim() || hostOf(page.url)
    const text = tidy(page.text)
    const cut = [...text].length > share
    const body = cut ? [...text].slice(0, share).join('') : text
    const selection = tidy(page.selection ?? '')
    return [
      `## ${index + 1}. ${title}`,
      en ? `Address: ${page.url}` : `网址：${page.url}`,
      ...(selection ? [`${en ? 'Selected text:' : '选中的文字：'}\n${selection}`] : []),
      body + (cut ? (en ? `\n\n(The page is long; only its first ${share} characters are attached.)` : `\n\n（网页较长，只附上了前 ${share} 字）`) : ''),
    ].join('\n\n')
  })
  return {
    fileName: en ? `web-pages-${pages.length}.md` : `网页对比-${pages.length}个网页.md`,
    mimeType: 'text/markdown',
    text: `${[en ? `# Compared web pages (${pages.length})` : `# 网页对比（${pages.length} 个网页）`, ...sections].join('\n\n')}\n`,
  }
}

// Blank lines kept to one, and spaces at the ends of lines and of the whole text dropped.
function tidy(text: string): string {
  return text.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname
  } catch {
    return 'page'
  }
}
