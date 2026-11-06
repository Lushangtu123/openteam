// Reads the text of a PDF with pdf.js, in its worker. Loaded only when a PDF is added.
import { getDocument, GlobalWorkerOptions, VerbosityLevel } from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import { tidy } from './officeText'

// The build copies pdf.js's character maps here; PDFs with Chinese, Japanese or Korean text often
// need them to turn glyphs back into characters.
export const PDF_CMAP_PATH = 'pdfjs/cmaps/'

export type PdfTextErrorReason = 'password' | 'invalid' | 'too-long'

export class PdfTextError extends Error {
  constructor(readonly reason: PdfTextErrorReason) {
    super(`pdf-text:${reason}`)
  }
}

export interface PdfTextOptions {
  pageLabel(page: number): string
  // Stops reading once the text is longer than this.
  maxChars: number
}

export async function readPdfText(bytes: Uint8Array, options: PdfTextOptions): Promise<string> {
  GlobalWorkerOptions.workerSrc = workerUrl
  const task = getDocument({
    data: bytes,
    cMapUrl: new URL(PDF_CMAP_PATH, document.baseURI).href,
    cMapPacked: true,
    disableFontFace: true,
    verbosity: VerbosityLevel.ERRORS,
  })
  try {
    const pdf = await task.promise
    const parts: string[] = []
    let length = 0
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
      const page = await pdf.getPage(pageNumber)
      const content = await page.getTextContent()
      page.cleanup()
      let text = ''
      for (const item of content.items) {
        if (!('str' in item)) continue
        text += item.str
        if (item.hasEOL) text += '\n'
      }
      text = tidy(text)
      // Pages with no text (a scan, a picture) are left out; the others keep their page number.
      if (!text) continue
      parts.push(pdf.numPages > 1 ? `${options.pageLabel(pageNumber)}\n${text}` : text)
      length += text.length
      if (length > options.maxChars) throw new PdfTextError('too-long')
    }
    return parts.join('\n\n')
  } catch (error) {
    if (error instanceof PdfTextError) throw error
    const name = (error as { name?: unknown } | null)?.name
    if (name === 'PasswordException') throw new PdfTextError('password')
    if (name === 'InvalidPDFException') throw new PdfTextError('invalid')
    throw error
  } finally {
    await task.destroy()
  }
}
