// OpenTeam fills the whole tab. The members' AI pages run underneath it, covered, so they keep
// sending and reading; they show only when the user asks for one (to sign in, pass a check or close
// a pop-up), with a button back to OpenTeam.

export interface AiPagesViewDependencies {
  appShellEl: HTMLElement
  returnEl: HTMLButtonElement
  showPagesEl?: HTMLButtonElement
  // Where the AI pages run. Hidden from assistive technology only while OpenTeam covers it.
  pagesHostEl?: HTMLElement
  // Where the focus goes back to OpenTeam when the element focused before is gone.
  homeFocusEl?: HTMLElement
  documentRef?: Document
}

export interface AiPagesView {
  registerAiPagesControls(): void
  showAiPages(shown: boolean): void
  isShowingAiPages(): boolean
}

export const AI_PAGES_SHOWN_CLASS = 'pages-shown'

export function createAiPagesView(deps: AiPagesViewDependencies): AiPagesView {
  const doc = deps.documentRef ?? document
  // The OpenTeam element that had the focus when the pages were shown.
  let focusBeforePages: HTMLElement | undefined

  function isShowingAiPages(): boolean {
    return deps.appShellEl.classList.contains(AI_PAGES_SHOWN_CLASS)
  }

  function showAiPages(shown: boolean): void {
    const wasShown = isShowingAiPages()
    if (shown && !wasShown) {
      const active = doc.activeElement
      focusBeforePages = active instanceof HTMLElement && deps.appShellEl.contains(active) ? active : undefined
    }
    deps.appShellEl.classList.toggle(AI_PAGES_SHOWN_CLASS, shown)
    deps.returnEl.hidden = !shown
    doc.body?.classList.toggle(AI_PAGES_SHOWN_CLASS, shown)
    // Coming back, the focus leaves the AI page first: hiding an area that holds the focus is
    // refused by the browser, and keys typed next belong to OpenTeam.
    if (!shown && wasShown) returnFocusToOpenTeam()
    if (shown) deps.pagesHostEl?.removeAttribute('aria-hidden')
    else deps.pagesHostEl?.setAttribute('aria-hidden', 'true')
  }

  // Back to the element focused before, unless it is gone or hidden by now (the menu that showed the
  // pages has closed): then to the message box.
  function returnFocusToOpenTeam(): void {
    const before = focusBeforePages
    focusBeforePages = undefined
    before?.focus({ preventScroll: true })
    if (!before || doc.activeElement !== before) deps.homeFocusEl?.focus({ preventScroll: true })
  }

  function registerAiPagesControls(): void {
    deps.returnEl.addEventListener('click', () => showAiPages(false))
    deps.showPagesEl?.addEventListener('click', () => showAiPages(true))
    // Esc comes back too, while the focus is still on OpenTeam (keys typed inside an AI page stay
    // with that page).
    doc.addEventListener('keydown', event => {
      if (event.key !== 'Escape' || !isShowingAiPages()) return
      event.preventDefault()
      showAiPages(false)
    })
  }

  return { registerAiPagesControls, showAiPages, isShowingAiPages }
}
