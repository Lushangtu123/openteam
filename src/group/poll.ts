// 投票: the user asks members to pick one of two to six options. The message carries the vote
// (GroupMessage.poll); each member is asked to answer with "投票：<letter>" and a reason, and its
// reply is read for the letter. Members vote without seeing each other's votes; once all have, the
// group shows the count (a card after the last vote) and one member sums up where they differ. A
// second round asks the same members again with everyone's first-round votes and reasons.
import type { GroupChat, GroupMessage, MessagePoll, OpenTeamStore } from './types'

export const POLL_MIN_OPTIONS = 2
export const POLL_MAX_OPTIONS = 6
export const POLL_QUESTION_MAX = 500
export const POLL_OPTION_MAX = 200
const REASON_MAX = 300
const LETTERS = ['A', 'B', 'C', 'D', 'E', 'F']

export interface PollInput {
  question: string
  options: string[]
  // A second round: the first round's message.
  of?: string
}

export interface PollVoter {
  roleId: string
  name: string
}

export interface PollVote extends PollVoter {
  choice: number
  reason: string
  // In a second round, what the member voted the first time.
  previousChoice?: number
}

export interface PollTally {
  message: GroupMessage
  poll: MessagePoll
  options: Array<{ letter: string; text: string; votes: PollVote[] }>
  // Answered without a vote that could be read.
  invalid: PollVoter[]
  // Did not answer (failed or skipped).
  missing: PollVoter[]
  // Still answering.
  waiting: PollVoter[]
  done: boolean
  voted: number
  // The options with the most votes (more than one on a tie; none before any vote).
  leaders: number[]
  // For a first round: its second round, once asked for.
  secondRound?: GroupMessage
}

export function pollLetter(index: number): string {
  return LETTERS[index] ?? '?'
}

export function readPollInput(raw: unknown): PollInput {
  const value = isRecord(raw) ? raw : {}
  const question = typeof value.question === 'string' ? value.question.trim() : ''
  if (!question) throw new Error('写下要投票的问题')
  if (question.length > POLL_QUESTION_MAX) throw new Error(`问题最多 ${POLL_QUESTION_MAX} 字`)
  const options = (Array.isArray(value.options) ? value.options : [])
    .map(option => typeof option === 'string' ? option.trim() : '')
    .filter(Boolean)
  if (options.length < POLL_MIN_OPTIONS) throw new Error(`至少要两个选项`)
  if (options.length > POLL_MAX_OPTIONS) throw new Error(`最多 ${POLL_MAX_OPTIONS} 个选项`)
  if (options.some(option => option.length > POLL_OPTION_MAX)) throw new Error(`每个选项最多 ${POLL_OPTION_MAX} 字`)
  if (new Set(options).size !== options.length) throw new Error('选项不能重复')
  return { question, options, ...(typeof value.of === 'string' && value.of ? { of: value.of } : {}) }
}

// The message the group shows: the question and its lettered options.
export function pollMessageText(poll: MessagePoll, english: boolean): string {
  const head = poll.round === 2 ? (english ? 'Vote again' : '再投一轮') : (english ? 'Vote' : '投票')
  return `${head}${english ? ': ' : '：'}${poll.question}\n${optionLines(poll)}`
}

// A member's vote: the letter after 投票： / Vote:, or a lone letter starting the reply.
export function readVote(content: string, optionCount: number): { choice?: number; reason: string } {
  const lines = content.split('\n')
  let choice: number | undefined
  let voteLine = -1
  const labelled = lines.findIndex(line => VOTE_LINE.test(line))
  if (labelled >= 0) {
    voteLine = labelled
    choice = letterIndex(lines[labelled].match(VOTE_LINE)![1])
  } else {
    const first = lines.findIndex(line => line.trim())
    const lone = first >= 0 ? lines[first].match(LONE_LETTER) : null
    if (lone) {
      voteLine = first
      choice = letterIndex(lone[1])
    }
  }
  // The reason after 理由： (after the vote line, when there is one), to the end of its paragraph
  // or list item; without one, the rest of the reply.
  const afterVote = voteLine >= 0 ? lines.slice(voteLine).join('\n') : content
  const reasonMatch = afterVote.match(REASON) ?? content.match(REASON)
  const reasonText = reasonMatch ? reasonMatch[1].split(REASON_END)[0] : lines.filter((_, index) => index !== voteLine).join('\n')
  const reason = reasonText.replace(/\*\*/g, '').replace(/\s+/g, ' ').trim().slice(0, REASON_MAX)
  return { ...(choice !== undefined && choice < optionCount ? { choice } : {}), reason }
}

const VOTE_LINE = /(?:投票|\bvote)\s*(?:\*\*)?\s*[:：]\s*(?:\*\*)?\s*(?:选项\s*|option\s*)?([A-F])(?![A-Za-z])/i
const LONE_LETTER = /^\s*(?:\*\*)?\s*([A-F])\s*(?:\*\*)?\s*(?:[.、:：)）]|$)/
const REASON = /(?:理由|reason)\s*(?:\*\*)?\s*[:：]\s*(?:\*\*)?\s*([\s\S]*)/i
// A blank line, or a new list item or heading.
const REASON_END = /\n\s*\n|\n\s*(?:[-*+]\s|\d+[.)]\s|#|\*\*)/

function letterIndex(letter: string): number {
  return LETTERS.indexOf(letter.toUpperCase())
}

// The count of a vote message: each member's latest reply, read for its vote.
export function tallyPoll(store: OpenTeamStore, chat: GroupChat, message: GroupMessage): PollTally | undefined {
  const poll = message.poll
  if (!poll || message.type !== 'user') return undefined
  const latest = new Map<string, GroupMessage>()
  for (const id of chat.messageIds) {
    const reply = store.messagesById[id]
    if (!reply || reply.type !== 'assistant' || reply.sourceMessageId !== message.id || !reply.roleId) continue
    if (reply.status !== 'received' || !reply.content.trim()) continue
    const previous = latest.get(reply.roleId)
    if (!previous || reply.seq > previous.seq) latest.set(reply.roleId, reply)
  }
  const first = poll.round === 2 && poll.of ? store.messagesById[poll.of] : undefined
  const before = first?.poll ? tallyPoll(store, chat, first) : undefined
  const previousChoice = (roleId: string) => before?.options.findIndex(option => option.votes.some(vote => vote.roleId === roleId))

  const options = poll.options.map((text, index) => ({ letter: pollLetter(index), text, votes: [] as PollVote[] }))
  const invalid: PollVoter[] = []
  const missing: PollVoter[] = []
  const waiting: PollVoter[] = []
  for (const roleId of message.targetRoleIds ?? Object.keys(message.deliveryStatus ?? {})) {
    const reply = latest.get(roleId)
    const voter = { roleId, name: store.rolesById[roleId]?.name ?? reply?.roleName ?? roleId }
    const status = message.deliveryStatus?.[roleId]
    if (reply && status !== 'error') {
      const vote = readVote(reply.content, poll.options.length)
      if (vote.choice === undefined) invalid.push(voter)
      else {
        const previous = previousChoice(roleId)
        options[vote.choice].votes.push({ ...voter, choice: vote.choice, reason: vote.reason, ...(previous !== undefined && previous >= 0 ? { previousChoice: previous } : {}) })
      }
    } else if (status === 'pending' || status === 'sent') waiting.push(voter)
    else missing.push(voter)
  }
  const most = Math.max(0, ...options.map(option => option.votes.length))
  const secondRound = poll.round === 1
    ? chat.messageIds.map(id => store.messagesById[id]).find(item => item?.poll?.of === message.id)
    : undefined
  return {
    message,
    poll,
    options,
    invalid,
    missing,
    waiting,
    done: waiting.length === 0,
    voted: options.reduce((sum, option) => sum + option.votes.length, 0),
    leaders: most > 0 ? options.flatMap((option, index) => option.votes.length === most ? [index] : []) : [],
    ...(secondRound ? { secondRound } : {}),
  }
}

// What a member is asked to do with a vote message, after the usual prompt.
export function pollInstruction(store: OpenTeamStore, chat: GroupChat, message: GroupMessage, english: boolean): string | undefined {
  const poll = message.poll
  if (!poll) return undefined
  const first = poll.round === 2 && poll.of ? store.messagesById[poll.of] : undefined
  const before = first ? tallyPoll(store, chat, first) : undefined
  const parts = [
    english ? 'This is a vote. Pick exactly one of these options:' : '这是一次投票，请从下面的选项中只选一个：',
    optionLines(poll),
  ]
  if (before) {
    parts.push(`${english ? 'First-round votes:' : '第一轮的投票：'}\n${firstRoundLines(before, english)}`)
    parts.push(english
      ? 'Having read everyone\'s reasons, you may keep your choice or change it.'
      : '看过大家的理由后，你可以坚持原来的选择，也可以改投。')
  }
  parts.push(english
    ? 'Start your answer with "Vote: " and one letter on the first line, for example "Vote: A"; on the second line write "Reason: " and a sentence or two. Pick one option only, and no answer outside them.'
    : '回答的第一行写「投票：」加一个字母，例如「投票：A」；第二行写「理由：」加一两句话。只选一个，不要写选项以外的答案。')
  return parts.join('\n')
}

// The count, for the member who sums up the vote.
export function pollTallyText(tally: PollTally, english: boolean): string {
  const names = (voters: PollVoter[]) => voters.map(voter => voter.name).join(english ? ', ' : '、')
  const lines = tally.options.map(option => {
    const count = option.votes.length
    const who = count > 0 ? (english ? ` (${names(option.votes)})` : `（${names(option.votes)}）`) : ''
    return english ? `${option.letter}. ${option.text}: ${count} vote${count === 1 ? '' : 's'}${who}` : `${option.letter}. ${option.text}：${count} 票${who}`
  })
  if (tally.invalid.length > 0) lines.push(english ? `Did not vote in the format: ${names(tally.invalid)}` : `没有按格式投票：${names(tally.invalid)}`)
  if (tally.missing.length > 0) lines.push(english ? `Did not answer: ${names(tally.missing)}` : `没有回答：${names(tally.missing)}`)
  return lines.join('\n')
}

function firstRoundLines(tally: PollTally, english: boolean): string {
  const byRole = new Map<string, string>()
  for (const option of tally.options) {
    for (const vote of option.votes) byRole.set(vote.roleId, vote.reason ? (english ? `${option.letter} (${vote.reason})` : `${option.letter}（${vote.reason}）`) : option.letter)
  }
  for (const voter of tally.invalid) byRole.set(voter.roleId, english ? 'did not vote in the format' : '没有按格式投票')
  for (const voter of tally.missing) byRole.set(voter.roleId, english ? 'did not answer' : '没有回答')
  const order = tally.message.targetRoleIds ?? [...byRole.keys()]
  const nameOf = (roleId: string) => [...tally.options.flatMap(option => option.votes), ...tally.invalid, ...tally.missing].find(voter => voter.roleId === roleId)?.name ?? roleId
  return order.filter(roleId => byRole.has(roleId)).map(roleId => `- ${nameOf(roleId)}${english ? ': ' : '：'}${byRole.get(roleId)}`).join('\n')
}

function optionLines(poll: MessagePoll): string {
  return poll.options.map((option, index) => `${pollLetter(index)}. ${option}`).join('\n')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
