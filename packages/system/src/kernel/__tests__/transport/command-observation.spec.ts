/**
 * D1022 hook B — the UDS parent reports a forked addon's device commands with
 * the addon the SOCKET belongs to as the actor.
 *
 * Real calls go down the real link chain (`ctx.api` → localProviderLink miss →
 * ipcParentLink → UDS → `LocalChildRegistry`), as in cap-usage-observation.spec.
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { AddonDeclaration, DeviceCommandObservation } from '@camstack/types'
import { commandOrigin, nodePin } from '@camstack/types/addon'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createUdsAddonContext } from '../../moleculer/addon-context-factory.js'
import type { CapCallInput } from '../../transport/child-cap-protocol.js'
import { createLocalTransport } from '../../transport/create-local-transport.js'
import { LocalChildClient } from '../../transport/local-child-client.js'
import { LocalChildRegistry } from '../../transport/local-child-registry.js'

const PARENT_NODE = 'hub'
const CALLER_ID = 'addon-export-alexa'

interface MutateApi {
  readonly switch: {
    readonly setState: { mutate: (input: unknown, opts?: unknown) => Promise<unknown> }
  }
  readonly streamCatalog: { getCatalog: { query: (input: unknown) => Promise<unknown> } }
}

describe('the UDS parent reports a forked addon’s device commands', () => {
  let registry: LocalChildRegistry
  let client: LocalChildClient
  let tmpDir: string
  let observed: DeviceCommandObservation[]
  let unowned: CapCallInput[]

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmd-obs-'))
    observed = []
    unowned = []
    registry = new LocalChildRegistry({
      server: createLocalTransport().createServer(PARENT_NODE),
      ownNodeId: PARENT_NODE,
      commandObserver: (obs) => void observed.push(obs),
      onUnownedCall: async (input) => {
        unowned.push(input)
        return { ok: true }
      },
    })
    registry.onReadinessSnapshotRequest(() => [])
    await registry.start()
    client = new LocalChildClient({
      nodeId: PARENT_NODE,
      childId: CALLER_ID,
      caps: [],
      dispatch: async () => {
        throw new Error('no inbound caps')
      },
    })
    await client.start()
  })

  afterEach(async () => {
    await client.close()
    await registry.close()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  async function api(): Promise<MutateApi> {
    const declaration: AddonDeclaration = { id: CALLER_ID, entry: './index.js' }
    const ctx = await createUdsAddonContext(client, `${PARENT_NODE}/${CALLER_ID}`, declaration, tmpDir)
    return ctx.api as unknown as MutateApi
  }

  it('names the addon on the socket as the actor of a plain command', async () => {
    await (await api()).switch.setState.mutate({ deviceId: 7, on: true })
    expect(observed).toHaveLength(1)
    expect(observed[0]).toMatchObject({
      deviceId: 7,
      capName: 'switch',
      method: 'setState',
      args: { deviceId: 7, on: true },
      actor: { kind: 'addon', addonId: CALLER_ID, nodeId: PARENT_NODE },
    })
    expect(unowned).toHaveLength(1)
  })

  it('adds the claimed origin as detail while the addon id stays the socket stamp', async () => {
    await (await api()).switch.setState.mutate(
      { deviceId: 7, on: true },
      commandOrigin({ kind: 'action', actionId: 'night-mode', runId: 'run-9' }),
    )
    expect(observed[0]?.actor).toEqual({
      kind: 'action',
      addonId: CALLER_ID,
      actionId: 'night-mode',
      runId: 'run-9',
    })
  })

  it('keeps the node pin and the origin claim together in one call', async () => {
    await (await api()).switch.setState.mutate(
      { deviceId: 7, on: true },
      commandOrigin({ kind: 'scheduler', schedulerId: 's-1' }, nodePin(PARENT_NODE)),
    )
    expect(observed[0]?.actor).toEqual({ kind: 'scheduler', addonId: CALLER_ID, schedulerId: 's-1' })
    expect(unowned[0]).toMatchObject({ nodeId: PARENT_NODE })
  })

  it('ignores an origin that is not a well-formed claim', async () => {
    await client.callOut({
      capName: 'switch',
      method: 'setState',
      args: { deviceId: 7, on: true },
      deviceId: 7,
      // wire-boundary: a hostile child can put anything in the frame
      origin: JSON.parse('{"kind":"user","userId":"root"}'),
    })
    expect(observed[0]?.actor).toEqual({ kind: 'addon', addonId: CALLER_ID, nodeId: PARENT_NODE })
  })

  it('does not report a call that is not a command', async () => {
    await (await api()).streamCatalog.getCatalog.query({})
    expect(observed).toEqual([])
  })
})
