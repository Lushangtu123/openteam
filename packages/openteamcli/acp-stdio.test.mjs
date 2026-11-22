import { mkdtempSync, readFileSync, realpathSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { pathInside, runStdioAcpAgent } from './acp-stdio.mjs'

const MOCK = resolve(import.meta.dirname, 'test-fixtures/mock-acp-agent.mjs')
const agent = { command: process.execPath, args: [MOCK] }
const folders = []

function workspace() {
  const folder = realpathSync(mkdtempSync(join(tmpdir(), 'ot-acp-')))
  folders.push(folder)
  return folder
}

afterEach(() => {
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true })
})

describe('ACP over stdio', () => {
  it('runs a prompt: streams text and tool calls, asks permission, writes inside the folder', async () => {
    const cwd = workspace()
    const events = []
    const asked = []
    const result = await runStdioAcpAgent(agent, {
      prompt: '写个文件 READ',
      cwd,
      timeoutMs: 10_000,
      onEvent: event => events.push(event),
      requestPermission: async request => {
        asked.push(request)
        return 'allow'
      },
    })
    expect(result.stopReason).toBe('end_turn')
    expect(result.output).toContain('已写入 hello.txt。')
    expect(result.output).toContain('读到：你好，来自 OpenTeam：写个文件 READ')
    expect(readFileSync(join(cwd, 'hello.txt'), 'utf8')).toBe('你好，来自 OpenTeam：写个文件 READ\n')
    expect(asked[0]).toMatchObject({ toolCall: { title: '写入 hello.txt' }, options: [{ optionId: 'allow', kind: 'allow_once' }, { optionId: 'reject' }] })
    expect(events.filter(event => event.kind === 'tool').map(event => event.status)).toEqual(['pending', 'completed'])
    expect(events).toContainEqual({ kind: 'file', action: 'write', path: 'hello.txt' })
  })

  it('writes nothing when permission is refused, and never outside the folder', async () => {
    const cwd = workspace()
    const refused = await runStdioAcpAgent(agent, { prompt: '写', cwd, timeoutMs: 10_000, requestPermission: async () => 'reject' })
    expect(refused.output).toContain('没有获得许可，未写入。')
    expect(existsSync(join(cwd, 'hello.txt'))).toBe(false)

    const escape = await runStdioAcpAgent(agent, { prompt: 'ESCAPE', cwd, timeoutMs: 10_000, requestPermission: async () => 'allow' })
    expect(escape.output).toContain('越界写入被拒绝：不能访问工作目录以外的文件。')
    expect(existsSync('/tmp/openteam-escape-test.txt')).toBe(false)
  })

  it('says a run stopped at its time limit timed out, also when the agent answers the stop', async () => {
    await expect(runStdioAcpAgent(agent, { prompt: 'SLOW', cwd: workspace(), timeoutMs: 300 })).rejects.toThrow('本地智能体运行超时。')
  })

  it('cancels a running prompt', async () => {
    const controller = new AbortController()
    const run = runStdioAcpAgent(agent, { prompt: 'SLOW', cwd: workspace(), timeoutMs: 10_000, signal: controller.signal })
    setTimeout(() => controller.abort(), 300)
    await expect(run).rejects.toThrow('本地智能体运行已取消。')
  })

  it('starts in the mode the agent entry names, and refuses to run when it cannot', async () => {
    const cwd = workspace()
    const asked = await runStdioAcpAgent({ ...agent, mode: 'default' }, { prompt: '写', cwd, timeoutMs: 10_000, requestPermission: async () => 'reject' })
    expect(asked.output).toContain('好的，我来写文件（default）。')
    const untouched = await runStdioAcpAgent(agent, { prompt: '写', cwd, timeoutMs: 10_000, requestPermission: async () => 'reject' })
    expect(untouched.output).toContain('（auto）')
    await expect(runStdioAcpAgent({ ...agent, mode: 'nope' }, { prompt: '写', cwd, timeoutMs: 10_000 })).rejects.toThrow('没能让本地智能体进入「nope」模式，所以没有开始执行')
  })

  it('says how to log in when the agent is not logged in', async () => {
    await expect(runStdioAcpAgent({ ...agent, env: { MOCK_ACP_AUTH: '1' } }, { prompt: 'x', cwd: workspace(), timeoutMs: 10_000 }))
      .rejects.toThrow('本机智能体不能用你的账号：可能还没有登录，或者账号/订阅暂时不能用。在终端里直接用一次这个智能体就能看到具体原因（例如 Claude Code：运行 claude -p "hi"）。登录方式：Log in with Claude Code：Run `claude /login` in the terminal。')
  })

  it('fails the run, and nothing else, when the agent leaves while a long prompt is being written to it', async () => {
    // Answers the handshake, then quits as soon as a prompt starts to arrive: the rest of a prompt
    // longer than the pipe holds can no longer be written (EPIPE). Unhandled, that ended the daemon.
    const leavesMidPrompt = {
      command: process.execPath,
      args: ['-e', `let buffer = ''
        const reply = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\\n')
        process.stdin.on('data', chunk => {
          buffer += chunk
          if (buffer.includes('"session/prompt"')) process.exit(0)
          let end
          while ((end = buffer.indexOf('\\n')) >= 0) {
            const message = JSON.parse(buffer.slice(0, end))
            buffer = buffer.slice(end + 1)
            if (message.method === 'initialize') reply(message.id, { protocolVersion: 1, agentCapabilities: {} })
            else if (message.method === 'session/new') reply(message.id, { sessionId: 's1' })
          }
        })`],
    }

    await expect(runStdioAcpAgent(leavesMidPrompt, { prompt: '很长的群聊上下文。'.repeat(40_000), cwd: workspace(), timeoutMs: 10_000 })).rejects.toThrow(/本地智能体/)
  })

  it('opens a remote agent\'s session in its own folder, and does not offer to read or write files for it', async () => {
    const cwd = workspace()
    const local = await runStdioAcpAgent(agent, { prompt: 'WHERE', cwd, timeoutMs: 10_000 })
    expect(local.output).toBe(`工作目录：${cwd}；可读：true；可写：true`)
    const remote = await runStdioAcpAgent(agent, { prompt: 'WHERE', cwd, agentCwd: '/home/purge/workspace/demo', timeoutMs: 10_000 })
    expect(remote.output).toBe('工作目录：/home/purge/workspace/demo；可读：false；可写：false')
    // An agent that asks anyway is refused, and nothing is written here.
    const asked = await runStdioAcpAgent(agent, { prompt: '写', cwd, agentCwd: cwd, timeoutMs: 10_000, requestPermission: async () => 'allow' })
    expect(asked.output).toContain('写入失败：OpenTeam 不替远程智能体读写文件')
    expect(existsSync(join(cwd, 'hello.txt'))).toBe(false)
  })

  it('explains an agent that cannot start', async () => {
    await expect(runStdioAcpAgent({ command: '/nonexistent/agent' }, { prompt: 'x', cwd: workspace(), timeoutMs: 5_000 })).rejects.toThrow('无法启动本地智能体')
  })

  it('keeps paths inside the folder, links included', async () => {
    const cwd = workspace()
    await expect(pathInside(cwd, join(cwd, 'a/b.txt'))).resolves.toBe(join(cwd, 'a/b.txt'))
    await expect(pathInside(cwd, 'relative.txt')).rejects.toThrow('绝对路径')
    await expect(pathInside(cwd, join(cwd, '../x.txt'))).rejects.toThrow('工作目录以外')
    const { symlinkSync } = await import('node:fs')
    symlinkSync(tmpdir(), join(cwd, 'out'))
    await expect(pathInside(cwd, join(cwd, 'out/x.txt'))).rejects.toThrow('工作目录以外')
  })
})
