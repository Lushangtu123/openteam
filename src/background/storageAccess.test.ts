import { readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { restrictStorageToExtension } from './storageAccess'

describe('keeping the extension\'s storage away from the AI sites\' pages', () => {
  it('closes every storage area to content scripts', async () => {
    const local = { setAccessLevel: vi.fn(async () => undefined) }
    const sync = { setAccessLevel: vi.fn(async () => undefined) }
    const log = { warn: vi.fn() }

    expect(await restrictStorageToExtension({ local, sync }, log)).toEqual(['local', 'sync'])
    expect(local.setAccessLevel).toHaveBeenCalledWith({ accessLevel: 'TRUSTED_CONTEXTS' })
    expect(sync.setAccessLevel).toHaveBeenCalledWith({ accessLevel: 'TRUSTED_CONTEXTS' })
    expect(log.warn).not.toHaveBeenCalled()
  })

  it('goes on, and says so, when an area cannot be closed', async () => {
    const local = { setAccessLevel: vi.fn(async () => { throw new Error('not supported') }) }
    const session = { setAccessLevel: vi.fn(async () => undefined) }
    const log = { warn: vi.fn() }

    // An area the browser does not have, one without the call, one that refuses, one that works.
    expect(await restrictStorageToExtension({ sync: undefined, managed: {}, local, session }, log)).toEqual(['session'])
    expect(log.warn).toHaveBeenCalledTimes(1)
    expect(log.warn).toHaveBeenCalledWith('storage-access:not-restricted', { area: 'local', error: 'not supported' })
  })

  it('is safe to do: nothing that runs inside a site\'s page reads the storage', () => {
    // src/content is the content script; src/shared is code it may import.
    const sources = (folder: string): string[] => readdirSync(folder, { withFileTypes: true }).flatMap(entry => {
      const path = join(folder, entry.name)
      if (entry.isDirectory()) return sources(path)
      return /\.ts$/.test(entry.name) && !/\.test\.ts$/.test(entry.name) ? [path] : []
    })
    const files = ['src/content', 'src/shared'].flatMap(folder => sources(resolve(process.cwd(), folder)))

    expect(files.length).toBeGreaterThan(20)
    expect(files.filter(file => /chrome\s*\??\.\s*storage/.test(readFileSync(file, 'utf8')))).toEqual([])
  })
})
