// Whether each member's page was hidden, and when. A page in a hidden OpenTeam tab (the window
// minimized, the screen locked, another tab in front) barely runs: it reads no replies, so a reply
// it missed then says nothing about the site. Member pages say so (TEAM_FRAME_VISIBILITY), and again
// with each heartbeat while hidden, so a background that started again learns it soon. Kept in
// memory only: it matters for the minutes a reply takes.
export interface PageVisibility {
  record(chatId: string, roleId: string, hidden: boolean): void
  // Hidden at some time between from and to (now when left out).
  wasHidden(chatId: string, roleId: string, from: number, to?: number): boolean
}

const SPANS_KEPT = 20

interface MemberPage {
  hiddenSince?: number
  // Times hidden that have ended, oldest first.
  spans: Array<[number, number]>
}

export function createPageVisibility(now: () => number): PageVisibility {
  const pages = new Map<string, MemberPage>()
  const key = (chatId: string, roleId: string) => `${chatId}\u0000${roleId}`

  return {
    record(chatId, roleId, hidden) {
      const page = pages.get(key(chatId, roleId)) ?? { spans: [] }
      pages.set(key(chatId, roleId), page)
      if (hidden) {
        page.hiddenSince ??= now()
        return
      }
      if (page.hiddenSince === undefined) return
      page.spans = [...page.spans, [page.hiddenSince, now()] as [number, number]].slice(-SPANS_KEPT)
      delete page.hiddenSince
    },
    wasHidden(chatId, roleId, from, to = now()) {
      const page = pages.get(key(chatId, roleId))
      if (!page) return false
      if (page.hiddenSince !== undefined && page.hiddenSince <= to) return true
      return page.spans.some(([start, end]) => start <= to && end >= from)
    },
  }
}
