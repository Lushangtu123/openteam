// Runs a local agent member's prompt through the OpenTeam daemon (ACP) and streams its work as the
// member's reply. Nothing runs before the user allows it; each permission the agent asks for (to edit
// a file, run a command) is asked of the user too. A run is never retried on its own: what an agent
// did cannot be undone by sending it again.
import { normalizeLanguage } from '../shared/i18n'
import type { ControlHttpResult, ExtensionRequest, LocalAgentEvent } from '../shared/localControlProtocol'
import type { ExternalModelCompletionInput } from './externalModelClient'
import type { LocalAgentApprovals } from './localAgentApprovals'

export interface LocalAgentControl {
  request(action: ExtensionRequest['action'], payload?: Record<string, unknown>, timeoutMs?: number): Promise<ControlHttpResult>
  onAgentEvents(runId: string, handler: (event: LocalAgentEvent) => void): () => void
}

export interface LocalAgentClientDependencies {
  control: LocalAgentControl
  approvals: Pick<LocalAgentApprovals, 'ask'>
  getLanguage(): unknown
}

const PROMPT_PREVIEW_CHARS = 6000

export function createLocalAgentClient(deps: LocalAgentClientDependencies) {
  async function* stream(input: ExternalModelCompletionInput): AsyncIterable<string> {
    const model = input.model
    const context = input.context
    if (!context) throw new Error('本机智能体只能作为群聊成员使用')
    if (!model.localAgentId || !model.workspace) throw new Error('这个本机智能体缺少设置，请在「添加大模型」里重新保存')
    const en = normalizeLanguage(deps.getLanguage()) === 'en'
    const who = context.roleName ?? model.name
    const signal = input.abortSignal

    const runAnswer = await deps.approvals.ask(context, {
      kind: 'run',
      title: en ? `${who} wants to work in ${model.workspace}` : `「${who}」要在 ${model.workspace} 里执行这项任务`,
      detail: input.prompt.length > PROMPT_PREVIEW_CHARS ? `${input.prompt.slice(0, PROMPT_PREVIEW_CHARS)}\n…` : input.prompt,
      options: [{ id: 'allow', label: en ? 'Allow this run' : '允许执行', kind: 'allow_once' }, { id: 'deny', label: en ? 'Refuse' : '拒绝', kind: 'reject_once' }],
    }, signal)
    throwIfAborted(signal)
    if (runAnswer !== 'allow') throw new Error(en ? 'You refused this run.' : '你拒绝了这次执行。')

    const started = await deps.control.request('agent.run', { agentId: model.localAgentId, prompt: input.prompt, cwd: model.workspace })
    if (!started.ok) throw new Error([started.error?.message ?? '本机智能体没有启动', started.error?.hint].filter(Boolean).join(' '))
    const runId = (started.data as { runId?: unknown } | undefined)?.runId
    if (typeof runId !== 'string') throw new Error('本机智能体没有启动')

    const queue: string[] = []
    let finished = false
    let failure: Error | undefined
    let wake: (() => void) | undefined
    const push = (text: string) => {
      queue.push(text)
      wake?.()
    }
    const fail = (error: Error) => {
      failure = error
      wake?.()
    }
    const seenTools = new Set<string>()
    let wroteText = false

    const unsubscribe = deps.control.onAgentEvents(runId, event => {
      switch (event.kind) {
        case 'text':
          wroteText = true
          push(event.text)
          return
        case 'tool':
          if (!seenTools.has(event.id) && event.title) {
            seenTools.add(event.id)
            push(`\n\n> 🛠 ${event.title}\n\n`)
          } else if (event.status === 'failed' && event.title) {
            push(`\n\n> ✗ ${event.title}${en ? ' failed' : ' 失败'}\n\n`)
          }
          return
        case 'file':
          if (event.action === 'write') push(`\n\n> 📝 ${en ? 'Wrote' : '已写入'} ${event.path}\n\n`)
          return
        case 'permission':
          void answerPermission(runId, event)
          return
        case 'done':
          if (!wroteText && !event.output.trim()) push(en ? '(The agent finished without writing anything.)' : '（智能体完成了，没有输出文字。）')
          finished = true
          wake?.()
          return
        case 'error':
        case 'cancelled':
          fail(new Error(event.message))
          return
        default:
      }
    })

    async function answerPermission(id: string, event: Extract<LocalAgentEvent, { kind: 'permission' }>): Promise<void> {
      const optionId = await deps.approvals.ask(context!, {
        kind: 'permission',
        title: en ? `${who} wants to: ${event.title}` : `「${who}」想要：${event.title}`,
        detail: event.toolKind ? (en ? `Kind: ${event.toolKind}` : `类型：${event.toolKind}`) : undefined,
        options: event.options.map(option => ({ id: option.optionId, label: option.name, kind: option.kind })),
      }, signal)
      const chosen = event.options.find(option => option.optionId === optionId)
      if (chosen) push(`\n\n> ${chosen.kind.startsWith('allow') ? '✅' : '⛔'} ${chosen.name}：${event.title}\n\n`)
      const answered = await deps.control.request('agent.permission', { runId: id, permissionId: event.permissionId, ...(optionId ? { optionId } : {}) })
      if (!answered.ok && !signal?.aborted) fail(new Error(answered.error?.message ?? '没能把你的决定告诉本机智能体'))
    }

    const onAbort = () => void deps.control.request('agent.cancel', { runId })
    signal?.addEventListener('abort', onAbort, { once: true })
    try {
      for (;;) {
        if (queue.length > 0) {
          yield queue.shift()!
          continue
        }
        if (failure) throw failure
        if (finished) return
        await new Promise<void>(resolve => { wake = resolve })
        wake = undefined
      }
    } finally {
      signal?.removeEventListener('abort', onAbort)
      unsubscribe()
      if (!finished && !failure) void deps.control.request('agent.cancel', { runId })
    }
  }

  return { stream }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    const error = new Error('aborted')
    error.name = 'AbortError'
    throw error
  }
}
