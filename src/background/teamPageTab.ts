// Commands from the local daemon (openteamcli chat activate, run create-and-post) show the OpenTeam
// page. An OpenTeam tab that is already open is brought forward in its window; a new one is opened
// only when there is none. Two OpenTeam tabs on the same group would each load every member's page,
// and the copies take the member away from each other.

interface TeamPageTab {
  id?: number
}

export interface TeamPageTabsApi {
  query(queryInfo: { url: string }): Promise<TeamPageTab[]>
  create(properties: { url: string; active: boolean }): Promise<unknown>
  update(tabId: number, properties: { active: boolean }): Promise<unknown>
}

export function createTeamPageShower(tabs: TeamPageTabsApi, teamPageUrl: string): () => Promise<void> {
  return async () => {
    const open = (await tabs.query({ url: `${teamPageUrl}*` })).find(tab => tab.id !== undefined)
    if (open?.id === undefined) {
      await tabs.create({ url: teamPageUrl, active: true })
      return
    }
    await tabs.update(open.id, { active: true })
  }
}
