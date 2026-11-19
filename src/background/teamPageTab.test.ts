import { describe, expect, it, vi } from 'vitest'
import { createTeamPageShower } from './teamPageTab'

const TEAM_URL = 'chrome-extension://test/team.html'

function setup(openTabs: Array<{ id?: number; windowId?: number; lastAccessed?: number }>) {
  const tabs = {
    query: vi.fn(async (_queryInfo: { url: string }) => openTabs),
    create: vi.fn(async (_properties: { url: string; active: boolean; windowId?: number }) => ({ id: 99 })),
    update: vi.fn(async (_tabId: number, _properties: { active: boolean }) => undefined),
  }
  const windows = { update: vi.fn(async (_windowId: number, _info: { focused: boolean }) => undefined) }
  return { tabs, windows, show: createTeamPageShower(tabs, TEAM_URL, windows) }
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
    const { tabs, windows, show } = setup([{ id: 7 }, { id: 8 }])

    await show()
    await show()

    expect(tabs.create).not.toHaveBeenCalled()
    expect(tabs.update).toHaveBeenCalledTimes(2)
    expect(tabs.update).toHaveBeenCalledWith(7, { active: true })
    // A command typed in a terminal does not pull the browser window in front of it.
    expect(windows.update).not.toHaveBeenCalled()
  })
})

describe('showing the OpenTeam page from the toolbar icon', () => {
  it('brings the open OpenTeam tab forward, and its window, instead of opening another', async () => {
    const { tabs, windows, show } = setup([{ id: 7, windowId: 2 }])

    await show({ fromWindowId: 1, focusWindow: true })

    expect(tabs.create).not.toHaveBeenCalled()
    expect(tabs.update).toHaveBeenCalledWith(7, { active: true })
    expect(windows.update).toHaveBeenCalledWith(2, { focused: true })
  })

  it('prefers an OpenTeam tab in the window the icon was clicked in, then the one used last', async () => {
    const tabs = [{ id: 7, windowId: 2, lastAccessed: 300 }, { id: 8, windowId: 1, lastAccessed: 100 }, { id: 9, windowId: 3, lastAccessed: 500 }]

    const here = setup(tabs)
    await here.show({ fromWindowId: 1, focusWindow: true })
    expect(here.tabs.update).toHaveBeenCalledWith(8, { active: true })

    const elsewhere = setup(tabs)
    await elsewhere.show({ fromWindowId: 4, focusWindow: true })
    expect(elsewhere.tabs.update).toHaveBeenCalledWith(9, { active: true })
    expect(elsewhere.windows.update).toHaveBeenCalledWith(3, { focused: true })
  })

  it('opens one in the window the icon was clicked in when none is open', async () => {
    const { tabs, windows, show } = setup([])

    await show({ fromWindowId: 4, focusWindow: true })

    expect(tabs.create).toHaveBeenCalledWith({ url: TEAM_URL, active: true, windowId: 4 })
    expect(windows.update).not.toHaveBeenCalled()
  })

  it('opens a tab behind the user\'s for a scheduled task, and leaves an open one where it is', async () => {
    const closed = setup([])
    await closed.show({ background: true })
    expect(closed.tabs.create).toHaveBeenCalledWith({ url: TEAM_URL, active: false })

    const open = setup([{ id: 7, windowId: 1 }])
    await open.show({ background: true })
    expect(open.tabs.create).not.toHaveBeenCalled()
    expect(open.tabs.update).not.toHaveBeenCalled()
    expect(open.windows.update).not.toHaveBeenCalled()
  })
})
