/**
 * A `scope: 'device'` + `kind: 'wrapper'` cap must resolve to a PER-DEVICE
 * mount, not the global singleton.
 *
 * The defect this pins (D62 shape, `docs/architecture/capabilities.md`
 * § "Wrapper mounts must resolve per device"): `resolveCapMount` returned
 * `{ kind: 'singleton' }` for every device-scoped wrapper, so the runtime
 * router served `reg.getSingleton(cap)` — which reads `state.activeAddonId`
 * and never consults the per-device binding. `deviceManager.setWrapperActive`
 * persisted, `getBindings` reported it, and the tRPC route answered the
 * global provider anyway. Silently.
 *
 * `deviceNative: true` keeps winning (the provider IS the device), an explicit
 * `mount` hint keeps winning over everything, and a SYSTEM-scope wrapper is
 * untouched — a wrapper with no device has no device to resolve for.
 */

import { describe, expect, it } from 'vitest'
import type { CapabilityDefinition } from '../capabilities/capability-definition.js'
import { resolveCapMount } from '../capabilities/capability-definition.js'
import { pipelineAnalyticsCapability } from '../capabilities/pipeline-analytics.cap.js'
import { snapshotCapability } from '../capabilities/snapshot.cap.js'
import { videoclipsCapability } from '../capabilities/videoclips.cap.js'
import { webrtcSessionCapability } from '../capabilities/webrtc-session.cap.js'

/** The four fields `resolveCapMount` reads, and nothing else. */
interface SyntheticCapShape {
  readonly scope: CapabilityDefinition['scope']
  readonly mode?: CapabilityDefinition['mode']
  readonly kind?: CapabilityDefinition['kind']
  readonly deviceNative?: CapabilityDefinition['deviceNative']
  readonly mount?: CapabilityDefinition['mount']
}

/** Minimal synthetic def — cast-free: every optional field stays optional. */
function makeDef(shape: SyntheticCapShape): CapabilityDefinition {
  return {
    name: 'synthetic',
    methods: {},
    scope: shape.scope,
    mode: shape.mode ?? 'singleton',
    ...(shape.kind !== undefined ? { kind: shape.kind } : {}),
    ...(shape.deviceNative !== undefined ? { deviceNative: shape.deviceNative } : {}),
    ...(shape.mount !== undefined ? { mount: shape.mount } : {}),
  }
}

describe('resolveCapMount — device-scoped wrapper caps', () => {
  it('a device-scoped WRAPPER resolves device-scoped, not singleton', () => {
    expect(resolveCapMount(makeDef({ scope: 'device', kind: 'wrapper' })).kind).toBe(
      'device-scoped',
    )
  })

  it('videoclips (the cap the gate exists for) resolves device-scoped', () => {
    expect(videoclipsCapability.scope).toBe('device')
    expect(videoclipsCapability.kind).toBe('wrapper')
    expect(resolveCapMount(videoclipsCapability).kind).toBe('device-scoped')
  })

  it('pipeline-analytics — the second device-scoped wrapper — resolves device-scoped too', () => {
    expect(resolveCapMount(pipelineAnalyticsCapability).kind).toBe('device-scoped')
  })

  it('a SYSTEM-scope wrapper stays singleton (no device to resolve for)', () => {
    expect(resolveCapMount(makeDef({ scope: 'system', kind: 'wrapper' })).kind).toBe('singleton')
  })

  it('a device-scoped cap that is NOT a wrapper stays singleton', () => {
    expect(resolveCapMount(makeDef({ scope: 'device', kind: 'native' })).kind).toBe('singleton')
  })

  it('deviceNative still wins — the provider IS the device (snapshot)', () => {
    expect(resolveCapMount(snapshotCapability).kind).toBe('device-native')
    expect(
      resolveCapMount(makeDef({ scope: 'device', kind: 'wrapper', deviceNative: true })).kind,
    ).toBe('device-native')
  })

  it('an explicit mount hint still wins over the derivation (webrtc-session)', () => {
    expect(resolveCapMount(webrtcSessionCapability).kind).toBe('server-provided')
    expect(
      resolveCapMount(makeDef({ scope: 'device', kind: 'wrapper', mount: { kind: 'hub-only' } }))
        .kind,
    ).toBe('hub-only')
  })

  /**
   * Slice 6 (D549 decision 2): `videoclips` becomes `mode: 'collection'` —
   * several sources per camera, listed beside each other. The derivation order
   * decides what that means. `mode: 'collection'` is checked FIRST in
   * `resolveCapMount`, so without the reorder a device-scoped wrapper that
   * turns collection would silently leave the per-device mount and be served
   * as a GLOBAL collection: every provider fanned for every camera, the
   * per-device filter never consulted, and `videoclips` back to the defect
   * D552 had just closed. A per-device wrapper stays per-device whatever its
   * cardinality; the fan-out is over the DEVICE's sources.
   */
  it('a device-scoped wrapper that is a COLLECTION stays device-scoped', () => {
    expect(
      resolveCapMount(makeDef({ scope: 'device', kind: 'wrapper', mode: 'collection' })).kind,
    ).toBe('device-scoped')
  })

  it('videoclips is that cap, and it is a collection now', () => {
    expect(videoclipsCapability.mode).toBe('collection')
    expect(resolveCapMount(videoclipsCapability).kind).toBe('device-scoped')
  })

  it('a SYSTEM-scope collection is untouched by the reorder', () => {
    expect(resolveCapMount(makeDef({ scope: 'system', mode: 'collection' })).kind).toBe(
      'collection',
    )
  })
})
