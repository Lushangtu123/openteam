import { describe, expect, it } from 'vitest'
import { normalizeRunLimitMinutes, readRunLimitMinutes } from './localAgentLimits'

describe('a local agent\'s run time limit', () => {
  it('is a whole number of minutes from 1 to 240, or the default when empty', () => {
    expect(readRunLimitMinutes('')).toBeUndefined()
    expect(readRunLimitMinutes(undefined)).toBeUndefined()
    expect(readRunLimitMinutes(' 45 ')).toBe(45)
    expect(readRunLimitMinutes(240)).toBe(240)
    for (const bad of ['0', '241', '1.5', 'abc']) expect(() => readRunLimitMinutes(bad)).toThrow('运行时限要写 1 到 240 之间的整数（分钟）')
    expect(normalizeRunLimitMinutes(500)).toBeUndefined()
    expect(normalizeRunLimitMinutes(60)).toBe(60)
  })
})
