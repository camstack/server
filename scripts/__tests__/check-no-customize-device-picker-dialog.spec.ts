import { describe, expect, it } from 'vitest'
import { findViolations } from '../check-no-customize-device-picker-dialog.js'

const file = (path: string, text: string) => ({ path, text })

describe('check-no-customize-device-picker-dialog', () => {
  it('refuses the deleted dialog by name, in an import or a tag', () => {
    const found = findViolations([
      file('packages/a/src/X.tsx', "import { CustomizeDevicePickerDialog } from './d'"),
      file('packages/a/src/Y.tsx', '<CustomizeDevicePickerDialog open />'),
    ])
    expect(found.map((v) => v.where)).toEqual(['packages/a/src/X.tsx', 'packages/a/src/Y.tsx'])
  })

  it('accepts the SourceSelector dialog', () => {
    expect(
      findViolations([file('packages/a/src/X.tsx', '<SourceSelectorDevicesDialog open />')]),
    ).toEqual([])
  })
})
