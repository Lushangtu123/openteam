// Whether a newer OpenTeam has been released. An extension loaded from a folder is never updated by
// Chrome, so without this nobody who installed a release would hear of the next one. Reads only the
// public version number of the latest GitHub release, at most once a day, and downloads nothing.
// The state is kept in its own storage key, outside the store (and so outside backups).

export const UPDATE_CHECK_STORAGE_KEY = 'openteamUpdateCheck'
export const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000
export const LATEST_RELEASE_API = 'https://api.github.com/repos/Lushangtu123/openteam/releases/latest'

export interface ReleaseInfo {
  version: string
  // The release's page on GitHub.
  url: string
}

export interface UpdateCheckState {
  enabled: boolean
  lastCheckedAt?: number
  latest?: ReleaseInfo
  // A version the user chose not to hear about again.
  ignoredVersion?: string
}

const VERSION = /^v?(\d+(?:\.\d+){0,3})$/

// Dotted versions compared as numbers: 1.10.0 is newer than 1.9.3.
export function compareVersions(left: string, right: string): number {
  const parts = (version: string) => version.replace(/^v/, '').split('.').map(part => Number.parseInt(part, 10) || 0)
  const a = parts(left)
  const b = parts(right)
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0)
    if (difference !== 0) return difference
  }
  return 0
}

export function readUpdateState(raw: unknown): UpdateCheckState {
  const value = isRecord(raw) ? raw : {}
  const state: UpdateCheckState = { enabled: value.enabled !== false }
  if (typeof value.lastCheckedAt === 'number' && Number.isFinite(value.lastCheckedAt)) state.lastCheckedAt = value.lastCheckedAt
  const latest = readRelease(value.latest)
  if (latest) state.latest = latest
  if (typeof value.ignoredVersion === 'string' && VERSION.test(value.ignoredVersion)) state.ignoredVersion = value.ignoredVersion
  return state
}

// The state after asking GitHub, when it is due (or `force`). A failed or odd answer leaves the
// state as it was, so the next opening of the page tries again.
export async function refreshUpdateState(input: { state: UpdateCheckState; now: number; fetchImpl?: typeof fetch; force?: boolean }): Promise<UpdateCheckState> {
  const { state, now } = input
  if (!state.enabled) return state
  if (!input.force && state.lastCheckedAt !== undefined && now - state.lastCheckedAt < UPDATE_CHECK_INTERVAL_MS) return state
  try {
    const response = await (input.fetchImpl ?? fetch)(LATEST_RELEASE_API, { headers: { Accept: 'application/vnd.github+json' } })
    if (!response.ok) return state
    const body = await response.json() as Record<string, unknown>
    const latest = readRelease({ version: typeof body.tag_name === 'string' ? body.tag_name.replace(/^v/, '') : undefined, url: body.html_url })
    if (!latest) return state
    return { ...state, lastCheckedAt: now, latest }
  } catch {
    return state
  }
}

// The release to tell the user about: newer than this one, and not ignored.
export function availableUpdate(state: UpdateCheckState, currentVersion: string): ReleaseInfo | undefined {
  const latest = state.latest
  if (!state.enabled || !latest) return undefined
  if (compareVersions(latest.version, currentVersion) <= 0) return undefined
  if (state.ignoredVersion && compareVersions(state.ignoredVersion, latest.version) === 0) return undefined
  return latest
}

// Only a version number, and a page on GitHub: the link is opened from the settings.
function readRelease(raw: unknown): ReleaseInfo | undefined {
  if (!isRecord(raw)) return undefined
  const { version, url } = raw
  if (typeof version !== 'string' || !VERSION.test(version)) return undefined
  if (typeof url !== 'string' || !url.startsWith('https://github.com/')) return undefined
  return { version: version.replace(/^v/, ''), url }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
