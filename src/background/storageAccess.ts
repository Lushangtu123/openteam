// Chats, settings and API keys are kept in the extension's storage. The browser lets content
// scripts read that storage too unless told otherwise, and OpenTeam's content script runs inside
// the pages of the AI sites: whatever got hold of it there could read all of it. Nothing that runs
// in a site's page uses the storage (storageAccess.test.ts checks that), so it is closed to
// everything but the extension's own pages and background. Done at every start of the background.
const EXTENSION_ONLY = 'TRUSTED_CONTEXTS'

export interface RestrictableStorageArea {
  setAccessLevel?(options: { accessLevel: typeof EXTENSION_ONLY }): Promise<void>
}

// Returns the areas that were closed; one that cannot be closed is logged and left as it is.
export async function restrictStorageToExtension(
  areas: Record<string, RestrictableStorageArea | undefined>,
  log: { warn(event: string, details?: Record<string, unknown>): void },
): Promise<string[]> {
  const restricted: string[] = []
  for (const [name, area] of Object.entries(areas)) {
    if (!area?.setAccessLevel) continue
    try {
      await area.setAccessLevel({ accessLevel: EXTENSION_ONLY })
      restricted.push(name)
    } catch (error) {
      log.warn('storage-access:not-restricted', { area: name, error: error instanceof Error ? error.message : String(error) })
    }
  }
  return restricted
}
