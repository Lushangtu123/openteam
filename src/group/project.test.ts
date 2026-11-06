import { describe, expect, it } from 'vitest'
import { allTasksDone, buildProjectPrompt, extractJsonObject, findMemberByName, hasDependencyCycle, parsePlan, parseReview, parseTaskOutcome, projectRequestText, readyTasks } from './project'
import { createDefaultStore } from './store'
import type { GroupChat, GroupMessage, GroupRole, OpenTeamStore, ProjectRun, ProjectTask } from './types'

function role(id: string, name: string, extra: Partial<GroupRole> = {}): GroupRole {
  return { id, chatId: 'chat-1', name, systemPrompt: `${name}的人设`, status: 'ready', contextCursor: 0, createdAt: 0, updatedAt: 0, ...extra }
}

const members = [role('a', '架构师', { description: '负责技术方案' }), role('b', '产品'), role('c', '产品经理')]

function task(id: string, extra: Partial<ProjectTask> = {}): ProjectTask {
  return { id, title: `任务${id}`, detail: `做${id}`, ownerRoleId: 'a', dependsOn: [], doneWhen: `${id}完成`, status: 'todo', attempts: 0, ...extra }
}

function project(tasks: ProjectTask[], extra: Partial<ProjectRun> = {}): ProjectRun {
  return { id: 'p1', goalMessageId: 'goal', coordinatorRoleId: 'c', status: 'running', tasks, steps: 1, maxSteps: 30, planAttempts: 1, reviewAttempts: 0, createdAt: 0, updatedAt: 0, ...extra }
}

describe('project rules', () => {
  it('finds the JSON in a reply: fenced, bare, or with trailing commas', () => {
    expect(extractJsonObject('计划如下：\n```json\n{"tasks":[{"id":"t1"}]}\n```\n就这样')).toEqual({ tasks: [{ id: 't1' }] })
    expect(extractJsonObject('好的 {"finish": true, "decisions": [],} 完毕')).toEqual({ finish: true, decisions: [] })
    expect(extractJsonObject('没有 JSON')).toBeUndefined()
  })

  it('matches owners by name, longest first', () => {
    expect(findMemberByName('产品经理', members)?.id).toBe('c')
    expect(findMemberByName('@产品', members)?.id).toBe('b')
    expect(findMemberByName('架构师（Gemini）', members)?.id).toBe('a')
    expect(findMemberByName('测试', members)).toBeUndefined()
  })

  it('reads a plan: owners, dependencies that exist, unique ids, and no cycles', () => {
    const reply = '```json\n' + JSON.stringify({ tasks: [
      { id: 't1', title: '技术方案', owner: '架构师', dependsOn: [], detail: '写技术方案', doneWhen: '有架构图' },
      { id: 't1', title: '功能清单', owner: '产品经理', dependsOn: ['t9'], detail: '列功能', doneWhen: '10 条以上' },
      { id: 't3', title: '汇总', owner: '没这个人', dependsOn: ['t1', 't2', 't3'], detail: '汇总', doneWhen: '' },
    ] }) + '\n```'
    const plan = parsePlan(reply, members, members[2])!
    expect(plan.map(planned => [planned.id, planned.ownerRoleId, planned.dependsOn])).toEqual([['t1', 'a', []], ['t2', 'c', []], ['t3', 'c', ['t1', 't2']]])
    expect(parsePlan('{"tasks":[]}', members, members[0])).toBeUndefined()
    expect(hasDependencyCycle([{ id: 'x', dependsOn: ['y'] }, { id: 'y', dependsOn: ['x'] }])).toBe(true)
    expect(parsePlan('{"tasks":[{"id":"x","title":"X","dependsOn":["y"]},{"id":"y","title":"Y","dependsOn":["x"]}]}', members, members[0])).toBeUndefined()
  })

  it('reads how a task went from its closing lines', () => {
    expect(parseTaskOutcome('方案正文……\n【状态】完成\n【摘要】写好了技术方案')).toEqual({ status: 'done', summary: '写好了技术方案' })
    expect(parseTaskOutcome('试了\n【状态】受阻：缺少接口文档')).toMatchObject({ status: 'blocked', blockedReason: '缺少接口文档' })
    expect(parseTaskOutcome('Done.\n[Status] blocked: no access\n[Summary] tried')).toMatchObject({ status: 'blocked', blockedReason: 'no access', summary: 'tried' })
    expect(parseTaskOutcome('只有正文，没有状态行')).toEqual({ status: 'done', summary: '只有正文，没有状态行' })
  })

  it('reads a check: verdicts, reassignments, new tasks within the limit, a question, finish', () => {
    const run = project([task('t1', { status: 'done' }), task('t2', { status: 'done' })])
    const review = parseReview('```json\n' + JSON.stringify({
      decisions: [
        { task: 't1', verdict: 'pass', note: '好' },
        { task: 't2', verdict: 'reassign', owner: '产品', note: '换人' },
        { task: 't2', verdict: 'reassign', owner: '没人', note: '' },
        { task: 't9', verdict: 'pass' },
      ],
      newTasks: [{ id: 't1', title: '补测试', owner: '架构师', dependsOn: ['t2'], detail: '写测试', doneWhen: '覆盖主流程' }],
      question: '要不要上线？',
      finish: false,
    }) + '\n```', run, members, members[2])!
    expect(review.decisions).toEqual([
      { taskId: 't1', verdict: 'pass', note: '好' },
      { taskId: 't2', verdict: 'reassign', note: '换人', ownerRoleId: 'b' },
      { taskId: 't2', verdict: 'redo', note: '' },
    ])
    expect(review.newTasks.map(planned => [planned.id, planned.dependsOn])).toEqual([['t3', ['t2']]])
    expect(review.question).toBe('要不要上线？')
    expect(review.finish).toBe(false)
    expect(parseReview('看起来都不错', run, members, members[2])).toBeUndefined()
  })

  it('starts tasks once what they depend on is done', () => {
    const run = project([task('t1', { status: 'done' }), task('t2', { dependsOn: ['t1'] }), task('t3', { dependsOn: ['t2'] }), task('t4', { status: 'redo' })])
    expect(readyTasks(run).map(ready => ready.id)).toEqual(['t2', 't4'])
    expect(allTasksDone(run)).toBe(false)
    expect(allTasksDone(project([task('t1', { status: 'done' })]))).toBe(true)
  })

  it('announces each step', () => {
    expect(projectRequestText('plan', '产品经理', undefined, 'zh-CN')).toBe('项目 · 请「产品经理」拆分任务')
    expect(projectRequestText('task', '架构师', task('t2', { attempts: 1 }), 'zh-CN')).toBe('项目 · 任务 t2「任务t2」交给「架构师」（第 2 次）')
    expect(projectRequestText('review', 'PM', undefined, 'en')).toBe('Project · PM checks the results')
  })
})

describe('project prompts', () => {
  function setup(): { store: OpenTeamStore; chat: GroupChat; add(message: Partial<GroupMessage> & Pick<GroupMessage, 'id' | 'type' | 'content'>): GroupMessage } {
    const store = createDefaultStore()
    store.settings.language = 'zh-CN'
    const chat: GroupChat = { id: 'chat-1', name: '项目', mode: 'collaborative', roleIds: ['a', 'b', 'c'], messageIds: [], nextMessageSeq: 1, status: 'ready', createdAt: 0, updatedAt: 0 }
    store.chatsById[chat.id] = chat
    for (const member of members) store.rolesById[member.id] = { ...member }
    const add = (message: Partial<GroupMessage> & Pick<GroupMessage, 'id' | 'type' | 'content'>) => {
      const full: GroupMessage = { chatId: chat.id, seq: chat.nextMessageSeq, createdAt: 0, status: 'received', ...message }
      chat.nextMessageSeq += 1
      store.messagesById[full.id] = full
      chat.messageIds.push(full.id)
      return full
    }
    add({ id: 'goal', type: 'user', content: '写一份 App 上线方案', projectGoal: true, attachments: [{ id: 'f1', type: 'file', status: 'ready', fileName: '需求.pdf', mimeType: 'application/pdf', size: 10, text: '需求原文' }] })
    return { store, chat, add }
  }

  it('asks the coordinator for a plan in JSON, naming the members and the files', () => {
    const { store, chat, add } = setup()
    chat.project = project([])
    add({ id: 'note', type: 'user', content: '测试交给产品', projectNoteOf: 'goal' })
    const request = add({ id: 'r1', type: 'user', content: '', projectRequest: { kind: 'plan' } })
    const prompt = buildProjectPrompt({ store, chat, project: chat.project, request, role: store.rolesById.c, language: 'zh-CN' })
    expect(prompt).toContain('你是「产品经理」，这次担任一个 AI 团队项目的协调员。')
    expect(prompt).toContain('项目目标（用户提出）：\n写一份 App 上线方案')
    expect(prompt).toContain('附件 需求.pdf（文件中的文字）')
    expect(prompt).toContain('- 架构师（')
    expect(prompt).toContain('：负责技术方案')
    expect(prompt).toContain('用户的补充和回答：\n- 测试交给产品')
    expect(prompt).toContain('```json\n{"tasks":[')
  })

  it('gives a member its task, the results it builds on, the feedback, and the closing lines to write', () => {
    const { store, chat, add } = setup()
    add({ id: 'res1', type: 'assistant', content: '技术方案全文', roleId: 'a', roleName: '架构师', sourceMessageId: 'x' })
    chat.project = project([task('t1', { status: 'done', resultMessageId: 'res1', summary: '技术方案' }), task('t2', { ownerRoleId: 'b', dependsOn: ['t1'], attempts: 1, note: '补上风险' })])
    const request = add({ id: 'r2', type: 'user', content: '', projectRequest: { kind: 'task', taskId: 't2' } })
    const prompt = buildProjectPrompt({ store, chat, project: chat.project, request, role: store.rolesById.b, includePersona: true, language: 'zh-CN' })
    expect(prompt).toContain('人设：\n产品的人设')
    expect(prompt).toContain('你的任务（t2 · 任务t2）：\n做t2')
    expect(prompt).toContain('完成标准：\nt2完成')
    expect(prompt).toContain('上一次结果的检查意见：\n补上风险')
    expect(prompt).toContain('【t1 · 任务t1 · 架构师】\n技术方案全文')
    expect(prompt).toContain('【状态】完成（或：受阻：原因）')
  })

  it('has the coordinator check new results in full and earlier ones by summary, then write the deliverable', () => {
    const { store, chat, add } = setup()
    add({ id: 'res1', type: 'assistant', content: '旧结果全文', roleId: 'a', sourceMessageId: 'x' })
    add({ id: 'res2', type: 'assistant', content: '新结果全文', roleId: 'b', sourceMessageId: 'y' })
    chat.project = project([task('t1', { status: 'done', resultMessageId: 'res1', summary: '旧摘要', checked: true }), task('t2', { status: 'done', resultMessageId: 'res2', summary: '新摘要' }), task('t3', { status: 'blocked', note: '缺资料' })])
    const review = add({ id: 'r3', type: 'user', content: '', projectRequest: { kind: 'review' } })
    const reviewPrompt = buildProjectPrompt({ store, chat, project: chat.project, request: review, role: store.rolesById.c, language: 'zh-CN' })
    expect(reviewPrompt).toContain('结果：\n旧摘要')
    expect(reviewPrompt).toContain('结果：\n新结果全文')
    expect(reviewPrompt).toContain('受阻原因：缺资料')
    expect(reviewPrompt).toContain('"verdict":"pass"')

    const final = add({ id: 'r4', type: 'user', content: '', projectRequest: { kind: 'final' } })
    const finalPrompt = buildProjectPrompt({ store, chat, project: chat.project, request: final, role: store.rolesById.c, language: 'zh-CN' })
    expect(finalPrompt).toContain('【任务t1】\n旧结果全文')
    expect(finalPrompt).toContain('整合成一份完整的最终交付')
  })
})
