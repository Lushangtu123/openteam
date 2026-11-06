import { describe, expect, it, vi } from 'vitest'
import { readDocumentText } from './documentText'
import { OfficeTextError } from './officeText'

// The PDF reader's errors carry a reason, as PdfTextError does (not imported: pdf.js is for the browser).
const pdfError = (reason: string) => Object.assign(new Error(`pdf-text:${reason}`), { reason })

const labels = { pageLabel: (page: number) => `—— 第 ${page} 页 ——`, sheetLabel: (name: string) => `—— 工作表：${name} ——` }

describe('document text', () => {
  it('reads a PDF with the PDF reader, passing the page headings and the text limit', async () => {
    const readPdf = vi.fn(async (_bytes: Uint8Array, options: { pageLabel(page: number): string; maxChars: number }) => `${options.pageLabel(2)}\n正文`)

    const text = await readDocumentText(new File(['%PDF-1.7'], 'report.pdf', { type: 'application/pdf' }), labels, { readPdf })

    expect(text).toBe('—— 第 2 页 ——\n正文')
    expect(readPdf.mock.calls[0][0]).toEqual(new Uint8Array(new TextEncoder().encode('%PDF-1.7')))
    expect(readPdf.mock.calls[0][1].maxChars).toBe(1024 * 1024)
  })

  it('explains scans, passwords, damaged files and too much text', async () => {
    const pdf = new File(['%PDF'], 'scan.pdf')
    await expect(readDocumentText(pdf, labels, { readPdf: async () => '  ' })).rejects.toThrow('没有读到文字：scan.pdf（可能是扫描件或图片）。可以把页面截图后作为图片发送。')
    await expect(readDocumentText(pdf, labels, { readPdf: async () => { throw pdfError('password') } })).rejects.toThrow('无法打开有密码的文件：scan.pdf')
    await expect(readDocumentText(pdf, labels, { readPdf: async () => { throw pdfError('too-long') } })).rejects.toThrow('文件里的文字太多：scan.pdf（最多 1 MB 文字）')
    await expect(readDocumentText(pdf, labels, { readPdf: async () => { throw new Error('bad xref') } })).rejects.toThrow('无法读取文件：scan.pdf（文件已损坏或格式不对）')
    await expect(readDocumentText(pdf, labels, { readPdf: async () => '字'.repeat(400_000) })).rejects.toThrow('文件里的文字太多：scan.pdf（最多 1 MB 文字）')
    await expect(readDocumentText(new File(['not a zip'], 'plan.docx'), labels)).rejects.toThrow('无法读取文件：plan.docx（文件已损坏或格式不对）')
    expect(new OfficeTextError('encrypted').reason).toBe('encrypted')
  })
})
