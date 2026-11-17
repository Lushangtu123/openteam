// Replies to a group start with their key points (the prompt asks for them); a long reply folds to
// them until opened. Recognizing the key points takes the shapes members actually write them in.
import { isKeyPointsHeading } from '../group/roundSummary'

// A reply with key points folds to them when the rest is longer than this.
const KEY_POINTS_FOLD_MIN_CHARS = 280
// An opening line a member may put before its key points is no longer than this.
const KEY_POINTS_OPENING_MAX_CHARS = 40
// Key points written as paragraphs of their own: at most this many, each this short (members are
// asked for 1–3 points of up to 40 characters).
const KEY_POINT_PARAGRAPHS_MAX = 3
const KEY_POINT_PARAGRAPH_MAX_CHARS = 60

// A reply that starts with key points shows only them until opened, when the rest is long. The
// reply is rendered whole and the rest hidden, so highlights and copying keep working. Which replies
// the user opened is kept by the caller in `expandedReplyIds`.
export function foldToKeyPoints(body: HTMLElement, messageId: string, expandedReplyIds: Set<string>): HTMLButtonElement | undefined {
  const parts = keyPointsParts([...body.children])
  if (!parts) return undefined
  body.classList.add('has-key-points')
  const restLength = [...body.children].slice(parts).reduce((total, element) => total + (element.textContent?.trim().length ?? 0), 0)
  if (restLength < KEY_POINTS_FOLD_MIN_CHARS) return undefined

  const toggle = document.createElement('button')
  toggle.type = 'button'
  toggle.className = 'key-points-toggle'
  const update = () => {
    const expanded = expandedReplyIds.has(messageId)
    body.classList.toggle('folded', !expanded)
    toggle.setAttribute('aria-expanded', String(expanded))
    toggle.textContent = expanded ? '收起' : '展开全文'
  }
  toggle.addEventListener('click', () => {
    if (expandedReplyIds.has(messageId)) expandedReplyIds.delete(messageId)
    else expandedReplyIds.add(messageId)
    update()
  })
  update()
  return toggle
}

// Marks a reply's key points and says how many leading elements they and anything before them
// take. They start the reply, or follow one short opening line (Gemini says who it is first).
function keyPointsParts(children: Element[]): number | undefined {
  const atStart = keyPointsAt(children, 0)
  if (atStart) return atStart
  const opening = children[0]
  if (opening?.tagName !== 'P' || (opening.textContent ?? '').trim().length > KEY_POINTS_OPENING_MAX_CHARS) return undefined
  return keyPointsAt(children, 1)
}

// Key points that start at the given element: marks them and returns the position after them.
// Members write them as a heading and a list, a heading and lines, the heading and lines in one
// paragraph, or a heading and a few short paragraphs, one per point.
function keyPointsAt(children: Element[], start: number): number | undefined {
  const first = children[start]
  if (!first) return undefined
  const isLines = (element: Element | undefined) => element?.tagName === 'P' && Boolean(element.querySelector('br'))
  if (isKeyPointsHeading(first.textContent ?? '')) {
    const second = children[start + 1]
    if (second && (second.tagName === 'UL' || second.tagName === 'OL' || isLines(second))) {
      first.classList.add('key-points-heading')
      second.classList.add('key-points-list')
      return start + 2
    }
    const points: Element[] = []
    for (const element of children.slice(start + 1, start + 1 + KEY_POINT_PARAGRAPHS_MAX)) {
      const length = (element.textContent ?? '').trim().length
      if (element.tagName !== 'P' || length === 0 || length > KEY_POINT_PARAGRAPH_MAX_CHARS) break
      points.push(element)
    }
    if (points.length === 0) return undefined
    first.classList.add('key-points-heading')
    for (const point of points) point.classList.add('key-points-list')
    return start + 1 + points.length
  }
  if (isLines(first) && isKeyPointsHeading(firstLineText(first))) {
    first.classList.add('key-points-list', 'key-points-block')
    return start + 1
  }
  return undefined
}

function firstLineText(element: Element): string {
  let text = ''
  for (const node of element.childNodes) {
    if (node.nodeName === 'BR') break
    text += node.textContent ?? ''
  }
  return text
}
