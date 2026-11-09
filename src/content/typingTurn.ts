// The page side of typing turns (see ../shared/frameInput): ask the OpenTeam page that embeds this
// one for a turn, type when it is granted, and give it back as soon as the prompt is in the box.
import { FRAME_INPUT_MESSAGE, isFrameInputGrantMessage, type FrameInputMessage } from '../shared/frameInput'

export interface TypingTurn {
  // Resolves when OpenTeam grants the turn, or after waitLimitMs whatever happens.
  granted: Promise<void>
  // Gives the turn back; later calls do nothing.
  done(): void
}

// OpenTeam holds turns while the user types. A page never waits longer than this: past it, sending
// matters more than the user's keystrokes.
export const TYPING_TURN_WAIT_LIMIT_MS = 60_000

export function requestTypingTurn(options: { extensionOrigin: string; win?: Window; waitLimitMs?: number }): TypingTurn {
  const win = options.win ?? window
  // Not inside OpenTeam: nobody else is typing here.
  if (win.parent === win) return { granted: Promise.resolve(), done: () => undefined }

  const turnId = `turn-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  const post = (state: FrameInputMessage['state']) => {
    try {
      win.parent.postMessage({ type: FRAME_INPUT_MESSAGE, state, turnId } satisfies FrameInputMessage, options.extensionOrigin)
    } catch {
      // Not embedded by OpenTeam.
    }
  }
  let release: () => void = () => undefined
  let finished = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const onMessage = (event: MessageEvent) => {
    if (event.source !== win.parent || event.origin !== options.extensionOrigin) return
    if (isFrameInputGrantMessage(event.data) && event.data.turnId === turnId) release()
  }
  const granted = new Promise<void>(resolve => {
    release = () => {
      win.removeEventListener('message', onMessage)
      if (timer !== undefined) clearTimeout(timer)
      resolve()
    }
    win.addEventListener('message', onMessage)
    timer = setTimeout(() => release(), options.waitLimitMs ?? TYPING_TURN_WAIT_LIMIT_MS)
    post('request')
  })

  return {
    granted,
    done() {
      if (finished) return
      finished = true
      release()
      post('done')
    },
  }
}

// Calls back once the site's input box holds the prompt: from then on the page no longer needs the
// focus (sending is a click). Returns a function that stops watching.
export function watchPromptInBox(findEditor: () => HTMLElement | null | undefined, prompt: string, onInBox: () => void, intervalMs = 50): () => void {
  const expected = comparable(prompt)
  const timer = setInterval(() => {
    const editor = findEditor()
    if (!editor) return
    const text = editor instanceof HTMLTextAreaElement || editor instanceof HTMLInputElement ? editor.value : editor.innerText || editor.textContent || ''
    if (comparable(text) !== expected) return
    clearInterval(timer)
    onInBox()
  }, intervalMs)
  return () => clearInterval(timer)
}

// Sites show line breaks and spaces their own way.
function comparable(value: string): string {
  return value.replace(/[\s​ ]+/g, '')
}
