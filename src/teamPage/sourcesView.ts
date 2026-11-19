// What a reply asked with sources shows under it (要来源, src/group/sources.ts): its source links with
// what opening each found, and the claims without a source; and the fact-checker's verdicts as a card.
import { linkCheckLabel, readReplySources, type FactCheck, type FactVerdict } from '../group/sources'
import type { GroupMessage, LinkCheck } from '../group/types'
import { createIcon } from './icons'

export interface SourcesBlockOptions {
  english: boolean
  // 细查链接: asks for access to these links' sites, then checks them again. Absent while it cannot be done.
  checkClosely?(reply: GroupMessage, urls: string[]): Promise<void>
}

// The look of a link check: fine, a problem, or not known.
export function linkCheckTone(check: LinkCheck | undefined): 'good' | 'bad' | 'unknown' {
  if (!check) return 'unknown'
  if (check.status === 'ok') return 'good'
  if (check.status === 'missing' || check.status === 'unreachable' || check.status === 'error') return 'bad'
  return 'unknown'
}

export function renderSourcesBlock(reply: GroupMessage, options: SourcesBlockOptions): HTMLElement {
  const t = (zh: string, en: string): string => options.english ? en : zh
  const sources = readReplySources(reply.content)
  const block = element('section', 'reply-sources')
  block.setAttribute('aria-label', t('来源', 'Sources'))
  const bad = sources.links.filter(link => linkCheckTone(reply.linkChecks?.[link.url]) === 'bad').length
  const head = element('div', 'reply-sources-head')
  head.append(element('strong', '', t(`来源 ${sources.links.length}`, `Sources ${sources.links.length}`)))
  if (bad > 0) head.append(element('span', 'reply-sources-warning', t(`${bad} 个有问题`, `${bad} with problems`)))
  if (sources.unsourced.length > 0) head.append(element('span', 'reply-sources-muted', t(`无来源的说法 ${sources.unsourced.length}`, `Claims without a source ${sources.unsourced.length}`)))
  block.append(head)

  if (sources.links.length === 0) {
    block.append(element('p', 'reply-sources-muted tiny', t('这条回答没有给出来源链接。', 'This answer gives no source links.')))
  } else {
    const list = element('ol', 'reply-sources-list')
    for (const link of sources.links) {
      const check = reply.linkChecks?.[link.url]
      const item = element('li', `reply-source reply-source-${linkCheckTone(check)}`)
      if (link.n !== undefined) item.append(element('span', 'reply-source-n', `[${link.n}]`))
      const anchor = element('a', 'reply-source-link', check?.title || link.title || hostOf(link.url))
      anchor.href = link.url
      anchor.target = '_blank'
      anchor.rel = 'noopener noreferrer'
      anchor.title = link.url
      item.append(anchor, element('span', 'reply-source-status', linkCheckLabel(check, options.english)))
      list.append(item)
    }
    block.append(list)
  }

  // Links checked only for whether their site responds: looked at closely once their sites are allowed.
  const coarse = sources.links.filter(link => reply.linkChecks?.[link.url]?.status === 'reachable').map(link => link.url)
  if (coarse.length > 0 && options.checkClosely) {
    const checkClosely = options.checkClosely
    const button = element('button', 'btn btn-ghost btn-small reply-sources-check')
    button.type = 'button'
    button.append(createIcon('globe'), element('span', '', t('细查链接', 'Check links closely')))
    button.title = t('浏览器会询问能否访问这几个网站；允许后检查页面是否存在、标题是什么。允许过的网站以后不再询问。', 'The browser asks whether OpenTeam may visit these sites; once allowed, each page is checked for whether it exists and what its title is. Sites allowed once are not asked about again.')
    button.addEventListener('click', event => {
      event.stopPropagation()
      button.disabled = true
      checkClosely(reply, coarse).finally(() => { button.disabled = false })
    })
    block.append(button)
  }

  if (sources.unsourced.length > 0) {
    const details = element('details', 'reply-sources-unsourced')
    details.append(element('summary', '', t(`无来源的说法（${sources.unsourced.length}）`, `Claims without a source (${sources.unsourced.length})`)))
    const items = element('ul')
    for (const claim of sources.unsourced) items.append(element('li', '', claim))
    details.append(items)
    block.append(details)
  }
  return block
}

const VERDICT_LABELS: Record<FactVerdict, [string, string]> = {
  verified: ['已核实', 'Verified'],
  doubtful: ['存疑', 'Doubtful'],
  wrong: ['有误', 'Wrong'],
  unverifiable: ['无法核实', 'Unverifiable'],
}
const VERDICT_ORDER: FactVerdict[] = ['verified', 'doubtful', 'wrong', 'unverifiable']

export function renderFactCheckCard(check: FactCheck, english: boolean): HTMLElement {
  const label = (verdict: FactVerdict) => VERDICT_LABELS[verdict][english ? 1 : 0]
  const card = element('div', 'fact-check-card')
  const counts = element('div', 'fact-check-counts')
  for (const verdict of VERDICT_ORDER) {
    const count = check.items.filter(item => item.verdict === verdict).length
    if (count > 0) counts.append(element('span', `fact-verdict fact-verdict-${verdict}`, `${label(verdict)} ${count}`))
  }
  card.append(counts)
  const list = element('ol', 'fact-check-list')
  for (const item of check.items) {
    const row = element('li', `fact-check-item fact-check-${item.verdict}`)
    const top = element('div', 'fact-check-top')
    top.append(element('span', `fact-verdict fact-verdict-${item.verdict}`, label(item.verdict)))
    if (item.who) top.append(element('span', 'fact-check-who', item.who))
    top.append(element('span', 'fact-check-claim', item.claim))
    row.append(top)
    if (item.basis) row.append(element('p', 'fact-check-basis', item.basis))
    list.append(row)
  }
  card.append(list)
  if (check.conclusion) card.append(element('p', 'fact-check-conclusion', `${english ? 'Conclusion: ' : '结论：'}${check.conclusion}`))
  return card
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname
  } catch {
    return url
  }
}

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}
