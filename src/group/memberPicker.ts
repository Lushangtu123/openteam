// 添加成员 → 让 AI 按任务挑: one API model reads the task, the group's members and the role library,
// and suggests who to add, each with a role and one of the models the user ticked. The user sees the
// list and adds what they keep (src/teamPage/memberPickDialog.ts). Roles come from the library, are
// written for the task, or both, as the user chose. What the model answers is checked here: unknown
// roles and models are dropped or replaced, names are made unique, and the list is cut to the limit.
import { normalizeLanguage } from '../shared/i18n'
import { CHAT_SITES, chatSiteLabel } from './chatSites'
import { extractJsonObject } from './project'
import { isOpenTeamRequest } from './roundSummary'
import { isReservedRoleName, ROLE_NAME_MAX_CHARACTERS } from './roleProfile'
import type { ChatSite, ExternalModelConfig, GroupChat, GroupMessage, GroupRole, OpenTeamLanguage, OpenTeamStore, RoleTemplate } from './types'

export type MemberPickSource = 'library-first' | 'new' | 'library-only'
export const MEMBER_PICK_SOURCES: MemberPickSource[] = ['library-first', 'new', 'library-only']
export const MEMBER_PICK_MAX = 6
const DESCRIPTION_MAX = 120
const PROMPT_MAX = 1_500
const WHY_MAX = 160
const LIBRARY_DESCRIPTION_IN_PROMPT = 80

export interface MemberPickModel {
  // "site:kimi" or "external:<model id>", as the add-member window keys them.
  key: string
  label: string
}

export type MemberPick = {
  name: string
  description?: string
  model: string
  why?: string
} & ({ kind: 'library'; templateId: string } | { kind: 'new'; systemPrompt: string })

export function isMemberPickSource(value: unknown): value is MemberPickSource {
  return MEMBER_PICK_SOURCES.includes(value as MemberPickSource)
}

export function memberPickModelKey(role: Pick<GroupRole, 'modelSource' | 'externalModelId' | 'chatSite'>, fallbackSite: ChatSite): string {
  return role.modelSource === 'external' && role.externalModelId ? `external:${role.externalModelId}` : `site:${role.chatSite ?? fallbackSite}`
}

// The models a member may be given: every web site and the API models (local agents too).
export function memberPickModels(store: OpenTeamStore, keys?: string[]): MemberPickModel[] {
  const all: MemberPickModel[] = [
    ...CHAT_SITES.map(site => ({ key: `site:${site}`, label: chatSiteLabel(site) })),
    ...store.settings.externalModelOrder
      .map(id => store.settings.externalModelsById[id])
      .filter((model): model is ExternalModelConfig => Boolean(model))
      .map(model => ({ key: `external:${model.id}`, label: model.format === 'local-agent' ? `${model.name}（本机智能体）` : `API · ${model.name}` })),
  ]
  return keys ? all.filter(model => keys.includes(model.key)) : all
}

// The models that can plan: API models, not local agents (they work only as members).
export function memberPickPlanners(store: OpenTeamStore): ExternalModelConfig[] {
  return store.settings.externalModelOrder
    .map(id => store.settings.externalModelsById[id])
    .filter((model): model is ExternalModelConfig => Boolean(model) && model!.format !== 'local-agent')
}

// What the group is working on, to start the window with: the latest message the user wrote.
export function latestTaskText(store: OpenTeamStore, chat: GroupChat): string {
  for (let index = chat.messageIds.length - 1; index >= 0; index -= 1) {
    const message: GroupMessage | undefined = store.messagesById[chat.messageIds[index]]
    if (message?.type !== 'user' || isOpenTeamRequest(message) || chat.teamFormation?.invitationIds.includes(message.id)) continue
    const text = message.content.replace(/@[^\s@]+/g, '').trim()
    if (text) return text.slice(0, 2_000)
  }
  return chat.description?.trim() ?? ''
}

export function buildMemberPickPrompt(input: {
  task: string
  members: GroupRole[]
  library: RoleTemplate[]
  models: MemberPickModel[]
  source: MemberPickSource
  count?: number
  // How roles did before on these models (src/group/memberRecord.ts memberRecordLines).
  records?: string[]
  language?: OpenTeamLanguage
}): string {
  const en = normalizeLanguage(input.language) === 'en'
  const most = Math.min(input.count ?? MEMBER_PICK_MAX, MEMBER_PICK_MAX)
  const library = input.source === 'new' ? [] : input.library
  const lines: string[] = []
  lines.push(en
    ? 'You pick members for an AI group chat. Read the task and the members already there, and suggest who to add so the group can do the task well.'
    : '你在为一个 AI 群聊挑选成员。读一下任务和群里已有的成员，建议再加哪些成员，让这个群能把任务做好。')
  lines.push(`${en ? 'Task' : '任务'}:\n${input.task.trim()}`)
  lines.push(input.members.length
    ? `${en ? 'Members already in the group (do not repeat their roles)' : '群里已有的成员（不要重复他们的角色）'}:\n${input.members.map(role => `- ${role.name}${role.description ? `: ${role.description}` : ''}`).join('\n')}`
    : (en ? 'The group has no members yet.' : '群里还没有成员。'))
  if (library.length) {
    lines.push(`${en ? 'Role library (use the id to pick one)' : '角色库（用 id 选用）'}:\n${library.map(template => `- id=${template.id} | ${template.name}${template.description ? ` | ${template.description.slice(0, LIBRARY_DESCRIPTION_IN_PROMPT)}` : ''}`).join('\n')}`)
  }
  lines.push(`${en ? 'Models you may give members (use the key exactly)' : '可以分配给成员的模型（key 照抄）'}:\n${input.models.map(model => `- key=${model.key} | ${model.label}`).join('\n')}`)
  const records = input.records ?? []
  if (records.length) {
    lines.push(`${en ? 'How these roles did before on these models (from replies the user kept or asked again)' : '这些角色以前在这些模型上的表现（来自用户留用或要求重答的回答）'}:\n${records.join('\n')}`)
  }
  const rule = input.source === 'library-only'
    ? (en ? 'Pick only from the role library, by id.' : '只能从角色库里选，用 id。')
    : input.source === 'new'
      ? (en ? 'Write every role for this task: a short name, one line on what it covers, and its persona (how it works and what it checks).' : '每个角色都按这个任务新写：简短的名称、一句话说明负责什么、它的人设（怎么做、重点检查什么）。')
      : (en ? 'Prefer roles from the library, by id. Only when none fits, write a new one: a short name, one line on what it covers, and its persona.' : '优先从角色库里选，用 id。没有合适的再新写：简短的名称、一句话说明负责什么、它的人设。')
  lines.push([
    rule,
    en ? `Suggest 1 to ${most} members, only as many as the task needs; none of them may duplicate a role already in the group.` : `建议 1 到 ${most} 位成员，任务需要几位就几位；不要和群里已有的角色重复。`,
    en ? 'Give each one the model that suits its role best; different models for different roles help the group see more sides.' : '给每位成员选最适合它角色的模型；不同角色用不同模型，群里能看到更多角度。',
    en ? 'Say in "why" in one sentence what this member adds to the task.' : '在 why 里用一句话说这位成员对任务的作用。',
    ...(records.length ? [en
      ? 'A role on a model with replies the user kept has proven itself: prefer it when it fits the task. Many replies asked again mean the user was not satisfied with that role on that model.'
      : '用户留用过回答的角色和模型组合更可靠：适合任务时优先用。要求重答多的，说明用户对这个角色用这个模型不满意。'] : []),
  ].join('\n'))
  lines.push(en
    ? 'Answer with JSON only, in this form:\n{"members":[{"templateId":"library id, or empty for a new role","name":"name","description":"one line","systemPrompt":"persona, for a new role","model":"model key","why":"one sentence"}]}'
    : '只回答 JSON，格式如下：\n{"members":[{"templateId":"角色库 id，新角色留空","name":"名称","description":"一句话","systemPrompt":"人设，新角色才写","model":"模型 key","why":"一句话"}]}')
  return lines.join('\n\n')
}

// The model's answer, checked. Throws when it holds no member that can be added.
export function parseMemberPicks(content: string, input: {
  library: RoleTemplate[]
  models: MemberPickModel[]
  source: MemberPickSource
  takenNames: string[]
  count?: number
}): MemberPick[] {
  const raw = extractJsonObject(content)
  const list = Array.isArray(raw?.members) ? raw.members : undefined
  if (!list) throw new Error('模型没有按格式给出成员名单')
  const most = Math.min(input.count ?? MEMBER_PICK_MAX, MEMBER_PICK_MAX)
  const byId = new Map(input.library.map(template => [template.id, template]))
  const byName = new Map(input.library.map(template => [template.name.trim().toLowerCase(), template]))
  const modelKeys = new Set(input.models.map(model => model.key))
  const taken = new Set(input.takenNames.map(name => name.trim().toLowerCase()))
  const usedTemplates = new Set<string>()
  const picks: MemberPick[] = []
  let nextModel = 0
  for (const item of list) {
    if (picks.length >= most) break
    if (!item || typeof item !== 'object') continue
    const entry = item as Record<string, unknown>
    const text = (value: unknown, max: number) => typeof value === 'string' ? value.trim().slice(0, max) : ''
    const id = text(entry.templateId, 200)
    const named = text(entry.name, ROLE_NAME_MAX_CHARACTERS)
    // A library role, by its id, or by its exact name when the id was mistyped.
    const template = input.source === 'new' ? undefined : byId.get(id) ?? (named ? byName.get(named.toLowerCase()) : undefined)
    const model = modelKeys.has(text(entry.model, 200)) ? text(entry.model, 200) : input.models[nextModel++ % input.models.length]?.key
    if (!model) continue
    const why = text(entry.why, WHY_MAX)
    if (template) {
      if (usedTemplates.has(template.id)) continue
      const name = uniqueName(template.name, taken)
      if (!name) continue
      usedTemplates.add(template.id)
      picks.push({ kind: 'library', templateId: template.id, name, ...(template.description ? { description: template.description } : {}), model, ...(why ? { why } : {}) })
      continue
    }
    if (input.source === 'library-only') continue
    const systemPrompt = text(entry.systemPrompt, PROMPT_MAX)
    const name = named ? uniqueName(named.replace(/[\s@]+/g, ''), taken) : undefined
    if (!name || !systemPrompt) continue
    const description = text(entry.description, DESCRIPTION_MAX)
    picks.push({ kind: 'new', name, systemPrompt, ...(description ? { description } : {}), model, ...(why ? { why } : {}) })
  }
  if (picks.length === 0) throw new Error(input.source === 'library-only' ? '角色库里没有模型挑中的角色，可以换成「先从角色库挑，不够再新写」' : '模型给出的名单里没有能加入的成员')
  return picks
}

// The name, or with a number after it when the group (or an earlier pick) has it already.
function uniqueName(name: string, taken: Set<string>): string | undefined {
  const base = name.trim().slice(0, ROLE_NAME_MAX_CHARACTERS - 2)
  if (!base || isReservedRoleName(base)) return undefined
  for (let index = 1; index < 20; index += 1) {
    const candidate = index === 1 ? base : `${base}${index}`
    if (!taken.has(candidate.toLowerCase())) {
      taken.add(candidate.toLowerCase())
      return candidate
    }
  }
  return undefined
}
