// 把结果发出去: a scheduled task's round, sent where the user reads it when it is over: a Feishu,
// WeCom or DingTalk group robot, or any https webhook. The summary is sent when the group summed the
// round up, with who answered; otherwise every member's answer. The robots take short messages
// (WeCom 4096 bytes, Feishu and DingTalk about 20 KB), so long answers are shortened and the full
// text stays in OpenTeam; a plain webhook gets everything as JSON. src/background/resultSender.ts
// sends it once the round is over.
import { describeSchedule } from './scheduledTasks'
import type { GroupMessage, OpenTeamStore } from './types'

export type ResultDestinationKind = 'feishu' | 'wecom' | 'dingtalk' | 'webhook'

export interface ResultDestination {
  id: string
  kind: ResultDestinationKind
  name: string
  // The robot's webhook address. It is a key: backups leave it out unless keys are exported.
  url: string
  // Feishu's 签名校验 or DingTalk's 加签 secret.
  secret?: string
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
const KINDS: ResultDestinationKind[] = ['feishu', 'wecom', 'dingtalk', 'webhook']
const PREFIXES: Record<Exclude<ResultDestinationKind, 'webhook'>, string[]> = {
  feishu: ['https://open.feishu.cn/open-apis/bot/v2/hook/', 'https://open.larksuite.com/open-apis/bot/v2/hook/'],
  wecom: ['https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key='],
  dingtalk: ['https://oapi.dingtalk.com/robot/send?access_token='],
}
const KIND_NAMES: Record<ResultDestinationKind, { zh: string; en: string }> = {
  feishu: { zh: '飞书群机器人', en: 'Feishu group robot' },
  wecom: { zh: '企业微信群机器人', en: 'WeCom group robot' },
  dingtalk: { zh: '钉钉群机器人', en: 'DingTalk group robot' },
  webhook: { zh: '通用 Webhook', en: 'Webhook' },
}
// What each robot takes, in bytes of text, with room for the rest of the request.
const BYTE_LIMITS: Record<Exclude<ResultDestinationKind, 'webhook'>, number> = { wecom: 4000, feishu: 18_000, dingtalk: 18_000 }
const FIRST_TEXT_LIMIT = 1500
const WEBHOOK_TEXT_LIMIT = 100_000

export function destinationKindName(kind: ResultDestinationKind, english: boolean): string {
  return english ? KIND_NAMES[kind].en : KIND_NAMES[kind].zh
}

export function readDestinationInput(raw: unknown): Omit<ResultDestination, 'id' | 'createdAt'> {
  const input = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const kind = input.kind as ResultDestinationKind
  if (!KINDS.includes(kind)) throw new Error('不认识这种推送方式')
  const url = typeof input.url === 'string' ? input.url.trim() : ''
  if (kind === 'webhook') {
    let parsed: URL | undefined
    try {
      parsed = new URL(url)
    } catch {
      parsed = undefined
    }
    if (parsed?.protocol !== 'https:') throw new Error('Webhook 地址要以 https:// 开头')
  } else if (!PREFIXES[kind].some(prefix => url.startsWith(prefix) && url.length > prefix.length)) {
    throw new Error(`${{ feishu: '飞书', wecom: '企业微信', dingtalk: '钉钉' }[kind]}机器人的地址应以 ${PREFIXES[kind][0]} 开头`)
  }
  const name = typeof input.name === 'string' && input.name.trim() ? input.name.trim().slice(0, 40) : KIND_NAMES[kind].zh
  const secret = typeof input.secret === 'string' ? input.secret.trim() : ''
  return { kind, name, url, ...(secret && (kind === 'feishu' || kind === 'dingtalk') ? { secret } : {}) }
}

export function normalizeResultDestinations(raw: unknown): ResultDestination[] {
  if (!Array.isArray(raw)) return []
  return raw.flatMap(item => {
    const value = item as Record<string, unknown> | undefined
    if (!value || typeof value !== 'object') return []
    if (typeof value.id !== 'string' || !KINDS.includes(value.kind as ResultDestinationKind) || typeof value.name !== 'string' || typeof value.url !== 'string') return []
    return [{
      id: value.id,
      kind: value.kind as ResultDestinationKind,
      name: value.name,
      url: value.url,
      ...(typeof value.secret === 'string' && value.secret ? { secret: value.secret } : {}),
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
  if (destination.kind === 'webhook') {
    return {
      url: destination.url,
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
  }
  const markdown = destination.kind !== 'feishu'
  const text = fitted(result, markdown, english, BYTE_LIMITS[destination.kind])
  if (destination.kind === 'wecom') return { url: destination.url, body: JSON.stringify({ msgtype: 'markdown', markdown: { content: text } }) }
  if (destination.kind === 'dingtalk') {
    let url = destination.url
    if (destination.secret) {
      const sign = await hmacBase64(destination.secret, `${now}\n${destination.secret}`)
      url += `&timestamp=${now}&sign=${encodeURIComponent(sign)}`
    }
    return { url, body: JSON.stringify({ msgtype: 'markdown', markdown: { title: titleOf(result, english), text } }) }
  }
  const timestamp = String(Math.floor(now / 1000))
  const signed = destination.secret ? { timestamp, sign: await hmacBase64(`${timestamp}\n${destination.secret}`, '') } : {}
  return { url: destination.url, body: JSON.stringify({ ...signed, msg_type: 'text', content: { text } }) }
}

// Undefined when the destination took it; else why not, in its own words.
export function readSendResponse(kind: ResultDestinationKind, status: number, text: string): string | undefined {
  if (status < 200 || status >= 300) return `HTTP ${status}`
  if (kind === 'webhook') return undefined
  let json: Record<string, unknown>
  try {
    json = JSON.parse(text) as Record<string, unknown>
  } catch {
    return `回复看不懂：${text.slice(0, 100)}`
  }
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

// The text, with each answer shortened until it all fits the destination.
function fitted(result: RoundResult, markdown: boolean, english: boolean, byteLimit: number): string {
  let limit = FIRST_TEXT_LIMIT
  let text = compose(result, markdown, english, limit)
  while (bytes(text) > byteLimit && limit > 40) {
    limit = Math.floor(limit * 0.7)
    text = compose(result, markdown, english, limit)
  }
  while (bytes(text) > byteLimit) text = text.slice(0, Math.floor(text.length * 0.9))
  return text
}

function compose(result: RoundResult, markdown: boolean, english: boolean, limit: number): string {
  const bold = (value: string) => markdown ? `**${value}**` : value
  const cut = (value: string) => value.length > limit ? `${value.slice(0, limit)}${english ? '… (full text in OpenTeam)' : '…（完整内容在 OpenTeam 里）'}` : value
  const schedule = result.schedule ? (english ? ` (${result.schedule})` : `（${result.schedule}）`) : ''
  const head = markdown ? `${bold(titleOf(result, english))}${schedule}` : `${titleOf(result, english)}${schedule}`
  const question = cut(result.question.split('\n')[0].slice(0, 200))
  const lines = [head, markdown ? `> ${question}` : `${english ? 'Question: ' : '问题：'}${question}`]
  if (result.summary) {
    const answered = result.answers.filter(answer => !answer.failed).map(answer => answer.member)
    const missing = result.answers.filter(answer => answer.failed).map(answer => answer.member)
    const who = english
      ? `Answered: ${answered.join(', ') || 'no one'}${missing.length ? `; no answer: ${missing.join(', ')}` : ''}`
      : `回答了：${answered.join('、') || '无'}${missing.length ? `；没回答：${missing.join('、')}` : ''}`
    return [lines.join('\n'), `${bold(english ? `Summary (${result.summary.member})` : `汇总（${result.summary.member}）`)}\n${cut(result.summary.text)}`, who].join('\n\n')
  }
  return [lines.join('\n'), ...result.answers.map(answer => `${bold(answer.member)}\n${answer.failed ? (english ? '(no answer)' : '（没有回答）') : cut(answer.text)}`)].join('\n\n')
}

function bytes(text: string): number {
  return new TextEncoder().encode(text).length
}

async function hmacBase64(key: string, message: string): Promise<string> {
  const encoder = new TextEncoder()
  const cryptoKey = await crypto.subtle.importKey('raw', encoder.encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const signature = new Uint8Array(await crypto.subtle.sign('HMAC', cryptoKey, encoder.encode(message)))
  let binary = ''
  for (const byte of signature) binary += String.fromCharCode(byte)
  return btoa(binary)
}
