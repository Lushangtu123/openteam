// 检查新版本 in the settings (src/shared/updateCheck.ts): the version this is, whether a newer one
// is out with a link to its release page, ignoring that version, and turning the check off. A dot
// on the settings button says an update is waiting.
import { availableUpdate, readUpdateState, refreshUpdateState, type UpdateCheckState } from '../shared/updateCheck'

export interface UpdateNoticeDependencies {
  document: Document
  settingsButtonEl: HTMLButtonElement
  currentVersion: string
  language(): 'en' | 'zh-CN'
  storage: {
    get(): Promise<unknown>
    set(state: UpdateCheckState): Promise<void>
  }
  now(): number
  fetchImpl?: typeof fetch
}

export interface UpdateNotice {
  // Reads what was saved, shows it, then asks GitHub if a day has passed.
  start(): Promise<void>
  // Shows the state again (the language may have changed).
  render(): void
}

export function createUpdateNotice(deps: UpdateNoticeDependencies): UpdateNotice {
  const find = <T extends HTMLElement>(id: string) => deps.document.getElementById(id) as T | null
  const statusEl = find<HTMLElement>('update-status')
  const actionsEl = find<HTMLElement>('update-actions')
  const linkEl = find<HTMLAnchorElement>('update-link')
  const ignoreEl = find<HTMLButtonElement>('update-ignore')
  const toggleEl = find<HTMLButtonElement>('update-check-toggle')
  let state: UpdateCheckState = { enabled: true }

  async function save(next: UpdateCheckState): Promise<void> {
    state = next
    render()
    await deps.storage.set(next)
  }

  async function refresh(force = false): Promise<void> {
    const next = await refreshUpdateState({ state, now: deps.now(), fetchImpl: deps.fetchImpl, force })
    if (next !== state) await save(next)
  }

  function render(): void {
    const en = deps.language() === 'en'
    const current = deps.currentVersion
    const update = availableUpdate(state, current)
    if (statusEl) {
      statusEl.textContent = !state.enabled
        ? (en ? `This is ${current}. Not checking for new versions.` : `当前 v${current}。不检查新版本。`)
        : update
        ? (en ? `Version ${update.version} is out (this is ${current})` : `有新版本 v${update.version}（当前 v${current}）`)
        : state.ignoredVersion && state.latest && state.latest.version === state.ignoredVersion
        ? (en ? `This is ${current}. Version ${state.ignoredVersion} is ignored.` : `当前 v${current}。已忽略 v${state.ignoredVersion}。`)
        : state.latest
        ? (en ? `This is ${current}, the latest version` : `当前 v${current}，已是最新版本`)
        : (en ? `This is ${current}` : `当前 v${current}`)
    }
    if (actionsEl) actionsEl.hidden = !update
    if (linkEl && update) linkEl.href = update.url
    toggleEl?.setAttribute('aria-checked', String(state.enabled))
    deps.settingsButtonEl.classList.toggle('has-update', Boolean(update))
    // A dot of its own: the button's ::before and ::after are its tooltip.
    const dot = deps.settingsButtonEl.querySelector('.update-dot')
    if (update && !dot) {
      const element = deps.document.createElement('span')
      element.className = 'update-dot'
      element.setAttribute('aria-hidden', 'true')
      deps.settingsButtonEl.append(element)
    } else if (!update) {
      dot?.remove()
    }
    const label = en ? 'Settings' : '设置'
    deps.settingsButtonEl.setAttribute('aria-label', update ? (en ? `${label} (update available)` : `${label}（有新版本）`) : label)
  }

  ignoreEl?.addEventListener('click', () => {
    if (state.latest) void save({ ...state, ignoredVersion: state.latest.version })
  })
  toggleEl?.addEventListener('click', () => {
    const enabled = !state.enabled
    void save({ ...state, enabled }).then(() => enabled ? refresh(true) : undefined)
  })

  return {
    async start() {
      try {
        state = readUpdateState(await deps.storage.get())
      } catch {
        state = { enabled: true }
      }
      render()
      await refresh()
    },
    render,
  }
}
