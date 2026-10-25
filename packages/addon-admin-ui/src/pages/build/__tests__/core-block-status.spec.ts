/**
 * A block that is not running must SAY SO.
 *
 * The runner guarantees the data: every path that does not end in a live
 * process writes a status with its reason. These tests are about not throwing
 * that away on the way to the screen — and about the one case the raw status
 * field gets wrong on its own, which is `stopped` on a block the operator
 * enabled.
 */

import type { CoreBlock } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import {
  badgeVariantForTone,
  describeBlockStatus,
  sortBlocksForDisplay,
  summariseBlocks,
} from '../core-block-status'

const block = (over: Partial<CoreBlock> = {}): CoreBlock => ({
  id: 'b1',
  name: 'Block',
  code: '',
  enabled: true,
  placement: 'hub',
  createdAt: 1,
  updatedAt: 1,
  createdBy: 'u',
  status: 'running',
  lastChangedAt: 1,
  ...over,
})

describe('an enabled block that is not running is an ERROR', () => {
  it('treats `stopped` on an ENABLED block as not running', () => {
    // The supervisor converges enabled blocks, so `stopped` here means
    // something did not happen — and the raw field alone would read as a
    // resting state.
    const view = describeBlockStatus(block({ status: 'stopped' }))
    expect(view.tone).toBe('error')
    expect(view.detail.length).toBeGreaterThan(0)
  })

  it('surfaces the recorded reason verbatim', () => {
    const view = describeBlockStatus(
      block({ status: 'failed', lastError: 'the block does not compile: Unexpected token }' }),
    )
    expect(view.tone).toBe('error')
    expect(view.detail).toContain('Unexpected token')
  })

  it('never leaves a failure without a line, even with no reason recorded', () => {
    // Silence is the failure this surface exists to prevent.
    const view = describeBlockStatus(block({ status: 'failed' }))
    expect(view.detail.trim().length).toBeGreaterThan(0)
  })
})

describe('a disabled block is idle, not broken', () => {
  it('reads as idle even when its last status was failed', () => {
    // The operator turned it off; the stale status must not shout at them.
    const view = describeBlockStatus(block({ enabled: false, status: 'failed', lastError: 'boom' }))
    expect(view.tone).toBe('idle')
  })
})

describe('the healthy cases', () => {
  it('running is ok', () => {
    expect(describeBlockStatus(block({ status: 'running' })).tone).toBe('ok')
  })

  it('starting is pending, and shows a crash note when there is one', () => {
    const view = describeBlockStatus(
      block({ status: 'starting', lastError: 'the block crashed — a respawn is scheduled' }),
    )
    expect(view.tone).toBe('pending')
    expect(view.detail).toContain('respawn')
  })
})

describe('ordering and summary', () => {
  it('puts what is broken first', () => {
    const out = sortBlocksForDisplay([
      block({ id: 'ok', name: 'Zeta', status: 'running' }),
      block({ id: 'bad', name: 'Alpha', status: 'failed' }),
      block({ id: 'off', name: 'Beta', enabled: false }),
    ])
    expect(out.map((b) => b.id)).toEqual(['bad', 'ok', 'off'])
  })

  it('says a failure in the header, before any row is read', () => {
    const text = summariseBlocks([
      block({ id: 'a', status: 'running' }),
      block({ id: 'b', status: 'failed' }),
    ])
    expect(text).toContain('NOT running')
  })

  it('does not invent a failure when there is none', () => {
    expect(summariseBlocks([block({ status: 'running' })])).not.toContain('NOT running')
  })

  it('is honest about an empty list', () => {
    expect(summariseBlocks([])).toBe('No blocks yet.')
  })
})

describe('a broken block never renders in the colour of a disabled one', () => {
  it('gives error and idle DIFFERENT variants', () => {
    // The one collapse that would make this whole page lie: a failed block
    // drawn in the neutral grey an operator reads as "off on purpose".
    expect(badgeVariantForTone('error')).not.toBe(badgeVariantForTone('idle'))
  })

  it('maps every tone to a distinct variant', () => {
    const variants = (['ok', 'pending', 'error', 'idle'] as const).map(badgeVariantForTone)
    expect(new Set(variants).size).toBe(4)
  })

  it('draws a failure in danger', () => {
    expect(badgeVariantForTone('error')).toBe('danger')
  })

  it('agrees with describeBlockStatus on an enabled-but-stopped block', () => {
    // The end-to-end claim: `stopped` while enabled reaches the screen RED.
    const view = describeBlockStatus(block({ status: 'stopped' }))
    expect(badgeVariantForTone(view.tone)).toBe('danger')
  })
})
