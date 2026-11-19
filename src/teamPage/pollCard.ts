// The card that shows a vote's count (投票, src/group/poll.ts), after the round's last vote: each
// option's votes with who cast them, the result once everyone has voted, each member's reason, and a
// button to vote again (once) with everyone's reasons in view.
import type { PollTally } from '../group/poll'
import { createIcon } from './icons'

export interface PollCardOptions {
  english: boolean
  // Asks the same members to vote again; absent when that is not possible.
  revote?(tally: PollTally): Promise<void>
}

export function pollCardSignature(tally: PollTally, english: boolean): string {
  return JSON.stringify({
    english,
    id: tally.message.id,
    round: tally.poll.round,
    question: tally.poll.question,
    options: tally.options.map(option => [option.text, option.votes.map(vote => [vote.roleId, vote.name, vote.reason, vote.previousChoice])]),
    invalid: tally.invalid.map(voter => voter.name),
    missing: tally.missing.map(voter => voter.name),
    waiting: tally.waiting.map(voter => voter.name),
    secondRound: tally.secondRound?.id,
  })
}

export function renderPollCard(tally: PollTally, options: PollCardOptions): HTMLElement {
  const t = (zh: string, en: string): string => options.english ? en : zh
  const list = (names: string[]) => names.join(options.english ? ', ' : '、')
  const total = tally.voted + tally.invalid.length + tally.missing.length + tally.waiting.length

  const card = element('section', `poll-card${tally.done ? ' poll-card-done' : ''}`)
  card.dataset.pollId = tally.message.id
  card.setAttribute('aria-label', tally.done ? t('投票结果', 'Vote result') : t('投票进行中', 'Vote in progress'))

  const head = element('div', 'poll-card-head')
  head.append(createIcon('poll'), element('strong', 'poll-card-title', tally.done ? t('投票结果', 'Vote result') : t('投票中', 'Voting')))
  if (tally.poll.round === 2) head.append(element('span', 'poll-card-round', t('第二轮', 'Round 2')))
  head.append(element('span', 'poll-card-progress tiny', t(`已投 ${tally.voted}/${total}`, `${tally.voted} of ${total} voted`)))
  card.append(head, element('p', 'poll-card-question', tally.poll.question))

  const leaders = new Set(tally.done ? tally.leaders : [])
  const rows = element('ol', 'poll-card-options')
  for (const [index, option] of tally.options.entries()) {
    const row = element('li', `poll-card-option${leaders.has(index) ? ' poll-card-leading' : ''}`)
    const line = element('div', 'poll-card-option-head')
    const count = option.votes.length
    line.append(element('span', 'poll-card-letter', option.letter), element('span', 'poll-card-text', option.text), element('span', 'poll-card-count', t(`${count} 票`, `${count} vote${count === 1 ? '' : 's'}`)))
    const bar = element('div', 'poll-card-bar')
    bar.setAttribute('aria-hidden', 'true')
    const fill = element('span')
    fill.style.width = `${tally.voted > 0 ? Math.round(count / tally.voted * 100) : 0}%`
    bar.append(fill)
    row.append(line, bar)
    if (count > 0) row.append(element('p', 'poll-card-voters tiny', list(option.votes.map(vote => vote.name))))
    rows.append(row)
  }
  card.append(rows)

  if (tally.done) card.append(element('p', 'poll-card-result', resultText(tally, t, list)))

  const voted = tally.options.flatMap(option => option.votes.map(vote => ({ vote, option })))
  if (voted.length > 0) {
    const reasons = element('details', 'poll-card-reasons')
    reasons.append(element('summary', '', t('各自的理由', 'Reasons')))
    const items = element('ul')
    for (const { vote, option } of voted) {
      const item = element('li')
      const changed = vote.previousChoice !== undefined && vote.previousChoice !== vote.choice
      const before = vote.previousChoice === undefined ? '' : changed
        ? t(`（第一轮投 ${tally.options[vote.previousChoice]?.letter}，改投）`, ` (was ${tally.options[vote.previousChoice]?.letter} in round 1)`)
        : t('（没有改）', ' (unchanged)')
      item.append(element('strong', '', vote.name), document.createTextNode(t(` 投 ${option.letter}${before}`, ` voted ${option.letter}${before}`)))
      if (vote.reason) item.append(document.createTextNode(t(`：${vote.reason}`, `: ${vote.reason}`)))
      items.append(item)
    }
    reasons.append(items)
    card.append(reasons)
  }

  const notes = [
    tally.invalid.length > 0 ? t(`没有按格式投票：${list(tally.invalid.map(voter => voter.name))}`, `Did not vote in the format: ${list(tally.invalid.map(voter => voter.name))}`) : '',
    tally.missing.length > 0 ? t(`没有回答：${list(tally.missing.map(voter => voter.name))}`, `Did not answer: ${list(tally.missing.map(voter => voter.name))}`) : '',
    tally.waiting.length > 0 ? t(`还在投：${list(tally.waiting.map(voter => voter.name))}`, `Still voting: ${list(tally.waiting.map(voter => voter.name))}`) : '',
  ].filter(Boolean)
  if (notes.length > 0) card.append(element('p', 'poll-card-note tiny', notes.join(t('；', '; '))))

  if (options.revote && tally.done && tally.poll.round === 1 && !tally.secondRound && tally.voted > 0) {
    const revote = options.revote
    const button = element('button', 'btn btn-ghost btn-small poll-card-revote')
    button.type = 'button'
    button.append(createIcon('retry'), element('span', '', t('再投一轮', 'Vote again')))
    button.title = t('让同样的成员看过彼此的理由后再投一次', 'The same members vote again, having read each other\'s reasons')
    button.addEventListener('click', event => {
      event.stopPropagation()
      button.disabled = true
      revote(tally).catch(() => { button.disabled = false })
    })
    card.append(button)
  }
  return card
}

function resultText(tally: PollTally, t: (zh: string, en: string) => string, list: (names: string[]) => string): string {
  if (tally.leaders.length === 0) return t('没有人按格式投票', 'Nobody voted in the format')
  const letters = tally.leaders.map(index => `${tally.options[index].letter}. ${tally.options[index].text}`)
  if (tally.leaders.length > 1) return t(`平票：${list(letters)}`, `Tie: ${list(letters)}`)
  return t(`${letters[0]} 胜出`, `${letters[0]} wins`)
}

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}
