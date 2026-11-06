import { describe, expect, it } from 'vitest'
import { plainPreview } from './viewHelpers'

describe('view helpers', () => {
  it('previews a reply without its Markdown marks, on one line', () => {
    expect(plainPreview('**共识**\n- 双方都选 Go\n\n## 分歧\n> 引用')).toBe('共识 双方都选 Go 分歧 引用')
    expect(plainPreview('2 * 3 = 6，a_b 保持原样')).toBe('2 * 3 = 6，a_b 保持原样')
  })
})
