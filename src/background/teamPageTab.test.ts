import { describe, expect, it, vi } from 'vitest'
import { createTeamPageShower } from './teamPageTab'

const TEAM_URL = 'chrome-extension://test/team.html'

function setup(openTabs: Array<{ id?: number }>) {
  const tabs = {
    query: vi.fn(async () => openTabs),
    create: vi.fn(async () => ({ id: 99 })),
    update: vi.fn(async () => undefined),
  }
  return { tabs, show: createTeamPageShower(tabs, TEAM_URL) }
}

describe('showing the OpenTeam page for a daemon command', () => {
  it('opens a tab when OpenTeam is not open', async () => {
    const { tabs, show } = setup([])

    await show()

    expect(tabs.query).toHaveBeenCalledWith({ url: 'chrome-extension://test/team.html*' })
    expect(tabs.create).toHaveBeenCalledWith({ url: TEAM_URL, active: true })
    expect(tabs.update).not.toHaveBeenCalled()
  })

  it('brings the open tab forward instead of opening another, however often it is asked', async () => {
    const { tabs, show } = setup([{ id: 7 }, { id: 8 }])

    await show()
    await show()

    expect(tabs.create).not.toHaveBeenCalled()
    expect(tabs.update).toHaveBeenCalledTimes(2)
    expect(tabs.update).toHaveBeenCalledWith(7, { active: true })
  })
})
