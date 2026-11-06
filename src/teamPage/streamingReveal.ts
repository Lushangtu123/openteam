// Shows a reply that grows in bursts (a web member's live text every half second, an API member's
// stream chunk by chunk) as one smooth flow: the new part is revealed a few characters at a time,
// catching up within about `catchUpMs` however much arrived. Text that is rewritten rather than
// extended is shown at once. Off when the user asks for reduced motion.

export interface StreamingRevealDependencies {
  // Draws `text` into `body` (replacing what was there).
  render(body: HTMLElement, text: string): void
  catchUpMs?: number
  // At most one redraw per this many milliseconds while revealing.
  minFrameMs?: number
  requestFrame?: (callback: (time: number) => void) => number
  cancelFrame?: (id: number) => void
  reduceMotion?: () => boolean
}

export interface StreamingReveal {
  show(key: string, body: HTMLElement, text: string): void
  // Forgets every reply but these (the ones still streaming).
  retain(keys: Set<string>): void
  isRevealing(key: string): boolean
}

interface RevealState {
  target: string
  shown: number
  body: HTMLElement
  frame?: number
  lastTick?: number
  lastRender: number
}

const DEFAULT_CATCH_UP_MS = 650
const DEFAULT_MIN_FRAME_MS = 40

export function createStreamingReveal(deps: StreamingRevealDependencies): StreamingReveal {
  const catchUpMs = deps.catchUpMs ?? DEFAULT_CATCH_UP_MS
  const minFrameMs = deps.minFrameMs ?? DEFAULT_MIN_FRAME_MS
  const requestFrame = deps.requestFrame ?? (callback => window.requestAnimationFrame(callback))
  const cancelFrame = deps.cancelFrame ?? (id => window.cancelAnimationFrame(id))
  const reduceMotion = deps.reduceMotion ?? (() => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false)
  const states = new Map<string, RevealState>()

  function show(key: string, body: HTMLElement, text: string): void {
    const state = states.get(key)
    let shown = state ? Math.min(state.shown, text.length) : 0
    // Rewritten rather than extended: show it as it is now.
    if (state && !text.startsWith(state.target.slice(0, shown))) shown = text.length
    if (reduceMotion()) shown = text.length
    const next: RevealState = { target: text, shown, body, frame: state?.frame, lastTick: state?.lastTick, lastRender: state?.lastRender ?? 0 }
    states.set(key, next)
    deps.render(body, text.slice(0, safeEnd(text, shown)))
    if (next.shown < text.length && next.frame === undefined) schedule(key)
    if (next.shown >= text.length && next.frame !== undefined) {
      cancelFrame(next.frame)
      next.frame = undefined
    }
  }

  function schedule(key: string): void {
    const state = states.get(key)
    if (!state) return
    state.frame = requestFrame(time => tick(key, time))
  }

  function tick(key: string, time: number): void {
    const state = states.get(key)
    if (!state) return
    state.frame = undefined
    // Drawn somewhere no longer on screen: wait for the next show() to give the new place.
    if (!state.body.isConnected) {
      state.lastTick = undefined
      return
    }
    const elapsed = state.lastTick === undefined ? 16 : Math.max(1, time - state.lastTick)
    state.lastTick = time
    const backlog = state.target.length - state.shown
    state.shown = Math.min(state.target.length, state.shown + Math.max(1, Math.ceil(backlog * elapsed / catchUpMs)))
    const done = state.shown >= state.target.length
    if (done || time - state.lastRender >= minFrameMs) {
      state.lastRender = time
      deps.render(state.body, state.target.slice(0, safeEnd(state.target, state.shown)))
    }
    if (!done) schedule(key)
    else state.lastTick = undefined
  }

  function retain(keys: Set<string>): void {
    for (const [key, state] of states) {
      if (keys.has(key)) continue
      if (state.frame !== undefined) cancelFrame(state.frame)
      states.delete(key)
    }
  }

  return {
    show,
    retain,
    isRevealing: key => {
      const state = states.get(key)
      return Boolean(state && state.shown < state.target.length)
    },
  }
}

// Never cut between the two halves of a surrogate pair (emoji and rare characters).
function safeEnd(text: string, end: number): number {
  if (end > 0 && end < text.length) {
    const code = text.charCodeAt(end - 1)
    if (code >= 0xd800 && code <= 0xdbff) return end + 1
  }
  return end
}
