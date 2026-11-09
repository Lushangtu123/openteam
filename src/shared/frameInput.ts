// Typing a prompt into a member's AI page needs the keyboard focus inside that page, which runs in a
// frame hidden under OpenTeam. Keys the user types meanwhile would go into the hidden page, and an
// unfinished pinyin entry would be cut off. So a page asks OpenTeam for a turn before it types;
// OpenTeam grants turns one at a time, when the user has paused typing, and takes the focus back
// as soon as the page says it no longer needs it.

// Page → OpenTeam: 'request' asks for a turn, 'done' gives it back.
export const FRAME_INPUT_MESSAGE = 'OPENTEAM_FRAME_INPUT'
// OpenTeam → page: the turn is yours.
export const FRAME_INPUT_GRANT_MESSAGE = 'OPENTEAM_FRAME_INPUT_GRANT'

export interface FrameInputMessage {
  type: typeof FRAME_INPUT_MESSAGE
  state: 'request' | 'done'
  turnId: string
}

export interface FrameInputGrantMessage {
  type: typeof FRAME_INPUT_GRANT_MESSAGE
  turnId: string
}

export function isFrameInputMessage(value: unknown): value is FrameInputMessage {
  if (!value || typeof value !== 'object') return false
  const message = value as Partial<FrameInputMessage>
  return message.type === FRAME_INPUT_MESSAGE && (message.state === 'request' || message.state === 'done') && typeof message.turnId === 'string'
}

export function isFrameInputGrantMessage(value: unknown): value is FrameInputGrantMessage {
  if (!value || typeof value !== 'object') return false
  const message = value as Partial<FrameInputGrantMessage>
  return message.type === FRAME_INPUT_GRANT_MESSAGE && typeof message.turnId === 'string'
}
