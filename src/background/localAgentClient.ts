// Runs a local agent member's prompt through the OpenTeam daemon (ACP) and streams its work as the
// member's reply. Nothing runs before the user allows it; each permission the agent asks for (to edit
// a file, run a command) is asked of the user too. A run is never retried on its own: what an agent
// did cannot be undone by sending it again. A run that goes quiet (a tool that does not end) says so
// in the reply, naming the tool, and stops at the agent's 运行时限 (src/shared/localAgentLimits.ts).
import { normalizeLanguage } from '../shared/i18n'
import type { ControlHttpResult, ExtensionRequest, LocalAgentEvent } from '../shared/localControlProtocol'
import type { ExternalModelCompletionInput } from './externalModelClient'
import { DEFAULT_RUN_LIMIT_MINUTES, STALL_NOTICE_MS, STALL_REPEAT_MS } from '../shared/localAgentLimits'
import type { LocalAgentApprovals } from './localAgentApprovals'
import type { ProjectRunGrants } from './projectRunGrants'
import { createWorkspaceQueue, type WorkspaceQueue } from './workspaceQueue'

export interface LocalAgentControl {
  request(action: ExtensionRequest['action'], payload?: Record<string, unknown>, timeoutMs?: number): Promise<ControlHttpResult>
  onAgentEvents(runId: string, handler: (event: LocalAgentEvent) => void): () => void
}

export interface LocalAgentClientDependencies {
  control: LocalAgentControl
  approvals: Pick<LocalAgentApprovals, 'ask'>
  // 这个项目都允许 (projectRunGrants.ts): a project's requests run without asking once it is given.
  projectRuns?: Pick<ProjectRunGrants, 'check' | 'allow'>
  getLanguage(): unknown
  // Shared by every run of this client: one agent at a time in a folder.
  workspaces?: WorkspaceQueue
}

const PROMPT_PREVIEW_CHARS = 6000

export function createLocalAgentClient(deps: LocalAgentClientDependencies) {
  const workspaces = deps.workspaces ?? createWorkspaceQueue()

  async function* stream(input: ExternalModelCompletionInput): AsyncIterable<string> {
    const model = input.model
    const context = input.context
    if (!context) throw new Error('本机智能体只能作为群聊成员使用')
    if (!model.localAgentId || !model.workspace) throw new Error('这个本机智能体缺少设置，请在「设置 → 模型」里重新保存')
    const en = normalizeLanguage(deps.getLanguage()) === 'en'
    const who = context.roleName ?? model.name
    const signal = input.abortSignal

    // Another member's agent working in this folder goes first; this run is asked for after it.
    const ticket = workspaces.enter(model.workspace, who)
    try {
      if (ticket.waitingFor.length > 0) {
        const names = ticket.waitingFor.map(name => en ? `"${name}"` : `「${name}」`).join(en ? ', ' : '、')
        yield en ? `> ⏳ Waiting for ${names} to finish in ${model.workspace}\n\n` : `> ⏳ 等${names}在 ${model.workspace} 里做完再开始\n\n`
      }
      await ticket.ready(signal)
      yield* run(input, model.workspace, who, en, signal)
    } finally {
      ticket.release()
    }
  }

  async function* run(input: ExternalModelCompletionInput, workspace: string, who: string, en: boolean, signal: AbortSignal | undefined): AsyncIterable<string> {
    const model = { ...input.model, workspace }
    const context = input.context!

    // A request of the running project: allowed already for the whole project, or that can be offered.
    const project = await deps.projectRuns?.check(context)
    const allowedForProject = project === 'allowed'
    if (!allowedForProject) {
      const runAnswer = await deps.approvals.ask(context, {
        kind: 'run',
        title: en ? `${who} wants to work in ${model.workspace}` : `「${who}」要在 ${model.workspace} 里执行这项任务`,
        detail: input.prompt.length > PROMPT_PREVIEW_CHARS ? `${input.prompt.slice(0, PROMPT_PREVIEW_CHARS)}\n…` : input.prompt,
        options: [
          { id: 'allow', label: en ? 'Allow this run' : '允许执行', kind: 'allow_once' },
          ...(project === 'can-allow' ? [{ id: 'allow-project', label: en ? 'Allow for this project' : '这个项目都允许', kind: 'allow_always' }] : []),
          { id: 'deny', label: en ? 'Refuse' : '拒绝', kind: 'reject_once' },
        ],
      }, signal)
      throwIfAborted(signal)
      // The project may have ended while the question waited: then this run alone is allowed.
      if (runAnswer === 'allow-project') await deps.projectRuns?.allow(context)
      else if (runAnswer !== 'allow') throw new Error(en ? 'You refused this run.' : '你拒绝了这次执行。')
    }

    const limitMinutes = model.runLimitMinutes ?? DEFAULT_RUN_LIMIT_MINUTES
    const startedAt = Date.now()
    const stoppedAtLimit = en ? `Stopped at its run time limit (${limitMinutes} min).` : `到了运行时限（${limitMinutes} 分钟），已停止这次运行。`
    const started = await deps.control.request('agent.run', { agentId: model.localAgentId, prompt: input.prompt, cwd: model.workspace, timeoutMs: limitMinutes * 60_000 })
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
    // Run without a question: the reply says why.
    if (allowedForProject) push(en ? `> ✅ ${who} may work on every task of this project\n\n` : `> ✅ 这个项目里已允许「${who}」执行任务\n\n`)
    const seenTools = new Set<string>()
    let wroteText = false
    // Going quiet: the last sign of work, the tools not yet ended (by title), and the questions the
    // user has not answered yet (that wait is not the agent's).
    let lastActivity = Date.now()
    let nextNoticeAt = lastActivity + STALL_NOTICE_MS
    const openTools = new Map<string, string>()
    let waitingForUser = 0
    // News starts the clock again; the waiting loop below sets its timer anew.
    const touch = () => {
      lastActivity = Date.now()
      nextNoticeAt = lastActivity + STALL_NOTICE_MS
      wake?.()
    }

    const unsubscribe = deps.control.onAgentEvents(runId, event => {
      touch()
      if (event.kind === 'tool') {
        const title = event.title || openTools.get(event.id)
        if (event.status === 'completed' || event.status === 'failed') openTools.delete(event.id)
        else if (title) openTools.set(event.id, title)
      }
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
          // Stopped without the user asking: at the run time limit (a daemon before CLI 0.6.1 ends
          // such a run as done, cancelled), or by the agent itself.
          if (event.stopReason === 'cancelled' && !signal?.aborted) {
            fail(new Error(Date.now() - startedAt >= limitMinutes * 60_000 - 5_000 ? stoppedAtLimit : en ? 'The agent stopped this run.' : '智能体中止了这次运行。'))
            return
          }
          if (!wroteText && !event.output.trim()) push(en ? '(The agent finished without writing anything.)' : '（智能体完成了，没有输出文字。）')
          finished = true
          wake?.()
          return
        case 'error':
        case 'cancelled':
          fail(new Error(event.message === '本地智能体运行超时。' ? stoppedAtLimit : event.message))
          return
        default:
      }
    })

    async function answerPermission(id: string, event: Extract<LocalAgentEvent, { kind: 'permission' }>): Promise<void> {
      waitingForUser += 1
      const optionId = await deps.approvals.ask(context!, {
        kind: 'permission',
        title: en ? `${who} wants to: ${event.title}` : `「${who}」想要：${event.title}`,
        detail: event.toolKind ? (en ? `Kind: ${event.toolKind}` : `类型：${event.toolKind}`) : undefined,
        options: event.options.map(option => ({ id: option.optionId, label: option.name, kind: option.kind })),
      }, signal).finally(() => {
        waitingForUser -= 1
        touch()
      })
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
        if (waitingForUser > 0) touch()
        else if (Date.now() >= nextNoticeAt) {
          yield stallNotice(Date.now() - lastActivity, [...openTools.values()].pop(), limitMinutes, en)
          nextNoticeAt = Date.now() + STALL_REPEAT_MS
          continue
        }
        let timer: ReturnType<typeof setTimeout> | undefined
        await new Promise<void>(resolve => {
          wake = resolve
          timer = setTimeout(resolve, Math.max(0, nextNoticeAt - Date.now()))
        })
        clearTimeout(timer)
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

// "> ⏳ 已经 3 分钟没有新动静，可能卡在「运行 npm test」……", a line of the reply.
export function stallNotice(quietMs: number, tool: string | undefined, limitMinutes: number, en: boolean): string {
  const minutes = Math.max(1, Math.round(quietMs / 60_000))
  return en
    ? `\n\n> ⏳ Nothing new for ${minutes} min${tool ? `; it may be stuck on "${tool}"` : ''}. You can wait, or click Stop to end this run (it stops on its own after ${limitMinutes} min).\n\n`
    : `\n\n> ⏳ 已经 ${minutes} 分钟没有新动静${tool ? `，可能卡在「${tool}」` : ''}。可以等它继续，或点「停止」结束这次运行（满 ${limitMinutes} 分钟会自动停止）。\n\n`
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    const error = new Error('aborted')
    error.name = 'AbortError'
    throw error
  }
}
