/**
 * Test helper: an S1 access gate under which the given users are ADMINS and
 * every device is exposed. For specs that exercise a handler, not the gate —
 * the gate itself is pinned by `directive-user-scoping.spec.ts`.
 */
import type { IScopedLogger } from '@camstack/types'
import { AlexaAccessGate } from '../../access/access-gate.js'
import type { EndpointAccessDeps } from '../../access/endpoint-access.js'
import type { VisionContext } from '../../handlers/data-controller.js'
import type { SnapshotProviderContext } from '../../handlers/snapshot-provider.js'
import { VisionStateStore } from '../../vision/vision-state.js'
import type { SnapshotRouteDeps } from '../../snapshots/snapshot-route.js'
import { SnapshotStore } from '../../snapshots/snapshot-store.js'

const quiet: IScopedLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  withTags: () => quiet,
  child: () => quiet,
}

export function allowAllAccess(
  opts: { userIds?: readonly string[]; parents?: Readonly<Record<number, number>> } = {},
): EndpointAccessDeps {
  const userIds = opts.userIds ?? ['user-1', 'user-42', 'tester', 'u1']
  const parents = opts.parents ?? {}
  return {
    gate: new AlexaAccessGate({
      listUserGrants: async () => userIds.map((userId) => ({ userId, isAdmin: true, scopes: [] })),
      getDeviceMeta: async (id) => ({
        id,
        type: 'camera',
        location: null,
        parentDeviceId: parents[id] ?? null,
      }),
      logger: quiet,
    }),
    isExposed: () => true,
  }
}

/** Test helper: the R2 snapshot dependencies with the switch OFF — for specs
 *  that exercise something else. */
export function snapshotsOff(): {
  readonly provider: SnapshotProviderContext
  readonly route: SnapshotRouteDeps
} {
  const store = new SnapshotStore(() => 'test-key')
  return {
    provider: {
      ctx: {} as SnapshotProviderContext['ctx'],
      logger: quiet,
      store,
      enabled: () => false,
      publicHubUrl: () => '',
    },
    route: {
      store,
      enabled: () => false,
      verifyToken: async () => null,
      mayView: async () => false,
      logger: quiet,
    },
  }
}

/** Test helper: the R4 object-detection dependencies with the feature OFF
 *  (no class declared, no history) — for specs that exercise something else. */
export function visionOff(over: Partial<VisionContext> = {}): VisionContext {
  return {
    ctx: {
      api: { deviceStatus: { getStatus: { query: async () => ({ online: true }) } } },
    } as unknown as VisionContext['ctx'],
    logger: quiet,
    vision: new VisionStateStore({ read: async () => ({}), write: async () => {} }),
    declaredClasses: async () => [],
    namespace: () => '6f1c2a54-1d0e-4c8b-9a52-0c3f7d2e9b11',
    listTracks: async () => [],
    getTrack: async () => null,
    imagesFor: () => ({}),
    ...over,
  }
}
