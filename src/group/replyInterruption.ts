// The note OpenTeam puts on a web member's reply that its page stopped reading (interruptedReplies.ts
// in the background), and what had been read before it.
export const SITE_REPLY_NOTICE = '⚠️ 这条回复还没有读完，成员页面就关闭或重新加载了（OpenTeam 页面被关闭或刷新，或浏览器被关闭）。站点上可能已经写完。\n\n可以点击下方的重新同步完整回复按钮把它读回来。'
// The note before the page's reload was mentioned, still in replies kept back then.
const EARLIER_SITE_REPLY_NOTICES = ['⚠️ 这条回复还没有读完，成员页面就关闭了（OpenTeam 页面或浏览器被关闭）。站点上可能已经写完。\n\n可以点击下方的重新同步完整回复按钮把它读回来。']

// What had been read of a web member's reply that was ended here, without the note: the text the
// member's page looks for on the site when the reply is read again (重新同步完整回复).
export function textReadBeforeInterruption(content: string): string {
  for (const notice of [SITE_REPLY_NOTICE, ...EARLIER_SITE_REPLY_NOTICES]) {
    if (content === notice) return ''
    const suffix = `\n\n${notice}`
    if (content.endsWith(suffix)) return content.slice(0, -suffix.length)
  }
  return content
}
