// The members' AI pages run in frames underneath OpenTeam. Typing a prompt into one needs the
// keyboard focus inside it; keys the user types meanwhile would go into that hidden page, and an
// unfinished pinyin entry would be cut off. So pages type in turns (see ../shared/frameInput):
// one at a time, only when the user has paused typing in OpenTeam, and the focus comes back to
// where the user was as soon as the page is done. A page that grabs the focus without a turn (a site
// focusing its own box as it loads) gives it back at once.
import { FRAME_INPUT_GRANT_MESSAGE, isFrameInputMessage, type FrameInputGrantMessage } from '../shared/frameInput'

export interface MemberFocusGuardDependencies {
  // Where the member frames are.
  hostEl: HTMLElement
  // The user is looking at the AI pages: the focus there is theirs.
  isShowingPages(): boolean
  // Where the focus goes when the user had none in OpenTeam yet.
  homeFocusEl?: HTMLElement
  window?: Window
  // How long the user must have stopped typing before a page may type.
  userPauseMs?: number
  // The longest one page keeps its turn.
  turnLimitMs?: number
}

export interface MemberFocusGuard {
  dispose(): void
}

interface Turn {
  source: Window
  origin: string
  turnId: string
}

export const USER_PAUSE_MS = 1500
const TURN_LIMIT_MS = 20_000
// Focus moves into a frame a moment before anything else is known about it.
const SETTLE_MS = 50

export function createMemberFocusGuard(deps: MemberFocusGuardDependencies): MemberFocusGuard {
  const win = deps.window ?? window
  const doc = win.document
  const userPauseMs = deps.userPauseMs ?? USER_PAUSE_MS
  const turnLimitMs = deps.turnLimitMs ?? TURN_LIMIT_MS
  const waiting: Turn[] = []
  let holder: (Turn & { since: number }) | undefined
  let lastFocus: HTMLElement | undefined
  let lastUserInputAt = 0
  let composing = false
  let pumpTimer: number | undefined
  let focusTimer: number | undefined

  const frameOf = (source: MessageEventSource | Window | null): HTMLIFrameElement | undefined =>
    source ? [...deps.hostEl.querySelectorAll('iframe')].find(frame => frame.contentWindow === source) : undefined

  function hiddenFrameWithFocus(): HTMLIFrameElement | undefined {
    const active = doc.activeElement
    if (!(active instanceof HTMLIFrameElement) || !deps.hostEl.contains(active)) return undefined
    return deps.isShowingPages() ? undefined : active
  }

  function giveFocusBack(): void {
    const frame = hiddenFrameWithFocus()
    if (!frame) return
    const target = lastFocus?.isConnected ? lastFocus : deps.homeFocusEl
    target?.focus({ preventScroll: true })
    if (doc.activeElement === frame) frame.blur()
  }

  // A page holding a turn keeps the focus; any other page gives it back.
  function checkFocus(): void {
    focusTimer = undefined
    const frame = hiddenFrameWithFocus()
    if (!frame) return
    if (holder && frame.contentWindow === holder.source) return
    giveFocusBack()
  }

  function endTurn(): void {
    holder = undefined
    giveFocusBack()
  }

  function schedulePump(delayMs: number): void {
    if (pumpTimer !== undefined) win.clearTimeout(pumpTimer)
    pumpTimer = win.setTimeout(pump, Math.max(0, delayMs))
  }

  function pump(): void {
    pumpTimer = undefined
    const now = Date.now()
    if (holder && (now - holder.since >= turnLimitMs || !frameOf(holder.source))) endTurn()
    if (holder) return schedulePump(holder.since + turnLimitMs - now)
    for (let index = waiting.length - 1; index >= 0; index -= 1) {
      if (!frameOf(waiting[index].source)) waiting.splice(index, 1)
    }
    if (waiting.length === 0) return
    // The user is typing: the pages wait for a pause.
    if (composing) return schedulePump(250)
    const pauseLeft = lastUserInputAt + userPauseMs - now
    if (pauseLeft > 0) return schedulePump(pauseLeft)
    const next = waiting.shift()!
    holder = { ...next, since: now }
    try {
      next.source.postMessage({ type: FRAME_INPUT_GRANT_MESSAGE, turnId: next.turnId } satisfies FrameInputGrantMessage, next.origin)
    } catch {
      holder = undefined
      return schedulePump(0)
    }
    schedulePump(turnLimitMs)
  }

  const onMessage = (event: MessageEvent) => {
    if (!isFrameInputMessage(event.data)) return
    const frame = frameOf(event.source)
    if (!frame?.contentWindow) return
    const source = frame.contentWindow
    const { state, turnId } = event.data
    if (state === 'request') {
      if (!waiting.some(turn => turn.source === source && turn.turnId === turnId)) waiting.push({ source, origin: event.origin, turnId })
      return schedulePump(0)
    }
    if (holder?.source === source && holder.turnId === turnId) endTurn()
    else {
      const index = waiting.findIndex(turn => turn.source === source && turn.turnId === turnId)
      if (index >= 0) waiting.splice(index, 1)
    }
    schedulePump(0)
  }

  const isOpenTeamTarget = (target: EventTarget | null): target is HTMLElement =>
    target instanceof HTMLElement && !(target instanceof HTMLIFrameElement) && !deps.hostEl.contains(target)

  const onFocusIn = (event: FocusEvent) => {
    if (isOpenTeamTarget(event.target)) lastFocus = event.target
  }
  const onUserInput = (event: Event) => {
    if (!isOpenTeamTarget(event.target)) return
    lastUserInputAt = Date.now()
    if (event.type === 'compositionstart') composing = true
    if (event.type === 'compositionend') composing = false
  }
  // Focus going into a frame blurs this window; coming back to the tab focuses it, and the focus may
  // have been left in a hidden page meanwhile.
  const onWindowFocusChange = () => {
    if (focusTimer !== undefined) win.clearTimeout(focusTimer)
    focusTimer = win.setTimeout(checkFocus, SETTLE_MS)
  }

  const userInputEvents = ['keydown', 'input', 'compositionstart', 'compositionupdate', 'compositionend'] as const
  doc.addEventListener('focusin', onFocusIn)
  for (const type of userInputEvents) doc.addEventListener(type, onUserInput, true)
  win.addEventListener('blur', onWindowFocusChange)
  win.addEventListener('focus', onWindowFocusChange)
  win.addEventListener('message', onMessage)

  return {
    dispose() {
      if (pumpTimer !== undefined) win.clearTimeout(pumpTimer)
      if (focusTimer !== undefined) win.clearTimeout(focusTimer)
      doc.removeEventListener('focusin', onFocusIn)
      for (const type of userInputEvents) doc.removeEventListener(type, onUserInput, true)
      win.removeEventListener('blur', onWindowFocusChange)
      win.removeEventListener('focus', onWindowFocusChange)
      win.removeEventListener('message', onMessage)
    },
  }
}
