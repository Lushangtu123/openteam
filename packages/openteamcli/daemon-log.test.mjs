import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createDaemonLogFile, endedWithoutRecord } from './daemon-log.mjs'

const folders = []
function folder() {
  const path = mkdtempSync(join(tmpdir(), 'ot-daemon-log-'))
  folders.push(path)
  return path
}
afterEach(() => {
  for (const path of folders.splice(0)) rmSync(path, { recursive: true, force: true })
})

describe('the daemon log file', () => {
  it('writes one line per event, with its time, readable only by the user', () => {
    const path = join(folder(), '.openteam', 'daemon.log')
    const log = createDaemonLogFile({ path, now: () => new Date('2026-11-14T16:00:00.000Z') })

    log.write('daemon:start', { pid: 42, port: 19305 })
    log.write('extension:connected', { profileId: 'p1' })

    expect(readFileSync(path, 'utf8')).toBe([
      '2026-11-14T16:00:00.000Z daemon:start {"pid":42,"port":19305}',
      '2026-11-14T16:00:00.000Z extension:connected {"profileId":"p1"}',
      '',
    ].join('\n'))
    expect(statSync(path).mode & 0o777).toBe(0o600)
    expect(log.lastLine()).toBe('2026-11-14T16:00:00.000Z extension:connected {"profileId":"p1"}')
  })

  it('keeps the previous file once it is full, and starts a new one', () => {
    const path = join(folder(), 'daemon.log')
    const log = createDaemonLogFile({ path, maxBytes: 200 })
    for (let index = 0; index < 6; index += 1) log.write('agent:run-start', { runId: `run-${index}`, cwd: '/Users/me/project' })

    expect(statSync(path).size).toBeLessThanOrEqual(200)
    expect(readFileSync(`${path}.1`, 'utf8')).toContain('run-')
    expect(readFileSync(path, 'utf8')).toContain('run-5')
  })

  it('never fails the daemon when the file cannot be written', () => {
    const path = join(folder(), 'daemon.log')
    mkdirSync(path)
    const log = createDaemonLogFile({ path })

    expect(() => log.write('daemon:start', {})).not.toThrow()
  })

  it('tells when the last run ended without saying so (killed, or the computer lost power)', () => {
    expect(endedWithoutRecord(undefined)).toBe(false)
    expect(endedWithoutRecord('2026-11-14T16:00:00.000Z daemon:exit {"code":0}')).toBe(false)
    expect(endedWithoutRecord('2026-11-14T16:00:00.000Z daemon:start-failed {"error":"port in use"}')).toBe(false)
    expect(endedWithoutRecord('2026-11-14T16:00:00.000Z extension:closed {"profileId":"p1"}')).toBe(true)
  })

  it('reads the last line of a long file', () => {
    const path = join(folder(), 'daemon.log')
    writeFileSync(path, `${'x'.repeat(20_000)}\n2026-11-14T16:00:00.000Z daemon:exit {"code":0}\n`)

    expect(createDaemonLogFile({ path }).lastLine()).toBe('2026-11-14T16:00:00.000Z daemon:exit {"code":0}')
  })
})
