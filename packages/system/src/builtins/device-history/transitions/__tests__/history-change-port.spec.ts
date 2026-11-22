/** The derived changes over the REAL device-history runtime (D1084). */
import { DeviceType } from '@camstack/types'
import { afterEach, describe, expect, it } from 'vitest'
import { type Harness, makeHarness } from '../../__tests__/support/harness.js'
import { emitState } from '../../__tests__/support/read-helpers.js'
import { DerivedChanges } from '../derived-changes.js'
import { HistoryChangePort } from '../history-change-port.js'

let h: Harness
afterEach(async () => {
  await h?.close()
})

describe('derived changes from the history runtime', () => {
  it('reads a switch change from its raw series and nothing for an unaudited field', async () => {
    h = await makeHarness({ devices: { 1: DeviceType.Switch } })
    const from = h.now() - 1_000
    emitState(h, 1, 'switch', { on: false })
    await h.settle()
    h.advance(10_000)
    emitState(h, 1, 'switch', { on: true })
    emitState(h, 1, 'battery', { level: 50 })
    await h.settle()
    h.advance(10_000)
    const reader = new DerivedChanges(new HistoryChangePort(h.runtime), () => h.now())
    const changes = await reader.read(1, { from, to: h.now() })
    expect(changes.map((c) => `${c.capName}.${c.field}:${c.from}>${c.to}`)).toEqual([
      'switch.on:false>true',
    ])
    expect(await reader.read(2, { from, to: h.now() })).toEqual([])
  })
})
