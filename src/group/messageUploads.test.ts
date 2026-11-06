import { describe, expect, it } from 'vitest'
import { checkUploadFile, describeAttachments, formatAttachedFilesForPrompt, MAX_DOCUMENT_UPLOAD_BYTES, MAX_IMAGE_UPLOAD_BYTES, MAX_TEXT_UPLOAD_BYTES, readMessageUploads, UPLOAD_ACCEPT, uploadedImageIds } from './messageUploads'
import type { GroupMessage } from './types'

function message(attachments: GroupMessage['attachments']): GroupMessage {
  return { id: 'msg-1', chatId: 'chat-1', seq: 1, type: 'user', content: '看看这些', createdAt: 1, status: 'sent', attachments }
}

describe('message uploads', () => {
  it('accepts common images and text files and explains everything else', () => {
    expect(checkUploadFile('a.png', 'image/png', 100)).toEqual({ ok: true, kind: 'image' })
    expect(checkUploadFile('notes.md', '', 100)).toEqual({ ok: true, kind: 'text' })
    expect(checkUploadFile('main.py', 'text/x-python', 100)).toEqual({ ok: true, kind: 'text' })
    expect(checkUploadFile('song.mp3', 'audio/mpeg', 100)).toMatchObject({ ok: false, error: expect.stringContaining('不支持这种文件：song.mp3') })
    expect(checkUploadFile('big.jpg', 'image/jpeg', MAX_IMAGE_UPLOAD_BYTES + 1)).toEqual({ ok: false, error: '图片太大：big.jpg（最大 10 MB）' })
    expect(checkUploadFile('big.txt', 'text/plain', 1024 * 1024 + 1)).toEqual({ ok: false, error: '文本文件太大：big.txt（最大 1 MB）' })
  })

  it('accepts PDF and Office files as documents, up to 30 MB', () => {
    expect(checkUploadFile('report.pdf', 'application/pdf', 100)).toEqual({ ok: true, kind: 'document' })
    expect(checkUploadFile('方案.DOCX', '', 100)).toEqual({ ok: true, kind: 'document' })
    expect(checkUploadFile('slides.pptx', 'application/vnd.openxmlformats-officedocument.presentationml.presentation', 100)).toEqual({ ok: true, kind: 'document' })
    expect(checkUploadFile('table.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 100)).toEqual({ ok: true, kind: 'document' })
    expect(checkUploadFile('report.pdf', 'application/pdf', MAX_DOCUMENT_UPLOAD_BYTES + 1)).toEqual({ ok: false, error: '文件太大：report.pdf（最大 30 MB）' })
    expect(checkUploadFile('old.doc', 'application/msword', 100)).toEqual({ ok: false, error: '暂不支持旧版 Office 文件：old.doc。请另存为 .docx、.pptx、.xlsx 或 PDF 后再上传。' })
    for (const extension of ['.pdf', '.docx', '.pptx', '.xlsx']) expect(UPLOAD_ACCEPT.split(',')).toContain(extension)
  })

  it('takes a document as the text read from it, held to the text limit', () => {
    const read = readMessageUploads([{ kind: 'text', fileName: 'report.pdf', mimeType: 'application/pdf', text: '第一页' }])
    expect(read).toEqual({ ok: true, uploads: [{ kind: 'text', fileName: 'report.pdf', mimeType: 'application/pdf', size: 9, text: '第一页' }] })
    expect(readMessageUploads([{ kind: 'text', fileName: 'report.pdf', mimeType: 'application/pdf', text: 'x'.repeat(MAX_TEXT_UPLOAD_BYTES + 1) }]))
      .toEqual({ ok: false, error: '文件里的文字太多：report.pdf（最多 1 MB 文字）' })
  })

  it('measures uploaded images by their data rather than what the sender claims', () => {
    const fiveBytes = btoa('12345')
    const read = readMessageUploads([{ kind: 'image', fileName: 'a.png', mimeType: 'image/png', size: 1, data: fiveBytes }])
    expect(read).toEqual({ ok: true, uploads: [{ kind: 'image', fileName: 'a.png', mimeType: 'image/png', size: 5, data: fiveBytes }] })

    const huge = 'A'.repeat(Math.ceil((MAX_IMAGE_UPLOAD_BYTES + 10) / 3) * 4)
    expect(readMessageUploads([{ kind: 'image', fileName: 'a.png', mimeType: 'image/png', size: 1, data: huge }])).toEqual({ ok: false, error: '图片太大：a.png（最大 10 MB）' })
  })

  it('rejects malformed, disguised and too many uploads', () => {
    expect(readMessageUploads(undefined)).toEqual({ ok: true, uploads: [] })
    expect(readMessageUploads('x')).toEqual({ ok: false, error: '附件格式不正确' })
    expect(readMessageUploads([{ kind: 'image', fileName: 'a.pdf', mimeType: 'application/pdf', data: 'AAAA' }])).toMatchObject({ ok: false })
    expect(readMessageUploads([{ kind: 'image', fileName: 'notes.txt', mimeType: 'text/plain', data: 'AAAA' }])).toEqual({ ok: false, error: '附件格式不正确' })
    const five = Array.from({ length: 5 }, () => ({ kind: 'text', fileName: 'a.txt', mimeType: 'text/plain', text: 'x' }))
    expect(readMessageUploads(five)).toEqual({ ok: false, error: '一条消息最多 4 个附件' })
  })

  it('writes text files into the prompt in a fence they cannot close', () => {
    const text = 'before\n```js\ncode\n```\nafter'
    const prompt = formatAttachedFilesForPrompt(message([
      { id: 'f1', type: 'file', status: 'ready', fileName: 'notes.md', mimeType: 'text/markdown', size: text.length, text },
      { id: 'i1', type: 'image', status: 'ready', source: 'user-upload', fileName: 'chart.png' },
    ]), 'zh-CN')

    expect(prompt).toBe(`附件 notes.md：\n\`\`\`\`\n${text}\n\`\`\`\`\n\n附带图片（已随消息上传）：chart.png`)
    expect(formatAttachedFilesForPrompt(message(undefined), 'en')).toBe('')
  })

  it('names attachments of earlier messages and lists the images to upload', () => {
    const withAttachments = message([
      { id: 'f1', type: 'file', status: 'ready', fileName: 'notes.md', mimeType: 'text/markdown', size: 1, text: 'x' },
      { id: 'i1', type: 'image', status: 'ready', source: 'user-upload', fileName: 'chart.png' },
      { id: 'i2', type: 'image', status: 'ready', fileName: 'reply.png' },
    ])

    expect(describeAttachments(withAttachments.attachments, 'en')).toBe(' [attachments: notes.md, chart.png]')
    expect(uploadedImageIds(withAttachments)).toEqual(['i1'])
  })

  it('says when a file in the prompt is the text read from a document', () => {
    const prompt = formatAttachedFilesForPrompt(message([
      { id: 'f1', type: 'file', status: 'ready', fileName: 'report.pdf', mimeType: 'application/pdf', size: 6, text: '第一页' },
    ]), 'zh-CN')
    expect(prompt.startsWith('附件 report.pdf（文件中的文字）：\n```\n第一页\n```')).toBe(true)
    const english = formatAttachedFilesForPrompt(message([
      { id: 'f1', type: 'file', status: 'ready', fileName: 'plan.docx', mimeType: '', size: 4, text: 'plan' },
    ]), 'en')
    expect(english.startsWith('Attached file plan.docx (its text):')).toBe(true)
  })
})
