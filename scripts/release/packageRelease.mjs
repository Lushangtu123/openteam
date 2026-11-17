// Packs a release into release/: the built extension as a ZIP, the CLI as an npm tarball, their
// SHA-256 sums and the release notes. CI runs it on a version tag (.github/workflows/release.yml);
// it runs the same way locally after `npm run build`, without --tag.
//
//   npm run package [-- --tag v1.1.0]
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(fileURLToPath(new URL('../..', import.meta.url)))

// The CLI tarball is also attached under a name with no version in it: GitHub serves the latest
// release's files at /releases/latest/download/<name>, so one install command always works.
export const CLI_FIXED_NAME = 'openteamcli.tgz'
export const CLI_LATEST_URL = `https://github.com/Lushangtu123/openteam/releases/latest/download/${CLI_FIXED_NAME}`

// What stands in the way of a release: each version that differs from package.json's.
export function releaseVersionProblems({ tag, packageVersion, manifestVersion, builtVersion }) {
  const problems = []
  if (manifestVersion !== packageVersion) {
    problems.push(`public/manifest.json has version ${manifestVersion}, package.json has ${packageVersion}`)
  }
  if (builtVersion === undefined) {
    problems.push('dist/manifest.json is missing: run npm run build first')
  } else if (builtVersion !== manifestVersion) {
    problems.push(`dist/ was built from version ${builtVersion}, not ${manifestVersion}: run npm run build again`)
  }
  if (tag !== undefined && tag !== `v${packageVersion}`) {
    problems.push(`the tag ${tag} does not match the version: it should be v${packageVersion}`)
  }
  return problems
}

export function releaseNotes({ version, extensionZip, cliPackage }) {
  return `## Files

- \`${extensionZip}\`: the Chrome extension
- \`${cliPackage}\`: the optional local CLI and daemon (for local agent members and agent control)
- \`${CLI_FIXED_NAME}\`: the same CLI under a name that does not change, for the one-line install below
- \`SHA256SUMS.txt\`: checksums of both

## Install

1. Download \`${extensionZip}\` and unzip it into a folder you will keep (Chrome loads the extension from that folder).
2. Open \`chrome://extensions\`, turn on **Developer mode**, click **Load unpacked** and choose the folder.
3. Sign in to the AI websites you want to use in normal tabs, then click the OpenTeam icon.

OpenTeam says in its settings when a new version is out. To update, empty that folder, unzip the new version into it and click the reload button on OpenTeam in \`chrome://extensions\`. Your chats are kept in the browser, so an update keeps them; removing OpenTeam from Chrome deletes them (make a backup in settings first).

Optional CLI (Node.js 18 or later): \`npm install -g ${CLI_LATEST_URL}\`, then \`openteamcli daemon start\`.

## 安装

1. 下载 \`${extensionZip}\`，解压到一个会长期保留的文件夹（Chrome 从这个文件夹加载扩展）。
2. 打开 \`chrome://extensions\`，开启「开发者模式」，点击「加载已解压的扩展程序」，选择该文件夹。
3. 先在普通标签页登录要用的 AI 网站，再点击 OpenTeam 图标。

有新版本时，OpenTeam 会在设置里提示。更新时，清空这个文件夹，把新版本解压进去，再在 \`chrome://extensions\` 里点 OpenTeam 的重新加载按钮。群聊数据保存在浏览器里，更新不会丢失；但在 Chrome 里移除 OpenTeam 会删除它们（移除前先在设置里备份）。

可选 CLI（需要 Node.js 18 或更高版本）：\`npm install -g ${CLI_LATEST_URL}\`，然后运行 \`openteamcli daemon start\`。

OpenTeam ${version} is based on [afumu/openteam](https://github.com/afumu/openteam) and released under the PolyForm Noncommercial License 1.0.0.
`
}

function readVersion(path) {
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')).version : undefined
}

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function main() {
  const args = process.argv.slice(2)
  const tagIndex = args.indexOf('--tag')
  const tag = tagIndex >= 0 ? args[tagIndex + 1] : undefined
  const packageVersion = readVersion(join(root, 'package.json'))
  const problems = releaseVersionProblems({
    tag,
    packageVersion,
    manifestVersion: readVersion(join(root, 'public/manifest.json')),
    builtVersion: readVersion(join(root, 'dist/manifest.json')),
  })
  if (problems.length > 0) {
    console.error(problems.map(problem => `- ${problem}`).join('\n'))
    process.exit(1)
  }

  const out = join(root, 'release')
  rmSync(out, { recursive: true, force: true })
  mkdirSync(out)

  // Chrome writes _metadata/ into a folder it has loaded; it is not part of the extension.
  const extensionZip = `openteam-extension-v${packageVersion}.zip`
  execFileSync('zip', ['-q', '-r', '-X', join(out, extensionZip), '.', '-x', '_metadata/*', '-x', '*.DS_Store'], { cwd: join(root, 'dist'), stdio: 'inherit' })
  execFileSync('npm', ['pack', '--silent', '--pack-destination', out], { cwd: join(root, 'packages/openteamcli'), stdio: ['ignore', 'ignore', 'inherit'] })
  const cliPackage = readdirSync(out).find(name => name.endsWith('.tgz'))
  if (!cliPackage) throw new Error('npm pack wrote no tarball')
  copyFileSync(join(out, cliPackage), join(out, CLI_FIXED_NAME))

  writeFileSync(join(out, 'SHA256SUMS.txt'), [extensionZip, cliPackage, CLI_FIXED_NAME].map(name => `${sha256(join(out, name))}  ${name}`).join('\n') + '\n')
  writeFileSync(join(out, 'RELEASE_NOTES.md'), releaseNotes({ version: packageVersion, extensionZip, cliPackage }))
  console.log(`release/ holds ${extensionZip}, ${cliPackage}, ${CLI_FIXED_NAME}, SHA256SUMS.txt and RELEASE_NOTES.md`)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
