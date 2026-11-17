// 导出诊断信息 in the settings: gathers the report (src/shared/diagnostics.ts) from the store, the
// background's recent logs and this page's own, and saves it as a JSON file. A background that
// cannot be reached is itself worth reporting, so the file is saved without its logs and says why.
import type { OpenTeamStore } from '../group/types'
import { buildDiagnosticsReport, diagnosticsFileName, type DiagnosticsReport } from '../shared/diagnostics'
import { recentLogs, type RecentLogEntry } from '../shared/logger'
import { readUpdateState, type UpdateCheckState } from '../shared/updateCheck'

export interface DiagnosticsExportDependencies {
  getStore(): OpenTeamStore
  extensionVersion: string
  userAgent: string
  now(): number
  getBackgroundLogs(): Promise<RecentLogEntry[]>
  getUpdateState(): Promise<unknown>
  save(fileName: string, text: string): void
}

export async function exportDiagnostics(deps: DiagnosticsExportDependencies): Promise<DiagnosticsReport & { backgroundLogsError?: string }> {
  let backgroundLogs: RecentLogEntry[] = []
  let backgroundLogsError: string | undefined
  try {
    backgroundLogs = await deps.getBackgroundLogs()
  } catch (error) {
    backgroundLogsError = error instanceof Error ? error.message : String(error)
  }
  let updateCheck: UpdateCheckState | undefined
  try {
    const raw = await deps.getUpdateState()
    if (raw !== undefined) updateCheck = readUpdateState(raw)
  } catch {
    // Reported without it.
  }
  const now = deps.now()
  const report = {
    ...buildDiagnosticsReport({ now, extensionVersion: deps.extensionVersion, userAgent: deps.userAgent, store: deps.getStore(), updateCheck, backgroundLogs, pageLogs: recentLogs() }),
    ...(backgroundLogsError ? { backgroundLogsError } : {}),
  }
  deps.save(diagnosticsFileName(now), JSON.stringify(report, null, 2))
  return report
}

// Saves text as a download, through a link the page clicks.
export function saveTextFile(fileName: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }))
  const link = document.createElement('a')
  link.href = url
  link.download = fileName
  link.click()
  window.setTimeout(() => URL.revokeObjectURL(url), 1000)
}
