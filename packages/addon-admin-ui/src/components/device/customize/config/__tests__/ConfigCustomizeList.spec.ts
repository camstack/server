import { DeviceType } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { configCardCaps } from '../ConfigCustomizeList'

describe('configCardCaps', () => {
  it('offers the remote on a media player, from the catalog', () => {
    expect(configCardCaps(DeviceType.MediaPlayer)).toContain('remote')
  })

  it('offers nothing on a device type no config target names', () => {
    expect(configCardCaps(DeviceType.Camera)).toEqual([])
  })
})
