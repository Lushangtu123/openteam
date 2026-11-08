export function querySelectorFirst(selectors: string): HTMLElement | null {
  for (const selector of selectors.split(',').map(item => item.trim())) {
    const element = document.querySelector(selector) as HTMLElement | null
    if (element) return element
  }

  return null
}

export function querySelectorFirstMatching(selectors: string, predicate: (element: HTMLElement) => boolean): HTMLElement | null {
  for (const selector of selectors.split(',').map(item => item.trim())) {
    const elements = [...document.querySelectorAll<HTMLElement>(selector)]
    const match = elements.find(predicate)
    if (match) return match
  }

  return null
}

// Like waitForElement, for the first element (selector by selector, in order) that passes the check:
// an input box, say, that is not an editor inside the conversation.
export async function waitForElementMatching(selectors: string, predicate: (element: HTMLElement) => boolean, timeoutMs: number): Promise<HTMLElement> {
  const startedAt = Date.now()
  for (;;) {
    const element = querySelectorFirstMatching(selectors, predicate)
    if (element) return element
    if (Date.now() - startedAt >= timeoutMs) throw new Error(`Element not found: ${selectors}`)
    await new Promise(resolve => window.setTimeout(resolve, 250))
  }
}

export function waitForElement(selectors: string, timeoutMs: number): Promise<HTMLElement> {
  const immediate = querySelectorFirst(selectors)
  if (immediate) return Promise.resolve(immediate)

  return new Promise((resolve, reject) => {
    const startedAt = Date.now()
    const timer = window.setInterval(() => {
      const element = querySelectorFirst(selectors)
      if (element) {
        window.clearInterval(timer)
        resolve(element)
        return
      }

      if (Date.now() - startedAt >= timeoutMs) {
        window.clearInterval(timer)
        reject(new Error(`Element not found: ${selectors}`))
      }
    }, 250)
  })
}

export function waitForClickableButton(selectors: string, timeoutMs: number, errorMessage: string): Promise<HTMLElement> {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now()
    const timer = window.setInterval(() => {
      const button = querySelectorFirstMatching(selectors, isClickableButton)
      if (button) {
        window.clearInterval(timer)
        resolve(button)
        return
      }

      if (Date.now() - startedAt >= timeoutMs) {
        window.clearInterval(timer)
        reject(new Error(errorMessage))
      }
    }, 250)
  })
}

export function isClickableButton(element: HTMLElement): boolean {
  if (!(element instanceof HTMLButtonElement)) return true
  return !element.disabled && element.getAttribute('aria-disabled') !== 'true'
}
