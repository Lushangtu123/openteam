import { describe, expect, it, vi } from 'vitest'
import { UPDATE_CHECK_INTERVAL_MS, availableUpdate, compareVersions, readUpdateState, refreshUpdateState } from './updateCheck'

const NOW = 1_800_000_000_000
const release = (tag: string, url = `https://github.com/Lushangtu123/openteam/releases/tag/${tag}`) =>
  new Response(JSON.stringify({ tag_name: tag, html_url: url, draft: false, prerelease: false }), { status: 200, headers: { 'content-type': 'application/json' } })

describe('version comparison', () => {
  it('compares dotted versions as numbers, with or without a leading v', () => {
    expect(compareVersions('1.10.0', '1.9.3')).toBeGreaterThan(0)
    expect(compareVersions('v1.4.0', '1.4.0')).toBe(0)
    expect(compareVersions('1.4', '1.4.1')).toBeLessThan(0)
    expect(compareVersions('2.0.0', '1.99.99')).toBeGreaterThan(0)
  })
})

describe('the saved state', () => {
  it('checks by default, and keeps only what it understands', () => {
    expect(readUpdateState(undefined)).toEqual({ enabled: true })
    expect(readUpdateState({ enabled: false, lastCheckedAt: 5, latest: { version: '1.5.0', url: 'https://github.com/x' }, ignoredVersion: '1.5.0', junk: 1 }))
      .toEqual({ enabled: false, lastCheckedAt: 5, latest: { version: '1.5.0', url: 'https://github.com/x' }, ignoredVersion: '1.5.0' })
    // A link that does not go to GitHub is dropped.
    expect(readUpdateState({ latest: { version: '1.5.0', url: 'https://evil.example/x' } })).toEqual({ enabled: true })
  })
})

describe('checking for a new version', () => {
  it('asks GitHub for the latest release and keeps its version and page', async () => {
    const fetchImpl = vi.fn(async () => release('v1.5.0'))
    const state = await refreshUpdateState({ state: { enabled: true }, now: NOW, fetchImpl })

    expect(fetchImpl).toHaveBeenCalledWith('https://api.github.com/repos/Lushangtu123/openteam/releases/latest', expect.objectContaining({ headers: expect.objectContaining({ Accept: 'application/vnd.github+json' }) }))
    expect(state).toEqual({ enabled: true, lastCheckedAt: NOW, latest: { version: '1.5.0', url: 'https://github.com/Lushangtu123/openteam/releases/tag/v1.5.0' } })
  })

  it('asks at most once a day, unless asked to now', async () => {
    const fetchImpl = vi.fn(async () => release('v1.5.0'))
    const recent = { enabled: true, lastCheckedAt: NOW - UPDATE_CHECK_INTERVAL_MS + 60_000 }
    expect(await refreshUpdateState({ state: recent, now: NOW, fetchImpl })).toBe(recent)
    expect(fetchImpl).not.toHaveBeenCalled()

    await refreshUpdateState({ state: recent, now: NOW, fetchImpl, force: true })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('does not ask when checking is off', async () => {
    const fetchImpl = vi.fn(async () => release('v1.5.0'))
    const off = { enabled: false }
    expect(await refreshUpdateState({ state: off, now: NOW, fetchImpl, force: true })).toBe(off)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('keeps what it knew when GitHub cannot be reached or answers oddly, and tries again next time', async () => {
    const known = { enabled: true, lastCheckedAt: NOW - 2 * UPDATE_CHECK_INTERVAL_MS, latest: { version: '1.5.0', url: 'https://github.com/Lushangtu123/openteam/releases/tag/v1.5.0' } }
    expect(await refreshUpdateState({ state: known, now: NOW, fetchImpl: async () => { throw new TypeError('Failed to fetch') } })).toBe(known)
    expect(await refreshUpdateState({ state: known, now: NOW, fetchImpl: async () => new Response('rate limited', { status: 403 }) })).toBe(known)
    expect(await refreshUpdateState({ state: known, now: NOW, fetchImpl: async () => release('not-a-version') })).toBe(known)
  })
})

describe('the update to offer', () => {
  const state = { enabled: true, latest: { version: '1.5.0', url: 'https://github.com/Lushangtu123/openteam/releases/tag/v1.5.0' } }

  it('is the latest release when it is newer than this one', () => {
    expect(availableUpdate(state, '1.4.0')).toEqual(state.latest)
    expect(availableUpdate(state, '1.5.0')).toBeUndefined()
    expect(availableUpdate(state, '1.6.0')).toBeUndefined()
  })

  it('is nothing once that version is ignored, or when checking is off', () => {
    expect(availableUpdate({ ...state, ignoredVersion: '1.5.0' }, '1.4.0')).toBeUndefined()
    expect(availableUpdate({ ...state, enabled: false }, '1.4.0')).toBeUndefined()
  })
})
