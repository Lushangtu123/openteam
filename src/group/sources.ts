// 要来源 (citations and fact-checking): a message the user sends with sources asked for has every
// member number the source of each fact and list the links. OpenTeam reads each reply's links and
// the claims without a source, checks that each link opens (src/background/linkCheck.ts), and once
// the round is done asks one member to check the claims, given the answers, the link checks and the
// unsourced claims. Its reply is read as a verdict per claim.
import { normalizeLanguage } from '../shared/i18n'
import type { RoundReply, SummarizableRound } from './roundSummary'
import type { GroupChat, GroupMessage, GroupRole, LinkCheck, OpenTeamLanguage, OpenTeamStore } from './types'

export const MAX_LINKS_PER_REPLY = 10
const CLAIM_MAX = 160
const MAX_UNSOURCED = 8

export interface ReplySource {
  n?: number
  url: string
  title?: string
}

export interface ReplySources {
  links: ReplySource[]
  // Claims marked as having no source, and claims with numbers or dates but no citation.
  unsourced: string[]
}

export type FactVerdict = 'verified' | 'doubtful' | 'wrong' | 'unverifiable'

export interface FactCheckItem {
  verdict: FactVerdict
  who?: string
  claim: string
  basis?: string
}

export interface FactCheck {
  items: FactCheckItem[]
  conclusion?: string
}

const SOURCES_HEADING = /^\s*(?:#{1,6}\s*)?(?:\*\*)?\s*(?:来源|参考来源|参考资料|参考文献|资料来源|sources?|references)\s*(?:\*\*)?\s*(?:[:：]|$)/i
const MARKDOWN_LINK = /\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g
const BARE_URL = /https?:\/\/[^\s<>()[\]"'，。、；！？）】]+/g
const NUMBERED = /^\s*(?:[-*+]\s*)?\[?(\d{1,2})(?:\]|[.)、])\s*/
const MARKED_UNSOURCED = /\[(?:无来源|no source)\]/i
const CITED = /\[\d{1,2}\]|https?:\/\//

export function readReplySources(content: string): ReplySources {
  const lines = content.split('\n')
  let heading = -1
  lines.forEach((line, index) => { if (SOURCES_HEADING.test(line)) heading = index })
  const body = heading >= 0 ? lines.slice(0, heading) : lines
  const section = heading >= 0 ? [lines[heading].replace(SOURCES_HEADING, ''), ...lines.slice(heading + 1)] : []

  const links: ReplySource[] = []
  const add = (link: ReplySource) => {
    const url = cleanUrl(link.url)
    if (links.length >= MAX_LINKS_PER_REPLY || links.some(item => item.url === url)) return
    links.push({ ...(link.n !== undefined ? { n: link.n } : {}), url, ...(link.title ? { title: link.title } : {}) })
  }
  for (const line of section) {
    const number = line.match(NUMBERED)
    const markdown = [...line.matchAll(MARKDOWN_LINK)]
    if (markdown.length > 0) {
      for (const match of markdown) add({ ...(number ? { n: Number(number[1]) } : {}), url: match[2], title: match[1].trim() })
      continue
    }
    for (const match of line.matchAll(BARE_URL)) {
      const title = number ? cleanTitle(line.slice(number[0].length, match.index)) : ''
      add({ ...(number ? { n: Number(number[1]) } : {}), url: match[0], ...(title ? { title } : {}) })
    }
  }
  const bodyText = body.join('\n')
  for (const match of bodyText.matchAll(MARKDOWN_LINK)) add({ url: match[2], title: match[1].trim() })
  for (const match of bodyText.replace(MARKDOWN_LINK, '').matchAll(BARE_URL)) add({ url: match[0] })

  const unsourced: string[] = []
  for (const line of body) {
    const text = line.replace(/\*\*|__/g, '').replace(/^\s*(?:[-*+]|\d+[.)、])\s+/, '').trim()
    if (!text || /^#/.test(text) || /[:：]$/.test(text)) continue
    for (const sentence of text.split(/(?<=[。！？!?])|(?<=\.)\s+/).map(item => item.trim())) {
      if (sentence.length < 6 || unsourced.length >= MAX_UNSOURCED) continue
      if (MARKED_UNSOURCED.test(sentence) || (!CITED.test(sentence) && /\d/.test(sentence))) unsourced.push(sentence.slice(0, CLAIM_MAX))
    }
  }
  return { links, unsourced }
}

function cleanUrl(url: string): string {
  return url.replace(/[.,;:!?]+$/, '')
}

function cleanTitle(text: string): string {
  return text.replace(/\*\*/g, '').replace(/[\s:：\-–—|·]+$/, '').replace(/^[\s:：\-–—|·]+/, '').trim()
}

// What each member is asked, after the usual prompt.
export function sourcesInstruction(english: boolean): string {
  return english
    ? 'This time give your sources: end each factual claim (numbers, dates, events, quotes) with a number such as [1], [2]; finish your answer with a separate "Sources:" part, one "[number] title full-link" per line. Mark a claim you have no reliable source for with [no source] at its end. List only links you have actually seen or know to exist; do not make any up.'
    : '这次请给出来源：每个事实性说法（数字、日期、事件、引述等）在句末标注编号，如 [1]、[2]；回答最后另起一段写「来源：」，每行一个「[编号] 标题 完整链接」。找不到可靠来源的说法，在句末标 [无来源]。只列你确实看过或确定存在的链接，不要编造。'
}

export function linkCheckLabel(check: LinkCheck | undefined, english: boolean): string {
  if (!check) return english ? 'Checking' : '检查中'
  const code = check.httpStatus ? (english ? ` (${check.httpStatus})` : `（${check.httpStatus}）`) : ''
  switch (check.status) {
    case 'ok': return english ? 'Opens' : '能打开'
    case 'missing': return english ? `Page not found${code}` : `页面不存在${code}`
    case 'refused': return english ? `Site refuses automatic visits${code}` : `网站拒绝自动访问${code}`
    case 'error': return english ? `Site error${code}` : `网站报错${code}`
    case 'reachable': return english ? 'Site responds; page not checked' : '网站能连上，没细查页面'
    case 'unreachable': return english ? 'Cannot connect; the site may not exist' : '连不上，网站可能不存在'
    case 'unchecked': return english ? 'Not checked (not an https link)' : '没有检查（不是 https 链接）'
  }
}

// The round a message asked with sources started, once every member it went to is done and at
// least one answered.
export function readCheckableRound(store: OpenTeamStore, chat: GroupChat, question: GroupMessage | undefined): SummarizableRound | undefined {
  if (!question?.wantsSources || question.type !== 'user' || question.chatId !== chat.id) return undefined
  const statuses = Object.values(question.deliveryStatus ?? {})
  if (statuses.length === 0 || statuses.some(status => status !== 'received' && status !== 'error')) return undefined
  const latest = new Map<string, GroupMessage>()
  for (const id of chat.messageIds) {
    const message = store.messagesById[id]
    if (!message || message.type !== 'assistant' || message.sourceMessageId !== question.id || !message.roleId) continue
    if (message.status !== 'received' || !message.content.trim() || question.deliveryStatus?.[message.roleId] === 'error') continue
    const previous = latest.get(message.roleId)
    if (!previous || message.seq > previous.seq) latest.set(message.roleId, message)
  }
  const replies: RoundReply[] = [...latest.values()]
    .sort((left, right) => left.seq - right.seq)
    .flatMap(message => {
      const role = store.rolesById[message.roleId!]
      return role ? [{ role, message }] : []
    })
  return replies.length > 0 ? { question, replies } : undefined
}

// True when the round already has a check asked for after its latest answer.
export function hasFactCheck(store: OpenTeamStore, chat: GroupChat, questionId: string): boolean {
  let request = -1
  let reply = -1
  for (const id of chat.messageIds) {
    const message = store.messagesById[id]
    if (!message) continue
    if (message.factCheckOf === questionId) request = Math.max(request, message.seq)
    else if (message.type === 'assistant' && message.sourceMessageId === questionId) reply = Math.max(reply, message.seq)
  }
  return request >= 0 && request > reply
}

export function factCheckRequestText(languageInput: OpenTeamLanguage | undefined): string {
  return normalizeLanguage(languageInput) === 'en' ? 'Check the facts in these answers' : '核查这一轮回答里的事实'
}

export function buildFactCheckPrompt(input: { round: SummarizableRound; checker: GroupRole; language?: OpenTeamLanguage; maxReplyChars?: number }): string {
  const en = normalizeLanguage(input.language) === 'en'
  const { question, replies } = input.round
  const share = Math.max(800, Math.floor((input.maxReplyChars ?? 60_000) / Math.max(1, replies.length)))
  const answers = replies.map(({ role, message }) => `${en ? `[${role.name}]` : `【${role.name}】`}\n${message.content.length > share ? `${message.content.slice(0, share)}…` : message.content}`)
  const checks: string[] = []
  const unsourced: string[] = []
  for (const { role, message } of replies) {
    const name = en ? `[${role.name}]` : `【${role.name}】`
    const sources = readReplySources(message.content)
    for (const link of sources.links) {
      const check = message.linkChecks?.[link.url]
      const title = check?.status === 'ok' && check.title ? (en ? `, titled "${check.title}"` : `，标题「${check.title}」`) : ''
      checks.push(`- ${name}${link.url}${en ? ': ' : '：'}${check ? linkCheckLabel(check, en) : (en ? 'not checked yet' : '还没检查完')}${title}`)
    }
    for (const claim of sources.unsourced) unsourced.push(`- ${name}${claim}`)
  }
  return [
    en ? `You are "${input.checker.name}". This time, act as the fact-checker of this round.` : `你是「${input.checker.name}」，这次请你担任事实核查员。`,
    `${en ? "The user's question:" : '用户的问题：'}\n${question.content.trim()}`,
    `${en ? "The members' answers, with their sources:" : '各成员的回答（含来源）：'}\n\n${answers.join('\n\n')}`,
    `${en ? 'OpenTeam opened the source links:' : 'OpenTeam 打开来源链接的结果：'}\n${checks.length > 0 ? checks.join('\n') : (en ? '(the answers give no links)' : '（回答里没有来源链接）')}`,
    ...(unsourced.length > 0 ? [`${en ? 'Claims OpenTeam found without a source:' : 'OpenTeam 找到的没标来源的说法：'}\n${unsourced.join('\n')}`] : []),
    en
      ? [
          'Check the factual claims in these answers one by one: numbers, dates, specific events and quotes first, at most 12. If you can browse, open the source links and compare them with the claims; say so when a link does not open or does not say what the claim says.',
          'One line per claim, in this form:',
          '- [Verified] member name: claim -- basis',
          'Use only these verdicts: Verified, Doubtful, Wrong, Unverifiable.',
          'End with a line starting "Conclusion:" and one sentence. Write only the check: @-mention nobody, and add no hand-off.',
        ].join('\n')
      : [
          '请逐条核对上面回答里的事实说法：优先核对数字、日期、具体事件和引述，最多 12 条。能上网的话，打开来源链接，对照原文核对；链接打不开、或者内容和说法对不上的，要指出来。',
          '每条写一行，格式：',
          '- 【已核实】成员名：说法 —— 依据',
          '判断只能用这四种：已核实、存疑、有误、无法核实。',
          '最后一行写「结论：」加一句话总结。只写核查结果：不要 @ 任何成员，也不要加交接的话。',
        ].join('\n'),
  ].join('\n\n')
}

const ITEM = /^\s*(?:[-*+]|\d+[.)、])?\s*(?:\*\*)?\s*[【[]\s*(已核实|存疑|有误|无法核实|verified|doubtful|wrong|unverifiable)\s*[】\]]\s*(?:\*\*)?\s*(.+)$/i
const CONCLUSION = /^\s*(?:\*\*)?\s*(?:结论|conclusion)\s*(?:\*\*)?\s*[:：]\s*(?:\*\*)?\s*(.+)$/i
const VERDICTS: Record<string, FactVerdict> = { 已核实: 'verified', 存疑: 'doubtful', 有误: 'wrong', 无法核实: 'unverifiable', verified: 'verified', doubtful: 'doubtful', wrong: 'wrong', unverifiable: 'unverifiable' }

export function readFactCheck(content: string): FactCheck | undefined {
  const items: FactCheckItem[] = []
  let conclusion: string | undefined
  for (const line of content.split('\n')) {
    const item = line.match(ITEM)
    if (item) {
      const [claimPart, ...basisParts] = item[2].split(/\s*(?:——|--)\s*/)
      const basis = basisParts.join(' — ').trim()
      const speaker = claimPart.match(/^([^：:]{1,24})[：:]\s*(.+)$/)
      items.push({
        verdict: VERDICTS[item[1].toLowerCase()] ?? VERDICTS[item[1]],
        ...(speaker ? { who: speaker[1].trim() } : {}),
        claim: (speaker ? speaker[2] : claimPart).trim(),
        ...(basis ? { basis } : {}),
      })
      continue
    }
    const end = line.match(CONCLUSION)
    if (end) conclusion = end[1].replace(/\*\*/g, '').trim()
  }
  return items.length > 0 ? { items, ...(conclusion ? { conclusion } : {}) } : undefined
}
