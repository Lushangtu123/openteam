import { describe, expect, it } from 'vitest'
import { buildMemberList } from './promptBuilder'
import {
  avatarTextProblem,
  avatarToneForSeed,
  describeRoleProfileProblem,
  isStorableAvatarImage,
  readAvatarTone,
  readStoredAvatar,
  roleAvatarTone,
  roleNameProblem,
  rolePositionBesideName,
  ROLE_AVATAR_IMAGE_MAX_LENGTH,
  updateGroupRoleProfile,
} from './roleProfile'
import { updateGroupRole, validateRoleName } from './roleTemplates'
import { createDefaultStore } from './store'
import type { GroupRole, OpenTeamStore } from './types'

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='

function makeStore(): OpenTeamStore {
  const store = createDefaultStore()
  const role = (id: string, name: string, chatSite: GroupRole['chatSite']): GroupRole => ({ id, chatId: 'c1', name, chatSite, modelSource: 'site', status: 'ready', contextCursor: 0, createdAt: 1, updatedAt: 1 })
  store.rolesById = { r1: role('r1', '产品经理', 'chatgpt'), r2: role('r2', '架构师', 'claude'), other: { ...role('other', '小D', 'kimi'), chatId: 'c2' } }
  store.chatsById.c1 = { id: 'c1', name: '群', mode: 'collaborative', roleIds: ['r1', 'r2'], messageIds: ['m1', 'm2', 'm3'], nextMessageSeq: 4, status: 'ready', createdAt: 1, updatedAt: 1 }
  store.chatsById.c2 = { id: 'c2', name: '另一个群', mode: 'collaborative', roleIds: ['other'], messageIds: [], nextMessageSeq: 1, status: 'ready', createdAt: 1, updatedAt: 1 }
  store.chatOrder = ['c1', 'c2']
  store.messagesById = {
    m1: { id: 'm1', chatId: 'c1', seq: 1, type: 'assistant', roleId: 'r1', roleName: '产品经理', content: '先做 MVP', status: 'received', createdAt: 1 },
    m2: { id: 'm2', chatId: 'c1', seq: 2, type: 'user', content: '同意', status: 'received', createdAt: 2, references: [{ messageId: 'm1', roleId: 'r1', roleName: '产品经理', contentSnapshot: '先做 MVP' }] },
    m3: { id: 'm3', chatId: 'c1', seq: 3, type: 'assistant', roleId: 'r2', roleName: '架构师', content: '用 Go', status: 'received', createdAt: 3 },
  }
  return store
}

describe('member names', () => {
  it('names the problem with a name, comparing other members without case', () => {
    expect(roleNameProblem('  ')).toBe('empty')
    expect(roleNameProblem('a'.repeat(51))).toBe('too-long')
    expect(roleNameProblem('小 D')).toBe('whitespace')
    expect(roleNameProblem('小@D')).toBe('at')
    for (const reserved of ['all', 'ALL', '所有人', '编排', 'Orchestration']) expect(roleNameProblem(reserved)).toBe('reserved')
    expect(roleNameProblem('Kimi', ['kimi'])).toBe('duplicate')
    expect(roleNameProblem('小D', ['产品经理'])).toBeUndefined()
  })

  it('keeps the library\'s messages and refuses the mention words there too', () => {
    expect(validateRoleName('all')).toBe('人员名称不能是 all')
    expect(validateRoleName('所有人')).toBe('人员名称不能是 所有人')
    expect(validateRoleName('研究员', ['研究员'])).toBe('人员名称已存在：研究员')
  })

  it('describes each problem in both languages', () => {
    expect(describeRoleProfileProblem('duplicate', 'zh-CN', '小D')).toBe('这个群里已经有叫「小D」的成员')
    expect(describeRoleProfileProblem('duplicate', 'en', '小D')).toBe('Another member here is already called "小D"')
    expect(describeRoleProfileProblem('avatar-text-too-long', 'en')).toBe('Avatar text is at most 2 characters')
  })
})

describe('member avatars', () => {
  it('takes one of the six preset colours, or the colour the name gives', () => {
    expect(readAvatarTone('tone-3')).toBe(3)
    expect(readAvatarTone('tone-6')).toBeUndefined()
    expect(readAvatarTone('#123456')).toBeUndefined()
    expect(roleAvatarTone({ name: '架构师', avatarColor: 'tone-4' })).toBe(4)
    expect(roleAvatarTone({ name: '架构师', avatarColor: '#123456' })).toBe(avatarToneForSeed('架构师'))
  })

  it('allows up to two characters of avatar text, without spaces', () => {
    expect(avatarTextProblem('产品')).toBeUndefined()
    expect(avatarTextProblem('👩‍💻A')).toBeUndefined()
    expect(avatarTextProblem('ABC')).toBe('too-long')
    expect(avatarTextProblem('A B')).toBe('whitespace')
  })

  it('stores only small PNG, JPEG or WebP pictures held in the data itself', () => {
    expect(isStorableAvatarImage(PNG)).toBe(true)
    expect(isStorableAvatarImage('https://example.com/a.png')).toBe(false)
    expect(isStorableAvatarImage('data:image/svg+xml;base64,PHN2Zz4=')).toBe(false)
    expect(isStorableAvatarImage('data:image/png;base64,abc"onerror=x')).toBe(false)
    expect(isStorableAvatarImage(`data:image/webp;base64,${'A'.repeat(ROLE_AVATAR_IMAGE_MAX_LENGTH)}`)).toBe(false)
  })

  it('drops stored values that break the rules', () => {
    expect(readStoredAvatar({ avatarColor: 'tone-2', avatarText: '小D', avatarImage: PNG })).toEqual({ avatarColor: 'tone-2', avatarText: '小D', avatarImage: PNG })
    expect(readStoredAvatar({ avatarColor: 'red', avatarText: '太长了', avatarImage: 'https://x.test/a.png' })).toEqual({})
  })
})

describe('editing a member', () => {
  it('renames the member, marks the name as the user\'s, and shows the new name on what it said', () => {
    const store = makeStore()
    const role = updateGroupRoleProfile(store, 'r1', { name: ' 小D ' }, 5)
    expect(role).toMatchObject({ name: '小D', userNamed: true, updatedAt: 5 })
    expect(store.chatsById.c1.updatedAt).toBe(5)
    expect(store.messagesById.m1.roleName).toBe('小D')
    expect(store.messagesById.m2.references?.[0].roleName).toBe('小D')
    expect(store.messagesById.m3.roleName).toBe('架构师')
  })

  it('refuses a name another member of the chat has, on any site, but not one from another chat', () => {
    const store = makeStore()
    expect(() => updateGroupRoleProfile(store, 'r1', { name: '架构师' }, 5)).toThrow('这个群里已经有叫「架构师」的成员')
    expect(() => updateGroupRoleProfile(store, 'r1', { name: '' }, 5)).toThrow('名字不能为空')
    expect(updateGroupRoleProfile(store, 'r1', { name: '小D' }, 5).name).toBe('小D')
  })

  it('leaves the name and its mark alone when it does not change', () => {
    const store = makeStore()
    updateGroupRoleProfile(store, 'r1', { name: '产品经理', avatarText: '产' }, 5)
    expect(store.rolesById.r1.userNamed).toBeUndefined()
    expect(store.rolesById.r1.avatarText).toBe('产')
  })

  it('sets and clears the avatar, and changes nothing when one value is wrong', () => {
    const store = makeStore()
    updateGroupRoleProfile(store, 'r2', { avatarColor: 'tone-1', avatarText: 'Go', avatarImage: PNG }, 5)
    expect(store.rolesById.r2).toMatchObject({ avatarColor: 'tone-1', avatarText: 'Go', avatarImage: PNG })

    expect(() => updateGroupRoleProfile(store, 'r2', { name: '新名字', avatarImage: 'https://x.test/a.png' }, 6)).toThrow('图片无法保存')
    expect(() => updateGroupRoleProfile(store, 'r2', { avatarColor: '#ff0000' }, 6)).toThrow('请选择一个预设颜色')
    expect(() => updateGroupRoleProfile(store, 'r2', { avatarText: 'ABC' }, 6)).toThrow('头像文字最多 2 个字')
    expect(store.rolesById.r2.name).toBe('架构师')

    updateGroupRoleProfile(store, 'r2', { avatarColor: '', avatarText: '', avatarImage: '' }, 7)
    expect(store.rolesById.r2).not.toHaveProperty('avatarColor')
    expect(store.rolesById.r2).not.toHaveProperty('avatarText')
    expect(store.rolesById.r2).not.toHaveProperty('avatarImage')
  })

  it('renames what a member said when anything else renames it too, such as confirming a team', () => {
    const store = makeStore()
    updateGroupRole(store, 'r2', { name: '后端负责人', teamPosition: '后端负责人' }, 5)
    expect(store.messagesById.m3.roleName).toBe('后端负责人')
    expect(store.rolesById.r2.teamPosition).toBe('后端负责人')
    expect(store.rolesById.r2.userNamed).toBeUndefined()
    updateGroupRole(store, 'r2', { teamPosition: '' }, 6)
    expect(store.rolesById.r2).not.toHaveProperty('teamPosition')
  })

  it('puts the position of a member the user named beside its name in the member list', () => {
    const named = { id: 'r1', chatId: 'c1', name: '小D', userNamed: true, teamPosition: '产品经理', description: '负责需求', status: 'ready', contextCursor: 0, createdAt: 1, updatedAt: 1 } as GroupRole
    expect(rolePositionBesideName(named)).toBe('产品经理')
    expect(rolePositionBesideName({ ...named, userNamed: undefined })).toBeUndefined()
    expect(buildMemberList([named, { ...named, id: 'r2', name: '架构师', userNamed: undefined, description: '架构师' }], 'zh-CN')).toBe('群聊成员：\n- 小D（产品经理）：负责需求\n- 架构师：架构师')
    expect(buildMemberList([{ ...named, description: '产品经理' }], 'en')).toBe('Group chat members:\n- 小D (产品经理)')
  })
})
