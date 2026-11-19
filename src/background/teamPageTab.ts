// Shows the OpenTeam page: for the toolbar icon, a reply notification, commands from the local
// daemon (openteamcli chat activate, run create-and-post) and a scheduled task that asks web
// members. An OpenTeam tab that is already open is brought forward; a new one is opened only when there is none. Two OpenTeam tabs on the same
// group would each load every member's page, and the copies take the member away from each other.

interface TeamPageTab {
  id?: number
  windowId?: number
  lastAccessed?: number
}

export interface TeamPageTabsApi {
  query(queryInfo: { url: string }): Promise<TeamPageTab[]>
  create(properties: { url: string; active: boolean; windowId?: number }): Promise<unknown>
  update(tabId: number, properties: { active: boolean }): Promise<unknown>
}

export interface TeamPageWindowsApi {
  update(windowId: number, updateInfo: { focused: boolean }): Promise<unknown>
}

export interface ShowTeamPageOptions {
  // The window the user is in: an OpenTeam tab there is preferred, and a new one opens there.
  fromWindowId?: number
  // Bring the tab's window to the front: the user asked from inside the browser. A command typed
  // in a terminal does not pull the browser in front of it.
  focusWindow?: boolean
}

export function createTeamPageShower(tabs: TeamPageTabsApi, teamPageUrl: string, windows?: TeamPageWindowsApi): (options?: ShowTeamPageOptions) => Promise<void> {
  return async (options = {}) => {
    const open = (await tabs.query({ url: `${teamPageUrl}*` })).filter(tab => tab.id !== undefined)
    const tab = open.find(candidate => options.fromWindowId !== undefined && candidate.windowId === options.fromWindowId)
      ?? [...open].sort((left, right) => (right.lastAccessed ?? 0) - (left.lastAccessed ?? 0))[0]
    if (tab?.id === undefined) {
      await tabs.create({ url: teamPageUrl, active: true, ...(options.fromWindowId !== undefined ? { windowId: options.fromWindowId } : {}) })
      return
    }
    await tabs.update(tab.id, { active: true })
    if (options.focusWindow && tab.windowId !== undefined) await windows?.update(tab.windowId, { focused: true })
  }
}
