import { describe, expect, it, vi } from 'vitest'
import type { ExternalModelConfig } from '../group/types'
import type { ControlHttpResult, LocalAgentEvent } from '../shared/localControlProtocol'
import { createLocalAgentClient } from './localAgentClient'

const model: ExternalModelConfig = { id: 'm1', name: 'Claude Code', format: 'local-agent', baseUrl: '', apiKey: '', modelName: 'claude-code', localAgentId: 'claude-code', workspace: '/Users/me/app', createdAt: 0, updatedAt: 0 }
const context = { chatId: 'chat-1', roleId: 'role-1', messageId: 'msg-1', roleName: '程序员' }

function setup(answers: Array<string | undefined>, events: LocalAgentEvent[] = []) {
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
  const client = createLocalAgentClient({ control, approvals, getLanguage: () => 'zh-CN' })
  return { client, control, requests, asked, listeners }
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

    expect(requests[0]).toEqual(['agent.run', { agentId: 'claude-code', prompt: '改一下 README', cwd: '/Users/me/app' }])
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

  it('explains a daemon that cannot start the agent', async () => {
    const { client, control } = setup(['allow'])
    control.request.mockResolvedValueOnce({ id: 'r', ok: false, error: { code: 'workspace_not_allowed', message: '工作目录不在这个智能体允许的范围内。', hint: '用 openteamcli agent add 加入这个目录' } })
    await expect(collect(client.stream({ model, prompt: 'x', context }))).rejects.toThrow('工作目录不在这个智能体允许的范围内。 用 openteamcli agent add 加入这个目录')
  })
})
