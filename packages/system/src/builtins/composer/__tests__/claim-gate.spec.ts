/**
 * The D49 gate over releasing a claim (D663): a claim nobody wants is handed
 * back only when two consecutive applies agree, and a release the hub did not
 * confirm is retried on every later apply until it lands — never on a timer,
 * never given up.
 */
import type { FieldClaim } from '@camstack/types'
import { beforeEach, describe, expect, it } from 'vitest'
import { ClaimGate, type ClaimKey, claimKey } from '../claim-gate.js'
import { type RecordingLogger, recordingLogger } from './fixtures.js'

const ON: ClaimKey = { deviceId: 51, capName: 'binary', owner: 'b1' }
const BATTERY: ClaimKey = { deviceId: 50, capName: 'battery', owner: 'b2' }
const PERSISTED: FieldClaim = { ...ON, mode: 'replace', fields: ['on'] }

let gate: ClaimGate
let log: RecordingLogger

beforeEach(() => {
  log = recordingLogger()
  gate = new ClaimGate(log.logger)
})

describe('two consecutive applies must agree (D49)', () => {
  it('a claim wanted on every apply is never released', () => {
    gate.seed([PERSISTED])
    expect(gate.filter([ON])).toEqual([])
    expect(gate.filter([ON])).toEqual([])
  })

  it('a seeded claim absent from the FIRST apply after a restart is released only on the SECOND', () => {
    gate.seed([PERSISTED])
    expect(gate.filter([])).toEqual([])
    expect(gate.filter([])).toEqual([ON])
  })

  it('a claim the gate learned from an apply follows the same rule when it vanishes', () => {
    expect(gate.filter([ON, BATTERY])).toEqual([])
    expect(gate.filter([BATTERY])).toEqual([])
    expect(gate.filter([BATTERY])).toEqual([ON])
  })

  it('a claim wanted again after one miss starts from zero misses', () => {
    gate.seed([PERSISTED])
    gate.filter([])
    gate.filter([ON])
    expect(gate.filter([])).toEqual([])
  })

  it('a claim the gate does not know is not released — an empty seed is not a list of claims to hand back', () => {
    gate.seed([])
    expect(gate.filter([])).toEqual([])
    expect(gate.filter([])).toEqual([])
  })

  it('names the claims of one owner, for a block whose plan is held (D659 placeholder rule)', () => {
    gate.seed([PERSISTED, { ...BATTERY, mode: 'add', fields: ['percentage'] }])
    expect(gate.claimsOf('b1')).toEqual([ON])
    expect(gate.claimsOf('nobody')).toEqual([])
  })
})

describe('a release the hub did not confirm is retried until it lands (D3) — never given up', () => {
  it('is returned again on the next apply until `released`', () => {
    gate.seed([PERSISTED])
    gate.filter([])
    expect(gate.filter([])).toEqual([ON])
    gate.releaseFailed(ON, 'hub unreachable')
    expect(gate.filter([])).toEqual([ON])
    gate.released(ON, 'released')
    expect(gate.filter([])).toEqual([])
  })

  it('a release that keeps failing is returned on EVERY apply (25 here), warned ONCE; landing ends it with one INFO naming the attempts', () => {
    gate.seed([PERSISTED])
    gate.filter([])
    for (let attempt = 0; attempt < 25; attempt++) {
      expect(gate.filter([])).toEqual([ON])
      gate.releaseFailed(ON, 'row-unreadable: sqlite busy')
    }
    expect(gate.filter([])).toEqual([ON])
    const warns = log.lines.filter((l) => l.message.includes('did not land'))
    expect(warns).toHaveLength(1)
    expect(warns[0]).toMatchObject({ level: 'warn' })
    expect(warns[0]?.extras?.tags).toEqual({ deviceId: 51 })
    expect(log.lines.filter((l) => l.level === 'error')).toEqual([])
    gate.released(ON, 'released')
    const landed = log.lines.filter((l) => l.message.includes('landed after failed attempts'))
    expect(landed).toHaveLength(1)
    expect(landed[0]).toMatchObject({ level: 'info' })
    expect(landed[0]?.extras?.tags).toEqual({ deviceId: 51 })
    expect(landed[0]?.extras?.meta).toMatchObject({ owner: 'b1', cap: 'binary', attempts: 25 })
    expect(gate.filter([])).toEqual([])
  })

  it('every gate line about a claim carries the device id', () => {
    gate.seed([PERSISTED])
    gate.filter([])
    gate.filter([])
    gate.releaseFailed(ON, 'hub unreachable')
    const lines = log.lines.filter((l) => l.message.includes('claim'))
    expect(lines.length).toBeGreaterThan(0)
    for (const line of lines) expect(line.extras?.tags).toEqual({ deviceId: 51 })
  })
})

describe('claimKey', () => {
  it('tells two owners of one field apart, and two fields of one owner', () => {
    expect(claimKey(ON)).not.toBe(claimKey({ ...ON, owner: 'b2' }))
    expect(claimKey(ON)).not.toBe(claimKey({ ...ON, capName: 'battery' }))
    expect(claimKey(ON)).toBe(claimKey({ ...ON }))
  })
})
