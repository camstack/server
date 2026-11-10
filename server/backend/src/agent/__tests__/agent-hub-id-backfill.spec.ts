/**
 * An agent paired before the hub announced an id records that id from a CA-signed membership
 * answer, and only when it has none (#494).
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AgentMembershipWatch } from '../agent-membership-watch.js'
import {
  isAgentPaired,
  needsHubId,
  recordHubIdFromAnswer,
  recordHubIdIfMissing,
} from '../agent-pairing-store.js'

const MINE = 'hub-0123456789abcdef'
const OTHER = 'hub-fedcba9876543210'
const MESH = { certPem: 'cert', keyPem: 'key', caCertPem: 'ca' }

let dir: string
let configPath: string

afterEach(() => {
  if (dir !== undefined) fs.rmSync(dir, { recursive: true, force: true })
})

function writeConfig(value: Record<string, unknown>): void {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-id-backfill-'))
  configPath = path.join(dir, 'agent.json')
  fs.writeFileSync(configPath, JSON.stringify(value))
}

const read = (): Record<string, unknown> => {
  const parsed: unknown = JSON.parse(fs.readFileSync(configPath, 'utf8'))
  return parsed !== null && typeof parsed === 'object'
    ? Object.fromEntries(Object.entries(parsed))
    : {}
}

describe('recordHubIdIfMissing', () => {
  it('records the hub id from a CA-signed answer when the pairing has none', () => {
    writeConfig({ nodeId: 'agent-a', meshTls: MESH, hubAddress: '192.0.2.9' })
    expect(recordHubIdIfMissing(configPath, MINE)).toBe(true)
    expect(read()['hubId']).toBe(MINE)
    expect(read()['meshTls']).toEqual(MESH)
  })

  it('never replaces an id already on record', () => {
    writeConfig({ meshTls: MESH, hubId: MINE })
    expect(recordHubIdIfMissing(configPath, OTHER)).toBe(false)
    expect(read()['hubId']).toBe(MINE)
  })
})

describe('the membership watch wiring that backfills the hub id (needsHubId -> askBackfill -> recordHubIdFromAnswer)', () => {
  const connectedWatch = (asked: { count: number }, hubId?: string): AgentMembershipWatch =>
    new AgentMembershipWatch({
      nodeId: 'agent-a',
      isPaired: () => isAgentPaired(configPath),
      isConnected: () => true,
      ask: async () => {
        asked.count += 1
        return { kind: 'answer', answer: { status: 'member', ...(hubId !== undefined ? { hubId } : {}) } }
      },
      onRevoked: async () => undefined,
      needsHubId: () => needsHubId(configPath),
      onAuthenticated: (answer) => void recordHubIdFromAnswer(configPath, answer),
      log: { warn: () => undefined, info: () => undefined },
    })

  it('a connected, paired agent with no hub id asks once and records the signed id', async () => {
    writeConfig({ nodeId: 'agent-a', meshTls: MESH, hubAddress: '192.0.2.9' })
    const asked = { count: 0 }
    await connectedWatch(asked, MINE).tick(0)
    expect(asked.count).toBe(1)
    expect(read()['hubId']).toBe(MINE)
  })

  it('an agent that already has the id never asks while connected', async () => {
    writeConfig({ nodeId: 'agent-a', meshTls: MESH, hubAddress: '192.0.2.9', hubId: MINE })
    const asked = { count: 0 }
    await connectedWatch(asked, OTHER).tick(0)
    expect(asked.count).toBe(0)
    expect(read()['hubId']).toBe(MINE)
  })

  it('an answer without an id records nothing', async () => {
    writeConfig({ nodeId: 'agent-a', meshTls: MESH, hubAddress: '192.0.2.9' })
    await connectedWatch({ count: 0 }).tick(0)
    expect(read()['hubId']).toBeUndefined()
  })
})
