import { describe, expect, it } from 'vitest'
import { createDefaultStore } from '../group/store'
import type { ExternalModelConfig, GroupRole, OpenTeamStore } from '../group/types'
import { recordSiteLimit, SITE_LIMIT_COOLDOWN_MS } from '../group/siteUsage'
import { backupDeliveryFor, backupModelFor, canBeAskedNow, memberSiteLimit, memberSiteUnavailable, siteBlocksMember } from './memberBackup'
import type { PromptDelivery } from './promptDelivery'

function model(id: string, fields: Partial<ExternalModelConfig> = {}): ExternalModelConfig {
  return { id, name: `模型 ${id}`, format: 'openai', baseUrl: 'https://api.example.com/v1', apiKey: 'key', modelName: 'm', createdAt: 0, updatedAt: 0, ...fields }
}

function setup(roleFields: Partial<GroupRole> = {}): { store: OpenTeamStore; role: GroupRole } {
  const store = createDefaultStore()
  store.settings.externalModelsById = {
    api: model('api', { name: 'DeepSeek API' }),
    agent: model('agent', { format: 'local-agent', apiKey: '', localAgentId: 'claude-code' }),
    nokey: model('nokey', { apiKey: '  ' }),
  }
  const role: GroupRole = { id: 'role-1', chatId: 'chat-1', name: '研究员', systemPrompt: '', status: 'ready', modelSource: 'site', chatSite: 'kimi', contextCursor: 0, createdAt: 0, updatedAt: 0, ...roleFields }
  store.rolesById[role.id] = role
  return { store, role }
}

describe('a web member whose site cannot take prompts', () => {
  it('is blocked while its page shows a check, an error page, a pop-up, a login page or a site error', () => {
    for (const status of ['blocked', 'unauthorized', 'error'] as const) {
      expect(siteBlocksMember(setup({ siteHealth: { siteId: 'kimi', status, updatedAt: 1 } }).role)).toBe(true)
    }
  })

  it('is not blocked when its page is ready (also signed out but usable), loading or writing, or has not reported', () => {
    for (const status of ['ready', 'loading', 'generating'] as const) {
      expect(siteBlocksMember(setup({ siteHealth: { siteId: 'kimi', status, updatedAt: 1 } }).role)).toBe(false)
    }
    expect(siteBlocksMember(setup({ siteHealth: { siteId: 'kimi', status: 'ready', reason: 'guest', updatedAt: 1 } }).role)).toBe(false)
    expect(siteBlocksMember(setup().role)).toBe(false)
  })

  it('never counts an API member as blocked', () => {
    expect(siteBlocksMember(setup({ modelSource: 'external', externalModelId: 'api', siteHealth: { siteId: 'kimi', status: 'blocked', updatedAt: 1 } }).role)).toBe(false)
  })
})

describe('the API model that answers for a web member', () => {
  it('is the member\'s chosen API model', () => {
    const { store, role } = setup({ backupModelId: 'api' })
    expect(backupModelFor(store, role)?.id).toBe('api')
  })

  it('is none when unset, removed, a local agent, without a key, or for an API member', () => {
    expect(backupModelFor(...Object.values(setup()) as [OpenTeamStore, GroupRole])).toBeUndefined()
    for (const backupModelId of ['gone', 'agent', 'nokey']) {
      const { store, role } = setup({ backupModelId })
      expect(backupModelFor(store, role)).toBeUndefined()
    }
    const { store, role } = setup({ modelSource: 'external', externalModelId: 'api', backupModelId: 'api' })
    expect(backupModelFor(store, role)).toBeUndefined()
  })

  it('lets a blocked member still be asked (its backup answers), and not one without a backup', () => {
    const blocked = { siteHealth: { siteId: 'kimi' as const, status: 'blocked' as const, updatedAt: 1 } }
    const asked = ({ store, role }: { store: OpenTeamStore; role: GroupRole }) => canBeAskedNow(store, role, 100)
    expect(asked(setup({ ...blocked, backupModelId: 'api' }))).toBe(true)
    expect(asked(setup(blocked))).toBe(false)
    expect(asked(setup())).toBe(true)
  })

  it('treats a member whose site is limiting like a blocked one, until the mark runs out', () => {
    const limited = setup()
    recordSiteLimit(limited.store, 'kimi', '额度用完', 0)
    expect(memberSiteLimit(limited.store, limited.role, 100)).toMatchObject({ limitedAt: 0 })
    expect(memberSiteUnavailable(limited.store, limited.role, 100)).toBe(true)
    expect(canBeAskedNow(limited.store, limited.role, 100)).toBe(false)
    expect(canBeAskedNow(limited.store, limited.role, SITE_LIMIT_COOLDOWN_MS)).toBe(true)
    limited.role.backupModelId = 'api'
    expect(canBeAskedNow(limited.store, limited.role, 100)).toBe(true)
    // Another site's limit, or an API member, is not affected.
    const other = setup({ chatSite: 'chatgpt' })
    recordSiteLimit(other.store, 'kimi', '额度用完', 0)
    expect(memberSiteUnavailable(other.store, other.role, 100)).toBe(false)
    const api = setup({ modelSource: 'external', externalModelId: 'api', chatSite: 'kimi' })
    recordSiteLimit(api.store, 'kimi', '额度用完', 0)
    expect(memberSiteLimit(api.store, api.role, 100)).toBeUndefined()
  })

  it('gets the member\'s own prompt, attempt and images, and says whose stand-in it is', () => {
    const { store, role } = setup({ backupModelId: 'api' })
    const delivery: PromptDelivery = {
      roleId: 'role-1',
      chatSite: 'kimi',
      tabId: 7,
      frameId: 3,
      imageAttachmentIds: ['img-1'],
      message: { type: 'TEAM_SEND_PROMPT', chatId: 'chat-1', roleId: 'role-1', messageId: 'msg-q', replyAttemptId: 'attempt-1', content: '完整的提示词' },
    }
    expect(backupDeliveryFor(store, role, delivery)).toEqual({
      roleId: 'role-1',
      roleName: '研究员',
      chatId: 'chat-1',
      messageId: 'msg-q',
      replyAttemptId: 'attempt-1',
      model: store.settings.externalModelsById.api,
      prompt: '完整的提示词',
      imageAttachmentIds: ['img-1'],
      answeredBy: 'DeepSeek API',
    })
    expect(backupDeliveryFor(setup().store, setup().role, delivery)).toBeUndefined()
  })
})
