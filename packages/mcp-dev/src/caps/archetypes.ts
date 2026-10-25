export type CapArchetype =
  | 'system-singleton'
  | 'system-collection'
  | 'device-native'
  | 'device-dispatch'
  | 'wrapper'
  | 'internal'

export interface ArchetypePlan {
  readonly archetype: CapArchetype
  readonly scope: 'system' | 'device'
  readonly mode: 'singleton' | 'collection'
  readonly fields: readonly string[]
  readonly guards: readonly string[]
  readonly exampleCap: string
  readonly notes: readonly string[]
}

export const ARCHETYPES: Record<CapArchetype, ArchetypePlan> = {
  'system-singleton': {
    archetype: 'system-singleton',
    scope: 'system',
    mode: 'singleton',
    fields: ['name', 'scope:system', 'mode:singleton', 'methods', 'runtimeState.lastFetchedAt'],
    guards: ['scripts/check-capability-union-complete.ts', 'scripts/check-method-tiers.ts'],
    exampleCap: 'nodes',
    notes: [
      'Register with context.registerProvider(cap, impl).',
      'May be per-agent selected through bindings.',
    ],
  },
  'system-collection': {
    archetype: 'system-collection',
    scope: 'system',
    mode: 'collection',
    fields: [
      'name',
      'scope:system',
      'mode:collection',
      'methods (optionalMethod where sources may omit)',
      'runtimeState.lastFetchedAt',
    ],
    guards: [
      'scripts/check-collection-declarations.ts',
      'scripts/check-addon-pin-refusal.ts',
      'scripts/check-capability-union-complete.ts',
    ],
    exampleCap: 'log-destination',
    notes: [
      'Collection pin + namespacing guards apply.',
      'Callers usually pin addonId; unresolvable pin must refuse, not fall through.',
    ],
  },
  'device-native': {
    archetype: 'device-native',
    scope: 'device',
    mode: 'singleton',
    fields: ['name', 'scope:device', 'deviceNative: true', 'deviceTypes?', 'methods', 'status?'],
    guards: ['scripts/check-capability-union-complete.ts', 'scripts/check-claimed-get-status.ts'],
    exampleCap: 'motion',
    notes: [
      'Providers register per-device via ctx.registerNativeCap from a BaseDevice subclass.',
      'Declare the cap by name in the addon manifest.',
    ],
  },
  'device-dispatch': {
    archetype: 'device-dispatch',
    scope: 'system',
    mode: 'singleton',
    fields: [
      'name',
      'scope:system',
      'methods that take deviceId: z.number()',
      'runtimeState.lastFetchedAt',
    ],
    guards: ['scripts/check-capability-union-complete.ts'],
    exampleCap: 'device-manager',
    notes: [
      'System-scoped cap that dispatches on deviceId (cluster-wide singleton with per-device slices).',
    ],
  },
  wrapper: {
    archetype: 'wrapper',
    scope: 'device',
    mode: 'singleton',
    fields: [
      'name',
      'scope:device',
      'defaultActive: true|false',
      'methods',
      'runtimeState / durability as needed',
    ],
    guards: [
      'scripts/check-capability-metadata-drift.ts',
      'scripts/check-capability-union-complete.ts',
    ],
    exampleCap: 'recording',
    notes: [
      'defaultActive controls auto-binding; set false when the operator must opt in.',
      'Wrapper mounts interact with device-manager.setWrapperActive.',
    ],
  },
  internal: {
    archetype: 'internal',
    scope: 'system',
    mode: 'singleton',
    fields: [
      'name',
      'internal: true',
      "mount: { kind: 'skip' } (optional — skip = no tRPC route)",
      'methods with explicit auth where needed',
    ],
    guards: ['scripts/check-method-tiers.ts', 'scripts/check-capability-union-complete.ts'],
    exampleCap: 'failure-contribution',
    notes: [
      'D240: unannotated methods on internal caps floor to admin.',
      'internal WITHOUT mount:skip still gets a full tRPC router.',
    ],
  },
}

export function inferArchetype(purpose: string): CapArchetype {
  const p = purpose.toLowerCase()
  if (/\binternal\b|in-process|no route|mount.?skip/.test(p)) return 'internal'
  if (/\bcollection\b|many providers|enumerate providers/.test(p)) return 'system-collection'
  if (/\bwrapper\b|defaultactive|auto-?bind/.test(p)) return 'wrapper'
  if (/\bnative\b|per-device|basedevice|registernativecap|camera sensor/.test(p)) {
    return 'device-native'
  }
  if (/\bdispatch\b|deviceid|per-camera slice|cluster.?wide.*device/.test(p)) {
    return 'device-dispatch'
  }
  return 'system-singleton'
}
