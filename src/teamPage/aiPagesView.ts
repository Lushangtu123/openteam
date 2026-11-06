// OpenTeam fills the whole tab. The members' AI pages run underneath it, covered, so they keep
// sending and reading; they show only when the user asks for one (to sign in, pass a check or close
// a pop-up), with a button back to OpenTeam.

export interface AiPagesViewDependencies {
  appShellEl: HTMLElement
  returnEl: HTMLButtonElement
  showPagesEl?: HTMLButtonElement
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

  function isShowingAiPages(): boolean {
    return deps.appShellEl.classList.contains(AI_PAGES_SHOWN_CLASS)
  }

  function showAiPages(shown: boolean): void {
    deps.appShellEl.classList.toggle(AI_PAGES_SHOWN_CLASS, shown)
    deps.returnEl.hidden = !shown
    doc.body?.classList.toggle(AI_PAGES_SHOWN_CLASS, shown)
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
