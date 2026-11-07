// Takes the same set of OpenTeam screenshots every time, so two builds can be compared pixel for
// pixel (scripts/visual/compare.mjs) after a change that should not move anything on screen, such as
// a stylesheet cleanup. Both styles, both themes, 21 screens, and three window widths: 108 images.
// Animations, clocks and the caret are frozen; members answer from a local mock API.
//
//   npm run build
//   npm run visual:snap -- test-artifacts/visual/before
//   (make the change, build again)
//   npm run visual:snap -- test-artifacts/visual/after
//   npm run visual:compare -- test-artifacts/visual/before test-artifacts/visual/after
//
// Needs Chrome for Testing (npx playwright install chromium), or OPENTEAM_CHROME set to a Chrome binary.
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, existsSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { homedir, tmpdir } from 'node:os'
import { createServer } from 'node:http'
import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createControlDaemon } from '../../packages/openteamcli/openteam-daemon.mjs'

const out = resolve(process.argv[2] ?? 'test-artifacts/visual/current')
const dist = resolve(process.env.OPENTEAM_DIST ?? 'dist')
if (!existsSync(join(dist, 'manifest.json'))) throw new Error(`No built extension in ${dist}: run npm run build first.`)
mkdirSync(out, { recursive: true })
const CHROME = process.env.OPENTEAM_CHROME ?? findChromeForTesting()
const MOCK_PORT = 51987

function findChromeForTesting() {
  const cache = process.platform === 'darwin' ? join(homedir(), 'Library/Caches/ms-playwright') : join(homedir(), '.cache/ms-playwright')
  const builds = existsSync(cache) ? readdirSync(cache).filter(name => name.startsWith('chromium-')).sort().reverse() : []
  for (const build of builds) {
    for (const candidate of [
      'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
      'chrome-mac/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
      'chrome-linux/chrome',
      'chrome-linux64/chrome',
    ]) {
      const path = join(cache, build, candidate)
      if (existsSync(path)) return path
    }
  }
  throw new Error('Chrome for Testing not found: run npx playwright install chromium, or set OPENTEAM_CHROME.')
}
const TEAM_URL = 'chrome-extension://cnccbifloajlkjglmiojkpimjciamlpe/team.html'
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const REPLIES = {
  架构师: '## 要点\n- 选 Go：单个二进制，部署最省事\n- 并发和启动速度都好\n\n团队熟悉 Python 的话可以先做原型；长期维护上 Go 更省事。',
  产品经理: '## 要点\n- 先上线比选型重要\n- 选团队最熟的语言\n\n先用两周做出最常用的三个命令，再决定要不要重写。',
  测试工程师: '## 要点\n- 两种都能测\n- 要有命令行回归用例\n\n给每个子命令写快照测试，CI 里跑一遍。',
}
let claims = 0
const server = createServer((req, res) => {
  let body = ''
  req.on('data', chunk => { body += chunk })
  req.on('end', () => {
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Headers', '*')
    if (req.method === 'OPTIONS') { res.end(); return }
    let parsed = {}
    try { parsed = JSON.parse(body) } catch {}
    const all = JSON.stringify(parsed.messages ?? [])
    if (all.includes('你是故障成员。')) {
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: { message: 'upstream overloaded' } }))
      return
    }
    const name = all.match(/你是(架构师|产品经理|测试工程师)。/)?.[1] ?? '架构师'
    let text = REPLIES[name]
    // A coordinator asked for a plan gets two tasks; a team-up invitation gets a position.
    if (all.includes('dependsOn')) {
      text = '```json\n' + JSON.stringify({ tasks: [
        { id: 't1', title: '列出最常用的命令', owner: '产品经理', dependsOn: [], detail: '从现有脚本里找出用得最多的三个命令。', doneWhen: '有一份带用法的命令清单' },
        { id: 't2', title: '为命令写回归测试', owner: '测试工程师', dependsOn: ['t1'], detail: '每个命令一个快照测试。', doneWhen: 'CI 里测试全部通过' },
      ] }) + '\n```'
    } else if (all.includes('我们要组队完成这件事')) {
      const positions = ['后端工程师', '产品经理', '测试工程师']
      text = '```json\n' + JSON.stringify({ first_choice: positions[claims++ % positions.length], second_choice: '技术写作', responsibility: '负责这一块的设计和实现', needed_positions: ['后端工程师', '测试工程师'] }) + '\n```'
    }
    if (parsed.stream) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`)
      res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`)
      res.write('data: [DONE]\n\n')
      res.end()
    } else {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: text } }] }))
    }
  })
})
await new Promise(done => server.listen(MOCK_PORT, '127.0.0.1', done))
const MOCK = `http://127.0.0.1:${MOCK_PORT}/v1`
const FREEZE = `*, *::before, *::after { animation: none !important; transition: none !important; caret-color: transparent !important; }
.message-time-divider, .chat-time, .message-usage, .message-search-meta > span:last-child { visibility: hidden !important; }
.orchestration-person-avatar { background: #8a8a8a !important; }
.message-body[data-pending-since] { display: none !important; }`

console.log(`Screenshots of ${dist} into ${out}`)
const profile = mkdtempSync(join(tmpdir(), 'ot-snap-'))
const chrome = spawn(CHROME, ['--headless=new', '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=0', `--user-data-dir=${profile}`, `--disable-extensions-except=${dist}`, `--load-extension=${dist}`, '--lang=zh-CN', '--hide-scrollbars', '--force-device-scale-factor=1', '--font-render-hinting=none'], { stdio: 'ignore' })
try {
  const portFile = join(profile, 'DevToolsActivePort')
  for (let i = 0; i < 100 && !existsSync(portFile); i += 1) await sleep(100)
  const [port, path] = readFileSync(portFile, 'utf8').trim().split('\n')
  const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`)
  await new Promise(resolve => ws.addEventListener('open', resolve, { once: true }))
  let nextId = 0
  const pending = new Map()
  // Errors the page reports while the screens are opened: listed at the end and in errors.txt.
  const pageErrors = []
  const backgroundSessions = new Set()
  ws.addEventListener('message', event => {
    const m = JSON.parse(String(event.data))
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return }
    const where = backgroundSessions.has(m.sessionId) ? 'background' : 'page'
    if (m.method === 'Runtime.exceptionThrown') pageErrors.push(`${where} exception: ${(m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text).split('\n')[0]}`)
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') pageErrors.push(`${where} console: ${m.params.args.map(arg => arg.value ?? arg.description ?? '').join(' ').slice(0, 200)}`)
    if (m.method === 'Target.attachedToTarget') {
      if (m.params.targetInfo.type === 'service_worker') {
        backgroundSessions.add(m.params.sessionId)
        void send('Runtime.enable', {}, m.params.sessionId)
      }
      void send('Runtime.runIfWaitingForDebugger', {}, m.params.sessionId)
    }
  })
  const send = (method, params = {}, sessionId) => new Promise(resolve => { nextId += 1; pending.set(nextId, resolve); ws.send(JSON.stringify({ id: nextId, method, params, ...(sessionId ? { sessionId } : {}) })) })
  const { result: { targetId } } = await send('Target.createTarget', { url: 'about:blank' })
  const { result: { sessionId } } = await send('Target.attachToTarget', { targetId, flatten: true })
  await send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }, sessionId)
  // The extension's service worker: attached now, and again whenever Chrome restarts it.
  await send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true })
  const { result: { targetInfos } } = await send('Target.getTargets')
  for (const info of targetInfos.filter(target => target.type === 'service_worker')) {
    const { result: attached } = await send('Target.attachToTarget', { targetId: info.targetId, flatten: true })
    backgroundSessions.add(attached.sessionId)
    await send('Runtime.enable', {}, attached.sessionId)
  }
  await send('Runtime.enable', {}, sessionId)
  const evaluate = async expression => {
    const { result } = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId)
    return result.exceptionDetails ? `EXCEPTION ${result.exceptionDetails.exception?.description}` : result.result.value
  }
  const size = (width, height) => send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false }, sessionId)
  const freeze = () => evaluate(`(() => { let s = document.getElementById('snap-freeze'); if (!s) { s = document.createElement('style'); s.id = 'snap-freeze'; document.head.append(s) } s.textContent = ${JSON.stringify(FREEZE)}; return 'ok' })()`)
  const shot = async name => {
    await freeze()
    await sleep(350)
    const { result } = await send('Page.captureScreenshot', { format: 'png' }, sessionId)
    writeFileSync(join(out, `${name}.png`), Buffer.from(result.data, 'base64'))
  }
  const click = sel => evaluate(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return 'missing'; el.click(); return 'ok' })()`)
  const closeAll = () => evaluate(`(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); document.querySelectorAll('.modal-close').forEach(b => b.offsetParent && b.click()); document.body.click(); return 'ok' })()`)
  const theme = async (name, style) => {
    await evaluate(`(() => { localStorage.setItem('openteam.theme', '${name}'); localStorage.setItem('openteam.uiStyle', '${style}'); location.reload() })()`)
    await sleep(2200)
  }

  await size(1440, 900)
  await send('Page.navigate', { url: TEAM_URL }, sessionId)
  await sleep(2500)
  await evaluate(`new Promise(r => chrome.runtime.sendMessage({ type: 'GROUP_SETTINGS_UPDATE', language: 'zh-CN' }, r)).then(() => location.reload())`)
  await sleep(2200)
  const looks = [['light', 'chatgpt'], ['dark', 'chatgpt'], ['light', 'grok'], ['dark', 'grok']]
  for (const [name, style] of looks) { await theme(name, style); await shot(`00-empty-${name}-${style}`) }

  await evaluate(`(async () => {
    const send = m => new Promise(r => chrome.runtime.sendMessage(m, r))
    const model = await send({ type: 'EXTERNAL_MODEL_CREATE', name: 'DeepSeek', format: 'openai', baseUrl: '${MOCK}', apiKey: 'test-key', modelName: 'mock' })
    const chat = await send({ type: 'GROUP_CHAT_CREATE', name: '命令行工具选型', mode: 'collaborative' })
    await send({ type: 'GROUP_ROLES_CREATE_BATCH', chatId: chat.chat.id, items: ['架构师', '产品经理', '测试工程师'].map(name => ({ source: 'temporary', name, systemPrompt: '你是' + name + '。', modelSource: 'external', externalModelId: model.model.id })) })
    return 'ok'
  })()`)
  await sleep(1500)
  await evaluate(`(() => { const input = document.querySelector('#message-input'); input.value = '@所有人 内部命令行工具用 Python 还是 Go？'; input.dispatchEvent(new Event('input', { bubbles: true })); document.querySelector('#send-message').click() })()`)
  for (let i = 0; i < 40; i += 1) {
    await sleep(500)
    const done = await evaluate(`new Promise(r => chrome.runtime.sendMessage({ type: 'GROUP_STORE_GET' }, r)).then(r => { const c = r.store.chatsById[r.store.currentChatId]; return c.messageIds.map(id => r.store.messagesById[id]).filter(m => m.type === 'assistant' && m.status !== 'pending').length })`)
    if (done >= 4) break
  }
  await sleep(1500)
  const mainChatId = await evaluate(`new Promise(r => chrome.runtime.sendMessage({ type: 'GROUP_STORE_GET' }, r)).then(r => r.store.currentChatId)`)
  const store = expression => evaluate(`new Promise(r => chrome.runtime.sendMessage({ type: 'GROUP_STORE_GET' }, r)).then(r => (${expression})(r.store))`)
  const waitFor = async (expression, ms) => { for (let waited = 0; waited < ms; waited += 500) { if (await store(expression)) return true; await sleep(500) } return false }
  const runtime = message => `new Promise(r => chrome.runtime.sendMessage(${message}, r))`
  const newGroup = async (name, members, modelId = 'model.model.id') => evaluate(`(async () => {
    const send = m => new Promise(r => chrome.runtime.sendMessage(m, r))
    const store = (await send({ type: 'GROUP_STORE_GET' })).store
    const model = { model: Object.values(store.settings.externalModelsById).find(m => m.format === 'openai') }
    const chat = await send({ type: 'GROUP_CHAT_CREATE', name: ${JSON.stringify(name)}, mode: 'collaborative' })
    await send({ type: 'GROUP_ROLES_CREATE_BATCH', chatId: chat.chat.id, items: ${JSON.stringify(members)}.map(name => ({ source: 'temporary', name, systemPrompt: '你是' + name + '。', modelSource: 'external', externalModelId: ${modelId} })) })
    return chat.chat.id
  })()`)
  const say = text => evaluate(`(() => { const input = document.querySelector('#message-input'); input.value = ${JSON.stringify(text)}; input.dispatchEvent(new Event('input', { bubbles: true })); document.querySelector('#send-message').click(); return 'sent' })()`)
  const extraChats = {}

  // A reply that failed: the member's API answers 500 until OpenTeam gives up (about 30 seconds).
  extraChats.error = await newGroup('出错的回复', ['故障成员'])
  await sleep(1200)
  await say('@所有人 试一下')
  await waitFor(`s => Object.values(s.messagesById).some(m => m.chatId === '${extraChats.error}' && m.type === 'assistant' && m.status === 'error')`, 70000)

  // A turn-by-turn discussion that has finished, with its bar.
  extraChats.discussion = await newGroup('轮流讨论', ['架构师', '产品经理'])
  await evaluate(runtime(`{ type: 'GROUP_CHAT_UPDATE', chatId: ${JSON.stringify(extraChats.discussion)}, discussionMode: true }`))
  await sleep(1200)
  await say('@架构师 @产品经理 内部命令行工具用 Python 还是 Go？')
  await waitFor(`s => s.chatsById['${extraChats.discussion}'].discussion && s.chatsById['${extraChats.discussion}'].discussion.status !== 'running'`, 60000)

  // A project whose plan waits for approval, on the board.
  extraChats.project = await newGroup('项目', ['架构师', '产品经理', '测试工程师'])
  await sleep(1200)
  await evaluate(runtime(`{ type: 'GROUP_PROJECT_START', chatId: ${JSON.stringify(extraChats.project)}, goal: '把内部命令行工具做成可发布的第一版' }`))
  await waitFor(`s => { const p = s.chatsById['${extraChats.project}'].project; return p && p.tasks && p.tasks.length > 0 }`, 60000)

  // A team-up whose members have chosen their positions.
  extraChats.team = await evaluate(`(async () => {
    const send = m => new Promise(r => chrome.runtime.sendMessage(m, r))
    const store = (await send({ type: 'GROUP_STORE_GET' })).store
    const model = Object.values(store.settings.externalModelsById).find(m => m.format === 'openai')
    await send({ type: 'GROUP_TEAM_CREATE', task: '把内部命令行工具做成可发布的第一版', members: [{ modelSource: 'external', externalModelId: model.id }, { modelSource: 'external', externalModelId: model.id }, { modelSource: 'external', externalModelId: model.id }], requiredPositions: [] })
    return (await send({ type: 'GROUP_STORE_GET' })).store.currentChatId
  })()`)
  await evaluate('location.reload()')
  await sleep(1800)
  await click('.team-formation-banner button')
  await sleep(500)
  await evaluate(`(() => { const b = [...document.querySelectorAll('.team-card-footer button')].find(b => b.textContent === '邀请它们自荐'); b?.click(); return 'ok' })()`)
  await waitFor(`s => { const f = s.chatsById['${extraChats.team}'].teamFormation; return f && f.invitationIds.length >= 2 }`, 60000)
  await sleep(4000)

  // A local agent waiting for the user to allow its run: its own daemon on another port, with the
  // test agent, so nothing reaches a daemon the user runs.
  // A fixed name, since it shows in the approval card.
  const agentFolder = join(realpathSync(tmpdir()), 'openteam-visual-agent')
  rmSync(agentFolder, { recursive: true, force: true })
  mkdirSync(agentFolder)
  const daemon = await createControlDaemon({
    port: 19418, token: 'snap', logToConsole: false,
    acpAgents: [{ id: 'mock', name: '测试智能体', type: 'stdio', command: process.execPath, args: [fileURLToPath(new URL('../../packages/openteamcli/test-fixtures/mock-acp-agent.mjs', import.meta.url))], cwdAllowlist: [agentFolder] }],
  })
  await evaluate(runtime(`{ type: 'GROUP_SETTINGS_UPDATE', agentControlEnabled: true, agentControlPort: 19418 }`))
  for (let i = 0; i < 40 && !daemon.status().extensionConnected; i += 1) await sleep(250)
  extraChats.approval = await evaluate(`(async () => {
    const send = m => new Promise(r => chrome.runtime.sendMessage(m, r))
    const created = await send({ type: 'EXTERNAL_MODEL_CREATE', name: 'Claude Code', format: 'local-agent', localAgentId: 'mock', workspace: ${JSON.stringify(agentFolder)} })
    const chat = await send({ type: 'GROUP_CHAT_CREATE', name: '本机智能体', mode: 'collaborative' })
    await send({ type: 'GROUP_ROLES_CREATE_BATCH', chatId: chat.chat.id, items: [{ source: 'temporary', name: '程序员', systemPrompt: '你是程序员。', modelSource: 'external', externalModelId: created.model.id }] })
    return chat.chat.id
  })()`)
  await sleep(1200)
  await say('@所有人 在当前目录新建 hello.md')
  await waitFor(`s => Object.values(s.rolesById).some(r => r.chatId === '${extraChats.approval}' && r.pendingApproval)`, 20000)

  await evaluate(runtime(`{ type: 'GROUP_CHAT_SWITCH', chatId: ${JSON.stringify(mainChatId)} }`))
  await evaluate('location.reload()')
  await sleep(1800)

  const sendMouseAway = () => send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 1, y: 1 }, sessionId)
  const inGroup = (key, then) => async () => {
    await evaluate(runtime(`{ type: 'GROUP_CHAT_SWITCH', chatId: ${JSON.stringify('__ID__')} }`).replace('__ID__', extraChats[key]))
    await evaluate('location.reload()')
    await sleep(1600)
    await evaluate(`document.querySelector('#messages').scrollTo(0, 99999)`)
    if (then) await then()
  }
  const backToMain = async () => {
    await evaluate(runtime(`{ type: 'GROUP_CHAT_SWITCH', chatId: ${JSON.stringify(mainChatId)} }`))
  }

  const screens = [
    ['chat', async () => { await evaluate(`document.querySelector('#messages').scrollTo(0, 0)`) }],
    ['chat-bottom', async () => { await evaluate(`document.querySelector('#messages').scrollTo(0, 99999)`) }],
    ['workflow-menu', async () => { await click('#open-workflow-menu') }],
    ['more-menu', async () => { await click('#open-more-menu') }],
    ['members', async () => { await click('#toggle-people-drawer') }],
    ['member-menu', async () => { await click('#toggle-people-drawer'); await sleep(200); await click('.role-more-btn') }],
    ['new-chat', async () => { await click('#quick-create-chat') }],
    ['new-chat-blank', async () => { await click('#quick-create-chat'); await click('#open-blank-chat') }],
    ['settings', async () => { await click('#settings-button') }],
    ['settings-replies', async () => { await click('#settings-button'); await click('[data-settings-tab="replies"]') }],
    ['models', async () => { await click('#settings-button'); await click('[data-settings-tab="models"]'); await click('#open-external-models') }],
    ['people-library', async () => { await click('#open-people-library') }],
    ['role-editor', async () => { await click('#open-people-library'); await click('#new-template') }],
    ['add-members', async () => { await click('#toggle-people-drawer'); await sleep(200); await evaluate(`document.querySelector('#add-role-form').requestSubmit()`); await sleep(300); await click('[data-add-person-models]') }],
    ['compare', async () => { await click('.message-compare-btn') }],
    ['orchestration', async () => { await click('#open-workflow-menu'); await click('#open-orchestration') }],
    ['project', async () => { await click('#open-workflow-menu'); await click('#open-project') }],
    ['team-setup', async () => { await click('#quick-create-chat'); await click('#open-team-formation') }],
    ['templates', async () => { await click('#quick-create-chat'); await click('#open-group-template-create') }],
    ['notes', async () => { await click('#toggle-notes-panel') }],
    ['search', async () => { await click('#open-message-search'); await sleep(300); await evaluate(`(() => { const i = document.querySelector('.message-search-input, .message-search input'); if (i) { i.value = 'Go'; i.dispatchEvent(new Event('input', { bubbles: true })) } })()`) }],
    ['reply-hover', async () => {
      await evaluate(`document.querySelector('#messages').scrollTo(0, 0)`)
      const point = JSON.parse(await evaluate(`JSON.stringify((() => { const r = document.querySelector('.message-row.assistant').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + 30 } })())`))
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y }, sessionId)
    }],
    ['reply-error', inGroup('error')],
    ['discussion', inGroup('discussion')],
    ['project-board', inGroup('project')],
    ['team-card', inGroup('team', async () => { await click('.team-formation-banner button') })],
    ['approval', inGroup('approval')],
  ]
  for (const [name, style] of looks) {
    await theme(name, style)
    for (const [screen, open] of screens) {
      await open()
      await sleep(450)
      await shot(`${screen}-${name}-${style}`)
      await closeAll()
      await sendMouseAway()
      if (screen in { 'reply-error': 1, discussion: 1, 'project-board': 1, 'team-card': 1, approval: 1 }) await backToMain()
      await sleep(250)
      // Some windows keep state across reopenings; a reload starts each screen clean.
      await evaluate('location.reload()')
      await sleep(1600)
    }
    for (const [width, height] of [[960, 800], [720, 800], [390, 844]]) {
      await size(width, height)
      await sleep(400)
      await shot(`chat-${width}-${name}-${style}`)
      if (width <= 720) { await click('#open-chat-list'); await sleep(350); await shot(`chat-list-${width}-${name}-${style}`); await closeAll() }
    }
    await size(1440, 900)
  }
  await evaluate(runtime(`{ type: 'GROUP_SETTINGS_UPDATE', agentControlEnabled: false }`))
  await daemon.close?.()
  rmSync(agentFolder, { recursive: true, force: true })
  ws.close()
  console.log(`${readdirSync(out).filter(name => name.endsWith('.png')).length} screenshots`)
  // The member set up to fail ('出错的回复') is expected to log its failure.
  const expected = error => error.includes('upstream overloaded')
  const uniqueErrors = [...new Set(pageErrors)].filter(error => !expected(error))
  const expectedCount = new Set(pageErrors.filter(expected)).size
  writeFileSync(join(out, 'errors.txt'), uniqueErrors.join('\n') + (uniqueErrors.length ? '\n' : ''))
  console.log(`${uniqueErrors.length} distinct page and background errors${uniqueErrors.length ? ':\n  ' + uniqueErrors.join('\n  ') : ''} (plus ${expectedCount} expected from the failing member)`)
} finally {
  chrome.kill()
  server.close()
  await sleep(400)
  rmSync(profile, { recursive: true, force: true })
}
