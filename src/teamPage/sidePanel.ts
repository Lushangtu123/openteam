// OpenTeam in Chrome's side panel (team.html?view=panel), beside the page the user is reading. It
// shows and sends like the OpenTeam tab, but hosts no member pages: Chrome reaches a page inside a
// frame only through the tab it is in, so members' AI pages load in an OpenTeam tab, which the
// background opens behind the current one when needed. Being no tab, the panel hears the store
// and other news from the background over a port.

// How soon the panel connects again after the background stopped (it is woken by connecting).
export const PANEL_RECONNECT_DELAY_MS = 500

export function isSidePanel(search: string): boolean {
  return new URLSearchParams(search).get('view') === 'panel'
}

interface PanelPort {
  onMessage: { addListener(listener: (message: unknown) => void): void }
  onDisconnect: { addListener(listener: () => void): void }
}

export interface SidePanelDependencies {
  connect(): PanelPort
  onPush(message: unknown): void
  // Connected again after a break: what was missed is read again.
  onReconnected(): void
  sendRuntimeMessage(type: string, payload?: Record<string, unknown>): Promise<unknown>
  getWindowId(): Promise<number | undefined>
  // The current group's id when it has members on AI sites, whose pages need an OpenTeam tab.
  memberPagesFor(): string | undefined
  openInTabButton: HTMLButtonElement
  closeWindow(): void
}

export interface SidePanel {
  start(): Promise<void>
  // After the store changed: another group may need member pages.
  refresh(): void
  // A member's AI page, which lives in the OpenTeam tab: that tab is brought forward showing it.
  showMemberPage(chatId: string, roleId: string): Promise<void>
}

export function createSidePanel(deps: SidePanelDependencies): SidePanel {
  let windowId: number | undefined
  let ensuredFor: string | undefined

  function connect(reconnected: boolean): void {
    let port: PanelPort
    try {
      port = deps.connect()
    } catch {
      setTimeout(() => connect(true), PANEL_RECONNECT_DELAY_MS * 4)
      return
    }
    port.onMessage.addListener(message => deps.onPush(message))
    port.onDisconnect.addListener(() => setTimeout(() => connect(true), PANEL_RECONNECT_DELAY_MS))
    if (reconnected) deps.onReconnected()
  }

  function ensureMemberPages(force: boolean): void {
    const chatId = deps.memberPagesFor()
    if (!chatId || (!force && chatId === ensuredFor)) return
    ensuredFor = chatId
    deps.sendRuntimeMessage('TEAM_PAGE_HOST_ENSURE', { windowId }).catch(() => {
      ensuredFor = undefined
    })
  }

  return {
    async start() {
      windowId = await deps.getWindowId().catch(() => undefined)
      connect(false)
      deps.openInTabButton.hidden = false
      deps.openInTabButton.addEventListener('click', () => {
        deps.sendRuntimeMessage('TEAM_PAGE_SHOW', { windowId })
          .catch(() => undefined)
          .then(() => deps.closeWindow())
      })
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') ensureMemberPages(true)
      })
      ensureMemberPages(false)
    },
    refresh() {
      ensureMemberPages(false)
    },
    async showMemberPage(chatId, roleId) {
      await deps.sendRuntimeMessage('TEAM_PAGE_SHOW', { windowId, chatId, roleId }).catch(() => undefined)
    },
  }
}
