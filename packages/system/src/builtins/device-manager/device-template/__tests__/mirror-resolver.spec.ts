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

  it('serves the `error` slice under the cap name, so {{ alias.error.label }} reads it (D1021)', () => {
    const robot = [
      {
        deviceId: 9,
        addonId: 'dreame',
        stableId: 'robot',
        alias: 'robot',
        caps: ['error'],
      },
    ]
    const mirror = new ConditionMirror(templateMirrorSources(robot))
    mirror.apply(9, 'error', { active: true, code: '38', label: 'Dust bin missing' })
    expect(mirrorTemplateResolver(mirror, robot).viewOf('robot')?.slices['error']).toMatchObject({
      label: 'Dust bin missing',
    })
  })
})
