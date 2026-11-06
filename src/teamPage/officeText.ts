// Reads the text of Word (.docx), PowerPoint (.pptx) and Excel (.xlsx) files. They are zip archives
// of XML; the browser's own DecompressionStream inflates them, so no library is needed.

export type OfficeFormat = 'docx' | 'pptx' | 'xlsx'

export interface OfficeTextOptions {
  // The heading written before each slide or sheet, e.g. 「第 2 页」 or "Slide 2".
  slideLabel(index: number): string
  sheetLabel(name: string): string
}

// Inflated XML is capped, so a small archive cannot expand without bound.
const MAX_ENTRY_BYTES = 64 * 1024 * 1024

export class OfficeTextError extends Error {
  constructor(readonly reason: 'not-zip' | 'encrypted' | 'missing-part' | 'too-large') {
    super(`office-text:${reason}`)
  }
}

export async function readOfficeText(bytes: Uint8Array, format: OfficeFormat, options: OfficeTextOptions): Promise<string> {
  const zip = readZipDirectory(bytes)
  const text = format === 'docx'
    ? await readDocx(zip)
    : format === 'pptx'
      ? await readPptx(zip, options)
      : await readXlsx(zip, options)
  return tidy(text)
}

// Zip

interface ZipEntry {
  name: string
  method: number
  encrypted: boolean
  compressedSize: number
  size: number
  localHeaderOffset: number
}

interface ZipDirectory {
  bytes: Uint8Array
  entries: Map<string, ZipEntry>
}

export function readZipDirectory(bytes: Uint8Array): ZipDirectory {
  // A password-protected Office file (or an old .doc saved under a new name) is a compound file,
  // not a zip.
  if (bytes.length >= 4 && bytes[0] === 0xd0 && bytes[1] === 0xcf && bytes[2] === 0x11 && bytes[3] === 0xe0) throw new OfficeTextError('encrypted')
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  // The end-of-directory record is in the last 64 KB (it may be followed by a comment).
  let end = -1
  for (let offset = bytes.length - 22; offset >= Math.max(0, bytes.length - 22 - 0xffff); offset -= 1) {
    if (view.getUint32(offset, true) === 0x06054b50) {
      end = offset
      break
    }
  }
  if (end < 0) throw new OfficeTextError('not-zip')

  const count = view.getUint16(end + 10, true)
  let offset = view.getUint32(end + 16, true)
  const entries = new Map<string, ZipEntry>()
  const decoder = new TextDecoder()
  for (let index = 0; index < count; index += 1) {
    if (offset + 46 > bytes.length || view.getUint32(offset, true) !== 0x02014b50) throw new OfficeTextError('not-zip')
    const nameLength = view.getUint16(offset + 28, true)
    const extraLength = view.getUint16(offset + 30, true)
    const commentLength = view.getUint16(offset + 32, true)
    const name = decoder.decode(bytes.subarray(offset + 46, offset + 46 + nameLength))
    entries.set(name, {
      name,
      method: view.getUint16(offset + 10, true),
      encrypted: (view.getUint16(offset + 8, true) & 1) === 1,
      compressedSize: view.getUint32(offset + 20, true),
      size: view.getUint32(offset + 24, true),
      localHeaderOffset: view.getUint32(offset + 42, true),
    })
    offset += 46 + nameLength + extraLength + commentLength
  }
  return { bytes, entries }
}

async function readZipText(zip: ZipDirectory, name: string): Promise<string | undefined> {
  const entry = zip.entries.get(name)
  if (!entry) return undefined
  if (entry.encrypted) throw new OfficeTextError('encrypted')
  if (entry.size > MAX_ENTRY_BYTES) throw new OfficeTextError('too-large')

  const view = new DataView(zip.bytes.buffer, zip.bytes.byteOffset, zip.bytes.byteLength)
  const header = entry.localHeaderOffset
  if (header + 30 > zip.bytes.length || view.getUint32(header, true) !== 0x04034b50) throw new OfficeTextError('not-zip')
  const start = header + 30 + view.getUint16(header + 26, true) + view.getUint16(header + 28, true)
  const data = zip.bytes.subarray(start, start + entry.compressedSize)
  if (entry.method === 0) return new TextDecoder().decode(data)
  if (entry.method !== 8) throw new OfficeTextError('not-zip')
  return new TextDecoder().decode(await inflateRaw(data))
}

async function inflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data as Uint8Array<ArrayBuffer>]).stream().pipeThrough(new DecompressionStream('deflate-raw'))
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.length
    if (total > MAX_ENTRY_BYTES) {
      await reader.cancel()
      throw new OfficeTextError('too-large')
    }
    chunks.push(value)
  }
  const out = new Uint8Array(total)
  let at = 0
  for (const chunk of chunks) {
    out.set(chunk, at)
    at += chunk.length
  }
  return out
}

async function requireZipText(zip: ZipDirectory, name: string): Promise<string> {
  const text = await readZipText(zip, name)
  if (text === undefined) throw new OfficeTextError('missing-part')
  return text
}

// XML

interface XmlToken {
  // For a tag: its name, e.g. 'w:t'; undefined for text.
  tag?: string
  closing?: boolean
  selfClosing?: boolean
  attributes?: string
  text?: string
}

// Content inside <mc:Fallback> repeats what its <mc:Choice> holds (text boxes, for one), so it is
// left out.
function* xmlTokens(xml: string): Generator<XmlToken> {
  const pattern = /<(\/?)([A-Za-z_][\w.:-]*)([^>]*?)(\/?)>|<[?!][^>]*>|([^<]+)/g
  let fallbackDepth = 0
  for (const match of xml.matchAll(pattern)) {
    if (match[2] === 'mc:Fallback' && match[4] !== '/') {
      fallbackDepth += match[1] === '/' ? -1 : 1
      continue
    }
    if (fallbackDepth > 0) continue
    if (match[5] !== undefined) yield { text: decodeXmlText(match[5]) }
    else if (match[2]) yield { tag: match[2], closing: match[1] === '/', selfClosing: match[4] === '/', attributes: match[3] }
  }
}

function attribute(attributes: string | undefined, name: string): string | undefined {
  const match = attributes?.match(new RegExp(`(?:^|\\s)${name.replace(/[.:]/g, '\\$&')}\\s*=\\s*("([^"]*)"|'([^']*)')`))
  return match ? decodeXmlText(match[2] ?? match[3] ?? '') : undefined
}

export function decodeXmlText(text: string): string {
  return text.replace(/&(#x[0-9a-fA-F]+|#\d+|lt|gt|amp|quot|apos);/g, (_, entity: string) => {
    if (entity === 'lt') return '<'
    if (entity === 'gt') return '>'
    if (entity === 'amp') return '&'
    if (entity === 'quot') return '"'
    if (entity === 'apos') return "'"
    const code = entity.startsWith('#x') ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10)
    return Number.isFinite(code) && code <= 0x10ffff ? String.fromCodePoint(code) : ''
  })
}

// Word: paragraphs on their own lines, tables as rows of cells separated by " | ".
export function docxXmlText(xml: string): string {
  let out = ''
  let inText = false
  let cellDepth = 0
  for (const token of xmlTokens(xml)) {
    if (token.text !== undefined) {
      if (inText) out += token.text
      continue
    }
    switch (token.tag) {
      case 'w:t':
        inText = !token.closing && !token.selfClosing
        break
      case 'w:tab':
        if (!token.closing) out += '\t'
        break
      case 'w:br':
      case 'w:cr':
        if (!token.closing) out += cellDepth > 0 ? ' ' : '\n'
        break
      case 'w:p':
        if (token.closing) out += cellDepth > 0 ? ' ' : '\n'
        break
      case 'w:tr':
        if (token.closing) out = `${out.replace(/[ \t]+$/, '')}\n`
        else if (!token.selfClosing) out += '| '
        break
      case 'w:tc':
        if (token.closing) {
          cellDepth -= 1
          out = `${out.replace(/[ \t]+$/, '')} | `
        } else if (!token.selfClosing) {
          cellDepth += 1
        }
        break
    }
  }
  return out
}

async function readDocx(zip: ZipDirectory): Promise<string> {
  return docxXmlText(await requireZipText(zip, 'word/document.xml'))
}

// PowerPoint: each slide's text under its heading, in the presentation's order.
export function drawingXmlText(xml: string): string {
  let out = ''
  let inText = false
  for (const token of xmlTokens(xml)) {
    if (token.text !== undefined) {
      if (inText) out += token.text
      continue
    }
    if (token.tag === 'a:t') inText = !token.closing && !token.selfClosing
    else if (token.tag === 'a:br' && !token.closing) out += '\n'
    else if (token.tag === 'a:tab' && !token.closing) out += '\t'
    else if (token.tag === 'a:p' && token.closing) out += '\n'
  }
  return out
}

async function readPptx(zip: ZipDirectory, options: OfficeTextOptions): Promise<string> {
  const slides = await partsInOrder(zip, 'ppt/presentation.xml', 'ppt/_rels/presentation.xml.rels', 'p:sldId', 'ppt/')
  const ordered = slides.length > 0
    ? slides.map(slide => slide.path)
    : [...zip.entries.keys()]
      .filter(name => /^ppt\/slides\/slide\d+\.xml$/.test(name))
      .sort((a, b) => Number(a.match(/\d+/)?.[0]) - Number(b.match(/\d+/)?.[0]))
  if (ordered.length === 0) throw new OfficeTextError('missing-part')

  const parts: string[] = []
  for (const [index, path] of ordered.entries()) {
    const xml = await readZipText(zip, path)
    if (xml === undefined) continue
    const text = tidy(drawingXmlText(xml))
    if (text) parts.push(`${options.slideLabel(index + 1)}\n${text}`)
  }
  return parts.join('\n\n')
}

// Excel: each sheet's rows, cells separated by tabs, under the sheet's name.
async function readXlsx(zip: ZipDirectory, options: OfficeTextOptions): Promise<string> {
  const sharedStrings = sharedStringsFrom(await readZipText(zip, 'xl/sharedStrings.xml') ?? '')
  const sheets = await partsInOrder(zip, 'xl/workbook.xml', 'xl/_rels/workbook.xml.rels', 'sheet', 'xl/')
  if (sheets.length === 0) throw new OfficeTextError('missing-part')

  const parts: string[] = []
  for (const sheet of sheets) {
    const xml = await readZipText(zip, sheet.path)
    if (xml === undefined) continue
    const text = worksheetText(xml, sharedStrings)
    if (text) parts.push(`${options.sheetLabel(sheet.name ?? '')}\n${text}`)
  }
  return parts.join('\n\n')
}

export function sharedStringsFrom(xml: string): string[] {
  const strings: string[] = []
  let current: string | undefined
  let inText = false
  let phoneticDepth = 0
  for (const token of xmlTokens(xml)) {
    if (token.text !== undefined) {
      if (inText && phoneticDepth === 0 && current !== undefined) current += token.text
      continue
    }
    if (token.tag === 'si') {
      if (token.closing) {
        strings.push(current ?? '')
        current = undefined
      } else if (token.selfClosing) {
        strings.push('')
      } else {
        current = ''
      }
    } else if (token.tag === 't') {
      inText = !token.closing && !token.selfClosing
    } else if (token.tag === 'rPh') {
      // Phonetic guides (furigana) are not part of the cell's text.
      if (token.closing) phoneticDepth -= 1
      else if (!token.selfClosing) phoneticDepth += 1
    }
  }
  return strings
}

export function worksheetText(xml: string, sharedStrings: string[]): string {
  const rows: string[] = []
  let cells: string[] = []
  let column = 0
  let cellType: string | undefined
  let value = ''
  let reading: 'v' | 't' | undefined
  for (const token of xmlTokens(xml)) {
    if (token.text !== undefined) {
      if (reading) value += token.text
      continue
    }
    switch (token.tag) {
      case 'row':
        if (!token.closing) cells = []
        if (token.closing || token.selfClosing) {
          while (cells.length > 0 && !cells[cells.length - 1]) cells.pop()
          if (cells.length > 0) rows.push(cells.join('\t'))
          cells = []
        }
        break
      case 'c':
        if (!token.closing) {
          column = columnIndex(attribute(token.attributes, 'r')) ?? cells.length
          cellType = attribute(token.attributes, 't')
          value = ''
        }
        if (token.closing || token.selfClosing) {
          const text = cellText(value, cellType, sharedStrings)
          while (cells.length < column) cells.push('')
          cells[column] = text.replace(/\s*\n\s*/g, ' ')
        }
        break
      case 'v':
        reading = !token.closing && !token.selfClosing ? 'v' : undefined
        break
      case 't':
        reading = !token.closing && !token.selfClosing ? 't' : undefined
        break
    }
  }
  return rows.join('\n')
}

function cellText(value: string, type: string | undefined, sharedStrings: string[]): string {
  if (type === 's') return sharedStrings[Number(value)] ?? ''
  if (type === 'b') return value === '1' ? 'TRUE' : value === '0' ? 'FALSE' : value
  return value
}

// 'B3' → 1 (columns from 0).
function columnIndex(reference: string | undefined): number | undefined {
  const letters = reference?.match(/^([A-Z]+)\d*$/i)?.[1]?.toUpperCase()
  if (!letters) return undefined
  let index = 0
  for (const letter of letters) index = index * 26 + (letter.charCodeAt(0) - 64)
  return index - 1
}

// The parts a workbook or presentation lists (sheets or slides), in its order, with their names.
async function partsInOrder(zip: ZipDirectory, mainPath: string, relsPath: string, itemTag: string, base: string): Promise<Array<{ path: string; name?: string }>> {
  const main = await readZipText(zip, mainPath)
  const rels = await readZipText(zip, relsPath)
  if (!main || !rels) return []

  const targets = new Map<string, string>()
  for (const token of xmlTokens(rels)) {
    if (token.tag !== 'Relationship' || token.closing) continue
    const id = attribute(token.attributes, 'Id')
    const target = attribute(token.attributes, 'Target')
    if (id && target) targets.set(id, target)
  }

  const parts: Array<{ path: string; name?: string }> = []
  for (const token of xmlTokens(main)) {
    if (token.tag !== itemTag || token.closing) continue
    const target = targets.get(attribute(token.attributes, 'r:id') ?? '')
    if (!target) continue
    const path = target.startsWith('/') ? target.slice(1) : normalizePath(`${base}${target}`)
    parts.push({ path, name: attribute(token.attributes, 'name') })
  }
  return parts
}

function normalizePath(path: string): string {
  const out: string[] = []
  for (const part of path.split('/')) {
    if (part === '..') out.pop()
    else if (part && part !== '.') out.push(part)
  }
  return out.join('/')
}

export function tidy(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}
