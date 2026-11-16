// One local agent at a time in a folder. Two agents working in the same files at once would overwrite
// each other's edits, so a run waits until every run that came before it in the same folder, or in a
// folder inside it or around it, has finished. Runs in folders that do not overlap go on together.

export interface WorkspaceTicket {
  // The members whose runs this one waits for, oldest first; empty when it can start at once.
  waitingFor: string[]
  // Resolves once those runs have finished; rejects with an AbortError when the signal fires first.
  ready(signal?: AbortSignal): Promise<void>
  // Lets the runs behind this one go on. Call it once the run has finished, failed or been stopped.
  release(): void
}

export interface WorkspaceQueue {
  enter(workspace: string, who: string): WorkspaceTicket
}

export function normalizeWorkspace(path: string): string {
  const trimmed = path.trim()
  return trimmed.length > 1 ? trimmed.replace(/\/+$/, '') : trimmed
}

export function workspacesOverlap(left: string, right: string): boolean {
  const a = normalizeWorkspace(left)
  const b = normalizeWorkspace(right)
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`) || a === '/' || b === '/'
}

export function createWorkspaceQueue(): WorkspaceQueue {
  const held: Array<{ workspace: string; who: string; finished: Promise<void> }> = []

  return {
    enter(workspace, who) {
      const ahead = held.filter(entry => workspacesOverlap(entry.workspace, workspace))
      let finish!: () => void
      const entry = { workspace, who, finished: new Promise<void>(resolve => { finish = resolve }) }
      held.push(entry)
      let released = false
      const release = () => {
        if (released) return
        released = true
        const index = held.indexOf(entry)
        if (index >= 0) held.splice(index, 1)
        finish()
      }
      return {
        waitingFor: ahead.map(item => item.who),
        release,
        async ready(signal) {
          if (ahead.length === 0) return
          const all = Promise.all(ahead.map(item => item.finished)).then(() => undefined)
          if (!signal) return all
          if (signal.aborted) throw abortError()
          let onAbort: (() => void) | undefined
          try {
            await Promise.race([all, new Promise<never>((_, reject) => {
              onAbort = () => reject(abortError())
              signal.addEventListener('abort', onAbort, { once: true })
            })])
          } finally {
            if (onAbort) signal.removeEventListener('abort', onAbort)
          }
        },
      }
    },
  }
}

function abortError(): Error {
  const error = new Error('aborted')
  error.name = 'AbortError'
  return error
}
