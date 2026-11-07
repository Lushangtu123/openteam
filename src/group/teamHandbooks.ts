import type { GroupChat, OpenTeamLanguage, TeamHandbook } from './types'

export const MAX_TEAM_HANDBOOKS = 20
export const MAX_HANDBOOK_CHARS = 256 * 1024
export const MAX_HANDBOOK_FILE_BYTES = 1024 * 1024

export function readTeamHandbook(raw: unknown): TeamHandbook | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const value = raw as Record<string, unknown>
  if (typeof value.id !== 'string' || !value.id.trim() || value.id.length > 100) return undefined
  if (typeof value.name !== 'string' || !value.name.trim() || value.name.trim().length > 100) return undefined
  if (typeof value.content !== 'string' || !value.content.trim() || value.content.length > MAX_HANDBOOK_CHARS || value.content.includes('\0')) return undefined
  return { id: value.id.trim(), name: value.name.trim(), content: value.content }
}

export function normalizeTeamHandbooks(raw: unknown): TeamHandbook[] {
  if (!Array.isArray(raw)) return []
  const seen = new Set<string>()
  return raw.flatMap(value => {
    const handbook = readTeamHandbook(value)
    if (!handbook || seen.has(handbook.id) || seen.size >= MAX_TEAM_HANDBOOKS) return []
    seen.add(handbook.id)
    return [handbook]
  })
}

// Added after ordinary context budgeting: compression must not remove a selected guide.
// This is workflow text, not a plugin install or a tool/permission grant.
export function withTeamHandbook(prompt: string, chat: GroupChat, language: OpenTeamLanguage): string {
  const handbook = readTeamHandbook(chat.executionHandbook)
  if (!handbook) return prompt
  const en = language === 'en'
  return [
    prompt,
    `${en ? 'Team execution handbook' : '本团队执行手册'}: ${handbook.name}`,
    en
      ? 'The user selected this text snapshot for this team. Use relevant sections for the task. Referenced paths identify sections in the supplied guide; use only tools and local files actually available. Keep the agreed task, responsibilities and permission boundaries.'
      : '这是用户为本团队选择的手册文本快照。按当前任务使用相关章节；引用路径用于定位手册章节，仅使用实际可用的工具和本地文件。保持已确认的任务、分工与权限边界。',
    handbook.content,
    en ? 'End of handbook. Now carry out the task above within its agreed scope.' : '手册结束。现在按已确认的范围执行上方任务。',
  ].join('\n\n')
}
