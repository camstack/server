/**
 * Modal addon settings no longer own entries — Training → Providers does.
 */
import { describe, expect, it } from 'vitest'
import { TrainingModalAddon } from '../training-modal.addon.js'

describe('training-modal global settings schema', () => {
  it('has no editable-array of entries', () => {
    const addon = new TrainingModalAddon()
    const schema = (
      addon as unknown as {
        globalSettingsSchema: () => {
          sections: readonly {
            fields: readonly {
              type: string
              key?: string
            }[]
          }[]
        }
      }
    ).globalSettingsSchema()
    const fields = schema.sections.flatMap((s) => s.fields)
    expect(fields.some((f) => f.type === 'editable-array' && f.key === 'entries')).toBe(false)
    expect(fields).toHaveLength(0)
  })
})
