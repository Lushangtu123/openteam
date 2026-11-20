// 把结果发出去: a scheduled task's round, sent where the user reads it when it is over: a Feishu,
// WeCom or DingTalk group robot, a Slack or Discord channel, a Telegram chat, or any https webhook.
// The summary is sent when the group summed the round up, with who answered; otherwise every
// member's answer. Each takes a message of its own shape and size (WeCom 4096 bytes, Telegram 4096
// characters, Discord 6000 across its cards), so long answers are shortened and the full text stays
// in OpenTeam; a plain webhook gets everything as JSON. src/background/resultSender.ts sends it once
// the round is over.
import { describeSchedule } from './scheduledTasks'
import type { GroupMessage, OpenTeamStore } from './types'

export type ResultDestinationKind = 'feishu' | 'wecom' | 'dingtalk' | 'slack' | 'discord' | 'telegram' | 'webhook'

export interface ResultDestination {
  id: string
  kind: ResultDestinationKind
  name: string
  // Where the message is posted; for Telegram, the bot's sendMessage address. It holds a key:
  // backups leave it out unless keys are exported.
  url: string
  // Feishu's 签名校验 or DingTalk's 加签 secret.
  secret?: string
  // The Telegram group or channel the bot posts to.
  chatId?: string
  createdAt: number
}

export interface RoundResult {
  chatName: string
  schedule: string
  question: string
  answers: Array<{ member: string; text: string; failed?: boolean }>
  summary?: { member: string; text: string }
}

export const MAX_RESULT_DESTINATIONS = 10
export const RESULT_DESTINATION_KINDS: ResultDestinationKind[] = ['feishu', 'wecom', 'dingtalk', 'slack', 'discord', 'telegram', 'webhook']
const PREFIXES: Partial<Record<ResultDestinationKind, string[]>> = {
  feishu: ['https://open.feishu.cn/open-apis/bot/v2/hook/', 'https://open.larksuite.com/open-apis/bot/v2/hook/'],
  wecom: ['https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key='],
  dingtalk: ['https://oapi.dingtalk.com/robot/send?access_token='],
  slack: ['https://hooks.slack.com/services/'],
  discord: ['https://discord.com/api/webhooks/', 'https://discordapp.com/api/webhooks/'],
}
const PREFIX_OWNER: Partial<Record<ResultDestinationKind, string>> = { feishu: '飞书机器人', wecom: '企业微信机器人', dingtalk: '钉钉机器人', slack: 'Slack ', discord: 'Discord ' }
const KIND_NAMES: Record<ResultDestinationKind, { zh: string; en: string }> = {
  feishu: { zh: '飞书群机器人', en: 'Feishu group robot' },
  wecom: { zh: '企业微信群机器人', en: 'WeCom group robot' },
  dingtalk: { zh: '钉钉群机器人', en: 'DingTalk group robot' },
  slack: { zh: 'Slack', en: 'Slack' },
  discord: { zh: 'Discord', en: 'Discord' },
  telegram: { zh: 'Telegram 机器人', en: 'Telegram bot' },
  webhook: { zh: '通用 Webhook', en: 'Webhook' },
}
const TELEGRAM_TOKEN = /^\d+:[\w-]{30,}$/
const TELEGRAM_ADDRESS = /^https:\/\/api\.telegram\.org\/bot(\d+:[\w-]{30,})\/sendMessage$/
const TELEGRAM_CHAT = /^(-?\d+|@[A-Za-z0-9_]{4,})$/
const FIRST_TEXT_LIMIT = 1500
const WEBHOOK_TEXT_LIMIT = 100_000
// Discord: a card's text up to 4096 characters, 6000 across a message's cards, 10 cards.
const DISCORD_FIRST_LIMIT = 4000
const DISCORD_TOTAL = 5800
const DISCORD_CARDS = 10

type Style = 'markdown' | 'slack' | 'plain'

export function destinationKindName(kind: ResultDestinationKind, english: boolean): string {
  return english ? KIND_NAMES[kind].en : KIND_NAMES[kind].zh
}

export function readDestinationInput(raw: unknown): Omit<ResultDestination, 'id' | 'createdAt'> {
  const input = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const kind = input.kind as ResultDestinationKind
  if (!RESULT_DESTINATION_KINDS.includes(kind)) throw new Error('不认识这种推送方式')
  const name = typeof input.name === 'string' && input.name.trim() ? input.name.trim().slice(0, 40) : KIND_NAMES[kind].zh
  const entered = typeof input.url === 'string' ? input.url.trim() : ''
  if (kind === 'telegram') {
    const token = TELEGRAM_TOKEN.test(entered) ? entered : TELEGRAM_ADDRESS.exec(entered)?.[1]
    if (!token) throw new Error('Telegram 机器人的 Token 应形如 123456789:AA…（在 BotFather 里拿到）')
    const chatId = typeof input.chatId === 'string' ? input.chatId.trim() : ''
    if (!TELEGRAM_CHAT.test(chatId)) throw new Error('填上 Telegram 群组或频道的 Chat ID（如 -1001234567890 或 @频道名）')
    return { kind, name, url: `https://api.telegram.org/bot${token}/sendMessage`, chatId }
  }
  if (kind === 'webhook') {
    let parsed: URL | undefined
    try {
      parsed = new URL(entered)
    } catch {
      parsed = undefined
    }
    if (parsed?.protocol !== 'https:') throw new Error('Webhook 地址要以 https:// 开头')
  } else {
    const prefixes = PREFIXES[kind]!
    if (!prefixes.some(prefix => entered.startsWith(prefix) && entered.length > prefix.length)) throw new Error(`${PREFIX_OWNER[kind]}的地址应以 ${prefixes[0]} 开头`)
  }
  const secret = typeof input.secret === 'string' ? input.secret.trim() : ''
  return { kind, name, url: entered, ...(secret && (kind === 'feishu' || kind === 'dingtalk') ? { secret } : {}) }
}

export function normalizeResultDestinations(raw: unknown): ResultDestination[] {
  if (!Array.isArray(raw)) return []
  return raw.flatMap(item => {
    const value = item as Record<string, unknown> | undefined
    if (!value || typeof value !== 'object') return []
    if (typeof value.id !== 'string' || !RESULT_DESTINATION_KINDS.includes(value.kind as ResultDestinationKind) || typeof value.name !== 'string' || typeof value.url !== 'string') return []
    return [{
      id: value.id,
      kind: value.kind as ResultDestinationKind,
      name: value.name,
      url: value.url,
      ...(typeof value.secret === 'string' && value.secret ? { secret: value.secret } : {}),
      ...(typeof value.chatId === 'string' && value.chatId ? { chatId: value.chatId } : {}),
      createdAt: typeof value.createdAt === 'number' ? value.createdAt : 0,
    }]
  }).slice(0, MAX_RESULT_DESTINATIONS)
}

// The round started by the question: each member it asked, with their answer, and the summary.
export function collectRoundResult(store: OpenTeamStore, chatId: string, questionId: string, english: boolean): RoundResult | undefined {
  const chat = store.chatsById[chatId]
  const question = store.messagesById[questionId]
  if (!chat || !question) return undefined
  const after = chat.messageIds.slice(chat.messageIds.indexOf(questionId) + 1).map(id => store.messagesById[id]).filter((message): message is GroupMessage => Boolean(message))
  const replyTo = (promptId: string, roleId: string) => {
    const own = after.filter(message => message.type === 'assistant' && message.roleId === roleId)
    return [...own].reverse().find(message => message.sourceMessageId === promptId) ?? own[0]
  }
  const answers = (question.targetRoleIds ?? []).map(roleId => {
    const reply = replyTo(questionId, roleId)
    const member = store.rolesById[roleId]?.name ?? reply?.roleName ?? roleId
    return reply?.status === 'received' ? { member, text: reply.content.trim() } : { member, text: '', failed: true }
  })
  const task = question.scheduledTaskId ? chat.scheduledTasks?.find(item => item.id === question.scheduledTaskId) : undefined
  const summaryRequest = after.find(message => message.type === 'user' && message.roundSummaryOf === questionId)
  const summaryReply = summaryRequest?.targetRoleIds?.[0] ? replyTo(summaryRequest.id, summaryRequest.targetRoleIds[0]) : undefined
  return {
    chatName: chat.name,
    schedule: task ? describeSchedule(task.days, task.time, english) : '',
    question: question.content.trim(),
    answers,
    ...(summaryReply?.status === 'received' && summaryReply.content.trim()
      ? { summary: { member: store.rolesById[summaryReply.roleId ?? '']?.name ?? summaryReply.roleName ?? '', text: summaryReply.content.trim() } }
      : {}),
  }
}

// The request for the destination: its address (DingTalk's carries the signature) and JSON body.
export async function buildSendRequest(destination: ResultDestination, result: RoundResult, now: number, english: boolean): Promise<{ url: string; body: string }> {
  const url = destination.url
  switch (destination.kind) {
    case 'webhook':
      return {
        url,
        body: JSON.stringify({
          source: 'openteam',
          group: result.chatName,
          schedule: result.schedule,
          question: result.question,
          summary: result.summary ? { member: result.summary.member, text: result.summary.text.slice(0, WEBHOOK_TEXT_LIMIT) } : null,
          answers: result.answers.map(answer => ({ member: answer.member, text: answer.text.slice(0, WEBHOOK_TEXT_LIMIT), status: answer.failed ? 'failed' : 'answered' })),
          sentAt: new Date(now).toISOString(),
        }),
      }
    case 'wecom':
      return { url, body: JSON.stringify({ msgtype: 'markdown', markdown: { content: fitted(result, 'markdown', english, bytes, 4000) } }) }
    case 'dingtalk': {
      let signed = url
      if (destination.secret) signed += `&timestamp=${now}&sign=${encodeURIComponent(await hmacBase64(destination.secret, `${now}\n${destination.secret}`))}`
      return { url: signed, body: JSON.stringify({ msgtype: 'markdown', markdown: { title: titleOf(result, english), text: fitted(result, 'markdown', english, bytes, 18_000) } }) }
    }
    case 'feishu': {
      const timestamp = String(Math.floor(now / 1000))
      const signed = destination.secret ? { timestamp, sign: await hmacBase64(`${timestamp}\n${destination.secret}`, '') } : {}
      return { url, body: JSON.stringify({ ...signed, msg_type: 'text', content: { text: fitted(result, 'plain', english, bytes, 18_000) } }) }
    }
    case 'slack':
      return { url, body: JSON.stringify({ text: fitted(result, 'slack', english, characters, 38_000) }) }
    case 'telegram':
      return { url, body: JSON.stringify({ chat_id: destination.chatId, text: fitted(result, 'plain', english, characters, 4000), disable_web_page_preview: true }) }
    case 'discord':
      return { url, body: JSON.stringify(discordMessage(result, english)) }
  }
}

// Undefined when the destination took it; else why not, in its own words.
export function readSendResponse(kind: ResultDestinationKind, status: number, text: string): string | undefined {
  const ok = status >= 200 && status < 300
  if (kind === 'webhook') return ok ? undefined : `HTTP ${status}`
  if (kind === 'slack') return ok ? undefined : `HTTP ${status}${text.trim() ? `：${text.trim().slice(0, 100)}` : ''}`
  const json = parse(text)
  if (kind === 'discord') {
    if (ok) return undefined
    return typeof json?.message === 'string' ? `${json.message}（${String(json.code ?? status)}）` : `HTTP ${status}`
  }
  if (kind === 'telegram') {
    if (ok && json?.ok === true) return undefined
    if (typeof json?.description === 'string') return `${json.description}（${String(json.error_code ?? status)}）`
    return ok ? `回复看不懂：${text.slice(0, 100)}` : `HTTP ${status}`
  }
  if (!ok) return `HTTP ${status}`
  if (!json) return `回复看不懂：${text.slice(0, 100)}`
  const code = kind === 'feishu' ? json.code ?? json.StatusCode : json.errcode
  if (code === 0) return undefined
  const said = kind === 'feishu' ? json.msg ?? json.StatusMessage : json.errmsg
  return `${typeof said === 'string' && said ? said : '发送失败'}（${String(code)}）`
}

// A test message for 测试.
export function testRoundResult(english: boolean): RoundResult {
  return english
    ? { chatName: 'OpenTeam', schedule: '', question: 'Test message', answers: [{ member: 'OpenTeam', text: 'If you can read this, scheduled task results will arrive here.' }] }
    : { chatName: 'OpenTeam', schedule: '', question: '测试消息', answers: [{ member: 'OpenTeam', text: '能看到这条，定时任务的结果就会发到这里。' }] }
}

function titleOf(result: RoundResult, english: boolean): string {
  return english ? `"${result.chatName}" scheduled task` : `「${result.chatName}」定时任务`
}

function scheduleText(result: RoundResult, english: boolean): string {
  return result.schedule ? (english ? ` (${result.schedule})` : `（${result.schedule}）`) : ''
}

function cutter(limit: number, english: boolean): (value: string) => string {
  return value => value.length > limit ? `${value.slice(0, limit)}${english ? '… (full text in OpenTeam)' : '…（完整内容在 OpenTeam 里）'}` : value
}

function whoAnswered(result: RoundResult, english: boolean): string {
  const answered = result.answers.filter(answer => !answer.failed).map(answer => answer.member)
  const missing = result.answers.filter(answer => answer.failed).map(answer => answer.member)
  return english
    ? `Answered: ${answered.join(', ') || 'no one'}${missing.length ? `; no answer: ${missing.join(', ')}` : ''}`
    : `回答了：${answered.join('、') || '无'}${missing.length ? `；没回答：${missing.join('、')}` : ''}`
}

// The text, with each answer shortened until it all fits the destination.
function fitted(result: RoundResult, style: Style, english: boolean, measure: (text: string) => number, limit: number): string {
  let textLimit = FIRST_TEXT_LIMIT
  let text = compose(result, style, english, textLimit)
  while (measure(text) > limit && textLimit > 40) {
    textLimit = Math.floor(textLimit * 0.7)
    text = compose(result, style, english, textLimit)
  }
  while (measure(text) > limit) text = text.slice(0, Math.floor(text.length * 0.9))
  return text
}

function compose(result: RoundResult, style: Style, english: boolean, limit: number): string {
  const bold = (value: string) => style === 'markdown' ? `**${value}**` : style === 'slack' ? `*${value}*` : value
  const cut = cutter(limit, english)
  const question = cut(result.question.split('\n')[0].slice(0, 200))
  const lines = [`${bold(titleOf(result, english))}${scheduleText(result, english)}`, style === 'plain' ? `${english ? 'Question: ' : '问题：'}${question}` : `> ${question}`]
  if (result.summary) {
    return [lines.join('\n'), `${bold(english ? `Summary (${result.summary.member})` : `汇总（${result.summary.member}）`)}\n${cut(result.summary.text)}`, whoAnswered(result, english)].join('\n\n')
  }
  return [lines.join('\n'), ...result.answers.map(answer => `${bold(answer.member)}\n${answer.failed ? (english ? '(no answer)' : '（没有回答）') : cut(answer.text)}`)].join('\n\n')
}

// Discord: the title and question as the message, a card for the summary or each answer, and no
// one pinged by an @ in what members wrote.
function discordMessage(result: RoundResult, english: boolean): Record<string, unknown> {
  const content = `**${titleOf(result, english)}**${scheduleText(result, english)}\n> ${result.question.split('\n')[0].slice(0, 200)}`
  const cards = (limit: number) => {
    const cut = cutter(limit, english)
    if (result.summary) return [{ title: (english ? `Summary (${result.summary.member})` : `汇总（${result.summary.member}）`).slice(0, 256), description: cut(result.summary.text), footer: { text: whoAnswered(result, english).slice(0, 2048) } }]
    return result.answers.slice(0, DISCORD_CARDS).map(answer => ({ title: answer.member.slice(0, 256), description: answer.failed ? (english ? '(no answer)' : '（没有回答）') : cut(answer.text) }))
  }
  const size = (list: Array<{ title: string; description: string; footer?: { text: string } }>) => list.reduce((sum, card) => sum + card.title.length + card.description.length + (card.footer?.text.length ?? 0), 0)
  let limit = DISCORD_FIRST_LIMIT
  let embeds = cards(limit)
  while (size(embeds) > DISCORD_TOTAL && limit > 40) {
    limit = Math.floor(limit * 0.7)
    embeds = cards(limit)
  }
  return { content, embeds, allowed_mentions: { parse: [] } }
}

function parse(text: string): Record<string, unknown> | undefined {
  try {
    const value = JSON.parse(text)
    return value && typeof value === 'object' ? value as Record<string, unknown> : undefined
  } catch {
    return undefined
  }
}

function bytes(text: string): number {
  return new TextEncoder().encode(text).length
}

function characters(text: string): number {
  return text.length
}

async function hmacBase64(key: string, message: string): Promise<string> {
  const encoder = new TextEncoder()
  const cryptoKey = await crypto.subtle.importKey('raw', encoder.encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const signature = new Uint8Array(await crypto.subtle.sign('HMAC', cryptoKey, encoder.encode(message)))
  let binary = ''
  for (const byte of signature) binary += String.fromCharCode(byte)
  return btoa(binary)
}
