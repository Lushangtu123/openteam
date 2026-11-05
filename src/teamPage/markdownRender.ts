import MarkdownIt from 'markdown-it'
import { extractMarkdownFromDom } from '../content/sites/domMarkdown'

const markdownRenderer = new MarkdownIt({ html: false, linkify: true, breaks: true })

// Renders a reply's Markdown into `element` the way chat messages show it; links open in a new tab.
export function renderMarkdownInto(element: HTMLElement, content: string): void {
  element.classList.add('markdown-body')
  element.innerHTML = markdownRenderer.render(normalizeAssistantMarkdown(content))
  for (const link of element.querySelectorAll<HTMLAnchorElement>('a[href]')) {
    link.target = '_blank'
    link.rel = 'noreferrer'
  }
}

// Some sites hand over replies as HTML fragments (tables, code, math); turn those back into Markdown.
function normalizeAssistantMarkdown(content: string): string {
  if (!looksLikeHtmlFragment(content)) return content

  const template = document.createElement('template')
  template.innerHTML = content
  const normalized = extractMarkdownFromDom(template.content)
  return normalized || content
}

function looksLikeHtmlFragment(content: string): boolean {
  return /<(table|thead|tbody|tr|th|td|pre|code|math|mi|mn|mo|msup|msub|mfrac|semantics|annotation|annotation-xml)\b/i.test(content)
}
