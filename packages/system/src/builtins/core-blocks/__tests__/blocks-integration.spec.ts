import type { DeclaredDeviceRow, DeviceManagerApi, IScopedLogger } from '@camstack/types'
import { describe, expect, it, vi } from 'vitest'
import {
  armBlocksIntegration,
  BLOCKS_INTEGRATION_NAME,
  type BlocksIntegrationPorts,
  reconcileBlocksIntegration,
} from '../blocks-integration.js'

/**
 * A core block CANNOT own an integration: every integration read is gated on
 * the installed-addon set and `core-block-<uuid>` is never in it, so a block's
 * own get-or-create minted a fresh, invisible, undeletable row on every start
 * (int_0021, int_0022 on the live hub, 2026-08-09).
 *
 * `core-blocks` — an installed builtin — owns ONE integration instead, and a
 * block hangs its devices off it by id. This is the host half of
 * `DeclaredDevicesSpec.integrationId`.
 */

function makeLogger(): IScopedLogger {
  const logger: IScopedLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: () => logger,
    withTags: () => logger,
  }
  return logger
}

interface Harness {
  readonly ports: BlocksIntegrationPorts
  readonly createIntegration: ReturnType<typeof vi.fn>
  readonly getIntegration: ReturnType<typeof vi.fn>
  readonly listOwnDevices: ReturnType<typeof vi.fn>
  readonly remove: ReturnType<typeof vi.fn>
  readonly create: ReturnType<typeof vi.fn>
}

interface HarnessOptions {
  readonly existing?: { id: string; info?: Record<string, unknown> | null } | null
  readonly ownDevices?: readonly DeclaredDeviceRow[]
  readonly localNodeId?: string
}

function harness(opts: HarnessOptions = {}): Harness {
  const createIntegration = vi.fn(async () => ({ id: 'int_0023' }))
  const getIntegration = vi.fn(async () => opts.existing ?? null)
  const listOwnDevices = vi.fn(async () => opts.ownDevices ?? [])
  const remove = vi.fn(async () => undefined)
  const create = vi.fn(async () => {
    throw new Error('core-blocks declares no devices of its own')
  })
  // Documented type boundary: `core-blocks` declares no devices, so the
  // primitive never reaches past `create` / `remove` — and both are here
  // precisely to PROVE they stay unused.
  const devices = { create, remove } as unknown as DeviceManagerApi
  const ports: BlocksIntegrationPorts = {
    logger: makeLogger(),
    devices,
    localNodeId: opts.localNodeId ?? 'hub',
    getIntegration,
    createIntegration,
    updateIntegration: vi.fn(async () => undefined),
    listOwnDevices,
  }
  return { ports, createIntegration, getIntegration, listOwnDevices, remove, create }
}

describe('reconcileBlocksIntegration', () => {
  it('mints the shared integration under `core-blocks`, never under a block id', async () => {
    // The whole point: the owner must be an id the integration reads accept.
    const h = harness()

    const id = await reconcileBlocksIntegration(h.ports)

    expect(id).toBe('int_0023')
    expect(h.getIntegration).toHaveBeenCalledWith('core-blocks')
    expect(h.createIntegration).toHaveBeenCalledWith(
      expect.objectContaining({ addonId: 'core-blocks', name: BLOCKS_INTEGRATION_NAME }),
    )
  })

  it('adopts the existing row on every later boot instead of minting a second', async () => {
    // Discriminating: this is the branch that failed for a block — its
    // `getIntegration` answered null forever, so it took the mint branch every
    // single start. Under `core-blocks` the read succeeds and nothing is made.
    const h = harness({ existing: { id: 'int_0023', info: { fixed: true } } })

    expect(await reconcileBlocksIntegration(h.ports)).toBe('int_0023')
    expect(h.createIntegration).not.toHaveBeenCalled()
  })

  it('removes nothing in the real case — the owner index is empty', async () => {
    const h = harness({ existing: { id: 'int_0023', info: { fixed: true } } })

    await reconcileBlocksIntegration(h.ports)

    expect(h.listOwnDevices).toHaveBeenCalled()
    expect(h.remove).not.toHaveBeenCalled()
  })

  it('WOULD sweep a row that appears under the shared integration — the trap, made executable', async () => {
    // `core-blocks` declares NO devices, so every row the index returns under
    // this integration is a withdrawal candidate. That is safe only because
    // `listOwnDevices` is scoped to `core-blocks` while a block's devices are
    // owned by `core-block-<uuid>`, so the listing is empty.
    //
    // This test does not assert the safe path — it asserts the DAMAGE, so that
    // an owner-less listing (or a device `core-blocks` starts declaring) shows
    // up as devices disappearing here rather than on the live hub. Row 1836 is
    // the composite a block declared on 2026-08-09.
    const h = harness({
      existing: { id: 'int_0023', info: { fixed: true } },
      ownDevices: [{ id: 1836, stableId: 'temp-delta', integrationId: 'int_0023' }],
    })

    await reconcileBlocksIntegration(h.ports)

    expect(h.remove).toHaveBeenCalledWith(1836)
  })

  it('owns nothing on a node that is not the hub', async () => {
    const h = harness({ localNodeId: 'agent-a/core-blocks' })

    expect(await reconcileBlocksIntegration(h.ports)).toBeNull()
    expect(h.createIntegration).not.toHaveBeenCalled()
  })
})

/**
 * The reconcile is BACKGROUND work, because the thing it reads cannot answer
 * yet (D167).
 *
 * `integrations` is a hub-CORE namespace, and the `$core-caps` Moleculer
 * service that serves it is registered AFTER `app.init()` — which is where the
 * whole addon boot happens. So during boot the call is not slow, it is
 * structurally unanswerable: it polls for the full 30 s discovery deadline and
 * fast-fails. Core caps get no boot-window retry, so there is no shorter path.
 *
 * Awaiting it inside `onInitialize()` put that 30 s on the hub's SERIAL
 * in-process builtin loop. Measured on the live hub on 2026-08-15: the boot
 * stalled from t0+10 s to t0+40 s, `device-manager` — the builtin behind it —
 * registered only at t0+40 s, every provider runner sat in
 * `awaitReady('device-manager')` until then, and the first camera's first
 * keyframe landed at t0+75 s. A feature nobody had asked for yet held every
 * camera.
 */
describe('armBlocksIntegration — the shared integration is not a boot gate', () => {
  it('returns before the reconcile has answered', async () => {
    let release: (() => void) | undefined
    const blocked = new Promise<void>((resolve) => {
      release = resolve
    })
    let landed: string | null | undefined
    const arm = armBlocksIntegration({
      logger: makeLogger(),
      reconcile: async () => {
        await blocked
        return 'int_0042'
      },
      onLanded: (id) => {
        landed = id
      },
      retryDelayMs: 0,
    })

    // No await on the reconcile: arming is synchronous work.
    expect(landed).toBeUndefined()
    release?.()
    await arm.settled
    expect(landed).toBe('int_0042')
  })

  it('retries a reconcile the boot window made unanswerable', async () => {
    const attempts: number[] = []
    let landed: string | null | undefined
    const arm = armBlocksIntegration({
      logger: makeLogger(),
      reconcile: async () => {
        attempts.push(attempts.length)
        // The first two are the boot window: `$core-caps` does not exist yet.
        if (attempts.length < 3) throw new Error('Service "$core-caps" is not found')
        return 'int_0042'
      },
      onLanded: (id) => {
        landed = id
      },
      retryDelayMs: 0,
    })

    await arm.settled
    expect(attempts).toHaveLength(3)
    expect(landed).toBe('int_0042')
  })

  it('gives up loudly rather than retrying forever', async () => {
    const logger = makeLogger()
    let landed: string | null | undefined
    const arm = armBlocksIntegration({
      logger,
      reconcile: async () => {
        throw new Error('still unreachable')
      },
      onLanded: (id) => {
        landed = id
      },
      retryDelayMs: 0,
      maxAttempts: 3,
    })

    await arm.settled
    // Never landed, and the give-up is a log line — a block that declares a
    // device will find no integration to name, and that must not be silent.
    expect(landed).toBeUndefined()
    expect(logger.warn).toHaveBeenCalled()
  })
})
