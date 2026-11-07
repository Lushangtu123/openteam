import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { CHAT_SITES } from '../group/chatSites'
import { TEAM_STYLESHEETS } from './teamStylesheets'

function readTeamHtml(): string {
  return readFileSync(resolve(process.cwd(), 'public/team.html'), 'utf8')
}

function readTeamCss(): string {
  return TEAM_STYLESHEETS.map(name => readFileSync(resolve(process.cwd(), 'public/styles', name), 'utf8')).join('\n')
}

function readTeamDocument(): string {
  return `${readTeamHtml()}\n${readTeamCss()}`
}


describe('team.html chat creation UI', () => {
  it('starts unlocked without a local invite-code activation gate', () => {
    const html = readTeamDocument()

    expect(html).toContain('<body>')
    expect(html).toContain('<div id="app" class="app-shell">')
    expect(html).not.toContain('access-locked')
    expect(html).not.toContain('invite-gate')
    expect(html).not.toContain('invite-code')
    expect(html).not.toMatch(/\binvite[-\w]*/i)
  })

  it('loads team styles from an external stylesheet', () => {
    const html = readTeamHtml()
    const css = readTeamCss()

    // The styles load in layers, each file overriding the ones before it.
    for (const name of TEAM_STYLESHEETS) expect(html).toContain(`<link rel="stylesheet" href="styles/${name}" />`)
    expect(html.indexOf('styles/base.css')).toBeLessThan(html.indexOf('styles/refinements.css'))
    expect(html).not.toContain('<style>')
    expect(html).not.toContain('</style>')
    expect(css).toContain(':root')
    expect(css).toContain('body {')
  })

  it('keeps the two-option theme choice in the settings window, and both page theme style sets', () => {
    const html = readTeamDocument()

    // The header is for the open group; the theme is chosen in the settings window only.
    expect(html).not.toContain('id="theme-switch"')
    expect(html).toContain('id="settings-theme-light"')
    expect(html).toContain('id="settings-theme-dark"')
    expect(html).toContain('浅色')
    expect(html).toContain('深色')
    expect(html).toContain('data-theme="dark"')
    expect(html).toMatch(/:root\[data-theme="light"\]\s*{/)
    expect(html).toMatch(/:root\[data-theme="dark"\]\s*{/)
  })

  it('light theme restyles dense dark surfaces instead of leaving dark component islands', () => {
    const html = readTeamDocument()

    expect(html).toMatch(/:root\[data-theme="light"\][\s\S]*--orchestration-node-bg:/)
  })

  it('keeps light theme page and modal backgrounds pure white instead of blue-gray washes', () => {
    const html = readTeamDocument()

    const lightTokens = html.match(/:root\[data-theme="light"\]\s*{(?<body>[^}]*)}/)?.groups?.body ?? ''

    expect(lightTokens).toContain('--bg: #ffffff;')
    expect(lightTokens).toContain('--page-bg: var(--bg);')
    expect(lightTokens).toContain('--shell-bg: #ffffff;')
    expect(lightTokens).toContain('--workspace-bg: #ffffff;')

    for (const selector of [
      '.all-notes-list',
      '#iframe-host',
      '.orchestration-workspace',
      '.orchestration-task-strip',
      '.orchestration-person',
      '.orchestration-template-card',
    ]) {
      expect(html).toMatch(new RegExp(`:root\\[data-theme="light"\\] ${selector.replace('.', '\\.')}\\s*{[^}]*background:\\s*#ffffff;`, 's'))
    }
  })

  it('offers an explicit chat mode choice before creating a chat from the plus button', () => {
    const html = readTeamDocument()
    const modeOptions = html.match(/<div class="mode-options">[\s\S]*?<\/div>\s*<\/div>\s*<div class="two-col">/)?.[0] ?? ''

    expect(html).toContain('id="chat-create-popover"')
    expect(html).toContain('id="new-chat-mode-independent"')
    expect(html).toContain('id="new-chat-mode-collaborative"')
    expect(html).toContain('协作群聊')
    expect(modeOptions.indexOf('new-chat-mode-collaborative')).toBeLessThan(modeOptions.indexOf('new-chat-mode-independent'))
    expect(modeOptions).toMatch(/id="new-chat-mode-collaborative"[^>]*checked/)
    expect(modeOptions).not.toMatch(/id="new-chat-mode-independent"[^>]*checked/)
  })

  it('starts a new group from three equal choices, the blank form opening from the last', () => {
    const html = readTeamDocument()
    const createForm = html.match(/<form id="create-chat-form"[\s\S]*?<\/form>/)?.[0] ?? ''
    const choices = createForm.match(/<div id="chat-create-choices"[\s\S]*?<div id="chat-create-blank"/)?.[0] ?? ''

    expect(['open-team-formation', 'open-group-template-create', 'open-blank-chat'].map(id => choices.indexOf(`id="${id}"`))).toEqual(expect.arrayContaining([expect.any(Number)]))
    expect(choices.indexOf('id="open-team-formation"')).toBeLessThan(choices.indexOf('id="open-group-template-create"'))
    expect(choices.indexOf('id="open-group-template-create"')).toBeLessThan(choices.indexOf('id="open-blank-chat"'))
    expect(createForm).toMatch(/<div id="chat-create-blank" class="chat-create-blank" hidden>[\s\S]*id="new-chat-name"[\s\S]*class="two-col"/)
    expect(html).toContain('id="group-template-modal"')
    expect(html).toContain('id="group-template-list"')
    expect(html).toContain('id="confirm-group-template-create"')
    expect(html).toContain('从模板创建')
    expect(html).toMatch(/\.group-template-option\s*{/s)
    expect(html).toMatch(/\.group-template-option\.active\s*{/s)
  })

  it('includes the people-library workflows, right drawer, iframe host, and minimized launcher', () => {
    const html = readTeamDocument()

    expect(html).toContain('id="settings-button"')
    expect(html).toContain('id="settings-menu"')
    expect(html).toContain('id="agent-control-toggle"')
    expect(html).toContain('本机智能体控制')
    expect(html).toContain('id="open-people-library"')
    expect(html).not.toContain('id="default-site-gemini"')
    expect(html).not.toContain('id="default-site-chatgpt"')
    expect(html).not.toContain('id="default-site-claude"')
    expect(html).not.toContain('id="default-site-deepseek"')
    for (const site of CHAT_SITES) expect(html).not.toContain(`id="default-site-${site}"`)
    expect(html).toContain('id="people-library-modal"')
    expect(html).toContain('id="people-library-list"')
    expect(html).toContain('id="people-library-search"')
    expect(html).toContain('id="people-library-category-filter"')
    expect(html).toContain('id="people-library-tab-builtin"')
    expect(html).toContain('id="people-library-tab-custom"')
    expect(html).toContain('id="builtin-template-detail-modal"')
    expect(html).toContain('id="builtin-template-detail-prompt"')
    expect(html).toContain('id="template-site-gemini"')
    expect(html).toContain('id="template-site-chatgpt"')
    expect(html).toContain('id="template-site-claude"')
    expect(html).toContain('id="template-site-deepseek"')
    expect(html).toContain('id="template-site-grok"')
    expect(html).toContain('id="template-site-qwen"')
    expect(html).not.toMatch(/id="template-site-gemini"[^>]*checked/)
    expect(html).toMatch(/id="template-site-deepseek"[^>]*checked/)
    // One radio per site in the registry.
    for (const site of CHAT_SITES) expect(html).toContain(`<input id="template-site-${site}" type="radio" name="template-chat-site" value="${site}"`)
    expect(html).toMatch(/\.site-segment\[hidden\]\s*{[^}]*display:\s*none;/s)
    expect(html).toContain('id="add-person-modal"')
    expect(html).toContain('id="add-person-category-filter"')
    expect(html).toContain('id="open-temporary-person"')
    expect(html).toContain('id="temporary-person-modal"')
    expect(html).toContain('id="add-library-people-form"')
    expect(html).toContain('id="add-temporary-person-form"')
    expect(html).toContain('id="toggle-people-drawer"')
    expect(html).toContain('class="panel role-panel"')
    expect(html).toContain('id="close-people-drawer"')
    expect(html).toContain('id="return-to-team"')
    expect(html).toContain('id="show-ai-pages"')
    expect(html).toContain('id="iframe-host"')
    expect(html).toContain('id="toggle-notes-panel"')
    expect(html).toContain('id="open-all-notes"')
    expect(html).toContain('id="all-notes-modal"')
    expect(html).toContain('id="all-notes-list"')
    expect(html).toContain('id="all-notes-editor"')
    expect(html).toContain('id="all-note-bold"')
    expect(html).toContain('id="notes-panel"')
    expect(html).toContain('id="notes-drag-handle"')
    expect(html).toContain('id="notes-editor"')
    expect(html).toContain('id="global-note-tab"')
    expect(html).toContain('id="chat-note-tab"')
    expect(html).toContain('id="template-chatgpt-gpts-field"')
    expect(html).toContain('id="template-chatgpt-gpts-url"')
    expect(html).toContain('id="template-grok-project-field"')
    expect(html).toContain('id="template-grok-project-url"')
    expect(html).toMatch(/\.field\[hidden\]\s*{[^}]*display:\s*none;/s)
    expect(html).toContain('角色库')
    expect(html).toContain('人设')
    expect(html).toContain('默认模型')
    expect(html).not.toContain('System Prompt')
  })

  it('opens notes as a draggable floating window instead of a right drawer', () => {
    const html = readTeamDocument()
    const notesPanelRule = html.match(/(?:^|\n)\.notes-panel\s*{(?<body>[^}]*)}/)?.groups?.body ?? ''
    const notesOpenRule = html.match(/(?:^|\n)\.notes-panel\.open\s*{(?<body>[^}]*)}/)?.groups?.body ?? ''

    expect(notesPanelRule).toContain('position: fixed;')
    expect(notesPanelRule).not.toContain('translateX(100%)')
    expect(notesOpenRule).toContain('pointer-events: auto;')
  })

  it('uses the left rail note icon for all notes instead of inactive placeholder icons', () => {
    const html = readTeamDocument()

    expect(html).toContain('aria-label="查看全部笔记"')
    expect(html).toContain('id="open-all-notes"')
    expect(html).toContain('data-tooltip="全部笔记"')
    expect(html).not.toContain('aria-label="消息"')
    expect(html).not.toContain('aria-label="实验"')
    expect(html).not.toContain('>✎</button>')
  })

  it('pins every modal close icon to the top-right corner of the whole dialog', () => {
    const html = readTeamDocument()
    const closeButtonIds = [
      'close-all-notes',
      'close-people-library',
      'close-external-models',
      'close-person-template',
      'close-builtin-template-detail',
      'close-add-person',
      'close-temporary-person',
      'close-orchestration',
    ]

    for (const id of closeButtonIds) {
      expect(html).toMatch(new RegExp(`<button id="${id}" class="icon-btn modal-close"`))
    }
    expect(html).toMatch(/\.modal-close\s*{[^}]*position:\s*absolute;[^}]*top:\s*14px;[^}]*right:\s*14px;/s)
  })

  it('adds an orchestration modal and chat-header entry before members without exposing stage wording', () => {
    const html = readTeamDocument()
    const chatRow = html.match(/<header class="chat-header">(?<body>[\s\S]*?)<\/header>/)?.groups?.body ?? ''
    const railActions = html.match(/<div class="rail-actions">(?<body>[\s\S]*?)<\/div>/)?.groups?.body ?? ''

    expect(html).toContain('id="open-orchestration"')
    expect(chatRow.indexOf('id="open-orchestration"')).toBeGreaterThanOrEqual(0)
    expect(chatRow.indexOf('id="open-orchestration"')).toBeLessThan(chatRow.indexOf('id="toggle-people-drawer"'))
    expect(railActions).not.toContain('id="open-orchestration"')
    expect(html).toContain('id="orchestration-modal"')
    expect(html).toContain('id="orchestration-task"')
    expect(html).toContain('id="auto-orchestration"')
    expect(html).toContain('id="orchestration-people-list"')
    expect(html).toContain('id="arrange-orchestration"')
    expect(html).toContain('id="orchestration-stage-canvas"')
    expect(html).toContain('id="orchestration-stage-settings"')
    expect(html).toContain('id="orchestration-review-settings"')
    expect(html).toContain('id="orchestration-max-rounds" type="number" min="1" max="200" value="50"')
    expect(html).toContain('画布节点按连线顺序执行')
    expect(html).toContain('拖到画布创建节点')
    expect(html).toContain('节点设置')
    expect(html).toContain('最大节点执行数')
    expect(html).toContain('执行节点和审核节点都会计数')
    expect(html).not.toContain('仅运行一轮')
    expect(html).not.toContain('添加为阶段')
    expect(html).not.toContain('阶段设置')
    expect(html).not.toContain('审核阶段')
    expect(html).toContain('不需要 @ 成员')
    expect(html).toContain('class="orchestration-task-strip"')
    expect(html).toContain('class="orchestration-task-input-row"')
    expect(html).toContain('class="orchestration-footer"')
    expect(html).toMatch(/\.orchestration-modal\s*{[^}]*height:\s*min\(760px,\s*calc\(100vh - 42px\)\);[^}]*grid-template-rows:\s*auto auto minmax\(0,\s*1fr\) auto;[^}]*overflow:\s*hidden;/s)
    expect(html).toMatch(/\.orchestration-layout\s*{[^}]*grid-template-columns:\s*220px minmax\(450px, 1fr\) 300px;[^}]*min-height:\s*0;[^}]*overflow:\s*hidden;/s)
    expect(html).toMatch(/\.orchestration-people-list\s*{[^}]*min-height:\s*0;[^}]*overflow:\s*auto;[^}]*flex:\s*1 1 auto;/s)
    expect(html).toMatch(/\.orchestration-arrange\s*{[^}]*position:\s*absolute;[^}]*top:\s*12px;[^}]*right:\s*12px;/s)
    expect(html).not.toContain('.x6-edge path:nth-child(2)')
    expect(html).toMatch(/\.orchestration-settings\s*{[^}]*overflow:\s*auto;/s)
    expect(html).toMatch(/\.orchestration-status-floating\s*{[^}]*position:\s*fixed;[^}]*box-sizing:\s*border-box;/s)
  })

  it('keeps the people library in the left rail and the models in the settings window', () => {
    const html = readTeamDocument()
    const railActions = html.match(/<div class="rail-actions">(?<body>[\s\S]*?)<\/div>/)?.groups?.body ?? ''
    const settingsMenu = html.match(/<div id="settings-menu"[\s\S]*?<div id="all-notes-modal"/)?.[0] ?? ''
    expect(settingsMenu).toContain('id="language-zh"')

    expect(railActions).toContain('id="open-people-library"')
    expect(railActions).toContain('aria-label="群聊"')
    expect(railActions).toContain('data-tooltip="群聊"')
    expect(railActions).toContain('aria-label="打开角色库"')
    expect(railActions).toContain('data-tooltip="角色库"')
    // Adding models is setup, not something to reach every day: it is a tab of the settings window.
    expect(railActions).not.toContain('id="open-external-models"')
    expect(settingsMenu).toMatch(/data-settings-panel="models"[\s\S]*id="open-external-models"/)
    expect(railActions).toContain('<svg aria-hidden="true"')
    expect(railActions).not.toContain('>⌁</button>')
    expect(railActions).not.toContain('>人</button>')
    expect(railActions).not.toContain('>模</button>')
    expect(settingsMenu).not.toContain('id="open-people-library"')
  })

  it('fills the whole tab, with the AI pages covered underneath it', () => {
    const html = readTeamHtml()
    const css = readTeamCss()
    const shellRule = css.match(/(?:^|\n)\.app-shell\s*{(?<body>[^}]*)}/)?.groups?.body ?? ''

    expect(shellRule).toContain('inset: 0;')
    expect(shellRule).not.toContain('border-radius')
    expect(shellRule).not.toContain('pointer-events: none')
    expect(css).toMatch(/\.app-shell\.pages-shown\s*{[^}]*display:\s*none;/s)
    expect(css).toMatch(/\.return-to-team\[hidden\]\s*{[^}]*display:\s*none;/s)
    expect(html).not.toContain('window-dot')
    expect(html).not.toContain('id="window-resize-handle"')
    expect(html).not.toContain('id="toggle-fullscreen"')
    expect(html).toMatch(/id="return-to-team"[^>]*hidden/)
    expect(css).not.toContain('.app-shell.fullscreen')
  })

  it('opens settings as their own window, with categories and a row per setting', () => {
    const html = readTeamHtml()
    const settings = html.match(/<div id="settings-menu"[\s\S]*?<div id="all-notes-modal"/)?.[0] ?? ''
    const rail = html.match(/<nav class="rail"[\s\S]*?<\/nav>/)?.[0] ?? ''

    expect(settings).toMatch(/<div id="settings-menu" class="modal-backdrop settings-backdrop" hidden>/)
    expect(settings).toContain('role="dialog"')
    expect(settings).toContain('id="close-settings"')
    for (const tab of ['general', 'replies', 'pages', 'agent', 'data']) {
      expect(settings).toContain(`data-settings-tab="${tab}"`)
      expect(settings).toContain(`data-settings-panel="${tab}"`)
    }
    for (const id of ['reply-key-points-toggle', 'round-summary-toggle', 'reply-notifications-toggle', 'agent-control-toggle']) {
      expect(settings).toMatch(new RegExp(`id="${id}" class="settings-switch"[^>]*role="switch"`))
    }
    expect(settings).toContain('id="show-ai-pages"')
    expect(settings).toContain('查看成员的 AI 网页')
    expect(settings).toContain('id="settings-theme-dark"')
    // The window is not squeezed into the left rail any more.
    expect(rail).not.toContain('id="settings-menu"')
    expect(rail).toContain('aria-haspopup="dialog"')
  })

  it('keeps the orchestration entry visually hidden when the hidden attribute is set', () => {
    const html = readTeamDocument()

    expect(html).toMatch(/#open-orchestration\[hidden\]\s*{[^}]*display:\s*none;/s)
  })

  it('uses template default sites for library people and the add-person picker for temporary people', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/teamPage/peopleLibraryView.ts'), 'utf8')

    expect(source).toContain("item.chatSites.map(chatSite =>")
    expect(source).toContain("if (item.source === 'library') return { source: 'library', roleTemplateId: item.roleTemplateId, ...modelPatch }")
    expect(source).toContain("source: 'temporary'")
    expect(source).toContain("return CHAT_SITES.find(site => deps.templateSiteEls[site].checked) ?? 'gemini'")
    expect(source).toContain('const VISIBLE_CHAT_SITES = CHAT_SITES')
  })

  it('stores a default target site on people-library entries instead of the settings menu', () => {
    const html = readTeamDocument()
    const source = readFileSync(resolve(process.cwd(), 'src/teamPage/peopleLibraryView.ts'), 'utf8')
    const domRefsSource = readFileSync(resolve(process.cwd(), 'src/teamPage/domRefs.ts'), 'utf8')

    expect(source).not.toContain("'#default-site-gemini'")
    expect(source).not.toContain("'#default-site-chatgpt'")
    expect(source).not.toContain("'#default-site-claude'")
    expect(source).not.toContain("'#default-site-deepseek'")
    for (const site of CHAT_SITES) expect(source).not.toContain(`'#default-site-${site}'`)
    expect(domRefsSource).toContain('templateSiteEls: Object.fromEntries(CHAT_SITES.map(site => [site, requireElement<HTMLInputElement>(`#template-site-${site}`)]))')
    expect(source).toContain('defaultChatSite: deps.templateSiteExternalEl.checked ? undefined : readTemplateChatSite()')
    expect(source).toContain('defaultExternalModelId: deps.templateSiteExternalEl.checked ? deps.templateExternalModelSelectEl.value : undefined')
    expect(source).toContain('template.defaultChatSite ?? store.settings.defaultChatSite')
    expect(source).toContain('chatGptGptsUrl: deps.templateSiteEls.chatgpt.checked ? deps.templateChatGptGptsUrlEl.value.trim() : undefined')
    expect(source).toContain('grokProjectUrl: deps.templateSiteEls.grok.checked ? deps.templateGrokProjectUrlEl.value.trim() : undefined')
    expect(html).not.toContain('默认站点：Gemini')
    expect(html).not.toContain('默认站点：ChatGPT')
    expect(html).not.toContain('默认站点：Claude')
    expect(html).not.toContain('默认站点：DeepSeek')
  })

  it('keeps the people-library modal as a list and opens a separate editor for creating or editing people', () => {
    const html = readTeamDocument()
    const source = readFileSync(resolve(process.cwd(), 'src/teamPage/peopleLibraryView.ts'), 'utf8')
    const domRefsSource = readFileSync(resolve(process.cwd(), 'src/teamPage/domRefs.ts'), 'utf8')
    const peopleLibraryModal = html.match(/<div id="people-library-modal"[\s\S]*?<div id="person-template-modal"/)?.[0] ?? ''
    const personTemplateModal = html.match(/<div id="person-template-modal"[\s\S]*?<div id="add-person-modal"/)?.[0] ?? ''

    expect(html).toContain('id="new-template"')
    expect(html).toContain('id="person-template-modal"')
    expect(html).toContain('id="close-person-template"')
    expect(personTemplateModal).toContain('id="template-name" type="text" maxlength="50"')
    expect(peopleLibraryModal).not.toContain('id="people-library-form"')
    expect(peopleLibraryModal).not.toContain('id="template-name"')
    expect(personTemplateModal).not.toContain('id="delete-template"')
    expect(source).toContain("edit.textContent = ui('编辑')")
    expect(source).toContain("remove.textContent = ui('删除')")
    expect(source).toContain('window.confirm(`确定删除「${template.name}」吗？删除后这个角色会从角色库移除。`)')
    expect(source).toContain('if (!isTemplateUsed(template.id)) actions.append(remove)')
    expect(domRefsSource).toContain("'#new-template'")
    expect(domRefsSource).toContain("'#close-person-template'")
  })

  it('keeps long people-library lists scrolling inside the left list pane', () => {
    const html = readTeamDocument()

    expect(html).toMatch(/#people-library-modal \.modal\s*{[^}]*overflow:\s*hidden;/s)
    expect(html).toMatch(/\.people-library-content\s*{[^}]*overflow:\s*hidden;/s)
    expect(html).toMatch(/#people-library-list\s*{[^}]*overflow:\s*auto;/s)
  })

  it('shows role sites as compact pills with a menu instead of always-visible switch buttons', () => {
    const html = readTeamDocument()
    const source = readFileSync(resolve(process.cwd(), 'src/teamPage/rolePanelView.ts'), 'utf8')

    expect(source).not.toContain('roleSiteBadge(role.chatSite)')
    expect(html).toMatch(/\.role-site-menu\s*{[^}]*position:\s*absolute;/s)
  })

  it('normalizes light theme site pills so model badges do not leak dark brand colors', () => {
    const html = readTeamDocument()

    for (const siteClass of ['gemini', 'chatgpt', 'claude', 'deepseek', 'grok', 'external']) {
      expect(html).toMatch(new RegExp(`:root\\[data-theme="light"\\] \\.site-pill-${siteClass}\\s*{[^}]*background:\\s*#f6f7f8;[^}]*color:\\s*#4b5563;`, 's'))
    }
  })

  it('does not keep a global add-person site picker', () => {
    const html = readTeamDocument()

    expect(html).not.toContain('name="add-person-chat-site"')
    expect(html).toMatch(/<form id="add-role-form" class="role-add-form">[\s\S]*?<button class="btn btn-primary btn-small" type="submit">[\s\S]*?<span>添加成员<\/span>/)
    expect(html).not.toContain('打开添加成员')
    expect(html).not.toContain('为这次加入群聊的人员统一指定 Gemini。')
    expect(html).not.toContain('为这次加入群聊的人员统一指定 ChatGPT。')
    expect(html).not.toContain('为这次加入群聊的人员统一指定 Claude。')
    expect(html).not.toContain('为这次加入群聊的人员统一指定千问。')
  })

  it('adds search and built-in/custom tabs to the add-person dialog', () => {
    const html = readTeamDocument()
    const source = readFileSync(resolve(process.cwd(), 'src/teamPage/peopleLibraryView.ts'), 'utf8')
    const domRefsSource = readFileSync(resolve(process.cwd(), 'src/teamPage/domRefs.ts'), 'utf8')

    expect(html).toContain('id="add-person-search"')
    expect(html).toContain('id="add-person-tab-builtin"')
    expect(html).toContain('id="add-person-tab-custom"')
    expect(html).toContain('搜索角色名称、描述或提示词')
    expect(source).toContain("deps.state.addPersonTemplateType === 'builtin'")
    expect(source).toContain('matchesAddPersonSearch')
    expect(domRefsSource).toContain("'#add-person-search'")
    expect(domRefsSource).toContain("'#add-person-tab-builtin'")
    expect(domRefsSource).toContain("'#add-person-tab-custom'")
  })

  it('keeps long add-person lists scrollable without hiding the submit button', () => {
    const html = readTeamDocument()

    expect(html).toMatch(/#add-person-modal \.modal\s*{[^}]*overflow:\s*hidden;/s)
    expect(html).toMatch(/#add-library-people-list\s*{[^}]*overflow:\s*auto;/s)
  })

  it('uses a deep desktop-style page background without decorative side panels', () => {
    const html = readTeamDocument()

    expect(html).not.toContain('body::before')
    expect(html).not.toContain('body::after')
    expect(html).toContain('--bg: #07080c;')
  })

  it('styles iframe background groups with chat and role labels', () => {
    const html = readTeamDocument()

    expect(html).toContain('.chat-frame-group-title')
    expect(html).toContain('.role-frame-shell')
    expect(html).toContain('.role-frame-label')
  })

  it('lays iframe chat groups as one group per row with up to three role frames per group', () => {
    const html = readTeamDocument()
    const hostRule = html.match(/#iframe-host\s*{(?<body>[^}]*)}/)?.groups?.body ?? ''
    const groupRule = html.match(/#iframe-host \.chat-frame-group\s*{(?<body>[^}]*)}/)?.groups?.body ?? ''

    expect(hostRule).toContain('scroll-snap-type: y proximity;')
    expect(hostRule).not.toContain('grid-template-columns')
    expect(html).not.toContain('#iframe-host::after')
    expect(groupRule).toContain('scroll-snap-align: start;')
    expect(groupRule).toContain('overflow: auto;')
    expect(groupRule).not.toContain('auto-fit')
  })

  it('makes the selected iframe chat group visibly highlighted without changing its layout', () => {
    const html = readTeamDocument()
    const activeGroupRule = html.match(/#iframe-host \.chat-frame-group\.active\s*{(?<body>[^}]*)}/)?.groups?.body ?? ''

    expect(activeGroupRule).not.toContain('height')
    expect(activeGroupRule).not.toContain('grid-row')
    expect(activeGroupRule).not.toContain('transform')
  })

  it('does not render person settings inside the people drawer', () => {
    const html = readTeamDocument()
    const source = readFileSync(resolve(process.cwd(), 'src/teamPage/index.ts'), 'utf8')

    expect(html).not.toContain('id="role-editor"')
    expect(html).not.toContain('人员设置')
    expect(html).not.toContain('id="edit-role-name"')
    expect(html).not.toContain('id="edit-role-description"')
    expect(html).not.toContain('id="edit-role-prompt"')
    expect(html).not.toContain('id="recover-role"')
    expect(html).not.toContain('id="initialize-role"')
    expect(html).not.toContain('id="new-role-name"')
    expect(source).not.toContain("'#role-editor'")
    expect(source).not.toContain("'#edit-role-name'")
    expect(source).not.toContain("'#recover-role'")
    expect(source).not.toContain("'#initialize-role'")
  })

  it('renders chat actions through a three-dot menu that updates, duplicates, and deletes chats', () => {
    const html = readTeamDocument()
    const chatListSource = readFileSync(resolve(process.cwd(), 'src/teamPage/chatListView.ts'), 'utf8')

    expect(chatListSource).toContain("menuButton.append(moreIcon())")
    expect(chatListSource).toContain("rename.textContent = ui('编辑名称')")
    expect(chatListSource).toContain("duplicate.textContent = ui('复制群聊')")
    expect(chatListSource).toContain("exportRecord.textContent = ui('导出记录')")
    expect(chatListSource).toContain("clearMessages.textContent = ui('清空消息')")
    expect(chatListSource).toContain("closeFrames.textContent = ui('关闭群聊')")
    expect(chatListSource).toContain("remove.textContent = ui('删除群聊')")
    expect(chatListSource).toContain("runCommand('GROUP_CHAT_CLEAR_MESSAGES'")
    expect(chatListSource).toContain("runCommand('GROUP_CHAT_CLOSE'")
    expect(chatListSource).toContain("runCommand('GROUP_CHAT_UPDATE'")
    expect(chatListSource).toContain("runCommand('GROUP_CHAT_DUPLICATE'")
    expect(chatListSource).toContain('formatChatExportMarkdown')
    expect(chatListSource).toContain("sendRuntimeMessage('GROUP_CHAT_DELETE'")
    expect(chatListSource).toContain("response.error === 'Unknown OpenTeam message'")
    expect(chatListSource).toContain('deleteChatFromLocalStore(chatId)')
    expect(html).toMatch(/\.chat-action-menu\s*{[^}]*position:\s*absolute;/s)
  })

  it('renders compact icon actions for assistant messages', () => {
    const html = readTeamDocument()
    const source = readFileSync(resolve(process.cwd(), 'src/teamPage/messagesView.ts'), 'utf8')
    const recoverySource = readFileSync(resolve(process.cwd(), 'src/teamPage/roleRecoveryController.ts'), 'utf8')

    expect(source).toContain("createMessageIconButton('跳转到原始窗口'")
    expect(source).toContain("createMessageIconButton('引用回复'")
    expect(source).toContain("createMessageIconButton('复制回复'")
    expect(source).toContain('showCopyFeedback(button)')
    expect(source).toContain("button.setAttribute('aria-label', '已复制')")
    expect(source).toContain("setMessageButtonIcon(button, 'check')")
    expect(source).toContain("setMessageButtonIcon(button, 'copy')")
    expect(source).toContain('deps.focusRoleFrame(message.chatId, message.roleId)')
    expect(source).toContain('copyMessageContent(message)')
    expect(source).toContain('navigator.clipboard.writeText(message.content)')
    expect(source).not.toContain("jump.textContent = '跳转'")
    expect(source).not.toContain("quote.textContent = '引用'")
    expect(recoverySource).toContain('showAiPages(true)')
    expect(html).toContain('.role-frame-shell.jump-highlight')
    expect(html).toContain('.message-tool-btn')
    expect(html).toContain('.message-tool-btn::after')
    expect(html).toContain('content: attr(aria-label);')
    expect(source).not.toContain('button.title = label')
    expect(html).not.toMatch(/\.message-row\.assistant:hover \.message-tools/)
    expect(html).toMatch(/\.message-row\.thinking:hover \.message-tools,/s)
    expect(source).toContain("createMessageIconButton('停止回复'")
    expect(source).toContain("createMessageIconButton('重新发送'")
    expect(source).not.toContain("打断重试")
    expect(recoverySource).toContain("runCommand('GROUP_ROLE_STOP_REPLY'")
    expect(recoverySource).toContain("type: 'GROUP_ROLE_RETRY_REPLY'")
  })

  it('keeps add-person sites per person and moves temporary people into a separate draft flow', () => {
    const html = readTeamDocument()
    const source = readFileSync(resolve(process.cwd(), 'src/teamPage/peopleLibraryView.ts'), 'utf8')
    const addPersonModal = html.match(/<div id="add-person-modal"[\s\S]*?<div id="temporary-person-modal"/)?.[0] ?? ''
    const temporaryModal = html.match(/<div id="temporary-person-modal"[\s\S]*?<div id="iframe-host"/)?.[0] ?? ''

    expect(addPersonModal).toContain('id="open-temporary-person"')
    // The add-person dialog builds its site choices per person in code, not as fixed radios.
    for (const site of CHAT_SITES) expect(addPersonModal).not.toContain(`id="add-person-site-${site}"`)
    expect(addPersonModal).not.toContain('id="add-temporary-person-form"')
    expect(temporaryModal).toContain('id="add-temporary-person-form"')
    expect(temporaryModal).toContain('id="close-temporary-person"')
    expect(source).toContain('temporaryPersonDrafts')
    expect(source).toContain('addPersonSiteControl')
    expect(source).toContain('selectedAddPersonItems()')
  })

  it('shows an add-person call to action when the selected chat has no people', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/teamPage/messagesView.ts'), 'utf8')

    expect(source).toContain("emptyChatPeopleCard('暂无成员'")
    expect(source).toContain("button.textContent = '添加成员'")
    expect(source).toContain('deps.openAddPersonDialog')
  })

  it('switches chats from the whole chat row while keeping row menus isolated', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/teamPage/chatListView.ts'), 'utf8')

    expect(source).toContain("item.addEventListener('click', () => switchChat(chat.id))")
    expect(source).toContain("item.addEventListener('keydown'")
    expect(source).toContain("item.tabIndex = 0")
    expect(source).toContain("item.setAttribute('role', 'button')")
    expect(source).toContain("menu.addEventListener('click', event => event.stopPropagation())")
  })

  it('hides the reference draft until quoting and keeps quoted text to one line', () => {
    const html = readTeamDocument()
    const source = readFileSync(resolve(process.cwd(), 'src/teamPage/composerView.ts'), 'utf8')

    expect(html).toMatch(/\.reference-draft\[hidden\]\s*{[^}]*display:\s*none;/s)
    expect(html).toMatch(/\.reference-draft-preview\s*{[^}]*text-overflow:\s*ellipsis;/s)
    expect(source).not.toContain("title.textContent = `引用 ${selectedReference.roleName || '成员'} 的观点`")
  })

  it('positions the mention panel next to the composer input instead of the right action area', () => {
    const html = readTeamDocument()
    const source = readFileSync(resolve(process.cwd(), 'src/teamPage/composerView.ts'), 'utf8')

    expect(source).toContain('roleMentionLabel(role, mentionLabelOptions())')
    expect(source).toContain('roleModelLabel(role, mentionLabelOptions())')
    expect(html).toMatch(/\.mention-name\s*{[^}]*text-overflow:\s*ellipsis;/s)
  })

  it('keeps the sidebar header focused on chat creation instead of a refresh control', () => {
    const html = readTeamDocument()
    const uiSource = readFileSync(resolve(process.cwd(), 'src/teamPage/teamUiController.ts'), 'utf8')

    expect(html).not.toContain('id="refresh-store"')
    expect(html).not.toContain('aria-label="同步并恢复当前群聊"')
    expect(html).toContain('id="quick-create-chat"')
    expect(uiSource).not.toContain('#refresh-store')
    expect(uiSource).not.toContain('refreshCurrentChat().catch')
  })

  it('never closes the OpenTeam tab on its own', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/teamPage/teamUiController.ts'), 'utf8')

    expect(source).not.toContain("window.confirm('确定要关闭 OpenTeam 窗口吗？')")
    expect(source).not.toContain('window.close()')
  })

  it('uses a refined composer and desktop-style chat header', () => {
    const html = readTeamDocument()
    const source = readFileSync(resolve(process.cwd(), 'src/teamPage/chatHeaderView.ts'), 'utf8')
    const uiSource = readFileSync(resolve(process.cwd(), 'src/teamPage/teamUiController.ts'), 'utf8')

    expect(html).toContain('placeholder="输入消息，@成员 让他回复；不 @ 只记在群里"')
    expect(source).toContain("togglePeopleDrawerEl.textContent = ui('成员 0')")
    expect(source).toContain('deps.togglePeopleDrawerEl.textContent = ui(`成员 ${roles.length}`)')
    expect(source).toContain("deps.togglePeopleDrawerEl.setAttribute('aria-label', ui(deps.state.peopleDrawerOpen ? '收起成员面板' : '打开成员面板'))")
    expect(uiSource).toContain('deps.state.peopleDrawerOpen && target && !memberPanelDocked() && !deps.rolePanelEl.contains(target) && !deps.togglePeopleDrawerEl.contains(target)')
    expect(uiSource).toContain('deps.state.peopleDrawerOpen = false')
    expect(source).not.toContain('人回复中')
  })

  it('keeps right member card controls as borderless icons with horizontal status text', () => {
    const css = readTeamCss()
    const roleStatusRule = css.match(/(?:^|\n)\.role-card \.status-pill\s*{(?<body>[^}]*)}/)?.groups?.body ?? ''

    expect(roleStatusRule).toContain('position: absolute;')
    expect(css).not.toMatch(/:root\[data-theme="light"\] \.role-prompt-detail,/)
  })

  it('places user messages on the right like a WeChat conversation', () => {
    const html = readTeamDocument()

    expect(html).not.toContain('.message-content')
  })

  it('wraps group template categories instead of showing a horizontal scroller', () => {
    const html = readTeamDocument()

    expect(html).not.toMatch(/\.group-template-categories\s*{[^}]*overflow-x:\s*auto;/s)
  })

  it('keeps group template cards roomy and descriptions fully readable', () => {
    const html = readTeamDocument()

    expect(html).toMatch(/\.group-template-summary\s*{[^}]*overflow:\s*hidden;/s)
    expect(html).not.toMatch(/\.group-template-option\.has-long-summary:hover \.group-template-summary/s)
    expect(html).not.toMatch(/\.group-template-option\.has-long-summary:focus-visible \.group-template-summary/s)
    expect(html).not.toMatch(/\.group-template-summary\s*{[^}]*overflow:\s*visible;/s)
    expect(html).not.toMatch(/\.group-template-meta\s*{[^}]*text-overflow:\s*ellipsis;/s)
    expect(html).not.toContain('群聊介绍 · 悬浮查看')
    expect(html).not.toContain('group-template-summary-collapsed')
  })

  it('renders explicit mentions inline inside user message bubbles', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/teamPage/messagesView.ts'), 'utf8')

    expect(source).toContain('renderMessageMentions(message)')
    expect(source).toContain('appendMentionsToBody(body, mentions)')
    expect(source).toContain('message.mentionedRoleIds')
    expect(source).toContain('roleMentionLabel(role, mentionLabelOptions())')
  })

  it('renders copied markdown replies with markdown-it while keeping other messages on the plain-text renderer', () => {
    const html = readTeamDocument()
    const source = readFileSync(resolve(process.cwd(), 'src/teamPage/messagesView.ts'), 'utf8')

    expect(source).toContain('shouldRenderMarkdownMessage(message)')
    expect(source).toContain("message.contentFormat === 'markdown' || message.type === 'assistant'")
    expect(source).toContain('renderMarkdownMessageBody(body, message.content)')
    expect(source).toContain('renderPlainMessageBody(body, message.content)')
    expect(source).toContain('pill.append(document.createTextNode(message.content))')
    const markdownSource = readFileSync(resolve(process.cwd(), 'src/teamPage/markdownRender.ts'), 'utf8')
    expect(source).toContain('renderMarkdownInto(body, content)')
    expect(markdownSource).toContain('MarkdownIt')
    expect(markdownSource).toContain('element.innerHTML = markdownRenderer.render(normalizeAssistantMarkdown(content))')
    expect(html).toContain('.message-body.markdown-body')
  })

  it('keeps chat titles as plain text and omits chat status from list rows', () => {
    const html = readTeamDocument()
    const source = readFileSync(resolve(process.cwd(), 'src/teamPage/chatListView.ts'), 'utf8')

    expect(source).not.toContain('statusPill(chat.status')
    expect(html).not.toContain('.chat-meta')
    expect(html).not.toContain('.chat-item .chat-name::before')
  })

  it('uses a WeChat-like chat list row with avatar, body, and right time column', () => {
    const html = readTeamDocument()
    const source = readFileSync(resolve(process.cwd(), 'src/teamPage/chatListView.ts'), 'utf8')

    expect(source).toContain("time.textContent = formatChatListTime(chat.updatedAt)")
    expect(source).not.toContain("textNode(`${chat.roleIds.length} 位成员 · ${formatTime(chat.updatedAt)}`)")
    expect(html).toContain('.chat-avatar')
    expect(html).toContain('.chat-time')
    expect(html).toMatch(/\.summary-line\s*{[^}]*text-overflow:\s*ellipsis;/s)
  })

  it('keeps chat switching to one store write and one store application', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/teamPage/chatListView.ts'), 'utf8')
    const runtimeSource = readFileSync(resolve(process.cwd(), 'src/teamPage/runtimeClient.ts'), 'utf8')

    expect(source).toContain("runCommand('GROUP_CHAT_SWITCH', { chatId })")
    expect(source).toContain('deps.renderSelectedChat()')
    expect(source).toContain('window.requestAnimationFrame(() => {')
    expect(source).not.toContain("runCommand('GROUP_CHAT_MARK_READ', { chatId })")
    expect(runtimeSource).toMatch(/if \(response\.store\) \{\s*deps\.applyStore\(response\.store\)\s*return\s*\}/s)
    expect(runtimeSource).not.toMatch(/if \(response\.store\) deps\.applyStore\(response\.store\)\s*await deps\.refreshStore\(false\)/s)
  })

  it('avoids layout-changing iframe group transitions while switching chats', () => {
    const html = readTeamDocument()
    const activeGroupRule = html.match(/#iframe-host \.chat-frame-group\.active\s*{(?<body>[^}]*)}/)?.groups?.body ?? ''
    const groupRule = html.match(/#iframe-host \.chat-frame-group\s*{(?<body>[^}]*)}/)?.groups?.body ?? ''

    expect(activeGroupRule).not.toContain('grid-row')
    expect(activeGroupRule).not.toContain('transform')
    expect(groupRule).not.toMatch(/transition:[^;]*transform/)
  })

  it('reuses rendered message nodes so returning to a chat is cheap', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/teamPage/messagesView.ts'), 'utf8')

    expect(source).toContain('messageNodeCache')
    expect(source).toContain('renderMessageNode(item.message, item.showName, item.showAvatar)')
    expect(source).toContain('messageSignature(message, showName, showAvatar)')
  })
})
