import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import {
  LAUNCH_AGENT_LABEL,
  buildLaunchAgentPlist,
  chooseNodePath,
  createLaunchAgent,
  daemonEnvironment,
  describeLaunchAgent,
  launchAgentPlistPath,
  parseLaunchctlPrint,
  programArgumentsOf,
} from './launch-agent.mjs'

// Nothing here touches the real ~/Library/LaunchAgents, launchd or the daemon on port 19305: the
// files, launchctl and the daemon are a pretend Mac's.
const HOME = '/Users/someone'
const PLIST = `${HOME}/Library/LaunchAgents/${LAUNCH_AGENT_LABEL}.plist`
const SERVICE = `gui/501/${LAUNCH_AGENT_LABEL}`
const NODE = '/opt/homebrew/bin/node'
const SCRIPT = '/opt/homebrew/lib/node_modules/@afumu/openteamcli/openteam-daemon.mjs'
const ENVIRONMENT = { PATH: '/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin' }
const OK = { code: 0, stdout: '', stderr: '' }

function expectedPlist(overrides = {}) {
  return buildLaunchAgentPlist({
    programArguments: [overrides.node ?? NODE, overrides.script ?? SCRIPT, '--port=19305'],
    environment: ENVIRONMENT,
    workingDirectory: HOME,
  })
}

// A pretend Mac: files in memory, a launchd that runs the daemon of the loaded service (unless the
// port is taken), and a daemon on the port that `daemon start` may have started.
function fakeMac(options = {}) {
  const mac = {
    files: new Map(Object.entries(options.files ?? {})),
    existing: new Set(options.existing ?? [NODE, SCRIPT]),
    loaded: options.loaded ?? false,
    launchdPid: undefined,
    lastExitCode: options.lastExitCode,
    portDaemon: options.portDaemon,
    disabled: options.disabled ?? false,
    bootstrapFailures: options.bootstrapFailures ?? 0,
    calls: [],
    nextPid: 9000,
  }
  if (mac.portDaemon?.launchd) mac.launchdPid = mac.portDaemon.pid
  const launchdStarts = () => {
    if (options.daemonNeverAnswers || mac.portDaemon) return
    mac.nextPid += 1
    mac.launchdPid = mac.nextPid
    mac.portDaemon = { pid: mac.launchdPid, launchd: true }
  }
  const printOutput = () => [
    `${SERVICE} = {`,
    '\tactive count = 1',
    `\tpath = ${PLIST}`,
    '\ttype = LaunchAgent',
    `\tstate = ${mac.launchdPid ? 'running' : 'not running'}`,
    '',
    `\tprogram = ${NODE}`,
    '\tendpoints = {',
    '\t\tstate = active',
    '\t}',
    '\truns = 1',
    ...(mac.launchdPid ? [`\tpid = ${mac.launchdPid}`] : []),
    `\tlast exit code = ${mac.lastExitCode ?? '(never exited)'}`,
    '}',
    '',
  ].join('\n')
  const launchctl = args => {
    mac.calls.push(`launchctl ${args.join(' ')}`)
    switch (args[0]) {
      case 'print':
        return mac.loaded
          ? { code: 0, stdout: printOutput(), stderr: '' }
          : { code: 113, stdout: '', stderr: `Bad request.\nCould not find service "${LAUNCH_AGENT_LABEL}" in domain for user gui: 501\n` }
      case 'bootout':
        if (!mac.loaded) return { code: 3, stdout: '', stderr: 'Boot-out failed: 3: No such process\n' }
        mac.loaded = false
        if (mac.portDaemon?.launchd) mac.portDaemon = undefined
        mac.launchdPid = undefined
        return OK
      case 'bootstrap':
        if (mac.bootstrapFailures > 0) {
          mac.bootstrapFailures -= 1
          return { code: 5, stdout: '', stderr: 'Bootstrap failed: 5: Input/output error\n' }
        }
        mac.loaded = true
        if (!mac.disabled) launchdStarts()
        return OK
      case 'print-disabled':
        return { code: 0, stdout: `disabled services = {\n\t"com.apple.example" => enabled\n${mac.disabled ? `\t"${LAUNCH_AGENT_LABEL}" => disabled\n` : ''}}\n`, stderr: '' }
      case 'enable':
        mac.disabled = false
        return OK
      case 'kickstart':
        if (!mac.loaded) return { code: 113, stdout: '', stderr: 'Could not find service\n' }
        if (mac.portDaemon?.launchd) mac.portDaemon = undefined
        mac.launchdPid = undefined
        launchdStarts()
        return OK
      default:
        throw new Error(`unexpected launchctl ${args.join(' ')}`)
    }
  }
  const agent = createLaunchAgent({
    platform: options.platform ?? 'darwin',
    uid: options.uid ?? 501,
    home: HOME,
    port: 19305,
    nodePath: NODE,
    daemonScript: options.daemonScript ?? SCRIPT,
    environment: ENVIRONMENT,
    fs: {
      read: path => mac.files.get(path),
      exists: path => mac.files.has(path) || mac.existing.has(path),
      mkdir: path => { mac.calls.push(`mkdir ${path}`) },
      write: (path, text) => {
        mac.calls.push(`write ${path}`)
        mac.files.set(path, text)
      },
      remove: path => {
        mac.calls.push(`remove ${path}`)
        mac.files.delete(path)
      },
    },
    launchctl,
    daemon: {
      status: async () => mac.portDaemon ? { ok: true, pid: mac.portDaemon.pid } : undefined,
      // `daemon stop`: the daemon ends with exit code 0.
      shutdown: async () => {
        mac.calls.push('daemon shutdown')
        if (options.shutdownFails) throw new Error('权限不足')
        if (mac.portDaemon?.launchd) {
          mac.launchdPid = undefined
          mac.lastExitCode = 0
        }
        mac.portDaemon = undefined
      },
    },
    kill: (pid, signal) => {
      mac.calls.push(`kill ${pid} ${signal}`)
      if (options.killWorks && mac.portDaemon?.pid === pid) mac.portDaemon = undefined
    },
    sleep: async () => undefined,
    stopTimeoutMs: 300,
    startTimeoutMs: 300,
    pollMs: 100,
  })
  return { mac, agent }
}

const changes = calls => calls.filter(call => !/^launchctl (print|print-disabled) /.test(call))

describe('the LaunchAgent plist', () => {
  it('runs this Node on the daemon with the port, at login, and again only after a failure', () => {
    const plist = buildLaunchAgentPlist({
      programArguments: ['/opt/homebrew/bin/node', '/Users/someone/R&D <tools>/openteam-daemon.mjs', '--port=19305'],
      environment: { PATH: '/opt/homebrew/bin:/usr/bin:/bin', OPENTEAM_EXTENSION_ORIGINS: 'chrome-extension://abc' },
      workingDirectory: HOME,
    })

    expect(launchAgentPlistPath(HOME)).toBe(PLIST)
    expect(programArgumentsOf(plist)).toEqual(['/opt/homebrew/bin/node', '/Users/someone/R&D <tools>/openteam-daemon.mjs', '--port=19305'])
    expect(plist).toContain('<string>/Users/someone/R&amp;D &lt;tools&gt;/openteam-daemon.mjs</string>')
    if (process.platform !== 'darwin') return
    // As launchd reads it (plutil converts what it is given on stdin; nothing is written).
    const converted = spawnSync('plutil', ['-convert', 'json', '-o', '-', '-'], { input: plist, encoding: 'utf8' })
    expect(converted.status, converted.stderr).toBe(0)
    expect(JSON.parse(converted.stdout)).toEqual({
      Label: LAUNCH_AGENT_LABEL,
      ProgramArguments: ['/opt/homebrew/bin/node', '/Users/someone/R&D <tools>/openteam-daemon.mjs', '--port=19305'],
      EnvironmentVariables: { PATH: '/opt/homebrew/bin:/usr/bin:/bin', OPENTEAM_EXTENSION_ORIGINS: 'chrome-extension://abc' },
      WorkingDirectory: HOME,
      RunAtLoad: true,
      KeepAlive: { SuccessfulExit: false },
    })
  })

  it('runs Node by the path on PATH that leads to it, which outlives an upgrade', () => {
    const programs = {
      '/opt/homebrew/bin/node': '/opt/homebrew/Cellar/node/23.7.0/bin/node',
      '/opt/homebrew/Cellar/node/23.7.0/bin/node': '/opt/homebrew/Cellar/node/23.7.0/bin/node',
      '/Users/someone/.nvm/versions/node/v22.11.0/bin/node': '/Users/someone/.nvm/versions/node/v22.11.0/bin/node',
      '/Users/someone/.volta/bin/node': '/Users/someone/.volta/bin/volta-shim',
    }
    const lookups = {
      realpath: path => {
        if (!programs[path]) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
        return programs[path]
      },
      isExecutable: path => Boolean(programs[path]),
    }

    // Homebrew: its bin folder rather than the Cellar folder of 23.7.0.
    expect(chooseNodePath('/opt/homebrew/Cellar/node/23.7.0/bin/node', '.:/Users/someone/.volta/bin:/opt/homebrew/bin:/usr/bin', lookups)).toBe('/opt/homebrew/bin/node')
    // nvm: the version's own folder is the only way to it.
    expect(chooseNodePath('/Users/someone/.nvm/versions/node/v22.11.0/bin/node', '/Users/someone/.nvm/versions/node/v22.11.0/bin:/opt/homebrew/bin', lookups)).toBe('/Users/someone/.nvm/versions/node/v22.11.0/bin/node')
    // No node on PATH leads to it (a shim, another version): the program itself.
    expect(chooseNodePath('/opt/homebrew/Cellar/node/23.7.0/bin/node', '/Users/someone/.volta/bin:/usr/bin', lookups)).toBe('/opt/homebrew/Cellar/node/23.7.0/bin/node')
    expect(chooseNodePath('/opt/homebrew/Cellar/node/23.7.0/bin/node', undefined, lookups)).toBe('/opt/homebrew/Cellar/node/23.7.0/bin/node')
  })

  it('gives the daemon the PATH it was installed with, and none of the other variables', () => {
    expect(daemonEnvironment({
      PATH: '.:/Users/someone/.npm-global/bin:/usr/bin:/usr/bin',
      ANTHROPIC_API_KEY: 'sk-ant-secret',
      OPENTEAM_EXTENSION_ORIGINS: ' chrome-extension://abc ',
    }, '/opt/homebrew/bin/node')).toEqual({
      PATH: '/opt/homebrew/bin:/Users/someone/.npm-global/bin:/usr/bin:/bin:/usr/sbin:/sbin',
      OPENTEAM_EXTENSION_ORIGINS: 'chrome-extension://abc',
    })
    expect(daemonEnvironment({}, '/opt/homebrew/bin/node')).toEqual({ PATH: '/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin' })
  })

  it('reads the state, pid and last exit code from launchctl print, not from the sections inside it', () => {
    expect(parseLaunchctlPrint([
      `${SERVICE} = {`,
      '\tactive count = 1',
      '\tendpoints = {',
      '\t\tstate = active',
      '\t}',
      '\tstate = running',
      '\tpid = 724',
      '\tlast exit code = (never exited)',
      '}',
    ].join('\n'))).toEqual({ state: 'running', pid: 724 })
    expect(parseLaunchctlPrint(`${SERVICE} = {\n\tstate = not running\n\tlast exit code = 78: Function not implemented\n}\n`)).toEqual({ state: 'not running', lastExitCode: 78 })
    expect(parseLaunchctlPrint('')).toEqual({})
  })
})

describe('daemon install', () => {
  it('writes the plist and has launchd load it, which starts the daemon', async () => {
    const { mac, agent } = fakeMac()

    const result = await agent.install()

    expect(result).toEqual({
      ok: true,
      installed: true,
      changed: true,
      label: LAUNCH_AGENT_LABEL,
      plistPath: PLIST,
      programArguments: [NODE, SCRIPT, '--port=19305'],
      running: true,
      pid: 9001,
    })
    expect(mac.files.get(PLIST)).toBe(expectedPlist())
    expect(changes(mac.calls)).toEqual([
      `mkdir ${HOME}/Library/LaunchAgents`,
      `write ${PLIST}`,
      `launchctl bootstrap gui/501 ${PLIST}`,
    ])
  })

  it('stops a daemon already on the port first, so the two do not compete for it', async () => {
    const { mac, agent } = fakeMac({ portDaemon: { pid: 777 } })

    const result = await agent.install()

    expect(result).toMatchObject({ running: true, stoppedPid: 777, pid: 9001 })
    expect(changes(mac.calls)).toEqual([
      'daemon shutdown',
      `mkdir ${HOME}/Library/LaunchAgents`,
      `write ${PLIST}`,
      `launchctl bootstrap gui/501 ${PLIST}`,
    ])
  })

  it('ends that daemon by its pid when it does not stop when asked', async () => {
    const { mac, agent } = fakeMac({ portDaemon: { pid: 777 }, shutdownFails: true, killWorks: true })

    await expect(agent.install()).resolves.toMatchObject({ running: true, stoppedPid: 777 })
    expect(changes(mac.calls).slice(0, 2)).toEqual(['daemon shutdown', 'kill 777 SIGTERM'])
  })

  it('changes nothing when that daemon cannot be stopped', async () => {
    const { mac, agent } = fakeMac({ portDaemon: { pid: 777 }, shutdownFails: true })

    await expect(agent.install()).rejects.toThrow('端口 19305 上已有一个守护进程（pid 777）停不下来')
    expect(mac.files.size).toBe(0)
    expect(changes(mac.calls)).toEqual(['daemon shutdown', 'kill 777 SIGTERM'])
  })

  it('does nothing the second time: the same file, loaded, its daemon running', async () => {
    const { mac, agent } = fakeMac()
    await agent.install()
    mac.calls.length = 0

    const again = await agent.install()

    expect(again).toEqual({ ok: true, installed: true, changed: false, label: LAUNCH_AGENT_LABEL, plistPath: PLIST, pid: 9001 })
    expect(changes(mac.calls)).toEqual([])
  })

  it('replaces an older install: unloads it, which stops its daemon, then loads the new file', async () => {
    const { mac, agent } = fakeMac({
      files: { [PLIST]: expectedPlist({ node: '/opt/homebrew/Cellar/node/22.1.0/bin/node' }) },
      loaded: true,
      portDaemon: { pid: 500, launchd: true },
    })

    const result = await agent.install()

    expect(result).toMatchObject({ changed: true, running: true, pid: 9001 })
    expect(result.stoppedPid).toBeUndefined()
    expect(mac.files.get(PLIST)).toBe(expectedPlist())
    expect(changes(mac.calls)).toEqual([
      `launchctl bootout ${SERVICE}`,
      `mkdir ${HOME}/Library/LaunchAgents`,
      `write ${PLIST}`,
      `launchctl bootstrap gui/501 ${PLIST}`,
    ])
  })

  it('starts the daemon again when it was installed but stopped with daemon stop', async () => {
    const { mac, agent } = fakeMac({ files: { [PLIST]: expectedPlist() }, loaded: true, lastExitCode: 0 })

    await expect(agent.install()).resolves.toMatchObject({ changed: true, running: true })
    expect(changes(mac.calls)).toContain(`launchctl bootstrap gui/501 ${PLIST}`)
  })

  it('turns the service back on when it was disabled with launchctl disable', async () => {
    const { mac, agent } = fakeMac({ disabled: true })

    await expect(agent.install()).resolves.toMatchObject({ running: true })
    expect(changes(mac.calls)).toEqual([
      `mkdir ${HOME}/Library/LaunchAgents`,
      `write ${PLIST}`,
      `launchctl enable ${SERVICE}`,
      `launchctl bootstrap gui/501 ${PLIST}`,
    ])
  })

  it('tries the bootstrap again while launchd lets go of the old service, then says why it failed', async () => {
    const once = fakeMac({ bootstrapFailures: 1 })
    await expect(once.agent.install()).resolves.toMatchObject({ running: true })
    expect(changes(once.mac.calls).filter(call => call.includes('bootstrap'))).toHaveLength(2)

    const always = fakeMac({ bootstrapFailures: 10 })
    await expect(always.agent.install()).rejects.toThrow(`launchctl bootstrap 没有成功（退出码 5）：Bootstrap failed: 5: Input/output error。文件已写在 ${PLIST}`)
    expect(changes(always.mac.calls).filter(call => call.includes('bootstrap'))).toHaveLength(3)
  })

  it('says so when launchd loaded it but the daemon does not answer', async () => {
    const { agent } = fakeMac({ daemonNeverAnswers: true })

    const result = await agent.install()

    expect(result).toMatchObject({ ok: true, installed: true, running: false })
    expect(result.hint).toContain('~/.openteam/daemon.log')
  })

  it('warns when the command runs from the npx cache, which npm clears', async () => {
    const script = `${HOME}/.npm/_npx/0a1b2c/node_modules/@afumu/openteamcli/openteam-daemon.mjs`
    const { agent } = fakeMac({ daemonScript: script, existing: [NODE, script] })

    await expect(agent.install()).resolves.toMatchObject({ warning: expect.stringContaining('npm install -g @afumu/openteamcli') })
  })

  it('refuses on other systems and under sudo, touching nothing', async () => {
    for (const [platform, uid, message] of [['linux', 1000, '只支持 macOS'], ['win32', undefined, '只支持 macOS'], ['darwin', 0, 'sudo']]) {
      const { mac, agent } = fakeMac({ platform, uid })
      await expect(agent.install()).rejects.toThrow(message)
      await expect(agent.uninstall()).rejects.toThrow(message)
      expect(mac.calls).toEqual([])
      expect(mac.files.size).toBe(0)
    }
  })
})

describe('daemon uninstall', () => {
  it('unloads the service, which stops its daemon, and removes the file', async () => {
    const { mac, agent } = fakeMac({ files: { [PLIST]: expectedPlist() }, loaded: true, portDaemon: { pid: 500, launchd: true } })

    const result = await agent.uninstall()

    expect(result).toEqual({ ok: true, installed: false, removed: true, label: LAUNCH_AGENT_LABEL, plistPath: PLIST, stoppedPid: 500 })
    expect(mac.files.has(PLIST)).toBe(false)
    expect(mac.portDaemon).toBeUndefined()
    expect(changes(mac.calls)).toEqual([`launchctl bootout ${SERVICE}`, `remove ${PLIST}`])
  })

  it('removes a file launchd has not loaded, and is fine with nothing installed', async () => {
    const notLoaded = fakeMac({ files: { [PLIST]: expectedPlist() } })
    await expect(notLoaded.agent.uninstall()).resolves.toMatchObject({ removed: true })
    expect(changes(notLoaded.mac.calls)).toEqual([`remove ${PLIST}`])

    const nothing = fakeMac()
    await expect(nothing.agent.uninstall()).resolves.toEqual({ ok: true, installed: false, removed: false, label: LAUNCH_AGENT_LABEL, plistPath: PLIST })
    expect(changes(nothing.mac.calls)).toEqual([])
  })
})

describe('the LaunchAgent in daemon status and doctor', () => {
  it('is not offered on other systems', () => {
    const { mac, agent } = fakeMac({ platform: 'linux' })
    expect(describeLaunchAgent(agent.status(), 123)).toEqual({ supported: false, installed: false })
    expect(mac.calls).toEqual([])
  })

  it('suggests installing it when it is not installed', () => {
    const { agent } = fakeMac({ portDaemon: { pid: 777 } })
    expect(describeLaunchAgent(agent.status(), 777)).toEqual({
      supported: true,
      installed: false,
      loaded: false,
      label: LAUNCH_AGENT_LABEL,
      plistPath: PLIST,
      hint: expect.stringContaining('openteamcli daemon install'),
    })
  })

  it('shows the daemon launchd runs, and whether it is the one on the port', async () => {
    const { mac, agent } = fakeMac()
    await agent.install()

    expect(describeLaunchAgent(agent.status(), 9001)).toEqual({
      supported: true,
      installed: true,
      loaded: true,
      state: 'running',
      pid: 9001,
      label: LAUNCH_AGENT_LABEL,
      plistPath: PLIST,
      managed: true,
    })
    // Stopped with `daemon stop`: launchd leaves it stopped until `daemon start` or the next login.
    mac.portDaemon = undefined
    mac.launchdPid = undefined
    mac.lastExitCode = 0
    expect(describeLaunchAgent(agent.status())).toMatchObject({ state: 'not running', lastExitCode: 0, hint: expect.stringContaining('openteamcli daemon start') })
    mac.lastExitCode = 1
    expect(describeLaunchAgent(agent.status()).hint).toContain('上次退出码 1')
  })

  it('says when the daemon on the port is not the one launchd runs', () => {
    const { agent } = fakeMac({ files: { [PLIST]: expectedPlist() }, loaded: true, portDaemon: { pid: 777 } })
    expect(describeLaunchAgent(agent.status(), 777)).toMatchObject({ loaded: true, managed: false, hint: expect.stringContaining('openteamcli daemon restart') })
  })

  it('says when the Node or the daemon it runs is gone, or it is not loaded yet', () => {
    const gone = fakeMac({ files: { [PLIST]: expectedPlist({ node: '/opt/homebrew/Cellar/node/22.1.0/bin/node' }) }, loaded: true })
    expect(describeLaunchAgent(gone.agent.status())).toMatchObject({
      missing: ['/opt/homebrew/Cellar/node/22.1.0/bin/node'],
      hint: expect.stringContaining('请重新运行 openteamcli daemon install'),
    })

    const notLoaded = fakeMac({ files: { [PLIST]: expectedPlist() } })
    expect(describeLaunchAgent(notLoaded.agent.status())).toMatchObject({ installed: true, loaded: false, hint: expect.stringContaining('下次登录时生效') })
  })
})

describe('daemon start with the LaunchAgent installed', () => {
  it('starts the daemon through launchd, so it is the one that comes back after a crash', async () => {
    const { mac, agent } = fakeMac({ files: { [PLIST]: expectedPlist() }, loaded: true, lastExitCode: 0 })

    expect(agent.kickstart()).toBe(true)
    expect(changes(mac.calls)).toEqual([`launchctl kickstart -k ${SERVICE}`])
    expect(mac.portDaemon).toEqual({ pid: 9001, launchd: true })
  })

  it('leaves the start to the caller when it is not loaded, or not on a Mac', () => {
    const notLoaded = fakeMac()
    expect(notLoaded.agent.kickstart()).toBe(false)
    expect(changes(notLoaded.mac.calls)).toEqual([])

    const linux = fakeMac({ platform: 'linux' })
    expect(linux.agent.kickstart()).toBe(false)
    expect(linux.mac.calls).toEqual([])
  })
})
