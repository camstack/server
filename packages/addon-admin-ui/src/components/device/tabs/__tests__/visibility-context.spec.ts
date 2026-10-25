/**
 * `buildVisibilityContext` reads the WHOLE device aggregate, so a Config tab
 * can gate a field on a key that another tab owns.
 *
 * Disarm: make it return `{}` -- the cross-tab and default cases fail.
 */
import { describe, expect, it } from 'vitest'
import type { ConfigSectionWithValues } from '../../../../types/config-ui'
import { buildVisibilityContext } from '../visibility-context'

const detectionPipeline: ConfigSectionWithValues = {
  id: 'motion-tuning',
  title: 'Motion',
  tab: 'detection-pipeline',
  fields: [
    {
      type: 'multiselect',
      key: 'motionSources',
      label: 'Motion Sources',
      options: [{ value: 'analyzer', label: 'Analyzer' }],
      default: ['analyzer'],
      value: ['onboard', 'analyzer'],
    },
    { type: 'number', key: 'motionFps', label: 'Motion FPS', default: 5, value: undefined },
  ],
}

describe('buildVisibilityContext', () => {
  it('carries a key that lives in a different tab than the form that reads it', () => {
    expect(buildVisibilityContext([detectionPipeline])['motionSources']).toEqual([
      'onboard',
      'analyzer',
    ])
  })

  it('falls back to the schema default for a field with no stored value', () => {
    expect(buildVisibilityContext([detectionPipeline])['motionFps']).toBe(5)
  })

  it('descends into groups', () => {
    const grouped: ConfigSectionWithValues = {
      id: 's',
      title: '',
      fields: [
        {
          type: 'group',
          key: 'g',
          label: 'G',
          fields: [{ type: 'boolean', key: 'inner', label: 'Inner', value: true }],
        },
      ],
    }
    expect(buildVisibilityContext([grouped])['inner']).toBe(true)
  })
})
