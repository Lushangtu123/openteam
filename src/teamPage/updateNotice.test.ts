// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest'
import { UPDATE_CHECK_INTERVAL_MS, type UpdateCheckState } from '../shared/updateCheck'
import { createUpdateNotice } from './updateNotice'

const NOW = 1_800_000_000_000
const RELEASE_URL = 'https://github.com/Lushangtu123/openteam/releases/tag/v1.5.0'

function setup(saved: unknown, options: { language?: 'en' | 'zh-CN'; latest?: string } = {}) {
  document.body.innerHTML = `
    <button id="settings-button" aria-label="设置"></button>
    <div class="settings-row">
      <div id="update-check-title">检查新版本</div>
      <p id="update-status"></p>
      <div id="update-actions" hidden>
        <a id="update-link">查看并下载</a>
        <button id="update-ignore" type="button">忽略这个版本</button>
      </div>
      <button id="update-check-toggle" role="switch" aria-checked="true"></button>
    </div>
  `
  let stored = saved
  const storage = {
    get: vi.fn(async () => stored),
    set: vi.fn(async (state: UpdateCheckState) => { stored = state }),
  }
  const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ tag_name: `v${options.latest ?? '1.5.0'}`, html_url: RELEASE_URL }), { status: 200 }))
  const notice = createUpdateNotice({
    document,
    settingsButtonEl: document.querySelector<HTMLButtonElement>('#settings-button')!,
    currentVersion: '1.4.0',
    language: () => options.language ?? 'zh-CN',
    storage,
    now: () => NOW,
    fetchImpl,
  })
  const $ = <T extends Element>(selector: string) => document.querySelector<T>(selector)!
  return { notice, storage, fetchImpl, $, stored: () => stored }
}

describe('update notice', () => {
  it('checks when the page opens, then shows the new version with a link and marks the settings button', async () => {
    const { notice, $, fetchImpl, stored } = setup(undefined)
    await notice.start()

    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect($('#update-status').textContent).toBe('有新版本 v1.5.0（当前 v1.4.0）')
    expect($<HTMLElement>('#update-actions').hidden).toBe(false)
    expect($<HTMLAnchorElement>('#update-link').href).toBe(RELEASE_URL)
    expect($('#settings-button').classList.contains('has-update')).toBe(true)
    // An element of its own: the button's ::before and ::after are its tooltip.
    expect($('#settings-button').querySelectorAll('.update-dot')).toHaveLength(1)
    notice.render()
    expect($('#settings-button').querySelectorAll('.update-dot')).toHaveLength(1)
    expect($('#settings-button').getAttribute('aria-label')).toBe('设置（有新版本）')
    expect(stored()).toMatchObject({ lastCheckedAt: NOW, latest: { version: '1.5.0' } })
  })

  it('says this is the latest version when it is', async () => {
    const { notice, $ } = setup(undefined, { latest: '1.4.0' })
    await notice.start()
    expect($('#update-status').textContent).toBe('当前 v1.4.0，已是最新版本')
    expect($<HTMLElement>('#update-actions').hidden).toBe(true)
    expect($('#settings-button').classList.contains('has-update')).toBe(false)
    expect($('#settings-button').getAttribute('aria-label')).toBe('设置')
  })

  it('does not ask GitHub again within a day', async () => {
    const { notice, fetchImpl, $ } = setup({ enabled: true, lastCheckedAt: NOW - UPDATE_CHECK_INTERVAL_MS / 2, latest: { version: '1.5.0', url: RELEASE_URL } })
    await notice.start()
    expect(fetchImpl).not.toHaveBeenCalled()
    expect($('#update-status').textContent).toContain('v1.5.0')
  })

  it('stops offering a version once it is ignored', async () => {
    const { notice, $, stored } = setup(undefined)
    await notice.start()
    $<HTMLButtonElement>('#update-ignore').click()
    await vi.waitFor(() => expect(stored()).toMatchObject({ ignoredVersion: '1.5.0' }))
    expect($<HTMLElement>('#update-actions').hidden).toBe(true)
    expect($('#settings-button').classList.contains('has-update')).toBe(false)
    expect($('#settings-button').querySelector('.update-dot')).toBeNull()
    expect($('#update-status').textContent).toBe('当前 v1.4.0。已忽略 v1.5.0。')
  })

  it('can be turned off, and asks at once when turned back on', async () => {
    const { notice, $, fetchImpl, stored } = setup({ enabled: true, lastCheckedAt: NOW - 1000, latest: { version: '1.4.0', url: RELEASE_URL } })
    await notice.start()
    const toggle = $<HTMLButtonElement>('#update-check-toggle')
    expect(toggle.getAttribute('aria-checked')).toBe('true')

    toggle.click()
    await vi.waitFor(() => expect(stored()).toMatchObject({ enabled: false }))
    expect(toggle.getAttribute('aria-checked')).toBe('false')
    expect($('#update-status').textContent).toBe('当前 v1.4.0。不检查新版本。')

    toggle.click()
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1))
    await vi.waitFor(() => expect($('#update-status').textContent).toBe('有新版本 v1.5.0（当前 v1.4.0）'))
  })

  it('speaks English when the page does', async () => {
    const { notice, $ } = setup(undefined, { language: 'en' })
    await notice.start()
    expect($('#update-status').textContent).toBe('Version 1.5.0 is out (this is 1.4.0)')
    expect($('#settings-button').getAttribute('aria-label')).toBe('Settings (update available)')
  })
})
