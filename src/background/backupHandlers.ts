import { parseBackup, referencedImageIds, restoreBackup } from '../group/backup'
import type { OpenTeamStore } from '../group/types'
import type { BackgroundMessageRoute } from './messageRouter'
import type { RuntimeMessage } from './runtimeClient'
import { mutateStore } from './storeAccess'

export interface BackupHandlersDependencies {
  broadcastStoreUpdated(store: OpenTeamStore, excludeTabId?: number): Promise<void> | void
  log: {
    info(event: string, details?: Record<string, unknown>): void
    warn(event: string, details?: Record<string, unknown>): void
  }
  imageAttachments?: {
    deleteOrphans(referencedIds: Set<string>): Promise<void>
  }
}

// Restores a backup made by the team page. The page has already written the backup's images.
export function createBackupHandlers(deps: BackupHandlersDependencies): BackgroundMessageRoute[] {
  const handleRestore = async (message: RuntimeMessage) => {
    const parsed = parseBackup(message.backup)
    if (!parsed.ok) return { ok: false, error: parsed.error }
    const mode = message.mode === 'replace' ? 'replace' : 'merge'

    const { store, result } = await mutateStore(draft => {
      const restored = restoreBackup(draft, parsed.backup.store, mode)
      replaceStoreContents(draft, restored.store)
      return { addedChatIds: restored.addedChatIds, skippedChatIds: restored.skippedChatIds }
    })
    deps.log.info('backup:restored', { mode, added: result.addedChatIds.length, skipped: result.skippedChatIds.length })

    if (mode === 'replace' && deps.imageAttachments) {
      deps.imageAttachments.deleteOrphans(new Set(referencedImageIds(store)))
        .catch(error => deps.log.warn('backup:image-cleanup-failed', { error: error instanceof Error ? error.message : String(error) }))
    }
    await deps.broadcastStoreUpdated(store)
    return { ok: true, store, restored: result }
  }

  return [{ type: 'GROUP_BACKUP_RESTORE', handler: handleRestore }]
}

function replaceStoreContents(draft: OpenTeamStore, next: OpenTeamStore): void {
  const target = draft as unknown as Record<string, unknown>
  for (const key of Object.keys(target)) {
    if (!(key in next)) delete target[key]
  }
  Object.assign(draft, next)
}
