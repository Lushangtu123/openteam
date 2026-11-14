// The daemon's own record, in a file: when it started and ended and why (a signal, a crash, a
// request to stop), the extension connecting and leaving, local agent runs. The daemon runs
// detached with its output thrown away, so without this an ended daemon leaves no trace. Prompts
// and the token are never written here.
import { appendFileSync, closeSync, mkdirSync, openSync, readSync, renameSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, resolve } from 'node:path'

export const DEFAULT_LOG_PATH = resolve(homedir(), '.openteam/daemon.log')
// One file this size is kept as daemon.log.1 when a new one starts.
export const LOG_MAX_BYTES = 1_000_000
const LAST_LINE_READ_BYTES = 8_192

export function createDaemonLogFile(options = {}) {
  const path = options.path ?? DEFAULT_LOG_PATH
  const maxBytes = options.maxBytes ?? LOG_MAX_BYTES
  const now = options.now ?? (() => new Date())
  try { mkdirSync(dirname(path), { recursive: true, mode: 0o700 }) } catch { /* written below, or not at all */ }
  let size = sizeOf(path)

  return {
    path,
    write(event, details = {}) {
      const line = `${now().toISOString()} ${event} ${JSON.stringify(details)}\n`
      const bytes = Buffer.byteLength(line)
      // A log that cannot be written must not stop the daemon.
      try {
        if (size > 0 && size + bytes > maxBytes) {
          renameSync(path, `${path}.1`)
          size = 0
        }
        appendFileSync(path, line, { mode: 0o600 })
        size += bytes
      } catch {
        // Nothing to do.
      }
    },
    // The last line written, by this run or the one before it.
    lastLine() {
      try {
        const fileSize = statSync(path).size
        const length = Math.min(fileSize, LAST_LINE_READ_BYTES)
        const buffer = Buffer.alloc(length)
        const fd = openSync(path, 'r')
        try { readSync(fd, buffer, 0, length, fileSize - length) } finally { closeSync(fd) }
        return buffer.toString('utf8').trimEnd().split('\n').pop() || undefined
      } catch {
        return undefined
      }
    },
  }
}

// A run that ended on its own terms wrote its end; one killed outright, or stopped by the
// computer losing power, ends with whatever it wrote last.
export function endedWithoutRecord(lastLine) {
  if (!lastLine) return false
  return !/ daemon:(exit|start-failed) /.test(lastLine)
}

function sizeOf(path) {
  try {
    return statSync(path).size
  } catch {
    return 0
  }
}
