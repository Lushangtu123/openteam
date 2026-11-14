// The daemon as a macOS LaunchAgent: launchd starts it when the user logs in (RunAtLoad) and again
// when it ends with a failure (KeepAlive SuccessfulExit false: a crash exits 1). `daemon stop`
// and the signals the system sends at log out end it with 0, which launchd leaves alone until the
// next login or `daemon start`. What it touches (files, launchctl, the daemon on the port) is
// passed in, so tests run none of it for real.
import { spawnSync } from 'node:child_process'
import { accessSync, chmodSync, constants, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { delimiter, dirname, join } from 'node:path'

export const LAUNCH_AGENT_LABEL = 'io.github.afumu.openteam.daemon'
const LAUNCHCTL = '/bin/launchctl'
const SYSTEM_PATH = ['/usr/bin', '/bin', '/usr/sbin', '/sbin']
const DAEMON_LOG = '~/.openteam/daemon.log'

export function launchAgentPlistPath(home) {
  return join(home, 'Library', 'LaunchAgents', `${LAUNCH_AGENT_LABEL}.plist`)
}

// The Node to run the daemon with: this one, by its path on PATH when that leads to the same
// program (Homebrew's /opt/homebrew/bin/node rather than the Cellar folder of one version, which
// the next `brew upgrade` removes).
export function chooseNodePath(execPath, pathEnv = '', { realpath = realpathSync, isExecutable = isExecutableFile } = {}) {
  let target
  try {
    target = realpath(execPath)
  } catch {
    return execPath
  }
  for (const folder of String(pathEnv).split(delimiter).filter(item => item.startsWith('/'))) {
    const candidate = join(folder, 'node')
    try {
      if (isExecutable(candidate) && realpath(candidate) === target) return candidate
    } catch {
      // Not this one.
    }
  }
  return execPath
}

// The daemon's environment under launchd, which gives it only the system folders on PATH. Local
// agents start with `npx`, a Node script, so it gets the PATH `daemon install` ran with, Node's
// folder in it. Nothing else from the shell is carried over (API keys among it): an agent that
// needs a variable gets it from `agent add --env`.
export function daemonEnvironment(env, nodePath) {
  const folders = String(env.PATH ?? '').split(delimiter).filter(item => item.startsWith('/'))
  const nodeFolder = dirname(nodePath)
  if (!folders.includes(nodeFolder)) folders.unshift(nodeFolder)
  for (const folder of SYSTEM_PATH) if (!folders.includes(folder)) folders.push(folder)
  const unique = [...new Set(folders)]
  return {
    PATH: unique.join(':'),
    ...(env.OPENTEAM_EXTENSION_ORIGINS?.trim() ? { OPENTEAM_EXTENSION_ORIGINS: env.OPENTEAM_EXTENSION_ORIGINS.trim() } : {}),
  }
}

export function buildLaunchAgentPlist({ label = LAUNCH_AGENT_LABEL, programArguments, environment, workingDirectory }) {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    '\t<key>Label</key>',
    `\t<string>${xml(label)}</string>`,
    '\t<key>ProgramArguments</key>',
    '\t<array>',
    ...programArguments.map(item => `\t\t<string>${xml(item)}</string>`),
    '\t</array>',
    '\t<key>EnvironmentVariables</key>',
    '\t<dict>',
    ...Object.entries(environment).flatMap(([key, value]) => [`\t\t<key>${xml(key)}</key>`, `\t\t<string>${xml(value)}</string>`]),
    '\t</dict>',
    '\t<key>WorkingDirectory</key>',
    `\t<string>${xml(workingDirectory)}</string>`,
    '\t<key>RunAtLoad</key>',
    '\t<true/>',
    '\t<key>KeepAlive</key>',
    '\t<dict>',
    '\t\t<key>SuccessfulExit</key>',
    '\t\t<false/>',
    '\t</dict>',
    '</dict>',
    '</plist>',
    '',
  ].join('\n')
}

// The program and its arguments in a plist this module wrote.
export function programArgumentsOf(plist) {
  const array = /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(plist)?.[1]
  if (!array) return []
  return [...array.matchAll(/<string>([^<]*)<\/string>/g)].map(match => unxml(match[1]))
}

// The parts of `launchctl print gui/<uid>/<label>` used here: its own lines are indented by one tab
// (those of the sections inside it by more). Its format is not a promise, so what is not found is
// left out rather than guessed.
export function parseLaunchctlPrint(text) {
  const fields = {}
  for (const line of String(text).split('\n')) {
    const match = /^\t([a-z][a-z ]*?) = (.*)$/.exec(line)
    if (match && !(match[1] in fields)) fields[match[1]] = match[2].trim()
  }
  const pid = Number(fields.pid)
  const lastExit = /^-?\d+/.exec(fields['last exit code'] ?? '')
  return {
    ...(fields.state ? { state: fields.state } : {}),
    ...(Number.isInteger(pid) && pid > 0 ? { pid } : {}),
    ...(lastExit ? { lastExitCode: Number(lastExit[0]) } : {}),
  }
}

// What `daemon status` and `doctor` show about the LaunchAgent, with the daemon answering on the
// port (its pid, when one answers): whether it is the one launchd runs, and what to do next.
export function describeLaunchAgent(agent, daemonPid) {
  const managed = agent.loaded && daemonPid ? agent.pid === daemonPid : undefined
  const hint = launchAgentHint(agent, daemonPid, managed)
  return {
    ...agent,
    ...(managed === undefined ? {} : { managed }),
    ...(hint ? { hint } : {}),
  }
}

function launchAgentHint(agent, daemonPid, managed) {
  if (!agent.supported) return undefined
  if (!agent.installed) return '运行 openteamcli daemon install，让守护进程在登录时自动启动、崩溃后自动重启。'
  if (agent.missing) return `LaunchAgent 要运行的文件已经不在了：${agent.missing.join('、')}。请重新运行 openteamcli daemon install。`
  if (!agent.loaded) return 'LaunchAgent 已安装但还没加载：下次登录时生效；现在就加载请运行 openteamcli daemon install。'
  if (managed === false) return '端口上的守护进程不是 LaunchAgent 启动的，崩溃后不会自动重启；运行 openteamcli daemon restart 换成 LaunchAgent 启动的。'
  if (!daemonPid && agent.state !== 'running') {
    return agent.lastExitCode
      ? `守护进程没在运行，上次退出码 ${agent.lastExitCode}（原因见 ${DAEMON_LOG}）；launchd 会再启动它，也可以运行 openteamcli daemon start。`
      : '守护进程没在运行（用 daemon stop 停下的会一直停着，直到下次登录）；运行 openteamcli daemon start 启动它。'
  }
  return undefined
}

export function createLaunchAgent(deps) {
  const {
    platform,
    uid,
    home,
    port,
    nodePath,
    daemonScript,
    environment,
    fs,
    launchctl,
    daemon,
    kill,
    sleep,
    stopTimeoutMs = 5_000,
    startTimeoutMs = 5_000,
    pollMs = 100,
  } = deps
  const label = deps.label ?? LAUNCH_AGENT_LABEL
  const plistPath = launchAgentPlistPath(home)
  const domain = `gui/${uid}`
  const service = `${domain}/${label}`

  function requireSupported() {
    if (platform !== 'darwin') {
      throw new Error(`登录时自动启动只支持 macOS（LaunchAgent），这台电脑是 ${platform}。请在登录后运行 openteamcli daemon start。`)
    }
    if (uid === 0) throw new Error('请不要用 sudo 运行：LaunchAgent 要装在你自己的账户里。')
  }

  function loadedService() {
    const result = launchctl(['print', service])
    if (result.code !== 0) return { loaded: false }
    return { loaded: true, ...parseLaunchctlPrint(result.stdout) }
  }

  function plist() {
    return buildLaunchAgentPlist({
      label,
      programArguments: [nodePath, daemonScript, `--port=${port}`],
      environment,
      workingDirectory: home,
    })
  }

  async function poll(check, timeoutMs) {
    for (let waited = 0; ; waited += pollMs) {
      const value = await check()
      if (value) return value
      if (waited >= timeoutMs) return undefined
      await sleep(pollMs)
    }
  }

  function launchctlError(action, result, extra = '') {
    const output = `${result.stderr ?? ''}\n${result.stdout ?? ''}`.trim()
    return new Error(`launchctl ${action} 没有成功（退出码 ${result.code}）${output ? `：${output}` : ''}${extra}`)
  }

  async function bootout() {
    const result = launchctl(['bootout', service])
    if (result.code !== 0 && loadedService().loaded) throw launchctlError('bootout', result)
    if (!(await poll(() => !loadedService().loaded, stopTimeoutMs))) throw new Error(`launchd 没有卸下 ${label}，请稍后再试。`)
  }

  // A daemon `daemon start` ran (or one from before): two cannot share the port, and the one
  // launchd starts would keep failing to listen.
  async function stopDaemonOnPort() {
    const running = await daemon.status()
    if (!running) return undefined
    const stopped = () => poll(async () => !(await daemon.status()), stopTimeoutMs)
    try {
      await daemon.shutdown()
    } catch {
      // Ended by its pid below.
    }
    if (await stopped()) return { pid: running.pid }
    if (running.pid) {
      try {
        kill(running.pid, 'SIGTERM')
      } catch {
        // Already gone, or not ours to end.
      }
      if (await stopped()) return { pid: running.pid }
    }
    throw new Error(`端口 ${port} 上已有一个守护进程（pid ${running.pid ?? '未知'}）停不下来；请先结束它，再运行 openteamcli daemon install。`)
  }

  // A service the user turned off with `launchctl disable` would be loaded but never started.
  function enableIfDisabled() {
    const result = launchctl(['print-disabled', domain])
    if (result.code !== 0) return
    if (new RegExp(`"${label.replace(/[.]/g, '\\.')}" => (disabled|true)`).test(result.stdout)) launchctl(['enable', service])
  }

  async function bootstrap() {
    let result = launchctl(['bootstrap', domain, plistPath])
    // Right after a bootout launchd can still be letting go of the old one ("5: Input/output error").
    for (let attempt = 0; result.code !== 0 && attempt < 2; attempt += 1) {
      await sleep(500)
      result = launchctl(['bootstrap', domain, plistPath])
    }
    if (result.code !== 0) {
      throw launchctlError('bootstrap', result, `。文件已写在 ${plistPath}，下次登录时会加载；如果在“系统设置 › 通用 › 登录项”里关掉了 node 的后台运行，请打开后再运行 openteamcli daemon install。`)
    }
  }

  return {
    label,
    plistPath,

    status() {
      if (platform !== 'darwin') return { supported: false, installed: false }
      const file = fs.read(plistPath)
      const current = loadedService()
      const missing = file === undefined ? [] : programArgumentsOf(file).slice(0, 2).filter(path => !fs.exists(path))
      return {
        supported: true,
        installed: file !== undefined,
        ...current,
        label,
        plistPath,
        ...(missing.length ? { missing } : {}),
      }
    },

    async install() {
      requireSupported()
      const content = plist()
      const before = loadedService()
      const running = await daemon.status()
      // Already as it should be: the same file, loaded, and its daemon the one on the port.
      if (fs.read(plistPath) === content && before.loaded && running && before.pid === running.pid) {
        return { ok: true, installed: true, changed: false, label, plistPath, pid: running.pid }
      }
      if (before.loaded) await bootout()
      const stopped = await stopDaemonOnPort()
      fs.mkdir(dirname(plistPath))
      fs.write(plistPath, content)
      enableIfDisabled()
      await bootstrap()
      const started = await poll(() => daemon.status(), startTimeoutMs)
      return {
        ok: true,
        installed: true,
        changed: true,
        label,
        plistPath,
        programArguments: programArgumentsOf(content),
        ...(stopped ? { stoppedPid: stopped.pid } : {}),
        running: Boolean(started),
        ...(started?.pid ? { pid: started.pid } : {}),
        ...(started ? {} : { hint: `LaunchAgent 已加载，但守护进程 ${Math.round(startTimeoutMs / 1000)} 秒内没有响应；运行 openteamcli daemon status 查看，原因见 ${DAEMON_LOG}。` }),
        // npx runs the command from its cache, which npm clears: the LaunchAgent would then run nothing.
        ...(/\/_npx\//.test(daemonScript) ? { warning: 'openteamcli 是用 npx 临时运行的，npm 清理缓存后 LaunchAgent 就找不到它了。建议先 npm install -g @afumu/openteamcli，再运行 openteamcli daemon install。' } : {}),
      }
    },

    async uninstall() {
      requireSupported()
      const before = loadedService()
      const hadFile = fs.exists(plistPath)
      if (before.loaded) await bootout()
      if (hadFile) fs.remove(plistPath)
      return {
        ok: true,
        installed: false,
        removed: hadFile || before.loaded,
        label,
        plistPath,
        ...(before.pid ? { stoppedPid: before.pid } : {}),
      }
    },

    // Starts the daemon through launchd when the LaunchAgent is loaded, so that it stays the one
    // launchd brings back after a crash; `-k` ends one that is still on its way out first. False
    // when it is not loaded (start it directly then).
    kickstart() {
      if (platform !== 'darwin' || !uid) return false
      if (!loadedService().loaded) return false
      return launchctl(['kickstart', '-k', service]).code === 0
    },
  }
}

export function runLaunchctl(args) {
  const result = spawnSync(LAUNCHCTL, args, { encoding: 'utf8' })
  return {
    code: result.status ?? -1,
    stdout: result.stdout ?? '',
    stderr: result.stderr || (result.error ? result.error.message : ''),
  }
}

export const nodeFileSystem = {
  read(path) {
    try {
      return readFileSync(path, 'utf8')
    } catch (error) {
      if (error?.code === 'ENOENT') return undefined
      throw error
    }
  },
  exists: path => existsSync(path),
  mkdir: path => mkdirSync(path, { recursive: true }),
  // launchd refuses a plist others can write to.
  write(path, text) {
    writeFileSync(path, text, { mode: 0o644 })
    chmodSync(path, 0o644)
  },
  remove: path => rmSync(path, { force: true }),
}

function isExecutableFile(path) {
  try {
    accessSync(path, constants.X_OK)
    return statSync(path).isFile()
  } catch {
    return false
  }
}

function xml(value) {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;')
}

function unxml(value) {
  return value.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&')
}
