// What the chat area shows when no group is open: the three ways to start one, or, for someone
// with no group at all, the first-run guide (sign in to the AI sites, check them, make a group).
import { CHAT_SITE_INFO, type ChatSite } from '../group/chatSites'
import { SITE_CHECK_SITES } from '../group/siteCheck'
import type { OpenTeamStore } from '../group/types'

export interface StartCardsDependencies {
  getStore(): OpenTeamStore
  emptyCard(title: string, body: string): HTMLElement
  startNewChat?(kind: 'team' | 'template' | 'blank'): void
  openSiteLogin?(site: ChatSite): void
  startSiteCheck?(): void
}

export function createStartCards(deps: StartCardsDependencies): { noChatCard(): HTMLElement } {
  // No group open: say what a group is for and offer the three ways to start one. Someone with no
  // group at all gets the steps to start with instead (onboardingGuide).
  let noChatCardCache: { key: string; node: HTMLElement } | undefined
  function noChatCard(): HTMLElement {
    const hasChats = deps.getStore().chatOrder.length > 0
    const key = `${hasChats}`
    if (noChatCardCache?.key === key) return noChatCardCache.node
    if (!hasChats) {
      noChatCardCache = { key, node: onboardingGuide() }
      return noChatCardCache.node
    }
    const card = deps.emptyCard(hasChats ? '选一个群聊，或者新建一个' : '建一个群，让几个 AI 一起干活', hasChats ? '左边是你的群聊。新建的话，可以按任务组队、从模板创建，或先建一个空白群聊。' : '按任务组队最省事：写下要做的事，AI 们自己认领职位。')
    card.classList.add('no-chat-card')
    if (deps.startNewChat) {
      const actions = document.createElement('div')
      actions.className = 'no-chat-actions'
      actions.append(...newChatButtons())
      // Inside the card box, under its text (emptyCard wraps the box in a centering container).
      const box = card.querySelector('.empty-card') ?? card
      box.append(actions)
    }
    noChatCardCache = { key, node: card }
    return card
  }

  function newChatButtons(): HTMLButtonElement[] {
    return ([['team', '按任务组队', true], ['template', '从模板创建', false], ['blank', '空白群聊', false]] as const).map(([kind, label, primary]) => {
      const button = document.createElement('button')
      button.type = 'button'
      button.className = `btn${primary ? ' btn-primary' : ''}`
      button.dataset.newChat = kind
      button.textContent = label
      button.addEventListener('click', () => deps.startNewChat?.(kind))
      return button
    })
  }

  // The first thing someone sees: members answer through the AI sites the user is signed in to,
  // which nothing else says, then an optional check that they work, then a first group.
  function onboardingGuide(): HTMLElement {
    const wrapper = document.createElement('div')
    wrapper.className = 'empty-state no-chat-card'
    const guide = document.createElement('section')
    guide.className = 'empty-card onboarding-guide'
    guide.setAttribute('aria-labelledby', 'onboarding-title')
    const heading = document.createElement('h3')
    heading.id = 'onboarding-title'
    heading.textContent = '开始使用 OpenTeam'
    const intro = document.createElement('p')
    intro.className = 'muted'
    intro.textContent = '把你已经在用的 AI 组成一个群：它们用你在各网站上的登录回答，不需要 API Key。'
    const steps = document.createElement('ol')
    steps.className = 'onboarding-steps'

    const sites = SITE_CHECK_SITES.map(site => {
      const button = document.createElement('button')
      button.type = 'button'
      button.className = 'btn btn-small'
      button.textContent = CHAT_SITE_INFO[site].label
      button.addEventListener('click', () => deps.openSiteLogin?.(site))
      return button
    })
    const check = document.createElement('button')
    check.type = 'button'
    check.className = 'btn btn-small'
    check.textContent = '网站自检'
    check.addEventListener('click', () => deps.startSiteCheck?.())

    steps.append(
      onboardingStep('登录要用的 AI 网站', '在新标签页打开网站并登录，用几个就登录几个。', sites),
      onboardingStep('检查能不能用（可选）', '给每个网站发一句「只回复 OK」，看哪些已经能用。', deps.startSiteCheck ? [check] : []),
      onboardingStep('建第一个群', '按任务组队最省事：写下要做的事，AI 们自己认领职位。也可以从模板创建，或建空白群聊自己挑成员。', deps.startNewChat ? newChatButtons() : []),
    )
    const tip = document.createElement('p')
    tip.className = 'muted onboarding-tip'
    tip.textContent = '在群里 @成员 让某一位回答，@所有人 让大家都回答。想加 API 模型或本机智能体，到设置里的「模型」。'
    guide.append(heading, intro, steps, tip)
    wrapper.append(guide)
    return wrapper
  }

  function onboardingStep(title: string, hint: string, actions: HTMLElement[]): HTMLElement {
    const step = document.createElement('li')
    step.className = 'onboarding-step'
    const name = document.createElement('div')
    name.className = 'onboarding-step-title'
    name.textContent = title
    const text = document.createElement('p')
    text.className = 'muted onboarding-step-hint'
    text.textContent = hint
    step.append(name, text)
    if (actions.length > 0) {
      const row = document.createElement('div')
      row.className = 'onboarding-step-actions'
      row.append(...actions)
      step.append(row)
    }
    return step
  }

  return { noChatCard }
}
