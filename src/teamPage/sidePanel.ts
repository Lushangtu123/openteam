// OpenTeam in Chrome's side panel (team.html?view=panel), beside the page the user is reading. It
// shows and sends like the OpenTeam tab, and while open it holds the members' AI pages: they stay
// visible to Chrome there, so they keep working while the user reads another tab (a tab in the
// background is held back after a few minutes). An OpenTeam tab lets them go while a panel is open
// (teamPagePrimary.ts). The member pages talk to the background over ports (memberLink.ts), and
// the panel, being no tab either, hears the store and other news over its own port.

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
  openInTabButton: HTMLButtonElement
  closeWindow(): void
}

export interface SidePanel {
  start(): Promise<void>
  // A member's AI page held by an OpenTeam tab (another window's panel holds them, say): that tab
  // is brought forward showing it.
  showMemberPage(chatId: string, roleId: string): Promise<void>
}

export function createSidePanel(deps: SidePanelDependencies): SidePanel {
  let windowId: number | undefined

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
    },
    async showMemberPage(chatId, roleId) {
      await deps.sendRuntimeMessage('TEAM_PAGE_SHOW', { windowId, chatId, roleId }).catch(() => undefined)
    },
  }
}
