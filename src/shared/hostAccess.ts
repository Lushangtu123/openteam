// OpenTeam asks for access to an API model's address only when the user adds that model, instead of
// asking for every website at install time. The manifest lists the AI chat sites it embeds as
// required hosts and "https://*/*" as optional; each API address is granted on its own.

interface PermissionsApi {
  contains(permissions: { origins: string[] }): Promise<boolean>
  request(permissions: { origins: string[] }): Promise<boolean>
}

// What earlier versions required, and what the manifest now lists as optional so that single
// addresses can be asked for. It is never asked for as a whole.
export const ALL_SITES_PATTERN = 'https://*/*'

function permissionsApi(): PermissionsApi | undefined {
  return (globalThis as { chrome?: { permissions?: PermissionsApi } }).chrome?.permissions
}

// The match pattern covering an API address: its scheme and host, any port and path. None for an
// address whose host has a wildcard: that would ask for a whole family of sites, or all of them.
export function hostAccessPattern(baseUrl: string): string | undefined {
  try {
    const url = new URL(baseUrl.trim())
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return undefined
    if (!url.hostname || url.hostname.includes('*')) return undefined
    return `${url.protocol}//${url.hostname}/*`
  } catch {
    return undefined
  }
}

export function hostAccessLabel(baseUrl: string): string {
  try {
    return new URL(baseUrl.trim()).hostname
  } catch {
    return baseUrl
  }
}

// Whether OpenTeam may reach this address. True where the permissions API is missing (tests, old
// browsers): the request itself then decides.
export async function hasHostAccess(baseUrl: string, api: PermissionsApi | undefined = permissionsApi()): Promise<boolean> {
  const pattern = hostAccessPattern(baseUrl)
  if (!pattern) return false
  if (!api) return true
  try {
    return await api.contains({ origins: [pattern] })
  } catch {
    return false
  }
}

// Asks the user to allow this address; the browser shows its own prompt, and only from a click.
// Resolves to whether access is granted (already, or just now).
export async function requestHostAccess(baseUrl: string, api: PermissionsApi | undefined = permissionsApi()): Promise<boolean> {
  const pattern = hostAccessPattern(baseUrl)
  if (!pattern) return false
  if (!api) return true
  if (await hasHostAccess(baseUrl, api)) return true
  try {
    return await api.request({ origins: [pattern] })
  } catch {
    return false
  }
}
