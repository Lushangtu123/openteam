export function setContentEditableText(editor: HTMLElement, content: string): void {
  editor.focus()

  // Prefer execCommand insertText — ProseMirror / React composers honor it more reliably
  // than replaceChildren + synthetic InputEvent alone.
  const selected = selectEditorContents(editor)
  let inserted = false
  if (selected) {
    try {
      inserted = document.execCommand('insertText', false, content)
    } catch {
      inserted = false
    }
  }

  if (!inserted || readEditorText(editor) !== content.trim()) {
    editor.replaceChildren()
    const block = document.createElement('p')
    block.textContent = content
    editor.append(block)
    editor.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, cancelable: true, inputType: 'insertText', data: content }))
    editor.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: content }))
    editor.dispatchEvent(new Event('change', { bubbles: true }))
  }
}

function selectEditorContents(editor: HTMLElement): boolean {
  const selection = window.getSelection()
  if (!selection) return false
  const range = document.createRange()
  range.selectNodeContents(editor)
  selection.removeAllRanges()
  selection.addRange(range)
  return true
}

export function readEditorText(editor: HTMLElement, options: { normalizeNbsp?: boolean } = {}): string {
  const raw = editor.innerText || editor.textContent || ''
  const text = options.normalizeNbsp ? raw.replace(/\u00a0/g, ' ') : raw
  return text.trim()
}

export function tryKeyboardSubmit(editor: HTMLElement): boolean {
  editor.focus()
  return dispatchEnter(editor) || dispatchEnter(editor, { metaKey: true })
}

function dispatchEnter(editor: HTMLElement, options: { metaKey?: boolean } = {}): boolean {
  const eventOptions = {
    bubbles: true,
    cancelable: true,
    composed: true,
    key: 'Enter',
    code: 'Enter',
    keyCode: 13,
    which: 13,
    metaKey: options.metaKey ?? false,
  }

  editor.dispatchEvent(new KeyboardEvent('keydown', eventOptions))
  editor.dispatchEvent(new KeyboardEvent('keypress', eventOptions))
  editor.dispatchEvent(new KeyboardEvent('keyup', eventOptions))
  return true
}
