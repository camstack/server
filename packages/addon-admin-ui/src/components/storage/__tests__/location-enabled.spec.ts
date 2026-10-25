/**
 * Turning an operator edit into an upsert payload.
 *
 * Two server rules this mirrors:
 *
 *  - **The write carries the WHOLE row.** `upsertLocation` REPLACES the record
 *    (`next = { ...input, createdAt, updatedAt }`). A payload built from a
 *    subset of fields does not "patch" — it drops what it left out, and
 *    `nodeId` is the one that hurts: a node-local location whose `nodeId` is
 *    omitted is silently re-stamped `'hub'`, i.e. an agent's disk becomes the
 *    hub's.
 *  - **The state is one enum.** `mode` is what the payload carries; the legacy
 *    `enabled` / `config.readOnly` pair is DERIVED from it, so a hub that
 *    predates `mode` still stops writing to a drained disk.
 */

import type { StorageLocation } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { locationDeletable, toLocationUpsertInput } from '../location-enabled'

const AGENT_DISK: StorageLocation = {
  id: 'recordings:nvme',
  type: 'recordings',
  displayName: 'NVMe',
  providerId: 'filesystem',
  config: { basePath: '/mnt/nvme/rec' },
  nodeId: 'agent-1',
  isSystem: false,
  enabled: false,
  capacity: { totalBytes: 1000, availableBytes: 500 },
  createdAt: 1,
  updatedAt: 2,
}

describe('locationDeletable', () => {
  const ssd: StorageLocation = { ...AGENT_DISK, id: 'recordings:ssd', enabled: true }
  const frozen: StorageLocation = { ...AGENT_DISK, id: 'recordings:hdd', enabled: false }

  it('lets a frozen location go when a writable sibling remains', () => {
    expect(locationDeletable(frozen, [ssd, frozen], 'multi')).toBe(true)
  })

  it('never deletes the only location of a type', () => {
    expect(locationDeletable(ssd, [ssd], 'multi')).toBe(false)
  })

  it('never deletes the only location still taking writes', () => {
    expect(locationDeletable(ssd, [ssd, frozen], 'multi')).toBe(false)
  })

  it('never deletes a single-cardinality location', () => {
    expect(locationDeletable(ssd, [ssd, frozen], 'single')).toBe(false)
  })
})

describe('toLocationUpsertInput', () => {
  it('carries every persisted field of the row it was read from', () => {
    const input = toLocationUpsertInput(AGENT_DISK, { mode: 'active' })
    expect(input).toEqual({
      id: 'recordings:nvme',
      type: 'recordings',
      displayName: 'NVMe',
      providerId: 'filesystem',
      config: { basePath: '/mnt/nvme/rec' },
      nodeId: 'agent-1',
      isSystem: false,
      enabled: true,
      mode: 'active',
    })
  })

  it('keeps nodeId — an omitted one is re-stamped "hub" by the orchestrator', () => {
    expect(toLocationUpsertInput(AGENT_DISK, { mode: 'active' }).nodeId).toBe('agent-1')
  })

  it('takes a nodeId the operator moved the location to', () => {
    expect(toLocationUpsertInput(AGENT_DISK, { nodeId: 'hub' }).nodeId).toBe('hub')
  })

  it('drops the COMPUTED capacity and the server-owned timestamps', () => {
    const input: Record<string, unknown> = { ...toLocationUpsertInput(AGENT_DISK, {}) }
    expect('capacity' in input).toBe(false)
    expect('createdAt' in input).toBe(false)
    expect('updatedAt' in input).toBe(false)
  })

  it('leaves an absent enabled flag absent when the patch sets no mode', () => {
    const legacy: StorageLocation = { ...AGENT_DISK }
    delete (legacy as { enabled?: boolean }).enabled
    const input: Record<string, unknown> = { ...toLocationUpsertInput(legacy, {}) }
    // An update that names no state preserves what is stored — including
    // "stored nothing". Stamping it here would rewrite an implicit contract on
    // an unrelated edit (a rename, a path change).
    expect('enabled' in input).toBe(false)
    expect('mode' in input).toBe(false)
  })

  it('does not mutate the row it was given', () => {
    toLocationUpsertInput(AGENT_DISK, { mode: 'drain' })
    expect(AGENT_DISK.enabled).toBe(false)
    expect(AGENT_DISK.config).toEqual({ basePath: '/mnt/nvme/rec' })
  })

  it('writes the mode AND the legacy pair a pre-mode hub still reads', () => {
    const drain = toLocationUpsertInput(AGENT_DISK, { mode: 'drain' })
    expect(drain.mode).toBe('drain')
    expect(drain.enabled).toBe(false)
    expect(drain.config).toEqual({ basePath: '/mnt/nvme/rec', readOnly: true })

    const readonly = toLocationUpsertInput(AGENT_DISK, { mode: 'readonly' })
    expect(readonly.enabled).toBe(false)
    expect('readOnly' in readonly.config).toBe(false)

    // `disabled` has no legacy expression; the closest an old hub gets is
    // "no writes, no eviction" — the mode is what makes it hide.
    const disabled = toLocationUpsertInput(AGENT_DISK, { mode: 'disabled' })
    expect(disabled.mode).toBe('disabled')
    expect(disabled.enabled).toBe(false)
    expect(disabled.config['readOnly']).toBe(true)
  })

  it('clears the legacy drain flag on a move back to active', () => {
    const drained: StorageLocation = {
      ...AGENT_DISK,
      config: { basePath: '/mnt/nvme/rec', readOnly: true },
    }
    const input = toLocationUpsertInput(drained, { mode: 'active' })
    expect(input.config).toEqual({ basePath: '/mnt/nvme/rec' })
    expect(input.enabled).toBe(true)
  })

  it('takes the config the Edit modal rebuilt, without losing the row around it', () => {
    const input = toLocationUpsertInput(AGENT_DISK, {
      displayName: 'NVMe (fast)',
      config: { basePath: '/mnt/nvme/rec', minFreeGb: 200 },
    })
    expect(input.displayName).toBe('NVMe (fast)')
    expect(input.config).toEqual({ basePath: '/mnt/nvme/rec', minFreeGb: 200 })
    expect(input.nodeId).toBe('agent-1')
    expect(input.enabled).toBe(false)
  })
})
