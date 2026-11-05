import type { SiteStatusInfo } from './types'

// How long a page may go without showing its input box before that counts as an error.
export const NO_EDITOR_GRACE_MS = 20_000

export interface SiteHealthProbe {
  findEditor(): Element | null | undefined
  isGenerating(): boolean
  // The site's own login or sign-up page (usually recognisable by its path).
  isLoginPage?(): boolean
  // A site error message shown on the page.
  findSiteError?(): string | undefined
  // Something drawn over the page that keeps the input box from being used (cookie banner, dialog).
  hasBlockingOverlay?(): boolean
  // A modal dialog that must be answered before anything can be sent, even with the input box on
  // the page behind it (Qwen asks guests to confirm their age). Returns the dialog's text.
  findBlockingDialog?(): string | undefined
}

export interface SiteHealthContext {
  // Time since this page started loading.
  pageAgeMs: number
  document?: Document
  now?: number
}

const LOGIN_CONTROL_TEXT = /^(log ?in|sign ?in|登录|登入|ログイン)$/i
const VERIFICATION_TITLE = /^(just a moment|attention required|one more step|请稍候|稍等片刻|请稍等)/i
const VERIFICATION_TEXT = /performing security verification|verify you are human|checking your browser|确认您是真人|正在进行安全验证/i
const VERIFICATION_SELECTOR = '#challenge-form, #challenge-stage, #cf-challenge-running, #challenge-running'
const TURNSTILE_SELECTOR = 'iframe[src*="challenges.cloudflare.com"], .cf-turnstile, [name="cf-turnstile-response"]'
const HTTP_ERROR_TITLE = /^(?:(?:403|404|429|500|502|503|504)\b|error\b)|access denied|request blocked|could not be satisfied|too many requests|forbidden/i

export function checkSiteHealth(probe: SiteHealthProbe, context: SiteHealthContext): SiteStatusInfo {
  const doc = context.document ?? document
  const timestamp = context.now ?? Date.now()
  const editor = probe.findEditor()

  // Interstitials have no input box; a conversation title alone ("Error handling…") must not count.
  if (!editor) {
    if (isVerificationPage(doc)) return { status: 'blocked', reason: 'verification', timestamp }
    if (HTTP_ERROR_TITLE.test(doc.title.trim())) return { status: 'blocked', reason: 'http-error', detail: doc.title.trim().slice(0, 80), timestamp }
  }
  if (probe.isLoginPage?.()) return { status: 'unauthorized', reason: 'login', timestamp }
  const dialog = probe.findBlockingDialog?.()
  if (dialog !== undefined) return { status: 'blocked', reason: 'overlay', ...(dialog ? { detail: dialog.slice(0, 160) } : {}), timestamp }

  const siteError = probe.findSiteError?.()
  if (siteError) return { status: 'error', reason: 'site-error', detail: siteError.slice(0, 160), timestamp }
  if (probe.isGenerating()) return { status: 'generating', timestamp }

  const loginControls = hasLoginControls(doc)
  if (editor) return loginControls ? { status: 'ready', reason: 'guest', timestamp } : { status: 'ready', timestamp }
  const stillLoading = context.pageAgeMs < NO_EDITOR_GRACE_MS
  if (probe.hasBlockingOverlay?.()) return { status: 'blocked', reason: 'overlay', timestamp }
  if (doc.querySelector(TURNSTILE_SELECTOR)) return { status: 'blocked', reason: 'verification', timestamp }
  // Guest pages (Gemini, Grok) show their sign-in button before the input box, so while the page
  // is still loading sign-in controls alone do not mean a login is needed.
  if (stillLoading) return { status: 'loading', reason: 'no-editor', timestamp }
  if (loginControls) return { status: 'unauthorized', reason: 'login', timestamp }
  return { status: 'error', reason: 'no-editor', timestamp }
}

function isVerificationPage(doc: Document): boolean {
  if (VERIFICATION_TITLE.test(doc.title.trim())) return true
  if (doc.querySelector(VERIFICATION_SELECTOR)) return true
  return VERIFICATION_TEXT.test(doc.body?.textContent?.slice(0, 2000) ?? '')
}

// A "Log in" / "Sign in" button or link means the page is not logged in. Logged-in pages of the
// supported sites have none.
function hasLoginControls(doc: Document): boolean {
  return [...doc.querySelectorAll<HTMLElement>('a, button, [role="button"]')].some(element => {
    if (element.closest('[hidden], [aria-hidden="true"]')) return false
    const label = (element.textContent?.trim() || element.getAttribute('aria-label')?.trim() || '').replace(/\s+/g, ' ')
    return LOGIN_CONTROL_TEXT.test(label)
  })
}
