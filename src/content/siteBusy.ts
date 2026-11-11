// A site cannot take a prompt while it is still writing a reply: its send button is a stop button
// then, and what is typed stays in the box. That happens when a member's page is opened again
// after OpenTeam was closed mid-reply: the site goes on writing the earlier reply (ChatGPT does).
// Worse, that reply, still growing, would be read as the answer to the new prompt. So a prompt
// waits until the site is done before it goes in.

// The longest a prompt waits for the site.
export const SITE_BUSY_MAX_WAIT_MS = 10 * 60_000
const SITE_BUSY_POLL_MS = 1_000
// How often the member says, meanwhile, that it is still taking the prompt: well within the time
// after which a member with no sign of its reply counts as stuck (see ../group/replyTiming).
export const SITE_BUSY_HEARTBEAT_MS = 30_000

export interface SiteBusyWait {
  isGenerating(): boolean
  // The reply this prompt is for was stopped while it waited.
  isStopped(): boolean
  heartbeat(): void
  now?(): number
  sleep?(ms: number): Promise<void>
}

export async function waitUntilSiteIsDone(wait: SiteBusyWait): Promise<'done' | 'stopped'> {
  const now = wait.now ?? Date.now
  const sleep = wait.sleep ?? (ms => new Promise<void>(resolve => setTimeout(resolve, ms)))
  const startedAt = now()
  let lastHeartbeatAt = startedAt
  while (true) {
    if (wait.isStopped()) return 'stopped'
    if (!wait.isGenerating()) return 'done'
    if (now() - startedAt >= SITE_BUSY_MAX_WAIT_MS) throw new Error('站点还在生成上一条回复，提示词没有发出。等它写完后可以点重新回复再试。')
    if (now() - lastHeartbeatAt >= SITE_BUSY_HEARTBEAT_MS) {
      lastHeartbeatAt = now()
      wait.heartbeat()
    }
    await sleep(SITE_BUSY_POLL_MS)
  }
}
