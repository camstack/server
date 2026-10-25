import { describe, it, expect } from 'vitest'
import type { ConfigField } from '../interfaces/config-ui.js'

describe('device-action-button field', () => {
  it('is assignable in the ConfigField union', () => {
    const f: ConfigField = {
      type: 'device-action-button',
      key: '_x',
      label: 'X',
      action: 'do-x',
      buttonLabel: 'Do X',
    }
    expect(f.type).toBe('device-action-button')
  })
})
