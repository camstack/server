/**
 * Task 7 — cross-node hardware display forwards via the cap INPUT (`nodeId`),
 * not a `nodePin` context.
 *
 * `platform-probe` is a singleton cap: the hub's router mount resolves it to the
 * HUB's provider and IGNORES a `nodePin` request context. The generated router
 * DOES honour an optional `nodeId` INPUT (`resolveProvider` forwards to that
 * node's provider — local for hub, Moleculer proxy for a remote agent). So the
 * hub, when it serves a REMOTE node's engine settings, must pass the target as
 * the cap input or it silently offers the HUB's hardware for every node.
 *
 * Asserts `resolveProbeHardware`:
 *  1. forwards a remote node as `getCapabilities({ nodeId })`.
 *  2. resolves the local node in-process (no nodeId → hub-local provider).
 */

import type { ProviderRegistration } from '@camstack/types'
import { describe, expect, it, vi } from 'vitest'
import DetectionPipelineAddon from '../index.js'

type AddonCtx = Parameters<DetectionPipelineAddon['initialize']>[0]

class TestAddon extends DetectionPipelineAddon {
  protected override async onInitialize(): Promise<ProviderRegistration[]> {
    return []
  }
}

function makeCaps() {
  return {
    hardware: { platform: 'linux', arch: 'x64', gpu: { type: 'intel' }, npu: null },
    scores: [],
  }
}

function makeAddon(query: ReturnType<typeof vi.fn>): { addon: TestAddon; ready: Promise<void> } {
  const ctx = {
    id: 'detection-pipeline',
    logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
    kernel: { localNodeId: 'hub' },
    eventBus: { emit: vi.fn(), subscribe: vi.fn(() => () => {}) },
    settings: {
      readAddonStore: async () => ({}),
      writeAddonStore: async () => undefined,
    },
    api: { platformProbe: { getCapabilities: { query } } },
  } as unknown as AddonCtx
  const addon = new TestAddon()
  return { addon, ready: addon.initialize(ctx).then(() => undefined) }
}

describe('resolveProbeHardware — node forwarding via cap input', () => {
  it('forwards a REMOTE node as the getCapabilities `nodeId` input (not a nodePin context)', async () => {
    const query = vi.fn(async () => makeCaps())
    const { addon, ready } = makeAddon(query)
    await ready

    await addon['resolveProbeHardware']('mac-mini')

    expect(query).toHaveBeenCalledWith({ nodeId: 'mac-mini' })
  })

  it('resolves the LOCAL node in-process — no nodeId input', async () => {
    const query = vi.fn(async () => makeCaps())
    const { addon, ready } = makeAddon(query)
    await ready

    await addon['resolveProbeHardware']('hub')

    // Local node keeps the default (unpinned) hub-in-process resolution.
    expect(query).toHaveBeenCalledWith()
  })
})
