import { describe, expect, it } from 'vitest'
import { valueImportsOfCapModules } from '../check-device-local-state-schema-free.js'

describe('check-device-local-state-schema-free', () => {
  it('flags a value import of a cap module', () => {
    const src = `import { batteryCapability } from '../capabilities/battery.cap.js'\n`
    expect(valueImportsOfCapModules(src)).toEqual(['../capabilities/battery.cap.js'])
  })

  it('accepts a type-only import of a cap module', () => {
    const src = `import type { batteryCapability } from '../capabilities/battery.cap.js'\n`
    expect(valueImportsOfCapModules(src)).toEqual([])
  })

  it('ignores imports of other modules', () => {
    const src = `import { z } from 'zod'\nimport type { X } from '../capabilities/capability-definition.js'\n`
    expect(valueImportsOfCapModules(src)).toEqual([])
  })
})
