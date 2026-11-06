import { CHAT_SITES, chatSiteLabel, type ChatSite } from '../group/chatSites'
import {
  buildTeamInvitation,
  buildTeamKickoff,
  buildTeamBrief,
  buildTeamFlowInstruction,
  collectTeamMembers,
  invitationRaw,
  isTeamMemberSettled,
  parseTeamClaim,
  planTeamRounds,
  resolveTeamPositions,
  splitPositions,
  TEAM_MAX_COPIES_PER_MODEL,
  TEAM_MAX_MEMBERS,
  TEAM_MIN_MEMBERS,
  teamLabels,
  teamMemberNames,
  teamModelKey,
  type TeamMember,
  type TeamResolution,
} from '../group/teamFormation'
import type { GroupChat, GroupMessage, GroupRole, OpenTeamLanguage, OpenTeamStore } from '../group/types'
import { normalizeLanguage } from '../shared/i18n'
import { PROBLEM_HEALTH_STATUSES, rolePageHealthLabel, type RolePageHealth } from './roleHealth'

export interface TeamFormationViewDependencies {
  getStore(): OpenTeamStore
  getCurrentChatId(): string | undefined
  runCommand(type: string, payload?: Record<string, unknown>): Promise<void>
  getRoleHealth(role: GroupRole): RolePageHealth
  focusRoleFrame(chatId: string, roleId: string): void
  showError(message: string): void
  showSuccess(message: string): void
  // Called before the setup window opens, to close the new-chat popover.
  onSetupOpen?(): void
  // Opens the orchestration editor and plans a flow for the task with this instruction.
  openAutoPlan?(task: string, instruction: string): void
}

export interface TeamFormationView {
  openSetup(): void
  openCard(chatId: string): void
  // Re-renders an open window, and invites the next round once the previous one has answered.
  refresh(): void
  // The notice at the top of a group whose members are still choosing positions.
  statusBanner(chat: GroupChat): HTMLElement | undefined
  isInvitation(chat: GroupChat, messageId: string): boolean
  renderClaim(message: GroupMessage): HTMLElement | undefined
}

interface MemberChoice {
  key: string
  label: string
  pillClass: string
  member: { modelSource: 'site'; chatSite: ChatSite } | { modelSource: 'external'; externalModelId: string }
}

export function createTeamFormationView(deps: TeamFormationViewDependencies): TeamFormationView {
  let setup: { backdrop: HTMLElement } | undefined
  let card: { chatId: string; backdrop: HTMLElement; body: HTMLElement; footer: HTMLElement; title: HTMLElement; task: HTMLElement; signature: string } | undefined
  // Positions the user typed on the card, per chat and role, until the positions are confirmed.
  const edits = new Map<string, Map<string, string>>()
  // Chats whose card was opened automatically once every member answered, keyed by invitation count.
  const autoOpened = new Map<string, number>()
  let busy = false
  // The inline form open in a confirmed team's card.
  let panel: 'none' | 'save' | 'redivide' = 'none'
  let advancing = false

  function language(): OpenTeamLanguage {
    return normalizeLanguage(deps.getStore().settings.language)
  }

  function t(zh: string, en: string): string {
    return language() === 'en' ? en : zh
  }

  // ----- Setup window -----

  function openSetup(): void {
    closeSetup()
    deps.onSetupOpen?.()
    const counts = new Map<string, number>()
    const choices = memberChoices()

    const backdrop = document.createElement('div')
    backdrop.className = 'modal-backdrop team-formation-modal'
    backdrop.addEventListener('click', event => {
      if (event.target === backdrop) closeSetup()
    })
    const dialog = element('section', 'modal team-setup-dialog')
    dialog.setAttribute('role', 'dialog')
    dialog.setAttribute('aria-modal', 'true')
    dialog.setAttribute('aria-labelledby', 'team-setup-title')

    const header = element('div', 'modal-header')
    const heading = element('div')
    const title = element('h2', '', t('按任务组队', 'Form a team for a task'))
    title.id = 'team-setup-title'
    heading.append(title, element('p', 'tiny', t('写下要做的事，挑几个 AI，让它们自己决定在这次项目里担任什么职位。', 'Describe the task, pick a few AIs, and let them decide which position each takes on this project.')))
    header.append(heading, closeButton(() => closeSetup()))

    const form = document.createElement('form')
    form.className = 'team-setup-form'
    form.noValidate = true

    const taskField = field(t('要做的事', 'The task'), 'team-setup-task')
    const task = document.createElement('textarea')
    task.id = 'team-setup-task'
    task.rows = 4
    task.placeholder = t('例如：做一个面向大学生的记账小程序，两周内出可用版本', 'For example: build a budgeting mini app for students, usable within two weeks')
    taskField.append(task)

    const membersField = field(t('选择队员', 'Team members'))
    const total = element('p', 'tiny team-setup-total')
    const list = element('div', 'team-setup-members')
    for (const choice of choices) {
      const row = element('div', 'team-setup-member')
      row.dataset.key = choice.key
      const label = element('span', `role-site-badge ${choice.pillClass}`, choice.label)
      const stepper = element('div', 'team-setup-stepper')
      const minus = stepButton('−', t(`少一个 ${choice.label}`, `One fewer ${choice.label}`))
      const value = element('span', 'team-setup-count', '0')
      const plus = stepButton('+', t(`多一个 ${choice.label}`, `One more ${choice.label}`))
      const update = (delta: number) => {
        const next = Math.max(0, Math.min(TEAM_MAX_COPIES_PER_MODEL, (counts.get(choice.key) ?? 0) + delta))
        if (delta > 0 && totalCount(counts) >= TEAM_MAX_MEMBERS && next > (counts.get(choice.key) ?? 0)) return
        counts.set(choice.key, next)
        value.textContent = String(next)
        row.classList.toggle('team-setup-member-selected', next > 0)
        renderTotal()
        clearError()
      }
      minus.addEventListener('click', () => update(-1))
      plus.addEventListener('click', () => update(1))
      stepper.append(minus, value, plus)
      row.append(label, stepper)
      list.append(row)
    }
    membersField.append(list, total)

    const requiredField = field(t('必须有的职位（选填）', 'Positions the team must have (optional)'), 'team-setup-required')
    const required = document.createElement('input')
    required.id = 'team-setup-required'
    required.type = 'text'
    required.autocomplete = 'off'
    required.placeholder = t('例如：测试、运维', 'For example: QA, operations')
    requiredField.append(required, element('p', 'tiny', t('留空就完全由它们自己决定。', 'Leave empty to let them decide entirely.')))

    const nameField = field(t('群聊名称（选填）', 'Group name (optional)'), 'team-setup-name')
    const name = document.createElement('input')
    name.id = 'team-setup-name'
    name.type = 'text'
    name.autocomplete = 'off'
    name.placeholder = t('默认用任务的开头', 'Defaults to the start of the task')
    nameField.append(name)

    const error = element('p', 'team-form-error')
    error.setAttribute('role', 'alert')
    const actions = element('div', 'team-setup-actions')
    const cancel = button(t('取消', 'Cancel'), 'btn')
    cancel.addEventListener('click', () => closeSetup())
    const submit = button(t('组建团队', 'Form the team'), 'btn btn-primary')
    submit.type = 'submit'
    actions.append(cancel, submit)
    const savedField = savedTeamsField()
    form.append(taskField, ...(savedField ? [savedField] : []), membersField, requiredField, nameField, error, actions)

    function savedTeamsField(): HTMLElement | undefined {
      const templates = deps.getStore().settings.teamTemplates ?? []
      if (templates.length === 0) return undefined
      const wrapper = field(t('已保存的团队', 'Saved teams'))
      const list = element('div', 'team-setup-saved')
      for (const template of templates) {
        const row = element('div', 'team-setup-saved-row')
        row.dataset.templateId = template.id
        const text = element('div', 'team-setup-saved-text')
        text.append(element('span', 'team-card-name', template.name), element('span', 'tiny', template.members.map(member => member.name).join(t('、', ', '))))
        const use = button(t('用这个团队', 'Use this team'), 'btn btn-small')
        use.addEventListener('click', () => {
          use.disabled = true
          deps.runCommand('GROUP_TEAM_CREATE', {
            templateId: template.id,
            ...(task.value.trim() ? { task: task.value.trim() } : {}),
            ...(name.value.trim() ? { name: name.value.trim() } : {}),
          }).then(() => {
            closeSetup()
            const chatId = deps.getStore().currentChatId
            if (chatId && deps.getStore().chatsById[chatId]?.teamFormation) openCard(chatId)
          }).catch(caught => {
            error.textContent = message(caught)
          }).finally(() => {
            use.disabled = false
          })
        })
        const remove = button(t('删除', 'Delete'), 'btn btn-ghost btn-small')
        remove.addEventListener('click', () => {
          deps.runCommand('GROUP_TEAM_TEMPLATE_DELETE', { templateId: template.id })
            .then(() => row.remove())
            .catch(caught => {
              error.textContent = message(caught)
            })
        })
        row.append(text, use, remove)
        list.append(row)
      }
      wrapper.append(list, element('p', 'tiny', t('用保存的团队会保留它们之前的职位和人设，检查网页后就能开工；也可以让它们为新任务重新自荐。', 'A saved team keeps its positions and personas: check the pages and start, or let them choose again for the new task.')))
      return wrapper
    }

    function renderTotal(): void {
      const count = totalCount(counts)
      total.textContent = t(`已选 ${count} 位，可选 ${TEAM_MIN_MEMBERS}–${TEAM_MAX_MEMBERS} 位；同一个 AI 最多 ${TEAM_MAX_COPIES_PER_MODEL} 位。`, `${count} selected, ${TEAM_MIN_MEMBERS}–${TEAM_MAX_MEMBERS} allowed; up to ${TEAM_MAX_COPIES_PER_MODEL} of the same AI.`)
    }
    function clearError(): void {
      error.textContent = ''
    }
    task.addEventListener('input', clearError)
    renderTotal()

    form.addEventListener('submit', event => {
      event.preventDefault()
      if (!task.value.trim()) {
        error.textContent = t('先写下要做的事。', 'Describe the task first.')
        task.focus()
        return
      }
      const count = totalCount(counts)
      if (count < TEAM_MIN_MEMBERS) {
        error.textContent = t(`至少选 ${TEAM_MIN_MEMBERS} 位队员。`, `Pick at least ${TEAM_MIN_MEMBERS} members.`)
        return
      }
      const members = choices.flatMap(choice => Array.from({ length: counts.get(choice.key) ?? 0 }, () => choice.member))
      submit.disabled = true
      deps.runCommand('GROUP_TEAM_CREATE', {
        task: task.value.trim(),
        members,
        requiredPositions: splitPositions(required.value),
        ...(name.value.trim() ? { name: name.value.trim() } : {}),
      }).then(() => {
        closeSetup()
        const chatId = deps.getStore().currentChatId
        if (chatId && deps.getStore().chatsById[chatId]?.teamFormation) openCard(chatId)
      }).catch(caught => {
        error.textContent = caught instanceof Error ? caught.message : String(caught)
      }).finally(() => {
        submit.disabled = false
      })
    })

    dialog.append(header, form)
    backdrop.append(dialog)
    document.body.append(backdrop)
    document.addEventListener('keydown', handleEscape)
    setup = { backdrop }
    task.focus()
  }

  function memberChoices(): MemberChoice[] {
    const store = deps.getStore()
    const sites: MemberChoice[] = CHAT_SITES.map(site => ({ key: `site:${site}`, label: chatSiteLabel(site), pillClass: `site-pill-${site}`, member: { modelSource: 'site', chatSite: site } }))
    const external: MemberChoice[] = store.settings.externalModelOrder
      .map(id => store.settings.externalModelsById[id])
      .filter((model): model is NonNullable<typeof model> => Boolean(model))
      .map(model => ({ key: `external:${model.id}`, label: `API · ${model.name}`, pillClass: 'site-pill-external', member: { modelSource: 'external', externalModelId: model.id } }))
    return [...sites, ...external]
  }

  function closeSetup(): void {
    setup?.backdrop.remove()
    setup = undefined
    if (!card) document.removeEventListener('keydown', handleEscape)
  }

  // ----- Role card -----

  function openCard(chatId: string): void {
    closeCard()
    const chat = deps.getStore().chatsById[chatId]
    if (!chat?.teamFormation) return

    const backdrop = document.createElement('div')
    backdrop.className = 'modal-backdrop team-formation-modal'
    backdrop.addEventListener('click', event => {
      if (event.target === backdrop) closeCard()
    })
    const dialog = element('section', 'modal team-card-dialog')
    dialog.setAttribute('role', 'dialog')
    dialog.setAttribute('aria-modal', 'true')
    dialog.setAttribute('aria-labelledby', 'team-card-title')
    const header = element('div', 'modal-header')
    const heading = element('div')
    const title = element('h2')
    title.id = 'team-card-title'
    const task = element('p', 'team-card-task', chat.teamFormation.task)
    heading.append(title, task)
    header.append(heading, closeButton(() => closeCard()))
    const body = element('div', 'team-card-body')
    const footer = element('div', 'team-card-footer')
    dialog.append(header, body, footer)
    backdrop.append(dialog)
    document.body.append(backdrop)
    document.addEventListener('keydown', handleEscape)
    card = { chatId, backdrop, body, footer, title, task, signature: '' }
    panel = 'none'
    renderCard()
  }

  function closeCard(): void {
    card?.backdrop.remove()
    card = undefined
    if (!setup) document.removeEventListener('keydown', handleEscape)
  }

  function handleEscape(event: KeyboardEvent): void {
    if (event.key !== 'Escape') return
    if (card) closeCard()
    else closeSetup()
  }

  function chatEdits(chatId: string): Map<string, string> {
    let map = edits.get(chatId)
    if (!map) {
      map = new Map()
      edits.set(chatId, map)
    }
    return map
  }

  function renderCard(): void {
    if (!card) return
    const store = deps.getStore()
    const chat = store.chatsById[card.chatId]
    const formation = chat?.teamFormation
    if (!chat || !formation) {
      closeCard()
      return
    }
    const members = collectTeamMembers(store, chat)
    const resolution = resolution_(chat, members)
    const health = members.map(member => memberHealth(member.role))
    const signature = JSON.stringify([formation.task, formation.status, formation.invitationIds, members.map(member => [member.roleId, member.role.name, member.status, member.claim, member.replyText?.length]), health.map(item => [item.status, item.reason, item.detail]), [...chatEdits(card.chatId)], busy, panel, formation.preset, formation.previousPositions, language()])
    if (signature === card.signature) return
    card.signature = signature
    // Dividing the work again changes the task.
    card.task.textContent = formation.task

    const focused = document.activeElement instanceof HTMLInputElement && card.body.contains(document.activeElement) ? document.activeElement.dataset.roleId : undefined
    if (formation.status === 'checking') renderChecking(chat, members, health)
    else renderClaims(chat, members, resolution)
    if (focused) card.body.querySelector<HTMLInputElement>(`input[data-role-id="${CSS.escape(focused)}"]`)?.focus()
  }

  function memberHealth(role: GroupRole): RolePageHealth {
    // API models answer without a web page, so there is nothing to check.
    return role.modelSource === 'external' ? { status: 'ready' } : deps.getRoleHealth(role)
  }

  function renderChecking(chat: GroupChat, members: TeamMember[], health: RolePageHealth[]): void {
    if (!card) return
    card.title.textContent = t('检查队员', 'Check the members')
    const rows = members.map((member, index) => {
      const item = health[index]
      const problem = PROBLEM_HEALTH_STATUSES.has(item.status)
      const row = element('div', `team-card-row team-health-${item.status}`)
      row.dataset.roleId = member.roleId
      const head = element('div', 'team-card-row-head')
      head.append(element('span', 'team-card-name', member.role.name), modelPill(member))
      const state = element('span', `team-card-state${problem ? ' team-card-problem' : ''}`, uiHealth(item))
      head.append(state)
      row.append(head)
      if (item.detail) row.append(element('p', 'tiny team-card-detail', item.detail))
      const actions = element('div', 'team-card-row-actions')
      if (member.role.modelSource !== 'external' && item.status !== 'ready') {
        const view = button(t('查看网页', 'Open the page'), 'btn btn-ghost btn-small')
        view.addEventListener('click', () => deps.focusRoleFrame(chat.id, member.roleId))
        actions.append(view)
      }
      if (members.length > TEAM_MIN_MEMBERS) {
        const remove = button(t('移除', 'Remove'), 'btn btn-ghost btn-small')
        remove.addEventListener('click', () => {
          deps.runCommand('GROUP_ROLE_DELETE', { roleId: member.roleId }).catch(caught => deps.showError(message(caught)))
        })
        actions.append(remove)
      }
      if (actions.childElementCount > 0) row.append(actions)
      return row
    })
    card.body.replaceChildren(element('p', 'tiny', t('每位队员的网页都要能发送消息：没登录、有弹窗或额度用完的，请先处理或移除。', 'Every member\'s page has to be able to send: sign in, close dialogs, or remove members that are out of quota.')), ...rows)

    const ready = health.every(item => item.status === 'ready')
    const preset = chat.teamFormation?.preset === true
    const invite = button(preset ? t('让它们重新自荐', 'Let them choose again') : t('邀请它们自荐', 'Invite them to choose'), preset ? 'btn' : 'btn btn-primary')
    invite.disabled = busy || !ready || members.length < TEAM_MIN_MEMBERS
    invite.addEventListener('click', () => void inviteRound(chat.id))
    const hint = element('p', 'team-card-hint', !ready
      ? t('等所有队员的网页都显示“可以发送”。', 'Wait until every member\'s page says it can send.')
      : preset
        ? t('这是保存的团队：职位和人设都在，可以直接开工。', 'This is a saved team: positions and personas are set, so it can start right away.')
        : t('它们会各自回答最适合自己的职位、备选职位和项目需要的职位。', 'Each will answer with the position that suits it, a fallback, and the positions the project needs.'))
    if (!preset) {
      card.footer.replaceChildren(hint, invite)
      return
    }
    const start = button(t('开工', 'Start'), 'btn btn-primary')
    start.disabled = busy || !ready
    start.addEventListener('click', () => void startPreset(chat.id))
    card.footer.replaceChildren(hint, invite, start)
  }

  function renderClaims(chat: GroupChat, members: TeamMember[], resolution: TeamResolution): void {
    if (!card) return
    const formation = chat.teamFormation!
    const confirmed = formation.status === 'confirmed'
    card.title.textContent = confirmed ? t('分工已确认', 'Positions confirmed') : t('它们给自己选的职位', 'The positions they chose')
    const conflictOf = new Map<string, string>()
    for (const conflict of resolution.conflicts) for (const roleId of conflict.roleIds) conflictOf.set(roleId, conflict.position)
    const editMap = chatEdits(chat.id)

    const rows = members.map(member => {
      const assignment = resolution.assignments[member.roleId]
      const conflict = conflictOf.get(member.roleId)
      const row = element('div', `team-card-row team-member-${member.status}${conflict ? ' team-card-conflict' : ''}`)
      row.dataset.roleId = member.roleId
      const head = element('div', 'team-card-row-head')
      head.append(element('span', 'team-card-name', member.role.name), modelPill(member))
      const stateText = memberStateText(member, chat)
      if (stateText) head.append(element('span', `team-card-state${member.status === 'failed' || member.status === 'unreadable' ? ' team-card-problem' : ''}`, stateText))
      row.append(head)

      if (!confirmed && (isTeamMemberSettled(member) || editMap.has(member.roleId))) {
        const positionRow = element('label', 'team-card-position')
        positionRow.append(element('span', '', t('职位', 'Position')))
        const input = document.createElement('input')
        input.type = 'text'
        input.dataset.roleId = member.roleId
        input.value = editMap.get(member.roleId) ?? assignment?.position ?? conflict ?? ''
        input.placeholder = t('手动填写职位', 'Type a position')
        input.addEventListener('change', () => {
          const value = input.value.trim()
          if (value) editMap.set(member.roleId, value)
          else editMap.delete(member.roleId)
          renderCard()
        })
        positionRow.append(input)
        if (assignment && !editMap.has(member.roleId)) positionRow.append(element('span', 'team-card-tag', assignment.from === 'first' ? t('第一选择', 'First choice') : t('第二选择', 'Second choice')))
        if (conflict && !editMap.has(member.roleId)) positionRow.append(element('span', 'team-card-tag team-card-tag-conflict', t('和别人重复', 'Clashes')))
        row.append(positionRow)
      }
      const claim = member.claim
      if (confirmed && member.role.systemPrompt) {
        // After confirming, what the member was told, not what it first asked for.
        row.append(element('p', 'tiny team-card-detail', member.role.systemPrompt))
      } else if (claim) {
        const details = element('dl', 'team-card-details')
        const add = (label: string, value: string | undefined) => {
          if (!value) return
          details.append(element('dt', '', label), element('dd', '', value))
        }
        add(t('想当', 'Wants'), claim.secondChoice ? `${claim.firstChoice}${t('（备选：', ' (fallback: ')}${claim.secondChoice}${t('）', ')')}` : claim.firstChoice)
        add(t('理由', 'Why'), claim.why)
        add(t('负责', 'Responsible for'), claim.responsibility)
        add(t('不负责', 'Not responsible for'), claim.notResponsible)
        add(t('先交付', 'Delivers first'), claim.firstDeliverable)
        row.append(details)
      } else if (member.replyText) {
        row.append(element('p', 'tiny team-card-detail', member.replyText.slice(0, 240)))
      }
      return row
    })

    const notes: HTMLElement[] = []
    if (!confirmed && resolution.conflicts.length > 0) {
      const names = (roleIds: string[]) => roleIds.map(roleId => members.find(member => member.roleId === roleId)?.role.name ?? roleId).join(t('、', ', '))
      notes.push(element('div', 'team-card-note team-card-note-conflict', resolution.conflicts.map(conflict => conflict.holderRoleId
        ? t(`「${conflict.position}」已经是 ${names([conflict.holderRoleId])} 的了，${names(conflict.roleIds)} 也想要。改 ${names(conflict.roleIds)} 的职位，或让它重选。`, `"${conflict.position}" is already ${names([conflict.holderRoleId])}'s, and ${names(conflict.roleIds)} wants it too. Change ${names(conflict.roleIds)}'s position, or ask it to choose again.`)
        : t(`「${conflict.position}」有 ${conflict.roleIds.length} 位想要：${names(conflict.roleIds)}。改其中一位的职位，或让它们重选。`, `${conflict.roleIds.length} members want "${conflict.position}": ${names(conflict.roleIds)}. Change one of them, or ask them to choose again.`)).join('\n')))
    }
    if (!confirmed && resolution.uncovered.length > 0) {
      const note = element('div', 'team-card-note')
      note.append(element('span', '', t('还没人负责：', 'Nobody holds yet: ')))
      for (const item of resolution.uncovered.slice(0, 8)) {
        note.append(element('span', `team-card-chip${item.required ? ' team-card-chip-required' : ''}`, item.required
          ? t(`${item.position}（必需）`, `${item.position} (required)`)
          : t(`${item.position} · ${item.mentions} 位提到`, `${item.position} · ${item.mentions} mentioned`)))
      }
      notes.push(note)
    }
    card.body.replaceChildren(...notes, ...rows)

    if (confirmed) {
      renderConfirmedActions(chat, members)
      return
    }
    const pending = members.some(member => !isTeamMemberSettled(member) && !editMap.has(member.roleId))
    const positions = members.map(member => ({ roleId: member.roleId, position: editMap.get(member.roleId) ?? resolution.assignments[member.roleId]?.position ?? '' }))
    const missing = positions.some(item => !item.position.trim())
    const repick = button(t('让重复的重选', 'Ask the clashing ones to choose again'), 'btn')
    repick.disabled = busy || pending || resolution.conflicts.length === 0
    repick.addEventListener('click', () => void inviteRepick(chat.id, resolution))
    const confirm = button(t('确认分工，开工', 'Confirm and start'), 'btn btn-primary')
    confirm.disabled = busy || pending || missing || resolution.conflicts.length > 0
    confirm.addEventListener('click', () => void confirmTeam(chat.id, members, positions))
    const hint = element('p', 'team-card-hint', pending
      ? t('还有队员在回答。', 'Some members are still answering.')
      : resolution.conflicts.length > 0
        ? t('先解决重复的职位。', 'Settle the clashing positions first.')
        : missing
          ? t('给每位队员填一个职位。', 'Give every member a position.')
          : t('确认后，每位队员会改名为它的职位，并收到开工消息和自己的分工。', 'On confirm, each member is renamed to its position and gets the kickoff message with its own brief.'))
    card.footer.replaceChildren(hint, repick, confirm)
  }

  function renderConfirmedActions(chat: GroupChat, members: TeamMember[]): void {
    if (!card) return
    const formation = chat.teamFormation!
    if (panel === 'save') {
      const form = element('div', 'team-card-panel')
      const input = document.createElement('input')
      input.type = 'text'
      input.className = 'team-card-panel-input'
      input.value = chat.name
      input.setAttribute('aria-label', t('团队名称', 'Team name'))
      const save = button(t('保存', 'Save'), 'btn btn-primary')
      save.disabled = busy
      save.addEventListener('click', () => void saveTemplate(chat.id, input.value))
      const cancel = button(t('取消', 'Cancel'), 'btn')
      cancel.addEventListener('click', () => {
        panel = 'none'
        renderCard()
      })
      form.append(element('span', '', t('团队名称', 'Team name')), input, cancel, save)
      card.footer.replaceChildren(element('p', 'team-card-hint', t('保存职位、人设和用的 AI。下次在“按任务组队”里就能直接用。', 'Saves the positions, personas and AIs. Next time, use it from "Team up for a task".')), form)
      input.focus()
      input.select()
      return
    }
    if (panel === 'redivide') {
      const form = element('div', 'team-card-panel team-card-panel-wide')
      const input = document.createElement('textarea')
      input.className = 'team-card-panel-input'
      input.rows = 3
      input.value = formation.task
      input.setAttribute('aria-label', t('这一阶段要做什么', 'What this phase is about'))
      const go = button(t('重新分工', 'Divide again'), 'btn btn-primary')
      go.disabled = busy
      go.addEventListener('click', () => void redivide(chat.id, members, input.value))
      const cancel = button(t('取消', 'Cancel'), 'btn')
      cancel.addEventListener('click', () => {
        panel = 'none'
        renderCard()
      })
      form.append(input, cancel, go)
      card.footer.replaceChildren(element('p', 'team-card-hint', t('写下这一阶段要做什么。队员会看到现在的分工，可以保持，也可以换。', 'Describe this phase. Members see the current positions and may keep or change theirs.')), form)
      input.focus()
      return
    }
    const actions: HTMLButtonElement[] = []
    if (deps.openAutoPlan) {
      const flow = button(t('按分工生成流程', 'Plan a flow from the roles'), 'btn')
      flow.addEventListener('click', () => {
        const store = deps.getStore()
        const instruction = buildTeamFlowInstruction(members.map(member => ({ name: store.rolesById[member.roleId]?.name ?? member.role.name, modelLabel: member.modelLabel, description: store.rolesById[member.roleId]?.description })), language())
        closeCard()
        deps.openAutoPlan?.(formation.task, instruction)
      })
      actions.push(flow)
    }
    const save = button(t('存为群聊模板', 'Save as a team'), 'btn')
    save.addEventListener('click', () => {
      panel = 'save'
      renderCard()
    })
    const again = button(t('重新分工', 'Divide again'), 'btn')
    again.addEventListener('click', () => {
      panel = 'redivide'
      renderCard()
    })
    const done = button(t('关闭', 'Close'), 'btn btn-primary')
    done.addEventListener('click', () => closeCard())
    card.footer.replaceChildren(element('p', 'team-card-hint', t('接下来可以按分工生成编排流程、把团队存起来下次直接用，或在项目进入新阶段时重新分工。', 'Next: plan a flow from the roles, save the team for next time, or divide the work again when the project moves to a new phase.')), ...actions, save, again, done)
  }

  function memberStateText(member: TeamMember, chat: GroupChat): string | undefined {
    switch (member.status) {
      case 'not-invited': return chat.teamFormation?.status === 'claiming' ? t('等同款 AI 先选，再轮到它', 'Waits for its twin to choose first') : t('还没邀请', 'Not invited yet')
      case 'waiting': return t('等待回复', 'Waiting for a reply')
      case 'replying': return t('正在想…', 'Thinking…')
      case 'failed': return t('回复失败', 'Reply failed')
      case 'unreadable': return t('没按格式回答，请手动填写', 'Did not answer in the format; type a position')
      case 'claimed':
      case 'replied': return undefined
    }
  }

  function resolution_(chat: GroupChat, members: TeamMember[]): TeamResolution {
    const editMap = chatEdits(chat.id)
    return resolveTeamPositions(members.map(member => ({ roleId: member.roleId, claim: member.claim, claimOrder: member.claimOrder, position: editMap.get(member.roleId) })), chat.teamFormation?.requiredPositions ?? [])
  }

  // ----- Sending -----

  async function inviteRound(chatId: string): Promise<void> {
    const store = deps.getStore()
    const chat = store.chatsById[chatId]
    const formation = chat?.teamFormation
    if (!chat || !formation || busy) return
    const round = formation.nextRound
    const roles = (formation.rounds[round] ?? []).map(id => store.rolesById[id]).filter((role): role is GroupRole => Boolean(role) && chat.roleIds.includes(role.id))
    busy = true
    try {
      if (roles.length === 0) {
        // Everyone in this round was removed: skip it.
        await deps.runCommand('GROUP_CHAT_UPDATE', { chatId, patch: { teamFormation: { nextRound: round + 1, status: 'claiming' } } })
        return
      }
      const members = collectTeamMembers(store, chat)
      const resolution = resolution_(chat, members)
      const taken = Object.entries(resolution.assignments).map(([roleId, assignment]) => ({ position: assignment.position, holder: store.rolesById[roleId]?.name ?? roleId }))
      const text = buildTeamInvitation({ task: formation.task, teamLabels: teamLabels(store, chatRoles(store, chat)), requiredPositions: formation.requiredPositions, taken, previous: formation.previousPositions, language: language() })
      await deps.runCommand('GROUP_MESSAGE_SEND', { chatId, raw: invitationRaw(store, roles, text), teamInvitation: true, teamRound: round })
    } catch (caught) {
      // Another team page sent this round already.
      if (!message(caught).includes('这一轮已经邀请过了')) deps.showError(message(caught))
    } finally {
      busy = false
      // The next round may already be due (its members' predecessors answered while this one sent).
      refresh()
    }
  }

  async function inviteRepick(chatId: string, resolution: TeamResolution): Promise<void> {
    const store = deps.getStore()
    const chat = store.chatsById[chatId]
    const formation = chat?.teamFormation
    if (!chat || !formation || busy) return
    const roleIds = [...new Set(resolution.conflicts.flatMap(conflict => conflict.roleIds))]
    const roles = roleIds.map(id => store.rolesById[id]).filter((role): role is GroupRole => Boolean(role))
    if (roles.length === 0) return
    const taken = Object.entries(resolution.assignments).map(([roleId, assignment]) => ({ position: assignment.position, holder: store.rolesById[roleId]?.name ?? roleId }))
    const text = buildTeamInvitation({ task: formation.task, teamLabels: teamLabels(store, chatRoles(store, chat)), requiredPositions: formation.requiredPositions, taken, repick: true, language: language() })
    busy = true
    try {
      await deps.runCommand('GROUP_MESSAGE_SEND', { chatId, raw: invitationRaw(store, roles, text), teamInvitation: true })
    } catch (caught) {
      deps.showError(message(caught))
    } finally {
      busy = false
      renderCard()
    }
  }

  async function confirmTeam(chatId: string, members: TeamMember[], positions: Array<{ roleId: string; position: string }>): Promise<void> {
    const chat = deps.getStore().chatsById[chatId]
    const formation = chat?.teamFormation
    if (!chat || !formation || busy) return
    const names = teamMemberNames(positions)
    const lang = language()
    busy = true
    renderCard()
    try {
      const briefs = new Map(members.map(member => {
        const position = positions.find(item => item.roleId === member.roleId)?.position.trim() ?? ''
        return [member.roleId, buildTeamBrief(position, member.claim, lang)] as const
      }))
      for (const member of members) {
        const brief = briefs.get(member.roleId)!
        await deps.runCommand('GROUP_ROLE_UPDATE', {
          roleId: member.roleId,
          patch: { name: names[member.roleId], description: brief.description, systemPrompt: brief.persona },
        })
      }
      await deps.runCommand('GROUP_CHAT_UPDATE', { chatId, patch: { teamFormation: { status: 'confirmed', confirmedAt: Date.now() } } })
      const store = deps.getStore()
      const kickoff = buildTeamKickoff({
        task: formation.task,
        members: members.map(member => ({
          name: store.rolesById[member.roleId]?.name ?? names[member.roleId],
          modelLabel: member.modelLabel,
          responsibility: briefs.get(member.roleId)?.responsibility,
        })),
        language: lang,
      })
      await deps.runCommand('GROUP_MESSAGE_SEND', { chatId, raw: kickoff, refreshPersona: true })
      edits.delete(chatId)
      panel = 'none'
      deps.showSuccess(t('分工已确认，开工消息已发出', 'Positions confirmed; the kickoff message is out'))
    } catch (caught) {
      deps.showError(message(caught))
    } finally {
      busy = false
      renderCard()
    }
  }

  async function startPreset(chatId: string): Promise<void> {
    const store = deps.getStore()
    const chat = store.chatsById[chatId]
    const formation = chat?.teamFormation
    if (!chat || !formation || busy) return
    busy = true
    renderCard()
    try {
      const members = collectTeamMembers(store, chat)
      const kickoff = buildTeamKickoff({
        task: formation.task,
        members: members.map(member => ({ name: member.role.name, modelLabel: member.modelLabel, responsibility: member.role.description && member.role.description !== member.role.name ? member.role.description : undefined })),
        language: language(),
      })
      await deps.runCommand('GROUP_CHAT_UPDATE', { chatId, patch: { teamFormation: { status: 'confirmed', confirmedAt: Date.now() } } })
      await deps.runCommand('GROUP_MESSAGE_SEND', { chatId, raw: kickoff, refreshPersona: true })
      deps.showSuccess(t('已开工', 'Started'))
    } catch (caught) {
      deps.showError(message(caught))
    } finally {
      busy = false
      renderCard()
    }
  }

  async function saveTemplate(chatId: string, name: string): Promise<void> {
    if (busy) return
    busy = true
    try {
      await deps.runCommand('GROUP_TEAM_TEMPLATE_SAVE', { chatId, name: name.trim() })
      panel = 'none'
      deps.showSuccess(t(`已保存团队「${name.trim() || deps.getStore().chatsById[chatId]?.name}」`, `Saved the team "${name.trim() || deps.getStore().chatsById[chatId]?.name}"`))
    } catch (caught) {
      deps.showError(message(caught))
    } finally {
      busy = false
      renderCard()
    }
  }

  // A new phase: the members see their current positions and choose again.
  async function redivide(chatId: string, members: TeamMember[], task: string): Promise<void> {
    const store = deps.getStore()
    const chat = store.chatsById[chatId]
    if (!chat?.teamFormation || busy) return
    if (!task.trim()) {
      deps.showError(t('先写下这一阶段要做什么', 'Describe this phase first'))
      return
    }
    busy = true
    try {
      const roles = chatRoles(store, chat)
      await deps.runCommand('GROUP_CHAT_UPDATE', {
        chatId,
        patch: {
          teamFormation: {
            task: task.trim(),
            status: 'checking',
            preset: false,
            rounds: planTeamRounds(roles.map(role => ({ roleId: role.id, modelKey: teamModelKey(role) }))),
            nextRound: 0,
            invitationIds: [],
            previousPositions: members.map(member => ({ position: store.rolesById[member.roleId]?.name ?? member.role.name, holder: member.modelLabel })),
            confirmedAt: null,
          },
        },
      })
      edits.delete(chatId)
      autoOpened.delete(chatId)
      panel = 'none'
    } catch (caught) {
      deps.showError(message(caught))
    } finally {
      busy = false
      renderCard()
    }
  }

  // ----- Driving rounds -----

  function refresh(): void {
    renderCard()
    const chatId = deps.getCurrentChatId()
    const chat = chatId ? deps.getStore().chatsById[chatId] : undefined
    const formation = chat?.teamFormation
    if (!chat || !formation || formation.status !== 'claiming') return
    const members = collectTeamMembers(deps.getStore(), chat)
    const invited = members.filter(member => member.status !== 'not-invited')
    const previousSettled = invited.every(isTeamMemberSettled)
    if (formation.nextRound < formation.rounds.length && previousSettled && !advancing && !busy) {
      advancing = true
      void inviteRound(chat.id).finally(() => {
        advancing = false
      })
      return
    }
    // Everyone has answered: show the card once per set of invitations.
    if (formation.nextRound >= formation.rounds.length && members.every(isTeamMemberSettled) && autoOpened.get(chat.id) !== formation.invitationIds.length) {
      autoOpened.set(chat.id, formation.invitationIds.length)
      if (!card && !setup) openCard(chat.id)
    }
  }

  function statusBanner(chat: GroupChat): HTMLElement | undefined {
    const formation = chat.teamFormation
    if (!formation || formation.status === 'confirmed') return undefined
    const members = collectTeamMembers(deps.getStore(), chat)
    const answered = members.filter(isTeamMemberSettled).length
    const banner = element('div', 'team-formation-banner')
    banner.append(element('span', 'team-formation-banner-text', formation.status === 'checking' && formation.preset
      ? t('团队已就绪：检查队员的网页后就能开工。', 'The team is ready: check the members\' pages, then start.')
      : formation.status === 'checking'
      ? t('组队中：先检查队员的网页，再邀请它们自荐职位。', 'Forming a team: check the members\' pages, then invite them to choose positions.')
      : t(`组队中：${answered}/${members.length} 位已选好职位。`, `Forming a team: ${answered} of ${members.length} have chosen.`)))
    const open = button(t('查看分工', 'View positions'), 'btn btn-small')
    open.addEventListener('click', () => openCard(chat.id))
    banner.append(open)
    return banner
  }

  function isInvitation(chat: GroupChat, messageId: string): boolean {
    return Boolean(chat.teamFormation?.invitationIds.includes(messageId))
  }

  function renderClaim(message: GroupMessage): HTMLElement | undefined {
    const chat = deps.getStore().chatsById[message.chatId]
    if (!chat || !message.sourceMessageId || !isInvitation(chat, message.sourceMessageId)) return undefined
    const claim = parseTeamClaim(message.content)
    if (!claim) return undefined
    const wrapper = element('div', 'team-claim-message')
    wrapper.append(element('p', 'team-claim-title', claim.secondChoice
      ? t(`⚑ 想当「${claim.firstChoice}」，备选「${claim.secondChoice}」`, `⚑ Wants "${claim.firstChoice}", fallback "${claim.secondChoice}"`)
      : t(`⚑ 想当「${claim.firstChoice}」`, `⚑ Wants "${claim.firstChoice}"`)))
    const details = element('dl', 'team-card-details')
    const add = (label: string, value: string | undefined) => {
      if (value) details.append(element('dt', '', label), element('dd', '', value))
    }
    add(t('理由', 'Why'), claim.why)
    add(t('负责', 'Responsible for'), claim.responsibility)
    add(t('不负责', 'Not responsible for'), claim.notResponsible)
    add(t('先交付', 'Delivers first'), claim.firstDeliverable)
    if (claim.neededPositions.length > 0) add(t('项目需要', 'Project needs'), claim.neededPositions.join(t('、', ', ')))
    if (details.childElementCount > 0) wrapper.append(details)
    return wrapper
  }

  // ----- Small helpers -----

  function uiHealth(health: RolePageHealth): string {
    const label = rolePageHealthLabel(health)
    if (language() !== 'en') return label
    return ({
      网页未打开: 'Page not open', 正在打开网页: 'Opening the page', 网页没有响应: 'Page not responding', 正在检查网页: 'Checking the page', 网页加载中: 'Page loading',
      可以发送: 'Ready', '可以发送（未登录）': 'Ready (signed out)', 网页回复中: 'Replying', 需要登录: 'Sign-in needed', 需要人机验证: 'Verification needed',
      网站拒绝访问: 'Site refused access', 有弹窗挡住页面: 'A dialog covers the page', 页面被拦截: 'Page blocked', 找不到输入框: 'No input box', 网站报错: 'Site error', 网页异常: 'Page problem',
    } as Record<string, string>)[label] ?? label
  }

  function modelPill(member: TeamMember): HTMLElement {
    const site = member.role.modelSource === 'external' ? 'external' : member.role.chatSite ?? deps.getStore().settings.defaultChatSite
    return element('span', `role-site-badge site-pill-${site}`, member.modelLabel)
  }

  function closeButton(onClick: () => void): HTMLButtonElement {
    const close = button('×', 'icon-btn modal-close')
    close.setAttribute('aria-label', t('关闭', 'Close'))
    close.addEventListener('click', onClick)
    return close
  }

  function stepButton(text: string, label: string): HTMLButtonElement {
    const step = button(text, 'icon-btn team-setup-step')
    step.setAttribute('aria-label', label)
    return step
  }

  return { openSetup, openCard, refresh, statusBanner, isInvitation, renderClaim }
}

function chatRoles(store: OpenTeamStore, chat: GroupChat): GroupRole[] {
  return chat.roleIds.map(id => store.rolesById[id]).filter((role): role is GroupRole => Boolean(role))
}

function totalCount(counts: Map<string, number>): number {
  return [...counts.values()].reduce((sum, count) => sum + count, 0)
}

function field(label: string, forId?: string): HTMLElement {
  const wrapper = element('div', 'field')
  const labelEl = element('label', '', label)
  if (forId) labelEl.htmlFor = forId
  wrapper.append(labelEl)
  return wrapper
}

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

function button(text: string, className: string): HTMLButtonElement {
  const node = element('button', className, text)
  node.type = 'button'
  return node
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
