// Chrome's own wording when a message has nobody to receive it: the other side (a member's page, or
// the background after the extension was reloaded) is gone. Code that has to tell this case apart
// matches this wording; only what the user is shown is put in plain words.
export const MEMBER_PAGE_GONE_MESSAGE = '连不上成员的网页（它可能已关闭或刷新）。请在成员卡片的菜单里点「刷新网页」后再试。'
export const BACKGROUND_GONE_MESSAGE = 'OpenTeam 后台暂时没有响应（扩展可能刚重新加载）。请刷新本页后再试。'

export function isReceiverGoneError(message: string): boolean {
  return message.includes('Could not establish connection') || message.includes('Receiving end does not exist')
}

// What the background answers the page with when a request failed. In the background, a message
// with nobody to receive it was one sent to a member's page.
export function backgroundErrorForUser(message: string): string {
  return isReceiverGoneError(message) ? MEMBER_PAGE_GONE_MESSAGE : message
}
