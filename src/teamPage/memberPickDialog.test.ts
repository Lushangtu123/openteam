// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createDefaultStore } from '../group/store'
import type { OpenTeamStore } from '../group/types'
import { currentMemberPickDialog, openMemberPickDialog } from './memberPickDialog'

afterEach(() => currentMemberPickDialog()?.close())

function setup(fields: (store: OpenTeamStore) => void = () => undefined) {
  const store = createDefaultStore()
  store.settings.language = 'zh-CN'
  store.settings.externalModelOrder = ['api']
  store.settings.externalModelsById = { api: { id: 'api', name: 'Gemini', format: 'openai', baseUrl: 'https://x', apiKey: 'k', modelName: 'gemini-flash', createdAt: 1, updatedAt: 1 } }
  store.chatsById.c = { id: 'c', name: '记账', mode: 'collaborative', roleIds: ['r1'], messageIds: ['m1'], nextMessageSeq: 2, status: 'ready', createdAt: 1, updatedAt: 1 }
  store.rolesById.r1 = { id: 'r1', chatId: 'c', name: '工程师', chatSite: 'kimi', status: 'ready', contextCursor: 0, createdAt: 1, updatedAt: 1 }
  store.messagesById.m1 = { id: 'm1', chatId: 'c', seq: 1, type: 'user', content: '@工程师 加上预算提醒', createdAt: 1, status: 'received' }
  fields(store)
  const request = vi.fn(async (_type: string, _payload?: Record<string, unknown>) => ({
    ok: true,
    planner: 'Gemini',
    picks: [
      { kind: 'library', templateId: 'builtin-x', name: '安全审计员', description: '找漏洞', model: 'site:kimi', why: '把关' },
      { kind: 'new', name: '预算设计师', systemPrompt: '你设计预算提醒。', model: 'external:api', why: '核心功能' },
    ],
  } as Record<string, unknown>))
  const runCommand = vi.fn(async () => undefined)
  const onClaim = vi.fn(async () => undefined)
  const onAdded = vi.fn()
  openMemberPickDialog({ getStore: () => store, getCurrentChat: () => store.chatsById.c, request, runCommand, onClaim, onAdded })
  const $ = <T extends HTMLElement>(selector: string) => document.querySelector<T>(selector)!
  const button = (label: string) => [...document.querySelectorAll<HTMLButtonElement>('.member-pick-dialog button')].find(node => node.textContent === label)!
  return { store, request, runCommand, onClaim, onAdded, $, button }
}

describe('what members did before, shown under the picks', () => {
  it('says how the role did on its model, and says it again when another model is chosen', async () => {
    const ctx = setup()
    ctx.request.mockResolvedValueOnce({
      ok: true,
      planner: 'Gemini',
      picks: [
        { kind: 'library', templateId: 'builtin-x', name: '安全审计员2', model: 'site:kimi', why: '把关' },
        { kind: 'new', name: '预算设计师', systemPrompt: '你设计预算提醒。', model: 'site:kimi' },
      ],
      records: [
        { key: 'template:builtin-x|site:kimi', name: '安全审计员', templateId: 'builtin-x', model: 'site:kimi', replies: 8, kept: 5, redone: 1 },
        { key: 'template:builtin-x|external:api', name: '安全审计员', templateId: 'builtin-x', model: 'external:api', replies: 4, kept: 0, redone: 0 },
      ],
    })
    ctx.button('让 AI 挑').click()
    await vi.waitFor(() => expect(document.querySelectorAll('.member-pick-row')).toHaveLength(2))
    const [first, second] = [...document.querySelectorAll<HTMLElement>('.member-pick-row')]
    expect(first.querySelector('.member-pick-record')!.textContent).toBe('过去 8 次回答，你留用了 5 次，重答 1 次')
    expect(second.querySelector('.member-pick-record')).toBeNull()
    const model = first.querySelector<HTMLSelectElement>('.member-pick-row-model')!
    model.append(new Option('API · Gemini', 'external:api'))
    model.value = 'external:api'
    model.dispatchEvent(new Event('change'))
    expect(first.querySelector('.member-pick-record')!.textContent).toBe('过去 4 次回答，你留用了 0 次')
  })
})

describe('letting an AI pick members for a task', () => {
  it('starts from the latest request and the models the group uses, asks, and lists the picks', async () => {
    const ctx = setup()
    expect(ctx.$<HTMLTextAreaElement>('#member-pick-task').value).toBe('加上预算提醒')
    expect(ctx.$<HTMLSelectElement>('#member-pick-planner').value).toBe('api')
    expect([...document.querySelectorAll<HTMLInputElement>('.member-pick-models input:checked')].map(input => input.getAttribute('aria-label'))).toEqual(['Kimi'])
    ;([...document.querySelectorAll<HTMLInputElement>('.member-pick-models input')].find(input => input.getAttribute('aria-label') === 'API · Gemini')!).click()
    ctx.$<HTMLInputElement>('input[name="member-pick-source"][value="new"]').click()
    ctx.$<HTMLSelectElement>('#member-pick-count').value = '2'
    ctx.button('让 AI 挑').click()
    await vi.waitFor(() => expect(document.querySelectorAll('.member-pick-row')).toHaveLength(2))
    expect(ctx.request).toHaveBeenCalledWith('GROUP_MEMBERS_SUGGEST', { chatId: 'c', task: '加上预算提醒', plannerModelId: 'api', models: ['site:kimi', 'external:api'], source: 'new', count: 2 })
    expect(ctx.$('.member-pick-status').textContent).toBe('Gemini 建议了 2 位，看过后加入。')
    expect([...document.querySelectorAll('.member-pick-row strong')].map(node => node.textContent)).toEqual(['安全审计员', '预算设计师'])
  })

  it('adds the kept picks with the models chosen for them', async () => {
    const ctx = setup()
    ctx.button('让 AI 挑').click()
    await vi.waitFor(() => expect(document.querySelectorAll('.member-pick-row')).toHaveLength(2))
    const rows = [...document.querySelectorAll<HTMLElement>('.member-pick-row')]
    rows[0].querySelector<HTMLInputElement>('input[type=checkbox]')!.click()
    ctx.button('加入选中的成员').click()
    await vi.waitFor(() => expect(ctx.onAdded).toHaveBeenCalledWith(1))
    expect(ctx.runCommand).toHaveBeenCalledWith('GROUP_ROLES_CREATE_BATCH', { chatId: 'c', items: [{ source: 'temporary', name: '预算设计师', systemPrompt: '你设计预算提醒。', modelSource: 'external', externalModelId: 'api' }] })
    expect(currentMemberPickDialog()).toBeUndefined()
  })

  it('says why it could not ask, or what the AI could not do', async () => {
    const ctx = setup()
    ctx.$<HTMLTextAreaElement>('#member-pick-task').value = ' '
    ctx.button('让 AI 挑').click()
    expect(ctx.$('.team-form-error').textContent).toBe('先写下要做的事')
    ctx.$<HTMLTextAreaElement>('#member-pick-task').value = '加预算'
    ctx.request.mockResolvedValueOnce({ ok: true, error: '模型没有按格式给出成员名单' })
    ctx.button('让 AI 挑').click()
    await vi.waitFor(() => expect(ctx.$('.team-form-error').textContent).toBe('模型没有按格式给出成员名单'))
    currentMemberPickDialog()?.close()
    const noApi = setup(store => { store.settings.externalModelOrder = []; store.settings.externalModelsById = {} })
    expect(noApi.$('.member-pick-warning').textContent).toContain('需要一个 API 模型来挑')
    noApi.button('让 AI 挑').click()
    expect(noApi.request).not.toHaveBeenCalled()
  })

  it('lets new members claim positions instead: how many of which AI', async () => {
    const ctx = setup()
    ctx.$<HTMLInputElement>('input[name="member-pick-mode"][value="claim"]').click()
    expect(ctx.$<HTMLElement>('#member-pick-planner').closest<HTMLElement>('.field')!.hidden).toBe(true)
    const kimi = [...document.querySelectorAll<HTMLElement>('.member-pick-models .team-setup-member')].find(row => row.textContent?.includes('Kimi'))!
    kimi.querySelectorAll('button')[1].click()
    kimi.querySelectorAll('button')[1].click()
    ctx.button('加入并让它们认领').click()
    await vi.waitFor(() => expect(ctx.onClaim).toHaveBeenCalledWith('加上预算提醒', [{ key: 'site:kimi', count: 2 }]))
    await vi.waitFor(() => expect(currentMemberPickDialog()).toBeUndefined())
  })

  it('shows only the button that goes with what is on screen, with the real styles', async () => {
    // jsdom lets the hidden attribute win over any rule; Chrome lets the page's own rules win (a
    // display: flex shows a hidden element). So hidden is swapped for data-hidden, hidden by a rule
    // that comes before the page's, as the browser's own rule does.
    const style = document.createElement('style')
    style.textContent = `[data-hidden] { display: none; }\n${readFileSync('public/styles/theme.css', 'utf8').replace(/\[hidden\]/g, '[data-hidden]')}`
    document.head.append(style)
    try {
      const ctx = setup()
      const shown = () => {
        const hidden = [...document.querySelectorAll<HTMLElement>('.member-pick-dialog [hidden]')]
        for (const node of hidden) {
          node.hidden = false
          node.setAttribute('data-hidden', '')
        }
        const labels = [...document.querySelectorAll<HTMLButtonElement>('.member-pick-dialog button.btn-primary')]
          .filter(node => {
            for (let at: HTMLElement | null = node; at; at = at.parentElement) if (getComputedStyle(at).display === 'none') return false
            return true
          })
          .map(node => node.textContent)
        for (const node of hidden) {
          node.removeAttribute('data-hidden')
          node.hidden = true
        }
        return labels
      }
      expect(shown()).toEqual(['让 AI 挑'])
      ctx.$<HTMLInputElement>('input[name="member-pick-mode"][value="claim"]').click()
      expect(shown()).toEqual(['加入并让它们认领'])
      ctx.$<HTMLInputElement>('input[name="member-pick-mode"][value="list"]').click()
      ctx.button('让 AI 挑').click()
      await vi.waitFor(() => expect(document.querySelectorAll('.member-pick-row')).toHaveLength(2))
      expect(shown()).toEqual(['让 AI 挑', '加入选中的成员'])
    } finally {
      style.remove()
    }
  })

  it('dims the page without blur, so it does not flash as it scrolls over 添加成员', () => {
    const style = document.createElement('style')
    style.textContent = ['base', 'theme', 'chatgpt', 'grok', 'refinements'].map(name => readFileSync(`public/styles/${name}.css`, 'utf8')).join('\n')
    document.head.append(style)
    try {
      setup()
      for (const [theme, style_] of [['dark', 'grok'], ['light', 'grok'], ['dark', undefined], ['light', undefined]] as const) {
        document.documentElement.dataset.theme = theme
        if (style_) document.documentElement.dataset.uiStyle = style_
        else delete document.documentElement.dataset.uiStyle
        expect(getComputedStyle(document.querySelector('.member-pick-modal')!).getPropertyValue('backdrop-filter')).toBe('none')
        expect(getComputedStyle(document.querySelector('.member-pick-dialog')!).getPropertyValue('contain')).toBe('paint')
      }
    } finally {
      style.remove()
      delete document.documentElement.dataset.theme
      delete document.documentElement.dataset.uiStyle
    }
  })

  it('lets long model names shorten instead of making the window scroll sideways', () => {
    const style = document.createElement('style')
    style.textContent = ['base', 'theme', 'chatgpt', 'grok', 'refinements'].map(name => readFileSync(`public/styles/${name}.css`, 'utf8')).join('\n')
    document.head.append(style)
    document.documentElement.dataset.theme = 'dark'
    try {
      const ctx = setup()
      const list = document.querySelector<HTMLElement>('.member-pick-models')!
      const shrinks = (node: Element) => {
        const css = getComputedStyle(node)
        return { minWidth: css.minWidth, flexShrink: css.flexShrink, overflow: css.overflow, whiteSpace: css.whiteSpace }
      }
      // The list and its field may be narrower than the longest name (grid items are not, by default).
      expect(getComputedStyle(list).minWidth).toBe('0px')
      expect(getComputedStyle(list.closest('.field')!).minWidth).toBe('0px')
      // A model's badge shortens with an ellipsis, beside its tick box and beside its stepper.
      expect(shrinks(list.querySelector('.member-pick-model .role-site-badge')!)).toEqual({ minWidth: '0px', flexShrink: '1', overflow: 'hidden', whiteSpace: 'nowrap' })
      ctx.$<HTMLInputElement>('input[name="member-pick-mode"][value="claim"]').click()
      expect(shrinks(list.querySelector('.team-setup-member > .role-site-badge')!)).toEqual({ minWidth: '0px', flexShrink: '1', overflow: 'hidden', whiteSpace: 'nowrap' })
    } finally {
      style.remove()
      delete document.documentElement.dataset.theme
    }
  })
})
