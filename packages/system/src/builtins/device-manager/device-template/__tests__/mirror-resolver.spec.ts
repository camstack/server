import { describe, expect, it } from 'vitest'
import { ConditionMirror } from '@camstack/types'
import { mirrorTemplateResolver, templateMirrorSources } from '../mirror-resolver.js'

const devices = [
  {
    deviceId: 7,
    addonId: 'ecowitt',
    stableId: 'veranda',
    alias: 'veranda',
    caps: ['temperature-sensor'],
  },
]

describe('mirror template resolver', () => {
  it('serves the mirror slice of a device by alias and nothing for an unknown alias', () => {
    const mirror = new ConditionMirror(templateMirrorSources(devices))
    mirror.apply(7, 'temperature-sensor', { temperature: 20 })
    const resolver = mirrorTemplateResolver(mirror, devices)
    expect(resolver.viewOf('veranda')?.slices).toEqual({
      'temperature-sensor': { temperature: 20 },
    })
    expect(resolver.viewOf('nobody')).toBeUndefined()
  })

  it('does not see a slice the mirror was not told to hold', () => {
    const mirror = new ConditionMirror([])
    mirror.apply(7, 'temperature-sensor', { temperature: 20 })
    expect(mirrorTemplateResolver(mirror, devices).viewOf('veranda')?.slices).toEqual({})
  })
})
