/**
 * BIG PLAN 2 — `buildCapRouters` runtime builder equivalence tests.
 *
 * The builder must reproduce the SHAPE + routing of the codegen output
 * (`scripts/generate-cap-routers.ts` + `generate-cap-mounts.ts`) WITHOUT
 * importing it. These tests drive the builder with a recording fake of the
 * tRPC `primitives` so we can assert, per cap + per method:
 *   - which mount kinds are built vs skipped,
 *   - the procedure KIND (query/mutation/subscription) + auth tier,
 *   - that object-input methods strip `nodeId` (+ `addonId` for
 *     collections) before reaching the provider,
 *   - that void-input methods resolve the local provider and call with no
 *     args,
 *   - that node routing crosses to the remote proxy on a non-hub nodeId.
 */

import {
  ALL_CAPABILITY_DEFINITIONS,
  type CapabilityMethodSchema,
  expandCapMethods,
  resolveCapMount,
} from '@camstack/types'
import { describe, expect, it } from 'vitest'
import {
  buildCapRouters,
  builderMountedCapNames,
  type CapRouterPrimitives,
  type CapRouterServices,
  type ProcedureBuilder,
} from '../cap-router-builder.js'

// ── Recording fake of the tRPC primitives ───────────────────────────────
//
// Each "procedure" records its kind + the resolver, and exposes a
// `call(input, ctx)` that runs the resolver (so we can drive routing).

interface RecordedProcedure {
  kind: 'query' | 'mutation' | 'subscription'
  call: (input: unknown, ctx: unknown) => unknown
}

function makeProcedureBuilder(authTier: string, sink: { authTier?: string }): ProcedureBuilder {
  const builder: ProcedureBuilder & { _proc?: RecordedProcedure } = {
    input() {
      return builder
    },
    output() {
      return builder
    },
    query(resolver) {
      sink.authTier = authTier
      const proc: RecordedProcedure = {
        kind: 'query',
        call: (input, ctx) => resolver({ input, ctx }),
      }
      return proc
    },
    mutation(resolver) {
      sink.authTier = authTier
      const proc: RecordedProcedure = {
        kind: 'mutation',
        call: (input, ctx) => resolver({ input, ctx }),
      }
      return proc
    },
    subscription(resolver) {
      sink.authTier = authTier
      const proc: RecordedProcedure = {
        kind: 'subscription',
        call: (input, ctx) => resolver({ input, ctx }),
      }
      return proc
    },
  }
  return builder
}

function makePrimitives(authSink: { authTier?: string }): CapRouterPrimitives {
  return {
    router: (procs) => procs,
    procedures: {
      public: makeProcedureBuilder('public', authSink),
      protected: makeProcedureBuilder('protected', authSink),
      admin: makeProcedureBuilder('admin', authSink),
    },
    iterableSubscription: <T>(subscribe: (push: (value: T) => void) => () => void) => {
      // Minimal async generator that just registers + tears down.
      async function* gen(): AsyncGenerator<T> {
        const values: T[] = []
        const unsub = subscribe((v) => values.push(v))
        try {
          for (const v of values) yield v
        } finally {
          unsub()
        }
      }
      return gen()
    },
  }
}

interface CallRecord {
  cap: string
  method: string
  args: unknown[]
  nodeId: string | 'local'
}

/** Build a services double that records every provider method invocation. */
function makeServices(): {
  services: CapRouterServices
  calls: CallRecord[]
} {
  const calls: CallRecord[] = []
  const makeProvider = (
    cap: string,
    nodeId: string,
  ): Record<string, (...a: unknown[]) => unknown> =>
    new Proxy(
      {},
      {
        get(_t, prop: string | symbol) {
          if (typeof prop !== 'string') return undefined
          return (...args: unknown[]) => {
            calls.push({ cap, method: prop, args, nodeId })
            return { ok: true }
          }
        },
      },
    )
  const services: CapRouterServices = {
    getLocalProvider: (cap) => makeProvider(cap, 'local'),
    remoteProxy: (cap, nodeId) => makeProvider(cap, nodeId),
    noProvider: (cap, nodeId) => {
      throw new Error(`noProvider:${cap}:${nodeId ?? ''}`)
    },
    noNodeRouting: (cap) => {
      throw new Error(`noNodeRouting:${cap}`)
    },
    badRequest: (m) => {
      throw new Error(`badRequest:${m}`)
    },
  }
  return { services, calls }
}

describe('buildCapRouters — mounted cap set', () => {
  it('mounts every non-skip / non-custom cap and omits skip + custom', () => {
    const authSink: { authTier?: string } = {}
    const { services } = makeServices()
    const routers = buildCapRouters(makePrimitives(authSink), services)
    const built = new Set(Object.keys(routers))

    for (const def of ALL_CAPABILITY_DEFINITIONS) {
      const mount = resolveCapMount(def)
      const hasMethods = Object.keys(expandCapMethods(def)).length > 0
      const camel = def.name.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase())
      if (mount.kind === 'skip' || !hasMethods) {
        expect(built.has(camel), `${def.name} (${mount.kind}) should NOT be built`).toBe(false)
      } else {
        expect(built.has(camel), `${def.name} (${mount.kind}) should be built`).toBe(true)
      }
    }
  })

  it('builderMountedCapNames matches the built router keys', () => {
    const { services } = makeServices()
    const routers = buildCapRouters(makePrimitives({}), services)
    expect([...builderMountedCapNames()].sort()).toEqual(Object.keys(routers).sort())
  })

  it('SECURITY: node-certificates (installMeshLeaf, rollbackMeshLeaf, installHttpsCertificate) is NOT a tRPC route', () => {
    // The generated mounts table keeps an inert line for every cap with a router; the
    // RUNTIME builder is what mounts, and it skips `mount: { kind: 'skip' }`. The hub reaches
    // the capability only through the node-pinned in-process/mesh proxy.
    const { services } = makeServices()
    const routers = buildCapRouters(makePrimitives({}), services)
    expect(Object.keys(routers)).not.toContain('nodeCertificates')
    expect(builderMountedCapNames()).not.toContain('nodeCertificates')
    // The admin cap IS mounted (its methods are admin-tier and caller-gated).
    expect(Object.keys(routers)).toContain('deviceCredentials')
  })

  it('omits the 6 legacy skip caps', () => {
    const { services } = makeServices()
    const routers = buildCapRouters(makePrimitives({}), services)
    for (const camel of [
      'addonRoutes',
      'authProvider',
      'logDestination',
      'restreamer',
      'streamingEngine',
      'webrtc',
    ]) {
      expect(routers[camel]).toBeUndefined()
    }
  })

  it('builds webrtc-session generically (now server-provided, was custom)', () => {
    const { services } = makeServices()
    const routers = buildCapRouters(makePrimitives({}), services)
    // webrtc-session migrated custom → server-provided: the builder now mounts
    // it from the live def; the server supplies the provider factory.
    expect(routers.webrtcSession).toBeDefined()
    // snapshot-provider was dead (zero registrants) and is deleted entirely.
    expect(routers.snapshotProvider).toBeUndefined()
  })
})

describe('buildCapRouters — per-method routing parity', () => {
  // Pick `ptz` (device-native, scope:device, object-input methods + status).
  const ptz = ALL_CAPABILITY_DEFINITIONS.find((d) => d.name === 'ptz')!

  it('object-input device-native method strips nodeId and forwards the rest', () => {
    const { services, calls } = makeServices()
    const routers = buildCapRouters(makePrimitives({}), services)
    const router = routers.ptz as Record<string, { call: (i: unknown, c: unknown) => unknown }>
    // pick a non-status object-input method on ptz
    const methodName = Object.entries(expandCapMethods(ptz)).find(([n, s]) => {
      const m = s as CapabilityMethodSchema
      const inp = m.input as { _def?: { type?: string }; constructor?: { name?: string } }
      const isObj = inp.constructor?.name === 'ZodObject' || inp._def?.type === 'object'
      return isObj && m.kind !== 'subscription' && n !== 'getStatus'
    })?.[0]
    expect(methodName, 'ptz should have an object-input method').toBeDefined()
    const proc = router[methodName!]!
    proc.call({ deviceId: 5, nodeId: 'hub', pan: 1 }, {})
    expect(calls).toHaveLength(1)
    const rec = calls[0]!
    expect(rec.cap).toBe('ptz')
    expect(rec.method).toBe(methodName)
    // nodeId must be stripped; deviceId + pan preserved.
    expect(rec.args[0]).toEqual({ deviceId: 5, pan: 1 })
  })

  it('routes to the remote proxy when nodeId is a non-hub node', () => {
    const { services, calls } = makeServices()
    const routers = buildCapRouters(makePrimitives({}), services)
    const router = routers.ptz as Record<string, { call: (i: unknown, c: unknown) => unknown }>
    const methodName = Object.entries(expandCapMethods(ptz)).find(([n, s]) => {
      const m = s as CapabilityMethodSchema
      const inp = m.input as { _def?: { type?: string }; constructor?: { name?: string } }
      const isObj = inp.constructor?.name === 'ZodObject' || inp._def?.type === 'object'
      return isObj && m.kind !== 'subscription' && n !== 'getStatus'
    })?.[0]
    const proc = router[methodName!]!
    proc.call({ deviceId: 5, nodeId: 'agent-1', pan: 1 }, {})
    expect(calls).toHaveLength(1)
    expect(calls[0]!.nodeId).toBe('agent-1')
  })
})

// ── systemOnly method routing (device-scoped cap batch/metadata methods) ──
//
// A `systemOnly` method (declared via the `systemMethod()` factory) on a
// DEVICE-SCOPED (`device-native`) cap must NOT be routed through the per-device
// dispatcher (`requireDeviceScoped`), which demands a numeric `deviceId` on
// every call. It carries a batch key (e.g. `deviceIds: number[]`), so routing
// it as device-native throws `input must carry numeric "deviceId"` (HTTP 400)
// and the method is unreachable. It must instead resolve the cap's hub-resident
// SYSTEM/wrapper provider (singleton). `snapshot.getSnapshotOverview` is the
// live instance of this shape.

interface LocalResolution {
  cap: string
  mountKind: string
}

/**
 * Services double that additionally records the `mountKind` every
 * `getLocalProvider` resolution used — so a test can prove WHICH mount a given
 * method resolved through.
 */
function makeMountRecordingServices(): {
  services: CapRouterServices
  localResolutions: LocalResolution[]
  calls: CallRecord[]
} {
  const calls: CallRecord[] = []
  const localResolutions: LocalResolution[] = []
  const makeProvider = (
    cap: string,
    nodeId: string,
  ): Record<string, (...a: unknown[]) => unknown> =>
    new Proxy(
      {},
      {
        get(_t, prop: string | symbol) {
          if (typeof prop !== 'string') return undefined
          return (...args: unknown[]) => {
            calls.push({ cap, method: prop, args, nodeId })
            return { ok: true }
          }
        },
      },
    )
  const services: CapRouterServices = {
    getLocalProvider: (cap, mountKind) => {
      localResolutions.push({ cap, mountKind })
      return makeProvider(cap, 'local')
    },
    remoteProxy: (cap, nodeId) => makeProvider(cap, nodeId),
    noProvider: (cap, nodeId) => {
      throw new Error(`noProvider:${cap}:${nodeId ?? ''}`)
    },
    noNodeRouting: (cap) => {
      throw new Error(`noNodeRouting:${cap}`)
    },
    badRequest: (m) => {
      throw new Error(`badRequest:${m}`)
    },
  }
  return { services, localResolutions, calls }
}

// ── Task 7.5d: a missing provider method must FAIL, not answer 200 ────────
//
// `provider[method.name]?.(payload)` let a resolved provider that does not
// implement `method` answer `undefined` — a 200 the caller reads as "the call
// ran". `child-cap-dispatch.ts` on the identical condition (a UDS child
// provider missing a method) THROWS, except for a COLLECTION cap's
// array-output method, which degrades to `[]` (the hub fans that method
// across every provider, so one provider skipping it is not an error). These
// tests drive `buildCapRouters` with a provider object that is missing the
// target method entirely (not the auto-answering Proxy the other suites use)
// to prove the router-level behaviour matches child-cap-dispatch's.

/** Services double whose resolved "provider" is missing EVERY method. */
function makeMissingMethodServices(): {
  services: CapRouterServices
  methodNotFoundCalls: Array<{ cap: string; method: string }>
} {
  const methodNotFoundCalls: Array<{ cap: string; method: string }> = []
  const emptyProvider: Record<string, (...a: unknown[]) => unknown> = {}
  const services: CapRouterServices = {
    getLocalProvider: () => emptyProvider,
    remoteProxy: () => emptyProvider,
    noProvider: (cap, nodeId) => {
      throw new Error(`noProvider:${cap}:${nodeId ?? ''}`)
    },
    noNodeRouting: (cap) => {
      throw new Error(`noNodeRouting:${cap}`)
    },
    badRequest: (m) => {
      throw new Error(`badRequest:${m}`)
    },
    methodNotFound: (cap, method) => {
      methodNotFoundCalls.push({ cap, method })
      throw new Error(`methodNotFound:${cap}:${method}`)
    },
  }
  return { services, methodNotFoundCalls }
}

describe('buildCapRouters — Task 7.5d: missing provider method fails loud', () => {
  const ptz = ALL_CAPABILITY_DEFINITIONS.find((d) => d.name === 'ptz')!

  it('non-collection (device-native) method missing on the provider throws instead of returning undefined', () => {
    const { services, methodNotFoundCalls } = makeMissingMethodServices()
    const routers = buildCapRouters(makePrimitives({}), services)
    const router = routers.ptz as Record<string, { call: (i: unknown, c: unknown) => unknown }>
    const found = Object.entries(expandCapMethods(ptz)).find(([n, s]) => {
      const m = s as CapabilityMethodSchema
      const inp = m.input as { _def?: { type?: string }; constructor?: { name?: string } }
      const isObj = inp.constructor?.name === 'ZodObject' || inp._def?.type === 'object'
      return isObj && m.kind !== 'subscription' && n !== 'getStatus'
    })
    expect(found, 'ptz should have an object-input method').toBeDefined()
    const methodName = found![0]

    expect(() => router[methodName]!.call({ deviceId: 5, nodeId: 'hub', pan: 1 }, {})).toThrow(
      `methodNotFound:ptz:${methodName}`,
    )
    expect(methodNotFoundCalls).toEqual([{ cap: 'ptz', method: methodName }])
  })

  it('a collection cap SCALAR method missing on the provider throws', async () => {
    const { services, methodNotFoundCalls } = makeMissingMethodServices()
    const routers = buildCapRouters(makePrimitives({}), services)
    const router = routers.broker as Record<
      string,
      { call: (i: unknown, c: unknown) => unknown | Promise<unknown> }
    >

    await expect(router.get!.call({ id: 'ha_001' }, {})).rejects.toThrow(
      'methodNotFound:broker:get',
    )
    expect(methodNotFoundCalls).toEqual([{ cap: 'broker', method: 'get' }])
  })

  it('a collection cap ARRAY-output method missing on the provider degrades to [] (mirrors child-cap-dispatch.ts)', async () => {
    const { services, methodNotFoundCalls } = makeMissingMethodServices()
    const routers = buildCapRouters(makePrimitives({}), services)
    const router = routers.broker as Record<
      string,
      { call: (i: unknown, c: unknown) => unknown | Promise<unknown> }
    >

    await expect(router.list!.call({}, {})).resolves.toEqual([])
    expect(methodNotFoundCalls).toEqual([])
  })

  it('falls back to badRequest when services.methodNotFound is not supplied (framework-live-update skew)', async () => {
    const emptyProvider: Record<string, (...a: unknown[]) => unknown> = {}
    const services: CapRouterServices = {
      getLocalProvider: () => emptyProvider,
      remoteProxy: () => emptyProvider,
      noProvider: (cap, nodeId) => {
        throw new Error(`noProvider:${cap}:${nodeId ?? ''}`)
      },
      noNodeRouting: (cap) => {
        throw new Error(`noNodeRouting:${cap}`)
      },
      badRequest: (m) => {
        throw new Error(`badRequest:${m}`)
      },
      // methodNotFound intentionally omitted
    }
    const routers = buildCapRouters(makePrimitives({}), services)
    const router = routers.broker as Record<
      string,
      { call: (i: unknown, c: unknown) => unknown | Promise<unknown> }
    >

    await expect(router.get!.call({ id: 'ha_001' }, {})).rejects.toThrow(/badRequest:.*broker.*get/)
  })
})

describe('buildCapRouters — systemOnly method routing', () => {
  const snapshot = ALL_CAPABILITY_DEFINITIONS.find((d) => d.name === 'snapshot')!

  it('snapshot fixture is a device-native cap with a systemOnly batch method', () => {
    // Guards the premise: if these ever change, the routing test below is moot.
    expect(resolveCapMount(snapshot).kind).toBe('device-native')
    const overview = snapshot.methods.getSnapshotOverview as CapabilityMethodSchema
    expect(overview.systemOnly).toBe(true)
  })

  it('systemOnly method dispatches WITHOUT a deviceId, via the SYSTEM (singleton) provider', () => {
    const { services, localResolutions, calls } = makeMountRecordingServices()
    const routers = buildCapRouters(makePrimitives({}), services)
    const router = routers.snapshot as Record<string, { call: (i: unknown, c: unknown) => unknown }>

    // Batch input keyed by `deviceIds` — NO singular `deviceId`, no `nodeId`.
    router.getSnapshotOverview!.call({ deviceIds: [1, 2] }, {})

    // Reached the provider (no deviceId-guard throw), payload intact.
    expect(calls).toHaveLength(1)
    expect(calls[0]!.method).toBe('getSnapshotOverview')
    expect(calls[0]!.args[0]).toEqual({ deviceIds: [1, 2] })

    // Resolved through the system (singleton) mount, NOT device-native.
    expect(localResolutions.some((r) => r.cap === 'snapshot' && r.mountKind === 'singleton')).toBe(
      true,
    )
    expect(
      localResolutions.some((r) => r.cap === 'snapshot' && r.mountKind === 'device-native'),
    ).toBe(false)
  })

  it('non-systemOnly method on the SAME cap still resolves device-native', () => {
    const { services, localResolutions, calls } = makeMountRecordingServices()
    const routers = buildCapRouters(makePrimitives({}), services)
    const router = routers.snapshot as Record<string, { call: (i: unknown, c: unknown) => unknown }>

    router.getSnapshot!.call({ deviceId: 7, nodeId: 'hub' }, {})

    expect(calls).toHaveLength(1)
    expect(calls[0]!.method).toBe('getSnapshot')
    expect(calls[0]!.args[0]).toEqual({ deviceId: 7 })
    expect(
      localResolutions.some((r) => r.cap === 'snapshot' && r.mountKind === 'device-native'),
    ).toBe(true)
    expect(localResolutions.some((r) => r.cap === 'snapshot' && r.mountKind === 'singleton')).toBe(
      false,
    )
  })
})

// ── device-scoped wrapper mount (slice 1 of the external-videoclips line) ──
//
// A `scope:'device'` + `kind:'wrapper'` cap resolves PER DEVICE, so its
// per-device binding (`deviceManager.setWrapperActive` →
// `registry.setDeviceOverride`) finally takes effect. Two rules ride with it:
//
//  1. Only a method that actually NAMES a device can be dispatched per device
//     — the dispatcher demands a numeric `deviceId` on every call. A method
//     whose input carries no required numeric `deviceId` (a batch method over
//     `deviceIds`, a fleet-wide count, a job id) resolves through the cap's
//     SYSTEM provider, exactly as `systemOnly` already does. Without this,
//     flipping the mount would 400 every one of those methods.
//  2. `systemOnly` keeps winning wherever it is declared.

describe('buildCapRouters — device-scoped wrapper mount', () => {
  const videoclips = ALL_CAPABILITY_DEFINITIONS.find((d) => d.name === 'videoclips')!
  const analytics = ALL_CAPABILITY_DEFINITIONS.find((d) => d.name === 'pipeline-analytics')!

  it('premise: both fixtures are device-scoped wrapper caps', () => {
    expect(resolveCapMount(videoclips).kind).toBe('device-scoped')
    expect(resolveCapMount(analytics).kind).toBe('device-scoped')
  })

  it('a deviceId-carrying method resolves through the device-scoped mount', () => {
    const { services, localResolutions, calls } = makeMountRecordingServices()
    const routers = buildCapRouters(makePrimitives({}), services)
    const router = routers.videoclips as Record<
      string,
      { call: (i: unknown, c: unknown) => unknown }
    >

    router.listClips!.call({ deviceId: 101, since: 1, until: 2, nodeId: 'hub' }, {})

    expect(calls).toHaveLength(1)
    expect(calls[0]!.args[0]).toEqual({ deviceId: 101, since: 1, until: 2 })
    expect(
      localResolutions.some((r) => r.cap === 'videoclips' && r.mountKind === 'device-scoped'),
    ).toBe(true)
    expect(
      localResolutions.some((r) => r.cap === 'videoclips' && r.mountKind === 'singleton'),
    ).toBe(false)
  })

  it('a method with NO required numeric deviceId resolves through the SYSTEM provider', () => {
    const { services, localResolutions, calls } = makeMountRecordingServices()
    const routers = buildCapRouters(makePrimitives({}), services)
    const router = routers.pipelineAnalytics as Record<
      string,
      { call: (i: unknown, c: unknown) => unknown }
    >

    // Batch shape: `deviceIds`, no singular `deviceId` — unreachable if this
    // entered the per-device dispatcher.
    router.listRecentTracks!.call({ deviceIds: [1, 2], since: 1, until: 2 }, {})

    expect(calls).toHaveLength(1)
    expect(calls[0]!.method).toBe('listRecentTracks')
    expect(
      localResolutions.some((r) => r.cap === 'pipeline-analytics' && r.mountKind === 'singleton'),
    ).toBe(true)
    expect(
      localResolutions.some(
        (r) => r.cap === 'pipeline-analytics' && r.mountKind === 'device-scoped',
      ),
    ).toBe(false)
  })

  it('a deviceId-carrying method on the SAME cap still resolves per device', () => {
    const { services, localResolutions } = makeMountRecordingServices()
    const routers = buildCapRouters(makePrimitives({}), services)
    const router = routers.pipelineAnalytics as Record<
      string,
      { call: (i: unknown, c: unknown) => unknown }
    >

    router.getActiveTracks!.call({ deviceId: 101 }, {})

    expect(
      localResolutions.some(
        (r) => r.cap === 'pipeline-analytics' && r.mountKind === 'device-scoped',
      ),
    ).toBe(true)
  })
})
