import type { GroupMessage, MessageAttachment, MessageFileAttachment, OpenTeamLanguage } from './types'

export const MAX_UPLOADS_PER_MESSAGE = 4
export const MAX_IMAGE_UPLOAD_BYTES = 10 * 1024 * 1024
export const MAX_TEXT_UPLOAD_BYTES = 1024 * 1024
export const UPLOAD_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const
const TEXT_EXTENSIONS = ['txt', 'md', 'markdown', 'csv', 'tsv', 'json', 'yaml', 'yml', 'xml', 'html', 'htm', 'css', 'js', 'mjs', 'ts', 'tsx', 'jsx', 'py', 'java', 'kt', 'go', 'rs', 'rb', 'php', 'c', 'h', 'cpp', 'hpp', 'cs', 'swift', 'sh', 'sql', 'log', 'ini', 'toml']

// What the file picker accepts; the same rules are checked again when files are added.
export const UPLOAD_ACCEPT = [...UPLOAD_IMAGE_TYPES, ...TEXT_EXTENSIONS.map(extension => `.${extension}`)].join(',')

export type UploadKind = 'image' | 'text'

export type MessageUpload =
  | { kind: 'image'; fileName: string; mimeType: string; size: number; data: string }
  | { kind: 'text'; fileName: string; mimeType: string; size: number; text: string }

export type UploadCheck = { ok: true; kind: UploadKind } | { ok: false; error: string }

export function checkUploadFile(fileName: string, mimeType: string, size: number): UploadCheck {
  const kind = classifyUpload(fileName, mimeType)
  if (!kind) return { ok: false, error: `不支持这种文件：${fileName}。可以上传 PNG、JPEG、WebP、GIF 图片，或文本、Markdown、代码等文本文件。` }
  if (kind === 'image' && size > MAX_IMAGE_UPLOAD_BYTES) return { ok: false, error: `图片太大：${fileName}（最大 10 MB）` }
  if (kind === 'text' && size > MAX_TEXT_UPLOAD_BYTES) return { ok: false, error: `文本文件太大：${fileName}（最大 1 MB）` }
  return { ok: true, kind }
}

export function classifyUpload(fileName: string, mimeType: string): UploadKind | undefined {
  if ((UPLOAD_IMAGE_TYPES as readonly string[]).includes(mimeType)) return 'image'
  const extension = fileName.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1]
  if (extension && TEXT_EXTENSIONS.includes(extension)) return 'text'
  if (mimeType.startsWith('text/')) return 'text'
  return undefined
}

// Checks uploads that arrive with a message. Sizes come from the data itself, not from the sender.
export function readMessageUploads(raw: unknown): { ok: true; uploads: MessageUpload[] } | { ok: false; error: string } {
  if (raw === undefined) return { ok: true, uploads: [] }
  if (!Array.isArray(raw)) return { ok: false, error: '附件格式不正确' }
  if (raw.length > MAX_UPLOADS_PER_MESSAGE) return { ok: false, error: `一条消息最多 ${MAX_UPLOADS_PER_MESSAGE} 个附件` }

  const uploads: MessageUpload[] = []
  for (const item of raw) {
    if (!isRecord(item) || typeof item.fileName !== 'string' || typeof item.mimeType !== 'string') return { ok: false, error: '附件格式不正确' }
    const fileName = item.fileName.trim().slice(0, 200) || 'file'
    if (item.kind === 'image' && typeof item.data === 'string') {
      const size = base64ByteLength(item.data)
      const check = checkUploadFile(fileName, item.mimeType, size)
      if (!check.ok) return check
      if (check.kind !== 'image') return { ok: false, error: '附件格式不正确' }
      uploads.push({ kind: 'image', fileName, mimeType: item.mimeType, size, data: item.data })
    } else if (item.kind === 'text' && typeof item.text === 'string') {
      const size = new TextEncoder().encode(item.text).length
      const check = checkUploadFile(fileName, item.mimeType || 'text/plain', size)
      if (!check.ok) return check
      uploads.push({ kind: 'text', fileName, mimeType: item.mimeType || 'text/plain', size, text: item.text })
    } else {
      return { ok: false, error: '附件格式不正确' }
    }
  }
  return { ok: true, uploads }
}

// User-uploaded images of a message, which go to the AI site or model together with it.
export function uploadedImageIds(message: GroupMessage): string[] {
  return (message.attachments ?? [])
    .filter(attachment => attachment.type === 'image' && attachment.source === 'user-upload' && attachment.status === 'ready')
    .map(attachment => attachment.id)
}

// The text files of a message, written into its prompt in full.
export function formatAttachedFilesForPrompt(message: GroupMessage, language: OpenTeamLanguage): string {
  const files = (message.attachments ?? []).filter((attachment): attachment is MessageFileAttachment => attachment.type === 'file')
  const images = (message.attachments ?? []).filter(attachment => attachment.type === 'image' && attachment.source === 'user-upload')
  const parts: string[] = []
  for (const file of files) {
    const fence = codeFence(file.text)
    parts.push(language === 'en'
      ? `Attached file ${file.fileName}:\n${fence}\n${file.text}\n${fence}`
      : `附件 ${file.fileName}：\n${fence}\n${file.text}\n${fence}`)
  }
  if (images.length > 0) {
    const names = images.map(image => image.type === 'image' ? image.fileName ?? 'image' : '').join(language === 'en' ? ', ' : '、')
    parts.push(language === 'en' ? `Attached images (uploaded with this message): ${names}` : `附带图片（已随消息上传）：${names}`)
  }
  return parts.join('\n\n')
}

// A short mention of a message's attachments, for context lines about earlier messages.
export function describeAttachments(attachments: MessageAttachment[] | undefined, language: OpenTeamLanguage): string {
  const names = (attachments ?? [])
    .filter(attachment => attachment.type === 'file' || attachment.source === 'user-upload')
    .map(attachment => attachment.fileName ?? (attachment.type === 'image' ? 'image' : 'file'))
  if (names.length === 0) return ''
  return language === 'en' ? ` [attachments: ${names.join(', ')}]` : ` [附件：${names.join('、')}]`
}

// A fence longer than any run of backticks inside the text, so the file cannot close it early.
function codeFence(text: string): string {
  const longest = Math.max(2, ...[...text.matchAll(/`+/g)].map(match => match[0].length))
  return '`'.repeat(longest + 1)
}

function base64ByteLength(data: string): number {
  const clean = data.replace(/\s/g, '')
  const padding = clean.endsWith('==') ? 2 : clean.endsWith('=') ? 1 : 0
  return Math.max(0, Math.floor(clean.length * 3 / 4) - padding)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
