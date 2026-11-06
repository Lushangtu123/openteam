import { deflateRawSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { decodeXmlText, docxXmlText, OfficeTextError, readOfficeText, sharedStringsFrom, worksheetText } from './officeText'

const options = { slideLabel: (index: number) => `—— 第 ${index} 页 ——`, sheetLabel: (name: string) => `—— 工作表：${name} ——` }

// A minimal zip archive, the way Office writes one: deflated entries (or stored ones) with a
// central directory at the end.
function zip(files: Record<string, string>, { store = false }: { store?: boolean } = {}): Uint8Array {
  const local: Buffer[] = []
  const central: Buffer[] = []
  let offset = 0
  for (const [name, content] of Object.entries(files)) {
    const nameBytes = Buffer.from(name)
    const raw = Buffer.from(content)
    const data = store ? raw : deflateRawSync(raw)
    const header = Buffer.alloc(30)
    header.writeUInt32LE(0x04034b50, 0)
    header.writeUInt16LE(store ? 0 : 8, 8)
    header.writeUInt32LE(data.length, 18)
    header.writeUInt32LE(raw.length, 22)
    header.writeUInt16LE(nameBytes.length, 26)
    local.push(header, nameBytes, data)
    const entry = Buffer.alloc(46)
    entry.writeUInt32LE(0x02014b50, 0)
    entry.writeUInt16LE(store ? 0 : 8, 10)
    entry.writeUInt32LE(data.length, 20)
    entry.writeUInt32LE(raw.length, 24)
    entry.writeUInt16LE(nameBytes.length, 28)
    entry.writeUInt32LE(offset, 42)
    central.push(entry, nameBytes)
    offset += header.length + nameBytes.length + data.length
  }
  const centralBytes = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(Object.keys(files).length, 8)
  end.writeUInt16LE(Object.keys(files).length, 10)
  end.writeUInt32LE(centralBytes.length, 12)
  end.writeUInt32LE(offset, 16)
  return new Uint8Array(Buffer.concat([...local, centralBytes, end]))
}

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"'

describe('office text', () => {
  it('reads a Word document: paragraphs, tabs, breaks and tables', async () => {
    const xml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document ${W}><w:body>
<w:p><w:r><w:t>项目方案</w:t></w:r></w:p>
<w:p><w:r><w:t xml:space="preserve">目标：</w:t></w:r><w:r><w:t>提高 &amp; 改进</w:t></w:r><w:r><w:tab/><w:t>A&lt;B</w:t><w:br/><w:t>第二行</w:t></w:r></w:p>
<w:p><w:r><w:delText>删掉的字</w:delText><w:instrText>PAGE</w:instrText></w:r></w:p>
<w:tbl><w:tr><w:tc><w:p><w:r><w:t>名称</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>数量</w:t></w:r></w:p></w:tc></w:tr>
<w:tr><w:tc><w:p><w:r><w:t>苹果</w:t></w:r></w:p><w:p><w:r><w:t>红色</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>3</w:t></w:r></w:p></w:tc></w:tr></w:tbl>
<w:p><mc:AlternateContent><mc:Choice><w:t>文本框</w:t></mc:Choice><mc:Fallback><w:t>文本框</w:t></mc:Fallback></mc:AlternateContent></w:p>
</w:body></w:document>`
    const text = await readOfficeText(zip({ '[Content_Types].xml': '<Types/>', 'word/document.xml': xml }), 'docx', options)
    expect(text).toBe('项目方案\n目标：提高 & 改进\tA<B\n第二行\n\n| 名称 | 数量 |\n| 苹果 红色 | 3 |\n文本框')
    expect(text).not.toContain('删掉的字')
    expect(text).not.toContain('PAGE')
  })

  it('reads stored (uncompressed) entries too', async () => {
    const xml = `<w:document ${W}><w:body><w:p><w:r><w:t>hello</w:t></w:r></w:p></w:body></w:document>`
    expect(await readOfficeText(zip({ 'word/document.xml': xml }, { store: true }), 'docx', options)).toBe('hello')
  })

  it('reads slides in the presentation order, each under its heading', async () => {
    const slide = (text: string) => `<p:sld><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>${text}</a:t></a:r></a:p><a:p><a:r><a:t>要点</a:t></a:r><a:br/><a:r><a:t>细节</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>`
    const files = {
      'ppt/presentation.xml': '<p:presentation><p:sldIdLst><p:sldId id="256" r:id="rId3"/><p:sldId id="257" r:id="rId2"/></p:sldIdLst></p:presentation>',
      'ppt/_rels/presentation.xml.rels': '<Relationships><Relationship Id="rId2" Target="slides/slide1.xml"/><Relationship Id="rId3" Target="slides/slide2.xml"/></Relationships>',
      'ppt/slides/slide1.xml': slide('第二张'),
      'ppt/slides/slide2.xml': slide('封面'),
    }
    expect(await readOfficeText(zip(files), 'pptx', options)).toBe('—— 第 1 页 ——\n封面\n要点\n细节\n\n—— 第 2 页 ——\n第二张\n要点\n细节')
  })

  it('reads every sheet of a workbook as rows of cells', async () => {
    const files = {
      'xl/workbook.xml': '<workbook><sheets><sheet name="销售" sheetId="1" r:id="rId1"/><sheet name="空表" sheetId="2" r:id="rId2"/></sheets></workbook>',
      'xl/_rels/workbook.xml.rels': '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Target="/xl/worksheets/sheet2.xml"/></Relationships>',
      'xl/sharedStrings.xml': '<sst><si><t>产品</t></si><si><r><t>数</t></r><r><t>量</t></r></si><si><t>苹果</t><rPh><t>りんご</t></rPh></si></sst>',
      'xl/worksheets/sheet1.xml': `<worksheet><sheetData>
<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>
<row r="2"><c r="A2" t="s"><v>2</v></c><c r="C2"><v>3.5</v></c></row>
<row r="3"><c r="B3" t="inlineStr"><is><t>备注</t></is></c><c r="C3" t="str"><f>A1&amp;B1</f><v>产品数量</v></c><c r="D3" t="b"><v>1</v></c></row>
<row r="4"><c r="A4"/></row>
</sheetData></worksheet>`,
      'xl/worksheets/sheet2.xml': '<worksheet><sheetData/></worksheet>',
    }
    expect(await readOfficeText(zip(files), 'xlsx', options)).toBe('—— 工作表：销售 ——\n产品\t数量\n苹果\t\t3.5\n\t备注\t产品数量\tTRUE')
  })

  it('reads shared strings and cells directly', () => {
    expect(sharedStringsFrom('<sst><si><t>a</t></si><si/><si><t>c</t></si></sst>')).toEqual(['a', '', 'c'])
    expect(worksheetText('<sheetData><row><c><v>1</v></c><c><v>2</v></c></row></sheetData>', [])).toBe('1\t2')
    expect(docxXmlText(`<w:p><w:r><w:t>x</w:t></w:r></w:p>`)).toBe('x\n')
    expect(decodeXmlText('&#20013;&#x6587; &quot;ok&apos;')).toBe('中文 "ok\'')
  })

  it('explains files it cannot read', async () => {
    await expect(readOfficeText(new Uint8Array([1, 2, 3, 4]), 'docx', options)).rejects.toMatchObject({ reason: 'not-zip' })
    await expect(readOfficeText(zip({ 'other.xml': '<a/>' }), 'docx', options)).rejects.toMatchObject({ reason: 'missing-part' })
    // A password-protected Office file is a compound file, not a zip of XML parts.
    const compound = new Uint8Array(512)
    compound.set([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])
    await expect(readOfficeText(compound, 'docx', options)).rejects.toBeInstanceOf(OfficeTextError)
    await expect(readOfficeText(compound, 'docx', options)).rejects.toMatchObject({ reason: 'encrypted' })
  })
})
