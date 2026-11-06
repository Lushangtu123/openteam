// Options a member ends its reply with, to be answered with one click: lettered ones ("A. …",
// "B) …", "C：…") on their own, numbered ones ("1. …") only after a line that asks to choose, so
// that ordinary numbered lists stay plain text. Options are short; a long item is not a choice.

export interface ReplyChoice {
  label: string
  text: string
}

const MAX_CHOICES = 8
const MAX_CHOICE_CHARS = 120
const LETTERS = 'ABCDEFGH'
const OPTION_LINE = /^\s*(?:[-*+]\s+)?(?:\*\*)?[(（]?([A-Ha-h]|[1-8])(?:[)）.、:：]|\s*[.、:：)）])(?:\*\*)?\s*(.+?)\s*$/
const ASKS_TO_CHOOSE = /[?？]|请选择|选择|选哪|哪个|哪一|哪种|回复编号|回复序号|choose|pick|select|which|would you/i

export function extractReplyChoices(content: string): ReplyChoice[] | undefined {
  const lines = content.replace(/\r\n?/g, '\n').split('\n')
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop()

  // The last block of option lines, read upward.
  const options: Array<{ key: string; text: string }> = []
  let index = lines.length - 1
  for (; index >= 0; index -= 1) {
    const line = lines[index]
    if (!line.trim()) {
      if (options.length) break
      continue
    }
    const match = OPTION_LINE.exec(line)
    if (!match) break
    options.unshift({ key: match[1].toUpperCase(), text: stripMarkdown(match[2]) })
  }
  if (options.length < 2 || options.length > MAX_CHOICES) return undefined
  if (insideCodeFence(lines.slice(0, index + 1))) return undefined
  if (options.some(option => !option.text || option.text.length > MAX_CHOICE_CHARS)) return undefined

  const lettered = options.every((option, position) => option.key === LETTERS[position])
  const numbered = options.every((option, position) => option.key === String(position + 1))
  if (!lettered && !numbered) return undefined
  if (numbered) {
    const question = [...lines.slice(0, index + 1)].reverse().find(line => line.trim())
    if (!question || !ASKS_TO_CHOOSE.test(question)) return undefined
  }
  return options.map(option => ({ label: option.key, text: option.text }))
}

function stripMarkdown(text: string): string {
  return text.replace(/\*\*(.+?)\*\*/g, '$1').replace(/`([^`]+)`/g, '$1').trim()
}

function insideCodeFence(linesBefore: string[]): boolean {
  return linesBefore.filter(line => /^\s*```/.test(line)).length % 2 === 1
}

// What clicking a choice sends to the member, after its @mention.
export function replyChoiceAnswer(choice: ReplyChoice, language: 'zh-CN' | 'en'): string {
  return language === 'en' ? `I choose ${choice.label}: ${choice.text}` : `我选 ${choice.label}：${choice.text}`
}
