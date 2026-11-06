// Which look the team page wears: the ChatGPT-like layout, or a Grok-like one (near-black, pill
// shapes, outlined controls). Independent of the light/dark theme; each style has both.
export type UiStyle = 'chatgpt' | 'grok'

export const UI_STYLE_STORAGE_KEY = 'openteam.uiStyle'
const DEFAULT_UI_STYLE: UiStyle = 'chatgpt'

export interface UiStyleControllerDependencies {
  root: HTMLElement
  // Every control that picks a style; all of them show the current one.
  buttons: Record<UiStyle, HTMLButtonElement[]>
  storage?: Storage
}

export interface UiStyleController {
  getStyle(): UiStyle
  initializeStyle(): void
  registerStyleEvents(): void
  setStyle(style: UiStyle): void
}

export function createUiStyleController(deps: UiStyleControllerDependencies): UiStyleController {
  const storage = deps.storage ?? safeLocalStorage()
  let current: UiStyle = normalizeUiStyle(deps.root.dataset.uiStyle) ?? DEFAULT_UI_STYLE
  let registered = false

  function apply(style: UiStyle, persist: boolean): void {
    current = style
    deps.root.dataset.uiStyle = style
    for (const [name, buttons] of Object.entries(deps.buttons) as Array<[UiStyle, HTMLButtonElement[]]>) {
      for (const button of buttons) button.setAttribute('aria-pressed', String(name === style))
    }
    if (!persist || !storage) return
    try {
      storage.setItem(UI_STYLE_STORAGE_KEY, style)
    } catch {
      // Browser privacy modes can reject localStorage; the switch still works for this page.
    }
  }

  return {
    getStyle: () => current,
    initializeStyle() {
      apply(readStoredStyle(storage) ?? normalizeUiStyle(deps.root.dataset.uiStyle) ?? DEFAULT_UI_STYLE, false)
    },
    registerStyleEvents() {
      if (registered) return
      registered = true
      for (const [name, buttons] of Object.entries(deps.buttons) as Array<[UiStyle, HTMLButtonElement[]]>) {
        for (const button of buttons) button.addEventListener('click', () => apply(name, true))
      }
    },
    setStyle(style) {
      apply(style, true)
    },
  }
}

export function normalizeUiStyle(value: string | undefined | null): UiStyle | undefined {
  return value === 'chatgpt' || value === 'grok' ? value : undefined
}

function readStoredStyle(storage: Storage | undefined): UiStyle | undefined {
  if (!storage) return undefined
  try {
    return normalizeUiStyle(storage.getItem(UI_STYLE_STORAGE_KEY))
  } catch {
    return undefined
  }
}

function safeLocalStorage(): Storage | undefined {
  try {
    return window.localStorage
  } catch {
    return undefined
  }
}
