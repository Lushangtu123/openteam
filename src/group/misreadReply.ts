// A web member's "reply" read from the wrong place on its page: OpenTeam's own prompt (the prompt
// typed into an editor inside the conversation, or the user's turn read as the reply), or its
// previous reply again. It is not accepted as the reply; the member's reply fails so it can be
// synced again. Returns why, or undefined for text that looks like a reply.

// Sentences only OpenTeam's prompts contain. A model may quote one of them while it reasons, so it
// takes two to count as a prompt.
const OPENTEAM_PROMPT_SENTENCES: Array<string | RegExp> = [
  '你正在一个 AI 群聊中。',
  /(^|\n)你是「[^」\n]{1,40}」。/,
  /(^|\n)你的身份是「[^」\n]{1,40}」。/,
  /(^|\n)用户(最新)?消息：\n/,
  '你上次之后，群聊里',
  /请以「[^」\n]{1,40}」身份回复。/,
  '只回复一个 JSON 代码块，格式如下：',
  'newTasks 里每个任务的格式和计划里一样',
  '最后另起两行写：',
  '请对照完成标准逐条检查',
  'owner 写成员的名字（不带括号里的模型）。',
  'You are in an AI group chat.',
  /(^|\n)You are "[^"\n]{1,40}"\./,
  /(^|\n)Your identity is "[^"\n]{1,40}"\./,
  /(^|\n)User (latest )?message:\n/,
  'Since your last turn, ',
  /Reply as "[^"\n]{1,40}"\. /,
  'Reply with only one JSON code block, in this form:',
  'New tasks use the same form as in the plan:',
  'Then end with two lines:',
  'Use the member names exactly as listed',
]

// A reply this long that equals the previous one was read from the older turn.
const REPEAT_MIN_CHARS = 200

export function misreadReplyReason(content: string, previousReply?: string): string | undefined {
  const found = OPENTEAM_PROMPT_SENTENCES.filter(sentence => typeof sentence === 'string' ? content.includes(sentence) : sentence.test(content)).length
  if (found >= 2) return '读到的是 OpenTeam 发给它的提示词'
  const compact = (text: string) => text.replace(/\s+/g, '')
  if (previousReply && compact(content).length >= REPEAT_MIN_CHARS && compact(content) === compact(previousReply)) return '和它上一条回复一模一样'
  return undefined
}
