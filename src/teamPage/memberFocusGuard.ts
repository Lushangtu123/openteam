// The members' AI pages run in frames underneath OpenTeam. When one takes the keyboard focus while
// OpenTeam covers it (OpenTeam typing a prompt into it, or the site focusing its own box as it
// loads), the keys the user types next would go into that hidden page. The focus comes back to where
// the user was in OpenTeam: at once, or when the page says it has finished typing a prompt.
import { isFrameInputMessage } from '../shared/frameInput'

export interface MemberFocusGuardDependencies {
  // Where the member frames are.
  hostEl: HTMLElement
  // The user is looking at the AI pages: the focus there is theirs.
  isShowingPages(): boolean
  // Where the focus goes when the user had none in OpenTeam yet.
  homeFocusEl?: HTMLElement
  window?: Window
  // The longest a page may keep the focus while it says it is typing.
  typingLimitMs?: number
}

export interface MemberFocusGuard {
  dispose(): void
}

// Focus moves into a frame a moment before the page's "typing" note arrives.
const SETTLE_MS = 150
const TYPING_LIMIT_MS = 60_000

export function createMemberFocusGuard(deps: MemberFocusGuardDependencies): MemberFocusGuard {
  const win = deps.window ?? window
  const doc = win.document
  const typingLimitMs = deps.typingLimitMs ?? TYPING_LIMIT_MS
  const typingSince = new Map<Window, number>()
  let lastFocus: HTMLElement | undefined
  let checkTimer: number | undefined

  function hiddenFrameWithFocus(): HTMLIFrameElement | undefined {
    const active = doc.activeElement
    if (!(active instanceof HTMLIFrameElement) || !deps.hostEl.contains(active)) return undefined
    return deps.isShowingPages() ? undefined : active
  }

  function typingLeftMs(frame: HTMLIFrameElement): number {
    const since = frame.contentWindow ? typingSince.get(frame.contentWindow) : undefined
    return since === undefined ? 0 : since + typingLimitMs - Date.now()
  }

  function giveFocusBack(frame: HTMLIFrameElement): void {
    const target = lastFocus?.isConnected ? lastFocus : deps.homeFocusEl
    target?.focus({ preventScroll: true })
    if (doc.activeElement === frame) frame.blur()
  }

  function check(): void {
    checkTimer = undefined
    const frame = hiddenFrameWithFocus()
    if (!frame) return
    const left = typingLeftMs(frame)
    // Still typing: its "done" note brings the focus back, or the limit does.
    if (left > 0) return scheduleCheck(left)
    giveFocusBack(frame)
  }

  function scheduleCheck(delayMs = SETTLE_MS): void {
    if (checkTimer !== undefined) win.clearTimeout(checkTimer)
    checkTimer = win.setTimeout(check, delayMs)
  }

  const onFocusIn = (event: FocusEvent) => {
    const target = event.target
    if (target instanceof HTMLElement && !(target instanceof HTMLIFrameElement) && !deps.hostEl.contains(target)) lastFocus = target
  }
  // Focus going into a frame blurs this window; coming back to the tab focuses it, and the focus may
  // have been left in a hidden page meanwhile.
  const onWindowFocusChange = () => scheduleCheck()
  const onMessage = (event: MessageEvent) => {
    if (!isFrameInputMessage(event.data)) return
    const frame = [...deps.hostEl.querySelectorAll('iframe')].find(candidate => candidate.contentWindow === event.source)
    if (!frame?.contentWindow) return
    if (event.data.typing) {
      typingSince.set(frame.contentWindow, Date.now())
      return
    }
    typingSince.delete(frame.contentWindow)
    scheduleCheck(0)
  }

  doc.addEventListener('focusin', onFocusIn)
  win.addEventListener('blur', onWindowFocusChange)
  win.addEventListener('focus', onWindowFocusChange)
  win.addEventListener('message', onMessage)

  return {
    dispose() {
      if (checkTimer !== undefined) win.clearTimeout(checkTimer)
      doc.removeEventListener('focusin', onFocusIn)
      win.removeEventListener('blur', onWindowFocusChange)
      win.removeEventListener('focus', onWindowFocusChange)
      win.removeEventListener('message', onMessage)
    },
  }
}
