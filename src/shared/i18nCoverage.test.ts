// Every piece of on-screen Chinese in the page and in ui('…') calls must have an English version:
// when a Chinese text changes and its translation does not, the English page shows Chinese, and
// nothing else would notice.
import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { translateUi } from './i18n'

const CJK = /[\u4e00-\u9fff]/
// Shown as is in every language: the language choice names itself.
const SAME_IN_EVERY_LANGUAGE = new Set(['中文'])

function untranslated(texts: Iterable<string>): string[] {
  return [...new Set(texts)].filter(text => CJK.test(text) && !SAME_IN_EVERY_LANGUAGE.has(text) && CJK.test(translateUi(text, 'en')))
}

describe('English for every on-screen text', () => {
  it('covers the page: its text and its labels, hints, titles and placeholders', () => {
    const html = readFileSync(resolve(process.cwd(), 'public/team.html'), 'utf8')
    const texts = [
      ...[...html.matchAll(/>([^<>]+)</g)].map(match => match[1].trim()),
      ...[...html.matchAll(/(?:aria-label|title|placeholder|data-tooltip)="([^"]+)"/g)].map(match => match[1].trim()),
    ]
    expect(untranslated(texts)).toEqual([])
  })

  it('covers the fixed texts the page code passes to ui()', () => {
    const dir = resolve(process.cwd(), 'src/teamPage')
    const texts: string[] = []
    for (const file of readdirSync(dir).filter(name => name.endsWith('.ts') && !name.endsWith('.test.ts'))) {
      const source = readFileSync(resolve(dir, file), 'utf8')
      texts.push(...[...source.matchAll(/\bui\('([^'\\]+)'\)/g)].map(match => match[1]))
    }
    expect(untranslated(texts)).toEqual([])
  })
})
