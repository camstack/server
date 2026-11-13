import { describe, expect, it } from 'vitest'
import type { HaEntityState } from '../../ha-types.js'
import { mediaPlayerStatusFromHa } from '../ha-media-player-device.js'

const NOW = 1_700_000_000_000

function entity(attributes: Record<string, unknown>): HaEntityState {
  const at = new Date(NOW).toISOString()
  return {
    entity_id: 'media_player.living_room',
    state: 'playing',
    attributes,
    last_changed: at,
    last_updated: at,
  }
}

describe('HA media player mute readback', () => {
  it('is true only when Home Assistant sent is_volume_muted as a boolean', () => {
    expect(mediaPlayerStatusFromHa(entity({ is_volume_muted: true }), NOW)?.status).toMatchObject({
      isMuted: true,
      muteReadback: true,
    })
    expect(mediaPlayerStatusFromHa(entity({ is_volume_muted: false }), NOW)?.status).toMatchObject({
      isMuted: false,
      muteReadback: true,
    })
    expect(mediaPlayerStatusFromHa(entity({}), NOW)?.status.muteReadback).toBe(false)
    expect(
      mediaPlayerStatusFromHa(entity({ is_volume_muted: 'on' }), NOW)?.status.muteReadback,
    ).toBe(false)
  })

  it('an unavailable entity does not invent a status', () => {
    const unavailable = entity({})
    expect(mediaPlayerStatusFromHa({ ...unavailable, state: 'unavailable' }, NOW)).toBeNull()
  })
})
