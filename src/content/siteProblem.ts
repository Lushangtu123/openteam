import type { SiteStatusInfo } from './sites/types'

// While a reply is pending, a page that shows it cannot answer (its own error message, a sign-in
// wall, a dialog in front of the input box) fails the reply with what the page says, instead of
// leaving the person "replying" until the reply times out. The same problem has to be seen on two
// checks in a row, so a passing glitch does not fail a reply that is still coming.

export interface SiteProblemTracker {
  // The reason to fail the pending reply with, once the problem is confirmed.
  observe(messageId: string | undefined, status: SiteStatusInfo): string | undefined
}

export function siteProblemReason(siteLabel: string, status: SiteStatusInfo): string | undefined {
  const detail = status.detail?.trim()
  if (status.status === 'unauthorized') return `${siteLabel} 需要登录才能回复，请在 ${siteLabel} 页面登录后重试${detail ? `（${detail}）` : ''}`
  if (status.status === 'error' && status.reason === 'site-error') return `${siteLabel} 页面报错${detail ? `：「${detail}」` : ''}`
  if (status.status === 'blocked' && status.reason === 'overlay') return `${siteLabel} 页面上有弹窗挡住了回复${detail ? `：「${detail}」` : ''}，请在 ${siteLabel} 页面里处理后重试`
  return undefined
}

export function createSiteProblemTracker(siteLabel: string): SiteProblemTracker {
  let seen: { key: string } | undefined
  return {
    observe(messageId, status) {
      const reason = messageId ? siteProblemReason(siteLabel, status) : undefined
      if (!messageId || !reason) {
        seen = undefined
        return undefined
      }
      const key = `${messageId}|${reason}`
      if (seen?.key !== key) {
        seen = { key }
        return undefined
      }
      seen = undefined
      return reason
    },
  }
}
