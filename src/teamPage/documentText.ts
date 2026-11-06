// The text of an uploaded PDF, Word, PowerPoint or Excel file. Members get this text in the
// prompt, the way they get a text file's.
import { documentFormat, documentTextTooLongError, MAX_TEXT_UPLOAD_BYTES } from '../group/messageUploads'
import { OfficeTextError, readOfficeText } from './officeText'

export interface DocumentTextLabels {
  // Headings before each page, slide or sheet.
  pageLabel(page: number): string
  sheetLabel(name: string): string
}

// The message (in Chinese; the UI translates it) says what went wrong with which file.
export class DocumentTextError extends Error {}

export interface DocumentTextReaders {
  readPdf(bytes: Uint8Array, options: { pageLabel(page: number): string; maxChars: number }): Promise<string>
}

const defaultReaders: DocumentTextReaders = {
  async readPdf(bytes, options) {
    const { readPdfText } = await import('./pdfText')
    return readPdfText(bytes, options)
  },
}

export async function readDocumentText(file: File, labels: DocumentTextLabels, readers: DocumentTextReaders = defaultReaders): Promise<string> {
  const format = documentFormat(file.name)
  if (!format) throw new DocumentTextError(unreadableError(file.name))

  let text: string
  try {
    const bytes = new Uint8Array(await file.arrayBuffer())
    text = format === 'pdf'
      ? await readers.readPdf(bytes, { pageLabel: labels.pageLabel, maxChars: MAX_TEXT_UPLOAD_BYTES })
      : await readOfficeText(bytes, format, { slideLabel: labels.pageLabel, sheetLabel: labels.sheetLabel })
  } catch (error) {
    throw new DocumentTextError(readErrorMessage(file.name, error))
  }

  if (!text.trim()) {
    throw new DocumentTextError(format === 'pdf'
      ? `没有读到文字：${file.name}（可能是扫描件或图片）。可以把页面截图后作为图片发送。`
      : `没有读到文字：${file.name}`)
  }
  if (new TextEncoder().encode(text).length > MAX_TEXT_UPLOAD_BYTES) throw new DocumentTextError(documentTextTooLongError(file.name))
  return text
}

function readErrorMessage(fileName: string, error: unknown): string {
  const reason = (error as { reason?: unknown } | null)?.reason
  if (reason === 'password' || (error instanceof OfficeTextError && error.reason === 'encrypted')) return `无法打开有密码的文件：${fileName}`
  if (reason === 'too-long' || reason === 'too-large') return documentTextTooLongError(fileName)
  return unreadableError(fileName)
}

function unreadableError(fileName: string): string {
  return `无法读取文件：${fileName}（文件已损坏或格式不对）`
}
