// An OpenTeam tab gives the members' pages to OpenTeam in the side panel when it opens
// (teamPagePrimary.ts yieldToPanel). Handing them over loads them again in the panel, which cuts a
// reply being written; the new page then reads it from the site (resumeReply), but that does not
// work on every site. So while a member replies, the tab keeps the pages, and hands them over once
// the replies are in, or after PANEL_HANDOVER_MAX_WAIT_MS at the latest. Meanwhile the panel says
// so (see index.ts).

export const PANEL_HANDOVER_MAX_WAIT_MS = 3 * 60_000

export interface PanelHandoverDependencies {
  // A member of this page is writing a reply.
  replying(): boolean
  yieldToPanel(yielding: boolean): void
  log: { info(event: string, details?: Record<string, unknown>): void; warn(event: string, details?: Record<string, unknown>): void }
}

export interface PanelHandover {
  panelChanged(open: boolean): void
  // The store changed: a reply may have come in.
  storeChanged(): void
  // Waiting for replies before handing the pages over.
  waiting(): boolean
}

export function createPanelHandover(deps: PanelHandoverDependencies): PanelHandover {
  let panelOpen = false
  let timer: ReturnType<typeof setTimeout> | undefined

  function stopWaiting(): void {
    if (timer !== undefined) clearTimeout(timer)
    timer = undefined
  }

  function handOver(): void {
    stopWaiting()
    deps.yieldToPanel(true)
  }

  return {
    panelChanged(open) {
      if (!open) {
        panelOpen = false
        stopWaiting()
        deps.yieldToPanel(false)
        return
      }
      if (panelOpen) return
      panelOpen = true
      if (!deps.replying()) {
        handOver()
        return
      }
      deps.log.info('panel-handover:waiting-for-replies')
      timer = setTimeout(() => {
        deps.log.warn('panel-handover:wait-over', { waitedMs: PANEL_HANDOVER_MAX_WAIT_MS })
        handOver()
      }, PANEL_HANDOVER_MAX_WAIT_MS)
    },
    storeChanged() {
      if (timer === undefined || deps.replying()) return
      deps.log.info('panel-handover:replies-in')
      handOver()
    },
    waiting: () => timer !== undefined,
  }
}
