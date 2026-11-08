import { roleMentionLabel, roleModelLabel, roleMentionLabelOptionsFromSettings } from './mentionParser'
import { collectReplies, type ComparedReplyStatus } from './replyComparison'
import { ROLE_NAME_MAX_CHARACTERS } from './roleTemplates'
import { isChatSite } from './chatSites'
import type { GroupChat, GroupMessage, GroupRole, OpenTeamLanguage, OpenTeamStore, TeamFormation, TeamTemplate, TeamTemplateMember } from './types'

export const TEAM_MIN_MEMBERS = 2
// Every member is a web page (or an API call) of its own, so a bigger team is heavier to run.
export const TEAM_MAX_MEMBERS = 12
export const TEAM_MAX_COPIES_PER_MODEL = 5
export const TEAM_MAX_TEMPLATES = 20

// What a member answered when asked which position it wants.
export interface TeamClaim {
  firstChoice: string
  secondChoice?: string
  why?: string
  responsibility?: string
  notResponsible?: string
  firstDeliverable?: string
  neededPositions: string[]
}

export type TeamMemberStatus = 'not-invited' | ComparedReplyStatus | 'unreadable' | 'claimed'

export interface TeamMember {
  roleId: string
  role: GroupRole
  modelLabel: string
  status: TeamMemberStatus
  claim?: TeamClaim
  // Which invitation the claim answered (0 = the first): an earlier claim wins a clash.
  claimOrder?: number
  // The reply's text, kept for a reply that could not be read as a claim.
  replyText?: string
}

export interface TeamAssignment {
  position: string
  from: 'first' | 'second'
}

export interface TeamResolution {
  assignments: Record<string, TeamAssignment>
  // Positions wanted by more than one member. roleIds are the members who have to change; holderRoleId
  // is who keeps the position, when someone does (it claimed earlier, or the user typed it).
  conflicts: Array<{ position: string; roleIds: string[]; holderRoleId?: string }>
  // Positions the task needs that nobody holds, most mentioned first.
  uncovered: Array<{ position: string; mentions: number; required: boolean }>
}

// Rounds of invitations: one copy of every model first, then the next copies, so a copy picks after
// seeing what the earlier copy of its model took (the same model given the same prompt would pick
// the same position).
export function planTeamRounds(members: Array<{ roleId: string; modelKey: string }>): string[][] {
  const rounds: string[][] = []
  const copiesSeen = new Map<string, number>()
  for (const member of members) {
    const copy = copiesSeen.get(member.modelKey) ?? 0
    copiesSeen.set(member.modelKey, copy + 1)
    ;(rounds[copy] ??= []).push(member.roleId)
  }
  return rounds
}

export function teamModelKey(role: Pick<GroupRole, 'modelSource' | 'externalModelId' | 'chatSite'>): string {
  return role.modelSource === 'external' ? `external:${role.externalModelId ?? ''}` : `site:${role.chatSite ?? ''}`
}

export function splitPositions(value: string): string[] {
  return uniquePositions(value.split(/[,，、;；\n]+/))
}

function uniquePositions(values: string[]): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const value of values) {
    const position = value.trim()
    const key = normalizePosition(position)
    if (!key || seen.has(key)) continue
    seen.add(key)
    result.push(position)
  }
  return result
}

// Compares position names loosely: case, spaces and punctuation do not matter.
export function normalizePosition(value: string | undefined): string {
  return (value ?? '').toLowerCase().replace(/[\s()（）\[\]【】「」"'“”‘’·•\-_/\\|,，、.。:：;；!！?？]+/g, '')
}

function samePosition(a: string, b: string): boolean {
  const left = normalizePosition(a)
  const right = normalizePosition(b)
  return Boolean(left) && left === right
}

// "测试" is covered by "测试工程师", and "前端开发工程师" by "前端开发".
function covers(assigned: string, needed: string): boolean {
  const left = normalizePosition(assigned)
  const right = normalizePosition(needed)
  return Boolean(left && right) && (left.includes(right) || right.includes(left))
}

export function buildTeamInvitation(input: {
  task: string
  teamLabels: string[]
  requiredPositions: string[]
  taken?: Array<{ position: string; holder: string }>
  // The current positions, when members divide the work again for a new phase.
  previous?: Array<{ position: string; holder: string }>
  repick?: boolean
  language: OpenTeamLanguage
}): string {
  const english = input.language === 'en'
  const taken = input.taken ?? []
  const lines = english
    ? [
        input.repick ? 'Some of you picked the same position. Please choose again.' : 'We are forming a team for this task:',
        '',
        input.task.trim(),
        '',
        `Team: ${input.teamLabels.join(', ')} (all AIs, each in its own chat window).`,
      ]
    : [
        input.repick ? '有几位选了同一个职位，请重新选择。' : '我们要组队完成这件事：',
        '',
        input.task.trim(),
        '',
        `团队成员：${input.teamLabels.join('、')}（都是 AI，各自在自己的网页里）。`,
      ]
  if (input.previous && input.previous.length > 0) {
    lines.push(
      english ? 'This is a new phase. The positions so far (keep yours or change it):' : '这是新阶段。到目前为止的分工（可以保持，也可以换）：',
      ...input.previous.map(item => `- ${item.position}${english ? ` (${item.holder})` : `（${item.holder}）`}`),
    )
  }
  if (input.requiredPositions.length > 0) {
    lines.push(english ? `Positions the team must have: ${input.requiredPositions.join(', ')}.` : `团队必须有的职位：${input.requiredPositions.join('、')}。`)
  }
  if (taken.length > 0) {
    lines.push(
      english ? 'Already taken (choose a different one):' : '这些职位已经有人了（请选别的）：',
      ...taken.map(item => `- ${item.position}${english ? ` (${item.holder})` : `（${item.holder}）`}`),
    )
  }
  lines.push(
    '',
    english
      ? 'Decide which position on this project suits you best. Answer only in the JSON below, inside a ```json code block, with nothing else:'
      : '请判断你在这个项目里最适合哪个职位。只用下面的 JSON 格式回答，放在 ```json 代码块里，不要写别的内容：',
    '```json',
    english
      ? JSON.stringify({
          first_choice: 'the position you want most',
          second_choice: 'your fallback if someone else takes your first choice',
          why: 'one sentence: why you suit it',
          responsibility: 'what you are responsible for',
          not_responsible: 'what you are not responsible for',
          first_deliverable: 'what you will deliver first',
          needed_positions: ['every position this project needs'],
        }, null, 2)
      : JSON.stringify({
          first_choice: '你最想担任的职位',
          second_choice: '第一选择被别人选了时的备选职位',
          why: '一句话：为什么你适合',
          responsibility: '你负责什么',
          not_responsible: '你不负责什么',
          first_deliverable: '你会先交付什么',
          needed_positions: ['这个项目需要的所有职位'],
        }, null, 2),
    '```',
  )
  return lines.join('\n')
}

// Reads a claim from a reply: the ```json block, or the first {...} in it. Keys may be in English or
// Chinese.
export function parseTeamClaim(content: string): TeamClaim | undefined {
  for (const candidate of jsonCandidates(content)) {
    const value = parseLooseJson(candidate)
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue
    const record = value as Record<string, unknown>
    const firstChoice = readText(record, ['first_choice', 'firstChoice', 'position', '第一选择', '职位'])
    if (!firstChoice) continue
    const secondChoice = readText(record, ['second_choice', 'secondChoice', '第二选择', '备选职位'])
    return {
      firstChoice,
      ...(secondChoice && !samePosition(secondChoice, firstChoice) ? { secondChoice } : {}),
      ...optional('why', readText(record, ['why', 'reason', '理由', '为什么'])),
      ...optional('responsibility', readText(record, ['responsibility', 'responsibilities', '负责'])),
      ...optional('notResponsible', readText(record, ['not_responsible', 'notResponsible', '不负责'])),
      ...optional('firstDeliverable', readText(record, ['first_deliverable', 'firstDeliverable', '第一份交付', '先交付'])),
      neededPositions: uniquePositions(readList(record, ['needed_positions', 'neededPositions', '需要的职位'])),
    }
  }
  return undefined
}

function jsonCandidates(content: string): string[] {
  const candidates = [...content.matchAll(/```(?:json)?\s*\n([\s\S]*?)```/gi)].map(match => match[1])
  const start = content.indexOf('{')
  const end = content.lastIndexOf('}')
  if (start >= 0 && end > start) candidates.push(content.slice(start, end + 1))
  return candidates
}

function parseLooseJson(text: string): unknown {
  for (const attempt of [text, text.replace(/,\s*([}\]])/g, '$1'), text.replace(/[“”]/g, '"')]) {
    try {
      return JSON.parse(attempt)
    } catch {
      // Try the next, more forgiving form.
    }
  }
  return undefined
}

function readText(record: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
    if (Array.isArray(value) && value.length > 0) return value.filter(item => typeof item === 'string').join('；').trim() || undefined
  }
  return undefined
}

function readList(record: Record<string, unknown>, keys: string[]): string[] {
  for (const key of keys) {
    const value = record[key]
    if (Array.isArray(value)) return value.filter((item): item is string => typeof item === 'string')
    if (typeof value === 'string') return value.split(/[,，、;；\n]+/)
  }
  return []
}

function optional<K extends string>(key: K, value: string | undefined): Partial<Record<K, string>> {
  return value ? { [key]: value } as Record<K, string> : {}
}

// Gives each member a position: its first choice when nobody else wants it, otherwise its second
// choice when that is free. In a clash, a member that claimed earlier (answered an earlier
// invitation) or whose position the user typed keeps the position. Among equals, one keeps it (one
// with nowhere else to go, or the first) only if all the others can move. Whoever is left over is a
// conflict, for the user or for another round.
export function resolveTeamPositions(members: Array<{ roleId: string; claim?: TeamClaim; position?: string; claimOrder?: number }>, requiredPositions: string[] = []): TeamResolution {
  const assignments: Record<string, TeamAssignment> = {}
  const fixed = members.filter(member => member.position?.trim())
  for (const member of fixed) assignments[member.roleId] = { position: member.position!.trim(), from: 'first' }
  const holderOf = (position: string) => fixed.find(member => samePosition(member.position!, position))?.roleId
  const claimants = members.filter(member => !member.position?.trim() && member.claim)
  const taken = () => Object.values(assignments).map(assignment => assignment.position)
  const conflicts: TeamResolution['conflicts'] = []

  const groups = new Map<string, typeof claimants>()
  for (const member of claimants) {
    const key = normalizePosition(member.claim!.firstChoice)
    groups.set(key, [...(groups.get(key) ?? []), member])
  }
  const firstChoiceKeys = new Set(groups.keys())
  const order = (member: typeof claimants[number]) => member.claimOrder ?? 0

  for (const group of groups.values()) {
    const position = group[0].claim!.firstChoice
    const typedHolder = holderOf(position)
    if (group.length === 1 && !typedHolder) {
      assignments[group[0].roleId] = { position, from: 'first' }
      continue
    }
    const freeSecond = (member: typeof group[number]) => {
      const second = member.claim!.secondChoice
      return Boolean(second) && !firstChoiceKeys.has(normalizePosition(second)) && !taken().some(other => samePosition(other, second!))
    }
    let keeper: typeof group[number] | undefined
    let holderRoleId = typedHolder
    if (!typedHolder) {
      const earliest = Math.min(...group.map(order))
      const first = group.filter(member => order(member) === earliest)
      if (first.length === 1 && group.some(member => order(member) > earliest)) {
        // It claimed before the others were even asked: it keeps the position.
        keeper = first[0]
        holderRoleId = keeper.roleId
      } else {
        keeper = first.find(member => !freeSecond(member)) ?? first[0]
      }
    }
    const unresolved: string[] = []
    for (const member of group) {
      if (member === keeper) {
        assignments[member.roleId] = { position, from: 'first' }
      } else if (freeSecond(member)) {
        assignments[member.roleId] = { position: member.claim!.secondChoice!, from: 'second' }
      } else {
        unresolved.push(member.roleId)
      }
    }
    if (unresolved.length === 0) continue
    if (holderRoleId) {
      conflicts.push({ position, roleIds: unresolved, holderRoleId })
    } else {
      // Equals with nowhere to go: all of them are in the conflict, including the one kept so far.
      if (keeper) delete assignments[keeper.roleId]
      conflicts.push({ position, roleIds: [...(keeper ? [keeper.roleId] : []), ...unresolved] })
    }
  }

  const held = Object.values(assignments).map(assignment => assignment.position).concat(conflicts.map(conflict => conflict.position))
  const mentions = new Map<string, { position: string; mentions: number; required: boolean }>()
  const mention = (position: string, required: boolean) => {
    const key = normalizePosition(position)
    if (!key) return
    const entry = [...mentions.entries()].find(([existing]) => existing.includes(key) || key.includes(existing))
    if (entry) {
      entry[1].mentions += required ? 0 : 1
      entry[1].required ||= required
    } else {
      mentions.set(key, { position: position.trim(), mentions: required ? 0 : 1, required })
    }
  }
  for (const position of requiredPositions) mention(position, true)
  for (const member of members) for (const position of member.claim?.neededPositions ?? []) mention(position, false)
  const uncovered = [...mentions.values()]
    .filter(entry => !held.some(position => covers(position, entry.position)))
    .sort((a, b) => Number(b.required) - Number(a.required) || b.mentions - a.mentions)
  return { assignments, conflicts, uncovered }
}

// Each member's latest answer across all invitations it got, and where it stands.
export function collectTeamMembers(store: OpenTeamStore, chat: GroupChat): TeamMember[] {
  const formation = chat.teamFormation
  const options = roleMentionLabelOptionsFromSettings(store.settings)
  const invitations = (formation?.invitationIds ?? []).map(id => store.messagesById[id]).filter((message): message is GroupMessage => message?.type === 'user')
  return chat.roleIds.flatMap((roleId): TeamMember[] => {
    const role = store.rolesById[roleId]
    if (!role) return []
    const modelLabel = roleModelLabel(role, options)
    const invitation = [...invitations].reverse().find(message => message.targetRoleIds?.includes(roleId))
    if (!invitation) return [{ roleId, role, modelLabel, status: 'not-invited' as const }]
    const claimOrder = invitations.indexOf(invitation)
    const reply = collectReplies(store, invitation).replies.find(item => item.roleId === roleId)
    if (!reply || reply.status !== 'replied' || !reply.message) return [{ roleId, role, modelLabel, status: reply?.status ?? 'waiting' }]
    const claim = parseTeamClaim(reply.message.content)
    return [claim
      ? { roleId, role, modelLabel, status: 'claimed' as const, claim, claimOrder }
      : { roleId, role, modelLabel, status: 'unreadable' as const, replyText: reply.message.content }]
  })
}

export function isTeamMemberSettled(member: TeamMember): boolean {
  return member.status === 'claimed' || member.status === 'unreadable' || member.status === 'failed'
}

// Labels for the invitation's team line: "Claude", "Claude ×2".
export function teamLabels(store: OpenTeamStore, roles: GroupRole[]): string[] {
  const options = roleMentionLabelOptionsFromSettings(store.settings)
  const counts = new Map<string, number>()
  for (const role of roles) {
    const label = roleModelLabel(role, options)
    counts.set(label, (counts.get(label) ?? 0) + 1)
  }
  return [...counts].map(([label, count]) => count > 1 ? `${label} ×${count}` : label)
}

export function invitationRaw(store: OpenTeamStore, roles: GroupRole[], text: string): string {
  const options = roleMentionLabelOptionsFromSettings(store.settings)
  return `${roles.map(role => `@${roleMentionLabel(role, options)}`).join(' ')} ${text}`
}

export interface TeamBrief {
  // The member's description, which every member sees in the member list.
  description: string
  persona: string
  responsibility?: string
}

// What a member is told about its position. What it wrote (responsible for, first deliverable)
// describes its first choice, so it is used only when it got its first choice; a member moved to its
// second choice, or given a position by the user, gets the position alone.
export function buildTeamBrief(position: string, claim: TeamClaim | undefined, language: OpenTeamLanguage): TeamBrief {
  const english = language === 'en'
  const ownChoice = claim && samePosition(claim.firstChoice, position)
  const second = claim?.secondChoice && samePosition(claim.secondChoice, position)
  const lines = [ownChoice
    ? (english ? `On this project you are the ${position}. You chose this position yourself when the team was formed.` : `你在这个项目中担任「${position}」，这是你自己在组队时选的职位。`)
    : second
      ? (english ? `On this project you are the ${position}, your second choice: someone else took "${claim!.firstChoice}". Plan your work for this position.` : `你在这个项目中担任「${position}」，这是你的第二选择：「${claim!.firstChoice}」已经有人了。请按这个职位安排你的工作。`)
      : (english ? `On this project you are the ${position}. The user gave you this position when the team was formed. Plan your work for it.` : `你在这个项目中担任「${position}」，这是组队时用户给你定的职位。请按这个职位安排你的工作。`)]
  const details = ownChoice ? claim : undefined
  if (details?.responsibility) lines.push(english ? `You are responsible for: ${details.responsibility}` : `你负责：${details.responsibility}`)
  if (details?.notResponsible) lines.push(english ? `You are not responsible for: ${details.notResponsible}` : `你不负责：${details.notResponsible}`)
  if (details?.firstDeliverable) lines.push(english ? `You will deliver first: ${details.firstDeliverable}` : `你会先交付：${details.firstDeliverable}`)
  return {
    description: details?.responsibility ?? position,
    persona: lines.join('\n'),
    ...(details?.responsibility ? { responsibility: details.responsibility } : {}),
  }
}

// Member names after the positions are confirmed: the position without spaces or "@" (names cannot
// hold them), kept unique and within the limit.
export function teamMemberNames(positions: Array<{ roleId: string; position: string }>): Record<string, string> {
  const names: Record<string, string> = {}
  const used = new Set<string>()
  for (const { roleId, position } of positions) {
    const cleaned = [...position.replace(/[\s@]+/g, '')].slice(0, ROLE_NAME_MAX_CHARACTERS - 3).join('')
    const base = cleaned && cleaned.toLowerCase() !== 'all' ? cleaned : 'member'
    let name = base
    for (let index = 2; used.has(normalizePosition(name)); index += 1) name = `${base}${index}`
    used.add(normalizePosition(name))
    names[roleId] = name
  }
  return names
}

export function buildTeamKickoff(input: { task: string; members: Array<{ name: string; modelLabel: string; responsibility?: string }>; language: OpenTeamLanguage }): string {
  const english = input.language === 'en'
  return [
    english ? '@all The positions are settled. Let us start.' : '@所有人 分工已经确定，开始工作吧。',
    '',
    english ? 'Task:' : '任务：',
    input.task.trim(),
    '',
    english ? 'Positions:' : '分工：',
    ...input.members.map(member => `- ${member.name}${english ? ` (${member.modelLabel})` : `（${member.modelLabel}）`}${member.responsibility ? `${english ? ': ' : '：'}${member.responsibility}` : ''}`),
    '',
    english
      ? 'Start with the first deliverable you named. When you need someone else, address them by name.'
      : '请先完成你说的第一份交付。需要别人配合时，直接点名对方。',
  ].join('\n')
}

// A confirmed team's project goal: the task, and who holds which position, for the coordinator to
// plan the steps by.
export function buildTeamProjectGoal(input: { task: string; members: Array<{ name: string; responsibility?: string }>; language: OpenTeamLanguage }): string {
  const english = input.language === 'en'
  return [
    input.task.trim(),
    '',
    english ? 'The team and its positions (plan the tasks by them):' : '团队分工（请按这个分工安排任务）：',
    ...input.members.map(member => `- ${member.name}${member.responsibility ? `${english ? ': ' : '：'}${member.responsibility}` : ''}`),
  ].join('\n')
}

// Accepts only a well-formed formation, so a malformed patch cannot break the group.
export function readTeamFormation(value: unknown, now: number): TeamFormation | undefined {
  if (!value || typeof value !== 'object') return undefined
  const record = value as Record<string, unknown>
  const task = typeof record.task === 'string' ? record.task.trim() : ''
  if (!task) return undefined
  const status = record.status === 'claiming' || record.status === 'confirmed' ? record.status : 'checking'
  const rounds = Array.isArray(record.rounds)
    ? record.rounds.map(round => Array.isArray(round) ? round.filter((id): id is string => typeof id === 'string') : []).filter(round => round.length > 0)
    : []
  const invitationIds = Array.isArray(record.invitationIds) ? record.invitationIds.filter((id): id is string => typeof id === 'string') : []
  const nextRound = typeof record.nextRound === 'number' && Number.isInteger(record.nextRound) ? Math.min(Math.max(record.nextRound, 0), rounds.length) : 0
  const requiredPositions = Array.isArray(record.requiredPositions) ? uniquePositions(record.requiredPositions.filter((item): item is string => typeof item === 'string')) : []
  const previousPositions = Array.isArray(record.previousPositions)
    ? record.previousPositions.flatMap(item => item && typeof item === 'object' && typeof (item as Record<string, unknown>).position === 'string' && typeof (item as Record<string, unknown>).holder === 'string'
      ? [{ position: (item as { position: string }).position, holder: (item as { holder: string }).holder }]
      : [])
    : []
  return {
    task,
    requiredPositions,
    status,
    rounds,
    nextRound,
    invitationIds,
    ...(record.preset === true ? { preset: true } : {}),
    ...(previousPositions.length > 0 ? { previousPositions } : {}),
    ...(typeof record.materialsMessageId === 'string' && record.materialsMessageId ? { materialsMessageId: record.materialsMessageId } : {}),
    createdAt: typeof record.createdAt === 'number' ? record.createdAt : now,
    ...(typeof record.confirmedAt === 'number' ? { confirmedAt: record.confirmedAt } : {}),
  }
}

// Asks the orchestration planner for a flow that uses the team as it is, by position.
export function buildTeamFlowInstruction(members: Array<{ name: string; modelLabel: string; description?: string }>, language: OpenTeamLanguage): string {
  const english = language === 'en'
  return [
    english
      ? `Use only the ${members.length} existing people in this chat. They have already divided the work by position:`
      : `只使用群聊里现有的 ${members.length} 位成员，他们已经按职位分好工：`,
    ...members.map(member => `- ${member.name}${english ? ` (${member.modelLabel})` : `（${member.modelLabel}）`}${member.description && member.description !== member.name ? `${english ? ': ' : '：'}${member.description}` : ''}`),
    english
      ? 'Do not create new people and do not change their personas. Give each node to the person whose position fits it, let work that depends on other work wait for it, and end with a review by the person best placed to judge the result.'
      : '不要新建成员，也不要改他们的人设。每个节点交给职位最合适的人；依赖别人产出的工作排在后面；最后由最适合把关的人审核结果。',
  ].join('\n')
}

// A saved team: the members' positions, personas and models, to start the same line-up again.
export function teamTemplateFromChat(store: OpenTeamStore, chat: GroupChat, name: string, id: string, now: number): TeamTemplate {
  const members: TeamTemplateMember[] = chat.roleIds.flatMap(roleId => {
    const role = store.rolesById[roleId]
    if (!role) return []
    return [{
      name: role.name,
      ...(role.description ? { description: role.description } : {}),
      ...(role.systemPrompt ? { systemPrompt: role.systemPrompt } : {}),
      modelSource: role.modelSource === 'external' ? 'external' as const : 'site' as const,
      ...(role.modelSource === 'external' ? { externalModelId: role.externalModelId } : { chatSite: role.chatSite ?? store.settings.defaultChatSite }),
    }]
  })
  return { id, name: name.trim() || chat.name, task: chat.teamFormation?.task ?? '', members, createdAt: now }
}

export function normalizeTeamTemplates(raw: unknown): TeamTemplate[] {
  if (!Array.isArray(raw)) return []
  return raw.flatMap((item): TeamTemplate[] => {
    if (!item || typeof item !== 'object') return []
    const record = item as Record<string, unknown>
    if (typeof record.id !== 'string' || typeof record.name !== 'string' || !record.name.trim() || !Array.isArray(record.members)) return []
    const members = record.members.flatMap((value): TeamTemplateMember[] => {
      if (!value || typeof value !== 'object') return []
      const member = value as Record<string, unknown>
      if (typeof member.name !== 'string' || !member.name.trim()) return []
      const external = member.modelSource === 'external'
      if (external ? typeof member.externalModelId !== 'string' : !isChatSite(member.chatSite)) return []
      return [{
        name: member.name.trim(),
        ...(typeof member.description === 'string' && member.description.trim() ? { description: member.description.trim() } : {}),
        ...(typeof member.systemPrompt === 'string' && member.systemPrompt.trim() ? { systemPrompt: member.systemPrompt.trim() } : {}),
        modelSource: external ? 'external' : 'site',
        ...(external ? { externalModelId: member.externalModelId as string } : { chatSite: member.chatSite as TeamTemplateMember['chatSite'] }),
      }]
    })
    if (members.length < TEAM_MIN_MEMBERS) return []
    return [{ id: record.id, name: record.name.trim(), task: typeof record.task === 'string' ? record.task : '', members, createdAt: typeof record.createdAt === 'number' ? record.createdAt : 0 }]
  }).slice(0, TEAM_MAX_TEMPLATES)
}
