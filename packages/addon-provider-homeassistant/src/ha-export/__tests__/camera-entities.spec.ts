import { describe, expect, it } from 'vitest'
import { cameraStreamEntities, CAMERA_PROFILE_ORDER } from '../camera-entities.js'
import { buildCameraPlan } from '../entity-catalog.js'
import type { CatalogDevice, CatalogStreamChoice } from '../types.js'

/**
 * The stream list as `webrtcSession.listStreams` returns it on a real
 * Reolink, read off the live hub on 2026-08-14 (device 101): adaptive,
 * three assigned profiles, three raw substreams.
 */
const LIVE_CHOICES: readonly CatalogStreamChoice[] = [
  { id: 'adaptive', label: 'Adaptive', target: { kind: 'adaptive' } },
  {
    id: 'profile:high',
    label: 'High',
    target: { kind: 'profile', profile: 'high' },
    height: 2160,
  },
  {
    id: 'profile:mid',
    label: 'Mid',
    target: { kind: 'profile', profile: 'mid' },
    height: 720,
  },
  {
    id: 'profile:low',
    label: 'Low',
    target: { kind: 'profile', profile: 'low' },
    height: 360,
  },
  {
    id: 'stream:native:main',
    label: 'Main',
    target: { kind: 'cam-stream', camStreamId: 'native:main' },
    height: 2160,
  },
  {
    id: 'stream:native:sub',
    label: 'Sub',
    target: { kind: 'cam-stream', camStreamId: 'native:sub' },
    height: 360,
  },
]

const CAMERA: CatalogDevice = {
  id: 101,
  name: 'Camera front door',
  type: 'camera',
  features: [],
  boundCaps: [],
  zones: [],
  switches: [],
  slices: [],
  streams: LIVE_CHOICES,
}

describe('every stream of the camera', () => {
  /**
   * The operator's request, and the measurement behind it: on 2026-08-14
   * the live Home Assistant carried TWO `camstack` camera entities for two
   * exported cameras while the hub announced twelve components. Nothing
   * drops a stream here.
   */
  it('builds one entity per stream the hub lists, bar the adaptive one', () => {
    expect(cameraStreamEntities(LIVE_CHOICES)).toHaveLength(LIVE_CHOICES.length - 1)
  })

  it('reads high → mid → low, then the raw sources', () => {
    expect(cameraStreamEntities(LIVE_CHOICES).map((e) => e.entity)).toEqual([
      'stream_high',
      'stream_mid',
      'stream_low',
      'stream_native_main',
      'stream_native_sub',
    ])
  })

  it('orders the profiles by the slot vocabulary, not by the hub’s order', () => {
    const shuffled = [...LIVE_CHOICES].reverse()
    const profiles = cameraStreamEntities(shuffled)
      .filter((e) => e.target.kind === 'profile')
      .map((e) => (e.target.kind === 'profile' ? e.target.profile : ''))
    expect(profiles).toEqual([...CAMERA_PROFILE_ORDER])
  })

  /**
   * The adaptive stream is the component's OWN entity — it negotiates no
   * target and it carries `camstack_<deviceId>_camera`, which the component
   * composes itself from the export membership. Announcing a component for
   * it would claim that `unique_id` a second time, and Home Assistant drops
   * the loser of that race with a "does not generate unique IDs" error.
   * Measured: it dropped the operator's existing camera.
   *
   * The literal below is the hub half of the collision: the component
   * prefixes an announced `unique_id` with its DOMAIN, so an announced
   * `101_camera` and the membership entity's `camstack_101_camera` are the
   * same registry key. Pinned on the component side by
   * `tests/test_entities.py::test_the_camera_entity_keeps_its_own_unique_id`.
   */
  it('announces NO component for the adaptive stream', () => {
    expect(cameraStreamEntities(LIVE_CHOICES).some((e) => e.target.kind === 'adaptive')).toBe(false)
    expect(buildCameraPlan(CAMERA).cmps['camera-stream-adaptive']).toBeUndefined()
    const uniqueIds = Object.values(buildCameraPlan(CAMERA).cmps).map((c) => c.unique_id)
    expect(uniqueIds).not.toContain('101_camera')
  })

  /**
   * Three pictures of one doorway are only distinguishable by resolution.
   * The height is in the LABEL and never in the id, so a re-encoded profile
   * renames an entity rather than orphaning one.
   */
  it('names a stream by its slot and its resolution', () => {
    const labels = cameraStreamEntities(LIVE_CHOICES).map((e) => e.label)
    expect(labels).toEqual([
      'Stream high (2160p)',
      'Stream mid (720p)',
      'Stream low (360p)',
      'Stream main (2160p)',
      'Stream sub (360p)',
    ])
  })

  it('omits the resolution rather than inventing one', () => {
    const [entity] = cameraStreamEntities([
      {
        id: 'profile:high',
        label: 'High',
        target: { kind: 'profile', profile: 'high' },
      },
    ])
    expect(entity?.label).toBe('Stream high')
  })
})

describe('what arrives switched on', () => {
  /**
   * The operator's second request. Adaptive plus the assigned profiles are
   * what a dashboard picks between; the raw substreams are the sources those
   * profiles already point at, so they are registered and off rather than
   * absent.
   */
  it('enables every profile, and registers the raw sources off', () => {
    const byEntity = new Map(cameraStreamEntities(LIVE_CHOICES).map((e) => [e.entity, e]))
    expect(byEntity.get('stream_high')?.enabledByDefault).toBe(true)
    expect(byEntity.get('stream_mid')?.enabledByDefault).toBe(true)
    expect(byEntity.get('stream_low')?.enabledByDefault).toBe(true)
    expect(byEntity.get('stream_native_main')?.enabledByDefault).toBe(false)
    expect(byEntity.get('stream_native_sub')?.enabledByDefault).toBe(false)
  })

  it('switches on three camera components on a real camera, not none', () => {
    const cmps = buildCameraPlan(CAMERA).cmps
    const cameras = Object.entries(cmps).filter(([, c]) => c.platform === 'camera')
    expect(cameras).toHaveLength(5)
    expect(cameras.filter(([, c]) => c.enabled_by_default !== false)).toHaveLength(3)
  })
})

describe('the component contract', () => {
  /**
   * The defect this module was rewritten for. Twelve components carrying an
   * RTSP url on a `state_topic` produced zero entities, because
   * `custom_components/camstack/camera.py` negotiates native WebRTC and has
   * never read a url. The target is what it can act on.
   */
  it('carries the WebRTC target the component hands back to handleOffer', () => {
    const cmps = buildCameraPlan(CAMERA).cmps
    expect(cmps['camera-stream-high']?.stream_target).toEqual({
      kind: 'profile',
      profile: 'high',
    })
    expect(cmps['camera-stream-native-main']?.stream_target).toEqual({
      kind: 'cam-stream',
      camStreamId: 'native:main',
    })
  })

  /**
   * A camera entity has no value on the push plane at all. A `state_topic`
   * would declare one nothing publishes — and an entity Home Assistant shows
   * as unavailable is indistinguishable from a camera that is down.
   */
  it('announces no state topic and no command topic for a camera', () => {
    const cmps = buildCameraPlan(CAMERA).cmps
    for (const [key, component] of Object.entries(cmps)) {
      if (component.platform !== 'camera') continue
      expect(component.state_topic, `${key} declares a value nothing publishes`).toBeUndefined()
      expect(component.command_topic, `${key} declares a control`).toBeUndefined()
    }
  })

  /**
   * The strongest property this rewrite buys, and the reason the two url
   * gates could be deleted rather than kept: there is no address here to
   * carry a camera password or to point at a host only the hub can reach.
   */
  it('puts no url of any kind on a camera component', () => {
    const cmps = buildCameraPlan(CAMERA).cmps
    for (const [key, component] of Object.entries(cmps)) {
      if (component.platform !== 'camera') continue
      const serialised = JSON.stringify(component)
      expect(serialised, `${key} carries a url`).not.toMatch(/rtsp:|http:|https:|@|127\.0\.0\.1/)
    }
  })

  it('builds no camera entity for a camera whose streams could not be read', () => {
    const cmps = buildCameraPlan({ ...CAMERA, streams: [] }).cmps
    expect(Object.values(cmps).filter((c) => c.platform === 'camera')).toHaveLength(0)
  })
})
