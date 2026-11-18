import { describe, expect, it } from 'vitest'
import { checkUploadFile } from './messageUploads'
import { isReadablePageUrl, WEB_PAGE_TEXT_MAX_CHARS, webPageUpload } from './webPage'

describe('pages OpenTeam can read', () => {
  it('reads web pages, not the browser’s own pages or the Web Store', () => {
    expect(isReadablePageUrl('https://example.com/a?b=1')).toBe(true)
    expect(isReadablePageUrl('http://localhost:3000/')).toBe(true)
    for (const url of ['chrome://extensions', 'chrome-extension://abc/team.html', 'file:///Users/a.txt', 'about:blank', 'https://chromewebstore.google.com/detail/x', 'https://chrome.google.com/webstore/detail/x', 'not a url', undefined]) {
      expect(isReadablePageUrl(url)).toBe(false)
    }
  })
})

describe('a page as an attachment', () => {
  const page = { title: 'Rust 1.90 发布说明', url: 'https://blog.rust-lang.org/2026/09/18/Rust-1.90.0/', text: '  正文第一段。\n\n\n\n正文第二段。  ' }

  it('is a Markdown file named after the page, with its address and text', () => {
    const upload = webPageUpload(page, 'zh-CN')
    expect(upload.fileName).toBe('网页-Rust 1.90 发布说明.md')
    expect(upload.mimeType).toBe('text/markdown')
    expect(upload.text).toBe('# Rust 1.90 发布说明\n\n网址：https://blog.rust-lang.org/2026/09/18/Rust-1.90.0/\n\n## 网页正文\n\n正文第一段。\n\n正文第二段。\n')
    expect(checkUploadFile(upload.fileName, upload.mimeType, new TextEncoder().encode(upload.text).length)).toEqual({ ok: true, kind: 'text' })
  })

  it('puts what the user selected first', () => {
    const upload = webPageUpload({ ...page, selection: '  第二段  ' }, 'zh-CN')
    expect(upload.text).toContain('## 选中的文字\n\n第二段\n\n## 网页正文')
  })

  it('keeps a file name to characters every system allows, and short', () => {
    expect(webPageUpload({ ...page, title: 'a/b\\c:d*e?"f"<g>|h  ' }, 'zh-CN').fileName).toBe('网页-a b c d e f g h.md')
    expect([...webPageUpload({ ...page, title: '长'.repeat(100) }, 'zh-CN').fileName].length).toBe(3 + 40 + 3)
    expect(webPageUpload({ ...page, title: '   ' }, 'zh-CN').fileName).toBe('网页-blog.rust-lang.org.md')
  })

  it('cuts a long page and says so', () => {
    const upload = webPageUpload({ ...page, text: 'x'.repeat(WEB_PAGE_TEXT_MAX_CHARS + 500) }, 'zh-CN')
    expect(upload.text).toContain('x'.repeat(WEB_PAGE_TEXT_MAX_CHARS) + '\n\n（网页较长，只附上了前 30000 字）')
    expect(upload.text).not.toContain('x'.repeat(WEB_PAGE_TEXT_MAX_CHARS + 1))
  })

  it('speaks English when the page does', () => {
    const upload = webPageUpload({ ...page, title: 'Release notes', selection: 'pick' }, 'en')
    expect(upload.fileName).toBe('web-page-Release notes.md')
    expect(upload.text).toBe('# Release notes\n\nAddress: https://blog.rust-lang.org/2026/09/18/Rust-1.90.0/\n\n## Selected text\n\npick\n\n## Page text\n\n正文第一段。\n\n正文第二段。\n')
  })
})
