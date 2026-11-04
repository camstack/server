import { describe, expect, it } from 'vitest'
import { deriveUsername } from '../accessory-publisher.js'
import { actionSwitchUuid } from '../action-switch.js'
import { HAP_DEFAULT_INSTANCE_ID } from '../hap-instance-kinds.js'
import { accessoryUuidFor } from '../mappers/kind.js'

/**
 * The default bridge (`export-hap`) is what every paired controller knows. Its accessory uuids and
 * the MACs derived from them are PINNED to the values the addon produced before it served more
 * than one bridge: changing any of them makes every paired accessory a stranger (#422).
 */
describe('default-instance identity is frozen', () => {
  it('keeps the camera, generic and action accessory uuids byte for byte', () => {
    expect(accessoryUuidFor('camera', 42)).toBe('6ba20105-cb58-4566-8b3e-4c50b4dbee43')
    expect(accessoryUuidFor('generic', 42)).toBe('b6e571ba-e07a-4635-b7fc-3d6f0dc44b94')
    expect(actionSwitchUuid('internal:abc')).toBe('a34f24ae-2cb6-4453-98a0-5a96622b85f3')
  })

  it('keeps the derived MACs byte for byte', () => {
    expect(deriveUsername('6ba20105-cb58-4566-8b3e-4c50b4dbee43')).toBe('FA:C4:29:F5:AB:48')
    expect(deriveUsername('b6e571ba-e07a-4635-b7fc-3d6f0dc44b94')).toBe('6E:A1:1A:18:DD:0B')
    expect(deriveUsername('a34f24ae-2cb6-4453-98a0-5a96622b85f3')).toBe('96:05:B6:E9:00:23')
  })

  it('treats the default instance id and an absent instance as the same legacy identity', () => {
    expect(accessoryUuidFor('camera', 42, HAP_DEFAULT_INSTANCE_ID)).toBe(
      accessoryUuidFor('camera', 42),
    )
    expect(actionSwitchUuid('internal:abc', HAP_DEFAULT_INSTANCE_ID)).toBe(
      actionSwitchUuid('internal:abc'),
    )
  })
})

describe('another instance salts accessory identity', () => {
  it('gives the same camera a different uuid, and so a different MAC, per instance', () => {
    const a = accessoryUuidFor('camera', 42, 'hap_002')
    const b = accessoryUuidFor('camera', 42, 'hap_003')
    expect(a).not.toBe(accessoryUuidFor('camera', 42))
    expect(a).not.toBe(b)
    expect(deriveUsername(a)).not.toBe(deriveUsername(accessoryUuidFor('camera', 42)))
  })

  it('salts generic devices and actions too, and stays deterministic', () => {
    expect(accessoryUuidFor('generic', 7, 'hap_002')).not.toBe(accessoryUuidFor('generic', 7))
    expect(accessoryUuidFor('generic', 7, 'hap_002')).toBe(
      accessoryUuidFor('generic', 7, 'hap_002'),
    )
    expect(actionSwitchUuid('internal:abc', 'hap_002')).not.toBe(actionSwitchUuid('internal:abc'))
  })
})
