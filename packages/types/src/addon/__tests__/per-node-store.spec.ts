import { describe, expect, it } from 'vitest'
import {
  nodeScopedKey,
  normalizeNodeId,
  projectStore,
  readNodeValue,
  scopePatch,
} from '../per-node-store.js'

describe('normalizeNodeId', () => {
  it('returns a bare node id unchanged', () => {
    expect(normalizeNodeId('hub')).toBe('hub')
    expect(normalizeNodeId('agent-1')).toBe('agent-1')
  })

  it('strips the <node>/<addon> suffix of a child-process node id', () => {
    expect(normalizeNodeId('hub/detection-pipeline')).toBe('hub')
    expect(normalizeNodeId('agent-1/decoder-ffmpeg')).toBe('agent-1')
  })

  it('keeps only the first segment for multi-segment ids', () => {
    expect(normalizeNodeId('a/b/c')).toBe('a')
  })

  it("defaults to 'hub' for undefined", () => {
    expect(normalizeNodeId(undefined)).toBe('hub')
  })

  it("defaults to 'hub' for null", () => {
    expect(normalizeNodeId(null)).toBe('hub')
  })

  it("defaults to 'hub' for the empty string", () => {
    expect(normalizeNodeId('')).toBe('hub')
  })
})

describe('nodeScopedKey', () => {
  it('joins base key and node id with @', () => {
    expect(nodeScopedKey('backend', 'agent-1')).toBe('backend@agent-1')
    expect(nodeScopedKey('engineBackend', 'hub')).toBe('engineBackend@hub')
  })

  it('normalizes the node id before scoping', () => {
    expect(nodeScopedKey('backend', 'agent-1/decoder-ffmpeg')).toBe('backend@agent-1')
  })
})

describe('readNodeValue', () => {
  const store: Readonly<Record<string, unknown>> = {
    'backend@hub': 'nodeav',
    'backend@agent-1': 'ffmpeg',
    backend: 'stale-bare-value',
    shared: 'cluster-wide',
  }

  it("reads the node's scoped key when present", () => {
    expect(readNodeValue(store, 'backend', 'hub')).toBe('nodeav')
    expect(readNodeValue(store, 'backend', 'agent-1')).toBe('ffmpeg')
  })

  it('returns undefined when the scoped key is absent', () => {
    expect(readNodeValue(store, 'backend', 'agent-99')).toBeUndefined()
  })

  it('NEVER falls back to a bare key — bare present, scoped absent is still undefined', () => {
    const bareOnly: Readonly<Record<string, unknown>> = { backend: 'bare-only' }
    expect(readNodeValue(bareOnly, 'backend', 'hub')).toBeUndefined()
    expect(readNodeValue(bareOnly, 'backend', 'agent-1')).toBeUndefined()
  })

  it('normalizes a child-process node id before the lookup', () => {
    expect(readNodeValue(store, 'backend', 'hub/decoder-ffmpeg')).toBe('nodeav')
  })
})

describe('scopePatch', () => {
  const perNodeKeys: ReadonlySet<string> = new Set(['backend'])

  it('re-maps bare perNode keys onto the target node scoped key', () => {
    const out = scopePatch({ backend: 'nodeav', shared: 'x' }, perNodeKeys, 'agent-1')
    expect(out).toEqual({ 'backend@agent-1': 'nodeav', shared: 'x' })
  })

  it('passes everything through untouched when the key set is empty', () => {
    const patch = { backend: 'nodeav', shared: 'x' }
    const out = scopePatch(patch, new Set<string>(), 'agent-1')
    expect(out).toEqual(patch)
  })

  it('normalizes the target node id', () => {
    const out = scopePatch({ backend: 'nodeav' }, perNodeKeys, 'agent-1/decoder-ffmpeg')
    expect(out).toEqual({ 'backend@agent-1': 'nodeav' })
  })

  it('does not mutate the input patch', () => {
    const patch = { backend: 'nodeav', shared: 'x' }
    scopePatch(patch, perNodeKeys, 'agent-1')
    expect(patch).toEqual({ backend: 'nodeav', shared: 'x' })
  })
})

describe('projectStore', () => {
  const perNodeKeys: ReadonlySet<string> = new Set(['backend'])
  const store: Readonly<Record<string, unknown>> = {
    'backend@hub': 'nodeav',
    'backend@agent-1': 'ffmpeg',
    backend: 'stale-bare-value',
    shared: 'cluster-wide',
    'unrelated@agent-1': 7,
  }

  it("overlays THIS node's scoped value onto the bare key — nodes are independent", () => {
    expect(projectStore(store, perNodeKeys, 'hub')['backend']).toBe('nodeav')
    expect(projectStore(store, perNodeKeys, 'agent-1')['backend']).toBe('ffmpeg')
  })

  it('drops every @-scoped key from the pass-through', () => {
    const out = projectStore(store, perNodeKeys, 'hub')
    expect(Object.keys(out).some((k) => k.includes('@'))).toBe(false)
    expect(out).not.toHaveProperty('backend@hub')
    expect(out).not.toHaveProperty('backend@agent-1')
    expect(out).not.toHaveProperty('unrelated@agent-1')
  })

  it('leaves the bare perNode key ABSENT when the node has no scoped value (schema default wins, NO bare fallback)', () => {
    const out = projectStore(store, perNodeKeys, 'agent-99')
    expect(Object.prototype.hasOwnProperty.call(out, 'backend')).toBe(false)
  })

  it('passes non-perNode bare keys through unchanged', () => {
    const out = projectStore(store, perNodeKeys, 'hub')
    expect(out['shared']).toBe('cluster-wide')
  })

  it('normalizes a child-process node id', () => {
    expect(projectStore(store, perNodeKeys, 'hub/decoder-ffmpeg')['backend']).toBe('nodeav')
  })

  it('does not mutate the input store', () => {
    const copy = { ...store }
    projectStore(store, perNodeKeys, 'hub')
    expect(store).toEqual(copy)
  })
})
