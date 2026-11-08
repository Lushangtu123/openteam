import { describe, expect, it } from 'vitest'
import { defaultLanguageForEnvironment, localizeGroupTemplate, localizeRoleTemplate, normalizeLanguage, translateUi } from './i18n'

describe('shared i18n configuration', () => {
  it('defaults to Chinese for Chinese browser locales and English otherwise', () => {
    expect(defaultLanguageForEnvironment({ language: 'en-US', languages: ['zh-CN', 'en-US'] })).toBe('zh-CN')
    expect(defaultLanguageForEnvironment({ language: 'zh-TW', languages: [] })).toBe('zh-CN')
    expect(defaultLanguageForEnvironment({ language: 'en-US', languages: ['en-US'] })).toBe('en')
  })

  it('keeps explicit saved languages authoritative', () => {
    expect(normalizeLanguage('zh-CN')).toBe('zh-CN')
    expect(normalizeLanguage('en')).toBe('en')
    expect(normalizeLanguage(undefined)).toBe('en')
  })

  it('translates UI strings from one shared table', () => {
    expect(translateUi('进行中', 'en')).toBe('Active')
    expect(translateUi('进行中', 'zh-CN')).toBe('进行中')
    expect(translateUi('9 个群聊 · 311 个角色', 'en')).toBe('9 chats · 311 people')
    expect(translateUi('已请「工程师」「设计师」互相审阅回答', 'en')).toBe("Asked 工程师, 设计师 to review each other's answers")
  })

  it('translates the chat buttons whose icons are drawn, not written', () => {
    expect(translateUi('对比 2 个回复', 'en')).toBe('Compare 2 replies')
    expect(translateUi('汇总本轮', 'en')).toBe('Summarize round')
    expect(translateUi('查看分工', 'en')).toBe('View positions')
  })

  it('translates page health copy, including the composer warning', () => {
    expect(translateUi('需要人机验证', 'en')).toBe('Verification required')
    expect(translateUi('网页暂时无法接收：Product Lead（DeepSeek） 需要登录；设计师 可以发送（未登录）', 'en'))
      .toBe('Pages that cannot receive messages right now: Product Lead（DeepSeek）: Login required; 设计师: Ready (not logged in)')
    expect(translateUi('将发送给：工程师（DeepSeek）', 'en')).toBe('Will send to: 工程师（DeepSeek）')
    expect(translateUi('请稍等：工程师 正在回复', 'en')).toBe('Please wait: 工程师 is replying')
    expect(translateUi('正在回复：工程师、设计师', 'en')).toBe('Replying: 工程师、设计师')
  })

  it('localizes built-in people from the same configuration', () => {
    const localized = localizeRoleTemplate({
      id: 'builtin-frankl',
      type: 'builtin',
      name: '弗兰克尔',
      category: '思想风格顾问',
      description: '意义疗法、责任、苦难中的尊严与行动方向',
      defaultChatSite: 'deepseek',
      systemPrompt: '你是「弗兰克尔式意义顾问」。',
      createdAt: 0,
      updatedAt: 0,
    }, 'en')

    expect(localized.name).toBe('ViktorFrankl')
    expect(localized.category).toBe('Thought-style advisors')
    expect(localized.description).toContain('Meaning therapy')
    expect(localized.systemPrompt).not.toContain('弗兰克尔')
  })

  it('localizes built-in group templates and roles from the same configuration', () => {
    const localized = localizeGroupTemplate({
      id: 'study-master',
      name: '学霸学习群',
      category: '学生与学习',
      summary: '把真实学习任务拆成目标、材料、计划、练习、复盘和反馈闭环。',
      userTypes: ['中学生', '大学生', '自学者'],
      aliases: ['学习计划'],
      suggestedQuestions: ['我想解决什么问题？'],
      riskLevel: 'normal',
      defaultChatName: '学霸学习群',
      defaultMode: 'collaborative',
      roles: [{
        name: '学习规划师',
        description: '负责把用户的考试、课程或自学目标拆解成可执行的日计划、周计划和复盘节点。',
        systemPrompt: '你是学习规划师。',
      }],
    }, 'en')

    expect(localized.name).toBe('Study Master Group')
    expect(localized.category).toBe('Study and Learning')
    expect(localized.summary).not.toContain('学习')
    expect(localized.userTypes).toEqual(['Middle school students', 'College students', 'Self-learners'])
    expect(localized.roles[0]?.name).toBe('StudyPlanner')
    expect(localized.roles[0]?.systemPrompt).not.toContain('学习规划师')
  })
})
