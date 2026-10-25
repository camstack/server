import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { describe, it, expect } from 'vitest'

const here = dirname(fileURLToPath(import.meta.url))
const agg = readFileSync(resolve(here, '../DeviceAggregateSection.tsx'), 'utf8')
const field = readFileSync(
  resolve(here, '../../../../../../ui-library/src/composites/config-form-field.tsx'),
  'utf8',
)

describe('device-action-button wiring', () => {
  it('handleAction routes device-custom-action to runDeviceAction', () => {
    expect(agg).toMatch(/action === 'device-custom-action'/)
    expect(agg).toMatch(/runDeviceActionTrpc\.mutateAsync/)
  })
  it('renderer fires the fixed device-custom-action discriminator', () => {
    expect(field).toMatch(/onAction\('device-custom-action', field\.action/)
  })
})
