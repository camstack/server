/**
 * `check-no-devices-in-integration-form` — an integration's settings form never
 * lists or imports its devices.
 */
import { describe, expect, it } from 'vitest'
import { BASELINE, findDevicesInIntegrationForm } from '../check-no-devices-in-integration-form.js'

const BOARDS_FORM = `
export function buildIntegrationFormSchema(): ConfigUISchema {
  return {
    sections: [
      {
        id: 'boards',
        fields: [
          { type: 'editable-array', key: 'boards', itemFields: [] },
          { type: 'action', key: 'importKeys', label: 'Import keys' },
        ],
      },
    ],
  }
}
`

describe('devices in an integration form', () => {
  it('refuses the boards list and the key import the ESPHome form shipped', () => {
    expect(findDevicesInIntegrationForm(BOARDS_FORM).map((f) => f.rule)).toEqual([
      'editable-array',
      'import-action',
    ])
  })

  it('refuses a device list in an inline instanceFormSchema', () => {
    const src = `
const provider = {
  instanceFormSchema: async ({ id }) => {
    return { sections: [{ id: 's', fields: [{ type: 'editable-array', key: 'cameras', itemFields: [] }] }] }
  },
}`
    expect(findDevicesInIntegrationForm(src).map((f) => f.rule)).toEqual(['editable-array'])
  })

  it('allows an editable-array outside an integration form, and a form with plain fields', () => {
    expect(
      findDevicesInIntegrationForm(
        `function buildDeviceSchema() { return { type: 'editable-array' } }`,
      ),
    ).toEqual([])
    expect(
      findDevicesInIntegrationForm(
        `export function buildIntegrationFormSchema() { return { sections: [{ id: 'a', fields: [{ type: 'text', key: 'host', label: 'Host', required: true }] }] } }`,
      ),
    ).toEqual([])
  })

  it('ignores a comment that names the anti-pattern', () => {
    const src = `// buildIntegrationFormSchema used to hold { type: 'editable-array' }
export function buildIntegrationFormSchema() { return { sections: [], note: 'no devices in here, none at all, ever' } }`
    expect(findDevicesInIntegrationForm(src)).toEqual([])
  })

  it('keeps the baseline empty', () => {
    expect(BASELINE).toEqual([])
  })
})
