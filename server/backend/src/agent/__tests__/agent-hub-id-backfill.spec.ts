/**
 * An agent paired before the hub announced an id records that id from a CA-signed membership
 * answer, and only when it has none (#494).
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { recordHubIdIfMissing } from '../agent-pairing-store.js'

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
