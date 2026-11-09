// A member's AI page tells the OpenTeam page that embeds it when it starts and stops typing a prompt.
// Typing needs the keyboard focus inside the page; once it is done, OpenTeam takes the focus back so
// the keys the user types next do not land in a page hidden behind OpenTeam.
export const FRAME_INPUT_MESSAGE = 'OPENTEAM_FRAME_INPUT'

export interface FrameInputMessage {
  type: typeof FRAME_INPUT_MESSAGE
  typing: boolean
}

export function isFrameInputMessage(value: unknown): value is FrameInputMessage {
  return Boolean(value) && typeof value === 'object'
    && (value as { type?: unknown }).type === FRAME_INPUT_MESSAGE
    && typeof (value as { typing?: unknown }).typing === 'boolean'
}

// Sent only to OpenTeam's own origin: a page embedded anywhere else tells nobody.
export function signalFrameInput(typing: boolean, extensionOrigin: string, win: Window = window): void {
  if (win.parent === win) return
  try {
    win.parent.postMessage({ type: FRAME_INPUT_MESSAGE, typing } satisfies FrameInputMessage, extensionOrigin)
  } catch {
    // The page is not embedded by OpenTeam: nothing to tell.
  }
}
