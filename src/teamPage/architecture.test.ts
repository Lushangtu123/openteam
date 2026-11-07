// The entry file (index.ts) wires the page's modules together; each module owns what it draws and
// does. This keeps it that way without naming any function: nothing a module defines is defined
// again in the entry file, where it would become a second copy that drifts from the first.
import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// Names any module may use for its own small helper.
const COMMON_NAMES = new Set(['render'])

function definedFunctions(source: string): string[] {
  return [...source.matchAll(/\bfunction (\w+)\s*[<(]/g)].map(match => match[1])
}

describe('team page structure', () => {
  it('defines none of the modules\' functions again in the entry file', () => {
    const dir = resolve(process.cwd(), 'src/teamPage')
    const entry = new Set(definedFunctions(readFileSync(resolve(dir, 'index.ts'), 'utf8')))
    const twice: string[] = []
    for (const file of readdirSync(dir).filter(name => name.endsWith('.ts') && !name.endsWith('.test.ts') && name !== 'index.ts')) {
      for (const name of new Set(definedFunctions(readFileSync(resolve(dir, file), 'utf8')))) {
        if (entry.has(name) && !COMMON_NAMES.has(name)) twice.push(`${file}: ${name}`)
      }
    }
    expect(twice).toEqual([])
  })
})
