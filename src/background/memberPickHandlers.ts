// 添加成员 → 让 AI 按任务挑 (src/group/memberPicker.ts): the chosen API model is asked once for the
// members to add, and once more when its answer is not the list asked for. The list goes back to the
// window, which adds what the user keeps; nothing is added here. Why it could not suggest anyone is
// answered, not thrown: the window shows it, and a thrown error would also pop up over the page.
import { buildMemberPickPrompt, isMemberPickSource, memberPickModels, memberPickPlanners, MEMBER_PICK_MAX, parseMemberPicks, type MemberPick } from '../group/memberPicker'
import { getAllRoleTemplates } from '../group/roleTemplates'
import type { OpenTeamStore } from '../group/types'
import type { ExternalModelClient } from './externalModelClient'
import type { BackgroundMessageRoute } from './messageRouter'
import type { RuntimeMessage } from './runtimeClient'
import { getChatRoles, requireChat } from './storeAccess'

export const MEMBER_PICK_ROUTE_TYPES = ['GROUP_MEMBERS_SUGGEST'] as const

export interface MemberPickHandlerDependencies {
  loadStore(): Promise<OpenTeamStore>
  externalModelClient: Pick<ExternalModelClient, 'complete'>
  log: { info(event: string, details?: Record<string, unknown>): void; warn(event: string, details?: Record<string, unknown>): void }
}

export function createMemberPickHandlers(deps: MemberPickHandlerDependencies): BackgroundMessageRoute[] {
  async function suggest(message: RuntimeMessage): Promise<{ picks: MemberPick[]; planner: string }> {
    const store = await deps.loadStore()
    const chat = requireChat(store, message.chatId)
    const task = typeof message.task === 'string' ? message.task.trim() : ''
    if (!task) throw new Error('先写下要做的事')
    const planners = memberPickPlanners(store)
    const planner = planners.find(model => model.id === message.plannerModelId) ?? planners[0]
    if (!planner) throw new Error('让 AI 挑成员需要一个 API 模型：请先在「设置 → 模型」里添加')
    const models = memberPickModels(store, Array.isArray(message.models) ? message.models.filter((key): key is string => typeof key === 'string') : [])
    if (models.length === 0) throw new Error('至少勾选一个可以用的模型')
    const source = isMemberPickSource(message.source) ? message.source : 'library-first'
    const count = typeof message.count === 'number' && Number.isInteger(message.count) && message.count >= 1 ? Math.min(message.count, MEMBER_PICK_MAX) : undefined
    const members = getChatRoles(store, chat)
    const library = getAllRoleTemplates(store)
    const prompt = buildMemberPickPrompt({ task, members, library, models, source, ...(count ? { count } : {}), language: store.settings.language })
    const read = (content: string) => parseMemberPicks(content, { library, models, source, takenNames: members.map(role => role.name), ...(count ? { count } : {}) })
    const first = await deps.externalModelClient.complete({ model: planner, prompt })
    try {
      return { picks: read(first.content), planner: planner.name }
    } catch (error) {
      deps.log.warn('member-pick:unreadable', { reason: error instanceof Error ? error.message : String(error), length: first.content.length })
      const again = await deps.externalModelClient.complete({ model: planner, prompt: `${prompt}\n\n上一次的回答没有按要求的 JSON 格式给出能加入的成员。请只回答 JSON。` })
      return { picks: read(again.content), planner: planner.name }
    }
  }

  return [{
    type: 'GROUP_MEMBERS_SUGGEST',
    handler: async message => {
      try {
        const result = await suggest(message)
        deps.log.info('member-pick:suggested', { chatId: message.chatId, count: result.picks.length })
        return { ok: true, ...result }
      } catch (error) {
        return { ok: true, error: error instanceof Error ? error.message : String(error) }
      }
    },
  }]
}
