import { describe, expect, it } from 'vitest'
import { releaseNotes, releaseVersionProblems } from './packageRelease.mjs'

describe('release version checks', () => {
  it('passes when the tag, package.json, the manifest and the build agree', () => {
    expect(releaseVersionProblems({ tag: 'v1.1.0', packageVersion: '1.1.0', manifestVersion: '1.1.0', builtVersion: '1.1.0' })).toEqual([])
  })

  it('needs no tag for a local package', () => {
    expect(releaseVersionProblems({ packageVersion: '1.1.0', manifestVersion: '1.1.0', builtVersion: '1.1.0' })).toEqual([])
  })

  it('names each version that differs', () => {
    const problems = releaseVersionProblems({ tag: 'v1.2.0', packageVersion: '1.1.0', manifestVersion: '1.0.3', builtVersion: '1.0.2' })
    expect(problems).toHaveLength(3)
    expect(problems.join('\n')).toContain('public/manifest.json')
    expect(problems.join('\n')).toContain('v1.2.0')
    expect(problems.join('\n')).toContain('npm run build')
  })

  it('asks for a build when there is none', () => {
    expect(releaseVersionProblems({ packageVersion: '1.1.0', manifestVersion: '1.1.0' })).toEqual(['dist/manifest.json is missing: run npm run build first'])
  })

  it('rejects a tag that is not v and the version', () => {
    expect(releaseVersionProblems({ tag: '1.1.0', packageVersion: '1.1.0', manifestVersion: '1.1.0', builtVersion: '1.1.0' })).toHaveLength(1)
  })
})

describe('release notes', () => {
  it('names the files and how to install them, in both languages', () => {
    const notes = releaseNotes({ version: '1.1.0', extensionZip: 'openteam-extension-v1.1.0.zip', cliPackage: 'afumu-openteamcli-0.1.0.tgz' })
    expect(notes).toContain('openteam-extension-v1.1.0.zip')
    expect(notes).toContain('afumu-openteamcli-0.1.0.tgz')
    expect(notes).toContain('chrome://extensions')
    expect(notes).toContain('加载已解压的扩展程序')
    expect(notes).toContain('Load unpacked')
  })
})
