import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ExternalModelConfig } from '../group/types'
import type { ControlHttpResult, LocalAgentEvent } from '../shared/localControlProtocol'
import { createLocalAgentClient } from './localAgentClient'
import { STALL_NOTICE_MS, STALL_REPEAT_MS } from '../shared/localAgentLimits'

const model: ExternalModelConfig = { id: 'm1', name: 'Claude Code', format: 'local-agent', baseUrl: '', apiKey: '', modelName: 'claude-code', localAgentId: 'claude-code', workspace: '/Users/me/app', createdAt: 0, updatedAt: 0 }
const context = { chatId: 'chat-1', roleId: 'role-1', messageId: 'msg-1', roleName: '程序员' }

function setup(answers: Array<string | undefined>, events: LocalAgentEvent[] = [], project?: 'allowed' | 'can-allow') {
  const listeners = new Map<string, (event: LocalAgentEvent) => void>()
  const requests: Array<[string, Record<string, unknown> | undefined]> = []
  const control = {
    request: vi.fn(async (action: string, payload?: Record<string, unknown>): Promise<ControlHttpResult> => {
      requests.push([action, payload])
      if (action === 'agent.run') {
        // The daemon starts the run, then streams its events.
        setTimeout(() => { for (const event of events) listeners.get('run-1')?.(event) }, 0)
        return { id: 'r', ok: true, data: { runId: 'run-1' } }
      }
      return { id: 'r', ok: true }
    }),
    onAgentEvents: vi.fn((runId: string, handler: (event: LocalAgentEvent) => void) => {
      listeners.set(runId, handler)
      return () => listeners.delete(runId)
    }),
  }
  const asked: unknown[] = []
  const approvals = { ask: vi.fn(async (_context: unknown, question: unknown) => { asked.push(question); return answers.shift() }) }
  const projectRuns = { check: vi.fn(async () => project), allow: vi.fn(async () => true) }
  const client = createLocalAgentClient({ control, approvals, getLanguage: () => 'zh-CN', projectRuns })
  return { client, control, requests, asked, listeners, projectRuns }
}

async function collect(stream: AsyncIterable<string>): Promise<string> {
  let text = ''
  for await (const chunk of stream) text += chunk
  return text
}

describe('local agent client', () => {
  it('runs nothing until the user allows it', async () => {
    const { client, requests, asked } = setup(['deny'])
    await expect(collect(client.stream({ model, prompt: '改一下 README', context }))).rejects.toThrow('你拒绝了这次执行。')
    expect(asked[0]).toMatchObject({ kind: 'run', title: '「程序员」要在 /Users/me/app 里执行这项任务', detail: '改一下 README', options: [{ id: 'allow' }, { id: 'deny' }] })
    expect(requests).toEqual([])
    await expect(collect(client.stream({ model, prompt: 'x' }))).rejects.toThrow('本机智能体只能作为群聊成员使用')
  })

  it('offers to allow the runs of the whole project for a project task, and then runs without asking', async () => {
    const done: LocalAgentEvent[] = [{ kind: 'started' }, { kind: 'text', text: '做好了。' }, { kind: 'done', output: '做好了。' }]
    const offered = setup(['allow-project'], done, 'can-allow')
    const text = await collect(offered.client.stream({ model, prompt: '实现登录', context }))
    expect(offered.asked[0]).toMatchObject({ kind: 'run', options: [{ id: 'allow' }, { id: 'allow-project', label: '这个项目都允许', kind: 'allow_always' }, { id: 'deny' }] })
    expect(offered.projectRuns.allow).toHaveBeenCalledWith(context)
    expect(offered.requests[0][0]).toBe('agent.run')
    expect(text).toContain('做好了。')

    // Allowed already: no question, and the reply says why it ran.
    const allowed = setup([], done, 'allowed')
    const next = await collect(allowed.client.stream({ model, prompt: '写测试', context }))
    expect(allowed.asked).toEqual([])
    expect(allowed.requests[0]).toEqual(['agent.run', expect.objectContaining({ prompt: '写测试' })])
    expect(next).toContain('> ✅ 这个项目里已允许「程序员」执行任务')

    // Outside a project only this run can be allowed.
    const plain = setup(['deny'])
    await expect(collect(plain.client.stream({ model, prompt: 'x', context }))).rejects.toThrow('你拒绝了这次执行。')
    expect((plain.asked[0] as { options: unknown[] }).options).toHaveLength(2)
  })

  it('streams the run: text, tools, files, and asks the user for each permission', async () => {
    const events: LocalAgentEvent[] = [
      { kind: 'started' },
      { kind: 'text', text: '我来改 README。' },
      { kind: 'tool', id: 't1', title: '编辑 README.md', toolKind: 'edit', status: 'pending' },
      { kind: 'permission', permissionId: 'p1', title: '编辑 README.md', toolKind: 'edit', options: [{ optionId: 'ok', name: '允许', kind: 'allow_once' }, { optionId: 'no', name: '拒绝', kind: 'reject_once' }] },
    ]
    const { client, requests, asked, listeners } = setup(['allow', 'ok'], events)
    const run = collect(client.stream({ model, prompt: '改一下 README', context }))
    await vi.waitFor(() => expect(requests.map(([action]) => action)).toContain('agent.permission'))
    listeners.get('run-1')?.({ kind: 'file', action: 'write', path: 'README.md' })
    listeners.get('run-1')?.({ kind: 'tool', id: 't1', title: '编辑 README.md', status: 'completed' })
    listeners.get('run-1')?.({ kind: 'text', text: '改好了。' })
    listeners.get('run-1')?.({ kind: 'done', output: '我来改 README。改好了。' })
    const text = await run

    expect(requests[0]).toEqual(['agent.run', { agentId: 'claude-code', prompt: '改一下 README', cwd: '/Users/me/app', timeoutMs: 30 * 60_000 }])
    expect(requests).toContainEqual(['agent.permission', { runId: 'run-1', permissionId: 'p1', optionId: 'ok' }])
    expect(asked[1]).toMatchObject({ kind: 'permission', title: '「程序员」想要：编辑 README.md', options: [{ id: 'ok', label: '允许', kind: 'allow_once' }, { id: 'no', label: '拒绝' }] })
    expect(text).toContain('我来改 README。')
    expect(text).toContain('> 🛠 编辑 README.md')
    expect(text).toContain('> ✅ 允许：编辑 README.md')
    expect(text).toContain('> 📝 已写入 README.md')
    expect(text).toContain('改好了。')
    expect(requests.map(([action]) => action)).not.toContain('agent.cancel')
  })

  it('reports a failed run and cancels a stopped one', async () => {
    const failed = setup(['allow'], [{ kind: 'error', message: '本地智能体已退出（1）' }])
    await expect(collect(failed.client.stream({ model, prompt: 'x', context }))).rejects.toThrow('本地智能体已退出（1）')

    const stopped = setup(['allow'], [{ kind: 'text', text: '开始' }])
    const controller = new AbortController()
    const chunks: string[] = []
    await expect((async () => {
      for await (const chunk of stopped.client.stream({ model, prompt: 'x', context, abortSignal: controller.signal })) {
        chunks.push(chunk)
        controller.abort()
        break
      }
    })()).resolves.toBeUndefined()
    expect(chunks).toEqual(['开始'])
    await vi.waitFor(() => expect(stopped.requests.map(([action]) => action)).toContain('agent.cancel'))
  })

  it('lets one member\'s agent work in a folder at a time, asking for the next run only after the first', async () => {
    const { client, requests, asked, listeners } = setup(['allow', 'allow'])
    const first = collect(client.stream({ model, prompt: '改 README', context }))
    await vi.waitFor(() => expect(requests.map(([action]) => action)).toEqual(['agent.run']))
    // The second member's agent works in a folder inside the first one's.
    const second = collect(client.stream({ model: { ...model, workspace: '/Users/me/app/docs' }, prompt: '改文档', context: { ...context, roleId: 'role-2', roleName: '文档员' } }))
    await new Promise(resolve => setTimeout(resolve, 10))
    // Not asked yet, not started yet.
    expect(asked).toHaveLength(1)
    expect(requests.map(([action]) => action)).toEqual(['agent.run'])

    listeners.get('run-1')?.({ kind: 'text', text: '改好了。' })
    listeners.get('run-1')?.({ kind: 'done', output: '', stopReason: 'end_turn' })
    await expect(first).resolves.toBe('改好了。')
    await vi.waitFor(() => expect(asked).toHaveLength(2))
    expect(asked[1]).toMatchObject({ kind: 'run', title: '「文档员」要在 /Users/me/app/docs 里执行这项任务' })
    await vi.waitFor(() => expect(requests.filter(([action]) => action === 'agent.run')).toHaveLength(2))
    // Its events are listened to once the run has started.
    await vi.waitFor(() => expect(listeners.has('run-1')).toBe(true))
    listeners.get('run-1')?.({ kind: 'done', output: '', stopReason: 'end_turn' })
    await expect(second).resolves.toBe('> ⏳ 等「程序员」在 /Users/me/app/docs 里做完再开始\n\n（智能体完成了，没有输出文字。）')
  })

  it('lets the next agent in the folder go on when a run is refused', async () => {
    const { client, requests } = setup(['deny', 'allow'])
    const first = collect(client.stream({ model, prompt: 'x', context }))
    const second = collect(client.stream({ model, prompt: 'y', context: { ...context, roleId: 'role-2', roleName: '文档员' } }))
    await expect(first).rejects.toThrow('你拒绝了这次执行。')
    await vi.waitFor(() => expect(requests.map(([action]) => action)).toEqual(['agent.run']))
    void second.catch(() => undefined)
  })

  it('explains a daemon that cannot start the agent', async () => {
    const { client, control } = setup(['allow'])
    control.request.mockResolvedValueOnce({ id: 'r', ok: false, error: { code: 'workspace_not_allowed', message: '工作目录不在这个智能体允许的范围内。', hint: '用 openteamcli agent add 加入这个目录' } })
    await expect(collect(client.stream({ model, prompt: 'x', context }))).rejects.toThrow('工作目录不在这个智能体允许的范围内。 用 openteamcli agent add 加入这个目录')
  })
})

describe('a local agent run that goes quiet', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('asks the daemon to stop it at the agent\'s run time limit, 30 minutes unless set', async () => {
    const done: LocalAgentEvent[] = [{ kind: 'started' }, { kind: 'text', text: '好了' }, { kind: 'done', output: '好了' }]
    const first = setup(['allow'], done)
    await collect(first.client.stream({ model, prompt: 'x', context }))
    expect(first.requests[0]).toEqual(['agent.run', { agentId: 'claude-code', prompt: 'x', cwd: '/Users/me/app', timeoutMs: 30 * 60_000 }])
    const second = setup(['allow'], done)
    await collect(second.client.stream({ model: { ...model, runLimitMinutes: 90 }, prompt: 'x', context }))
    expect(second.requests[0][1]).toMatchObject({ timeoutMs: 90 * 60_000 })
  })

  it('says so in the reply after 3 minutes without news, naming the tool it may be stuck on, and again every 5', async () => {
    vi.useFakeTimers()
    const { client, listeners } = setup(['allow'], [{ kind: 'started' }, { kind: 'tool', id: 't1', title: '运行 npm test', toolKind: 'execute', status: 'in_progress' }])
    const chunks: string[] = []
    const run = (async () => { for await (const chunk of client.stream({ model, prompt: '跑测试', context })) chunks.push(chunk) })()
    await vi.advanceTimersByTimeAsync(10)
    expect(chunks.join('')).toContain('🛠 运行 npm test')
    await vi.advanceTimersByTimeAsync(STALL_NOTICE_MS - 1_000)
    expect(chunks.join('')).not.toContain('没有新动静')
    await vi.advanceTimersByTimeAsync(1_000)
    expect(chunks.join('')).toContain('> ⏳ 已经 3 分钟没有新动静，可能卡在「运行 npm test」。可以等它继续，或点「停止」结束这次运行（满 30 分钟会自动停止）。')
    await vi.advanceTimersByTimeAsync(STALL_REPEAT_MS)
    expect(chunks.join('')).toContain('已经 8 分钟没有新动静')
    // News starts the clock again; a finished tool is no longer named.
    listeners.get('run-1')?.({ kind: 'tool', id: 't1', title: '运行 npm test', status: 'completed' })
    await vi.advanceTimersByTimeAsync(STALL_NOTICE_MS)
    expect(chunks.join('').match(/没有新动静/g)).toHaveLength(3)
    expect(chunks.join('').trim().endsWith('> ⏳ 已经 3 分钟没有新动静。可以等它继续，或点「停止」结束这次运行（满 30 分钟会自动停止）。')).toBe(true)
    listeners.get('run-1')?.({ kind: 'done', output: '' })
    await vi.advanceTimersByTimeAsync(10)
    await run
  })

  it('does not count the time it waits for the user to allow something', async () => {
    vi.useFakeTimers()
    let answer: ((value: string) => void) | undefined
    const listeners = new Map<string, (event: LocalAgentEvent) => void>()
    const control = {
      request: vi.fn(async (action: string): Promise<ControlHttpResult> => {
        if (action === 'agent.run') {
          setTimeout(() => listeners.get('run-1')?.({ kind: 'permission', permissionId: 'p1', title: '运行 rm -rf build', options: [{ optionId: 'ok', name: '允许', kind: 'allow_once' }] }), 0)
          return { id: 'r', ok: true, data: { runId: 'run-1' } }
        }
        return { id: 'r', ok: true }
      }),
      onAgentEvents: vi.fn((runId: string, handler: (event: LocalAgentEvent) => void) => {
        listeners.set(runId, handler)
        return () => listeners.delete(runId)
      }),
    }
    let asked = 0
    const approvals = { ask: vi.fn(async () => (asked += 1) === 1 ? 'allow' : new Promise<string>(resolve => { answer = resolve })) }
    const client = createLocalAgentClient({ control, approvals, getLanguage: () => 'en' })
    const chunks: string[] = []
    const run = (async () => { for await (const chunk of client.stream({ model, prompt: 'clean', context })) chunks.push(chunk) })()
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    expect(chunks.join('')).not.toContain('Nothing new')
    answer?.('ok')
    await vi.advanceTimersByTimeAsync(STALL_NOTICE_MS)
    expect(chunks.join('')).toContain('> ⏳ Nothing new for 3 min. You can wait, or click Stop to end this run (it stops on its own after 30 min).')
    listeners.get('run-1')?.({ kind: 'done', output: 'ok' })
    await vi.advanceTimersByTimeAsync(10)
    await run
  })
})

describe('a local agent run that stops without the user asking', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('says it reached the run time limit, from the daemon\'s timeout or from an older daemon\'s cancelled end', async () => {
    const timedOut = setup(['allow'], [{ kind: 'started' }, { kind: 'error', message: '本地智能体运行超时。' }])
    await expect(collect(timedOut.client.stream({ model, prompt: 'x', context }))).rejects.toThrow('到了运行时限（30 分钟），已停止这次运行。')

    vi.useFakeTimers()
    const older = setup(['allow'], [{ kind: 'started' }, { kind: 'text', text: '开始' }])
    const run = collect(older.client.stream({ model: { ...model, runLimitMinutes: 4 }, prompt: 'x', context }))
    const failed = expect(run).rejects.toThrow('到了运行时限（4 分钟），已停止这次运行。')
    await vi.advanceTimersByTimeAsync(4 * 60_000)
    older.listeners.get('run-1')?.({ kind: 'done', output: '', stopReason: 'cancelled' })
    await vi.advanceTimersByTimeAsync(10)
    await failed
  })

  it('says the agent stopped it when that was well before the limit', async () => {
    const early = setup(['allow'], [{ kind: 'started' }, { kind: 'done', output: '', stopReason: 'cancelled' }])
    await expect(collect(early.client.stream({ model, prompt: 'x', context }))).rejects.toThrow('智能体中止了这次运行。')
  })
})
