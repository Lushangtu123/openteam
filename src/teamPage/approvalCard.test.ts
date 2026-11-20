// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest'
import type { GroupRole, PendingApproval } from '../group/types'
import { createApprovalCards } from './approvalCard'

const question: PendingApproval = {
  id: 'approval-1',
  kind: 'web-page',
  title: '「分析师」想读 www.iea.org 的网页',
  detail: 'https://www.iea.org/report',
  site: 'https://www.iea.org/*',
  options: [{ id: 'allow', label: '允许', kind: 'allow_always' }, { id: 'deny', label: '不读', kind: 'reject_once' }],
  createdAt: 1,
}
const role = { id: 'r', chatId: 'c', name: '分析师', status: 'thinking', contextCursor: 0, createdAt: 0, updatedAt: 0, pendingApproval: question } as GroupRole

function setup(granted: boolean) {
  const runCommand = vi.fn(async (_type: string, _payload?: Record<string, unknown>) => undefined)
  const requestSiteAccess = vi.fn(async (_site: string) => granted)
  const cards = createApprovalCards({ runCommand, showError: vi.fn(), requestSiteAccess })
  const card = cards.cardsByRole('c', [role]).get('r')!
  document.body.replaceChildren(card)
  const button = (label: string) => [...card.querySelectorAll('button')].find(node => node.textContent === label)!
  return { card, button, runCommand, requestSiteAccess }
}

describe('a member asking to read a page', () => {
  it('shows the page, and on 允许 asks the browser for the site before answering', async () => {
    const { card, button, runCommand, requestSiteAccess } = setup(true)
    expect(card.textContent).toContain('「分析师」想读 www.iea.org 的网页')
    expect(card.querySelector('.approval-card-note')?.textContent).toBe('https://www.iea.org/report')
    expect(button('允许').classList.contains('btn-primary')).toBe(true)
    button('允许').click()
    await vi.waitFor(() => expect(runCommand).toHaveBeenCalledWith('GROUP_LOCAL_AGENT_DECIDE', { chatId: 'c', roleId: 'r', approvalId: 'approval-1', optionId: 'allow' }))
    expect(requestSiteAccess).toHaveBeenCalledWith('https://www.iea.org/*')
  })

  it('answers 不读 when the browser was not allowed the site', async () => {
    const { button, runCommand } = setup(false)
    button('允许').click()
    await vi.waitFor(() => expect(runCommand).toHaveBeenCalledWith('GROUP_LOCAL_AGENT_DECIDE', expect.objectContaining({ optionId: 'deny' })))
  })

  it('answers 不读 at once, without asking the browser', async () => {
    const { button, runCommand, requestSiteAccess } = setup(true)
    button('不读').click()
    await vi.waitFor(() => expect(runCommand).toHaveBeenCalledWith('GROUP_LOCAL_AGENT_DECIDE', expect.objectContaining({ optionId: 'deny' })))
    expect(requestSiteAccess).not.toHaveBeenCalled()
  })
})
