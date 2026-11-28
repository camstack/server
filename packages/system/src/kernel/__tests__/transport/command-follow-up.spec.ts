import { randomUUID } from 'node:crypto'
/**
 * D1062 — the UDS parent holds a forked addon's device command until its
 * follow-up (the state refresh) ran; a call that is not a command is answered
 * at once. Real calls down the real link chain, as in command-observation.spec.
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { AddonDeclaration } from '@dominevo/types'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createUdsAddonContext } from '../../moleculer/addon-context-factory.js'
import type { CommandFollowUpTarget } from '../../command-follow-up.js'
import { createLocalTransport } from '../../transport/create-local-transport.js'
import { LocalChildClient } from '../../transport/local-child-client.js'
import { LocalChildRegistry } from '../../transport/local-child-registry.js'

/** Unique per run: the UDS path derives from the node id, and a shared one collides with a parallel run. */
const PARENT_NODE = `hub-${randomUUID().slice(0, 8)}`
const CALLER_ID = 'addon-export-alexa'

interface MutateApi {
  readonly switch: {
    readonly setState: { mutate: (input: unknown) => Promise<unknown> }
    readonly getStatus: { query: (input: unknown) => Promise<unknown> }
  }
}

describe('the UDS parent awaits the command follow-up (D1062)', () => {
  let registry: LocalChildRegistry
  let client: LocalChildClient
  let tmpDir: string
  let events: string[]

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmd-follow-'))
    events = []
    registry = new LocalChildRegistry({
      server: createLocalTransport().createServer(PARENT_NODE),
      ownNodeId: PARENT_NODE,
      commandFollowUp: async (target: CommandFollowUpTarget, outcome) => {
        events.push(`follow-up ${target.capName}.${target.method}#${target.deviceId} ${outcome}`)
        await new Promise((resolve) => setTimeout(resolve, 5))
        events.push('follow-up done')
      },
      onUnownedCall: async () => ({ ok: true }),
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
    const ctx = await createUdsAddonContext(
      client,
      `${PARENT_NODE}/${CALLER_ID}`,
      declaration,
      tmpDir,
    )
    // documented test boundary: the generated AddonApi narrowed to the two procedures driven, as in cap-usage-observation.spec
    return ctx.api as unknown as MutateApi
  }

  it('answers a command only after the follow-up ran', async () => {
    await (await api()).switch.setState.mutate({ deviceId: 7, on: true })
    events.push('answered')
    expect(events).toEqual(['follow-up switch.setState#7 ok', 'follow-up done', 'answered'])
  })

  it('answers a call that is not a command without a follow-up', async () => {
    await (await api()).switch.getStatus.query({ deviceId: 7 })
    expect(events).toEqual([])
  })
})
