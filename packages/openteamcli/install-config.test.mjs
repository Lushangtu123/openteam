import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const packageRoot = import.meta.dirname
const root = resolve(packageRoot, '../..')

describe('openteamcli install configuration', () => {
  it('keeps the extension project private and delegates publish metadata to the CLI package', () => {
    const rootPkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'))

    expect(rootPkg.private).toBe(true)
    expect(rootPkg.bin).toBeUndefined()
    expect(rootPkg.files).toBeUndefined()
    expect(rootPkg.scripts.openteamcli).toBe('node packages/openteamcli/openteamcli.mjs')
  })

  it('exposes openteamcli from a lightweight publishable package', () => {
    const pkg = JSON.parse(readFileSync(resolve(packageRoot, 'package.json'), 'utf8'))

    expect(pkg).toMatchObject({
      name: '@lushangtu123/openteamcli',
      version: expect.any(String),
      type: 'module',
      private: false,
      bin: {
        openteamcli: 'openteamcli.mjs',
      },
      engines: {
        node: '>=18',
      },
      publishConfig: {
        access: 'public',
      },
    })
    expect(pkg.files).toEqual(expect.arrayContaining([
      'openteamcli.mjs',
      'openteam-daemon.mjs',
      'skills',
    ]))
  })

  it('publishes every module the published files load', () => {
    const pkg = JSON.parse(readFileSync(resolve(packageRoot, 'package.json'), 'utf8'))
    // From the command and the daemon, every local module they import, and what those import.
    const seen = new Set()
    const visit = file => {
      if (seen.has(file)) return
      seen.add(file)
      const source = readFileSync(resolve(packageRoot, file), 'utf8')
      for (const [, imported] of source.matchAll(/from '\.\/([^']+)'/g)) visit(imported)
    }
    visit(pkg.bin.openteamcli)

    expect([...seen].sort()).toEqual(expect.arrayContaining(['openteam-daemon.mjs']))
    for (const file of seen) expect(pkg.files, `${file} is loaded but not published`).toContain(file)
  })

  it('documents the installed openteamcli command in the skill', () => {
    const skill = readFileSync(resolve(packageRoot, 'skills/openteam-control/SKILL.md'), 'utf8')

    expect(skill).toContain('openteamcli daemon start')
    expect(skill).toContain('openteamcli doctor')
    expect(skill).not.toContain('npm run openteamcli --')
  })
})
