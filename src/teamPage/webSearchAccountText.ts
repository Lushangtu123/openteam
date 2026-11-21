// What the Tavily account has used, in a line, for the 联网搜索 and 用量 windows and the notice
// (src/shared/webSearchUsage.ts): credits against the nearer limit, the plan, and when it was read.
import { searchQuotaState, type WebSearchUsage } from '../shared/webSearchUsage'

export function accountUsageText(usage: WebSearchUsage | undefined, english: boolean, now: number): string | undefined {
  const account = usage?.account
  if (!account) return undefined
  const quota = searchQuotaState(usage)
  const when = readAt(account.checkedAt, now, english)
  const parts: string[] = []
  if (quota) {
    const percent = Math.round(quota.share * 100)
    parts.push(quota.scope === 'key'
      ? (english ? `This key used ${quota.used} of its ${quota.limit} credits this cycle (${percent}%)` : `这个 Key 本期已用 ${quota.used} / ${quota.limit} 个额度（${percent}%，是你在 Tavily 给它设的上限）`)
      : (english ? `${quota.used} of ${quota.limit} credits used this cycle (${percent}%)` : `本期已用 ${quota.used} / ${quota.limit} 个额度（${percent}%）`))
  } else {
    parts.push(english ? `${account.used} credits used this cycle` : `本期已用 ${account.used} 个额度`)
  }
  if (account.plan) parts.push(english ? `plan ${account.plan}` : `套餐 ${account.plan}`)
  parts.push(english ? `read ${when}` : `${when}读取`)
  return parts.join(' · ')
}

// "07:58", or "11月20日 07:58" on another day.
function readAt(time: number, now: number, english: boolean): string {
  const date = new Date(time)
  const clock = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
  if (date.toDateString() === new Date(now).toDateString()) return english ? `at ${clock}` : `${clock} `
  return english ? `on ${date.getMonth() + 1}/${date.getDate()} at ${clock}` : `${date.getMonth() + 1}月${date.getDate()}日 ${clock} `
}
