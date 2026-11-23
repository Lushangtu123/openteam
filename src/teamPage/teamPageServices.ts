import { createLogger } from '../shared/logger'

export const teamPageLog = createLogger('team-page')

// The toast (#error in team.html) is a live region: an error is read out at once, a success when the
// reader is free. Each message stays its whole time: the one before it no longer hides it early.
const toastTimers = new WeakMap<HTMLElement, number>()

function showToast(errorEl: HTMLElement, message: string, success: boolean, ms: number): void {
  window.clearTimeout(toastTimers.get(errorEl))
  errorEl.classList.toggle('toast-success', success)
  errorEl.setAttribute('aria-live', success ? 'polite' : 'assertive')
  errorEl.hidden = false
  errorEl.textContent = message
  toastTimers.set(errorEl, window.setTimeout(() => {
    errorEl.hidden = true
    errorEl.classList.remove('toast-success')
    toastTimers.delete(errorEl)
  }, ms))
}

export function createErrorPresenter(errorEl: HTMLElement): (message: string) => void {
  return message => showToast(errorEl, message, false, 5200)
}

export function createSuccessPresenter(errorEl: HTMLElement): (message: string) => void {
  return message => showToast(errorEl, message, true, 2200)
}
