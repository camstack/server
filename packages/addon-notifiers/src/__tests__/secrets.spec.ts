/**
 * Unit tests for target secret redaction + merge, including secrets nested in
 * `editable-array` rows (e.g. the webhook custom-header `value`).
 */
import type { ConfigUISchema, Target, TargetKind, TargetKindCaps } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import {
  mergeSecrets,
  passwordFieldKeys,
  REDACTED_MARKER,
  redactForRead,
  type SecretMergeRequest,
} from '../secrets.js'

const CAPS: TargetKindCaps = {
  attachments: { mediaTypes: [], mode: 'url', max: 0 },
  actions: 0,
  levels: [],
  format: ['text'],
  clickUrl: false,
  sound: false,
  ttl: false,
  bodyMaxLen: 1000,
}

/** A schema with a top-level password AND an editable-array with a nested password. */
function schema(): ConfigUISchema {
  return {
    sections: [
      {
        id: 'main',
        title: 'Main',
        fields: [
          { type: 'text', key: 'url', label: 'URL' },
          { type: 'password', key: 'token', label: 'Token' },
          {
            type: 'editable-array',
            key: 'headers',
            label: 'Headers',
            itemFields: [
              { type: 'text', key: 'name', label: 'Header' },
              { type: 'password', key: 'value', label: 'Value' },
            ],
          },
        ],
      },
    ],
  }
}

function descriptor(): TargetKind {
  return {
    kind: 'webhook',
    label: 'Webhook',
    icon: 'webhook',
    addonId: 'notifiers',
    configSchema: schema(),
    supportsDiscovery: false,
    caps: CAPS,
  }
}

/** A same-kind, same-destination save — the only shape a restore is granted to. */
function request(
  existing: Record<string, unknown>,
  incoming: Record<string, unknown>,
): SecretMergeRequest {
  return {
    existing: { kind: 'webhook', config: existing },
    incoming: { id: 't1', kind: 'webhook', config: incoming },
    adapter: { descriptor: descriptor(), destinationKeys: ['url'] },
  }
}

function target(config: Record<string, unknown>): Target {
  return { id: 't1', name: 'T', kind: 'webhook', addonId: 'notifiers', enabled: true, config }
}

describe('passwordFieldKeys', () => {
  it('collects top-level password keys only (nested handled separately)', () => {
    expect([...passwordFieldKeys(descriptor())]).toEqual(['token'])
  })
})

describe('redactForRead — nested editable-array password', () => {
  it('redacts each row password + top-level, leaves non-secret fields', () => {
    const redacted = redactForRead(
      target({
        url: 'https://x',
        token: 'secret',
        headers: [
          { name: 'Authorization', value: 'Bearer abc' },
          { name: 'X-Empty', value: '' },
        ],
      }),
      descriptor(),
    )
    expect(redacted.config['token']).toBe(REDACTED_MARKER)
    expect(redacted.config['url']).toBe('https://x')
    const rows = redacted.config['headers'] as Array<Record<string, unknown>>
    expect(rows[0]).toEqual({ name: 'Authorization', value: REDACTED_MARKER })
    // Empty secret is left as-is (distinguishes "unset" from "hidden").
    expect(rows[1]).toEqual({ name: 'X-Empty', value: '' })
  })

  it('does not mutate the source target', () => {
    const src = target({ headers: [{ name: 'A', value: 'v' }] })
    redactForRead(src, descriptor())
    expect((src.config['headers'] as Array<Record<string, unknown>>)[0]!['value']).toBe('v')
  })
})

describe('mergeSecrets — nested editable-array password', () => {
  it('restores a stored row secret when the operator re-submits the marker (matched by identity)', () => {
    const existing = {
      token: 'realtoken',
      headers: [
        { name: 'Authorization', value: 'Bearer real' },
        { name: 'X-Api', value: 'apikey' },
      ],
    }
    const incoming = {
      token: REDACTED_MARKER,
      headers: [
        // reordered vs stored — matched by `name`, not index
        { name: 'X-Api', value: REDACTED_MARKER },
        { name: 'Authorization', value: REDACTED_MARKER },
      ],
    }
    const merged = mergeSecrets(request(existing, incoming))
    expect(merged['token']).toBe('realtoken')
    const rows = merged['headers'] as Array<Record<string, unknown>>
    expect(rows[0]).toEqual({ name: 'X-Api', value: 'apikey' })
    expect(rows[1]).toEqual({ name: 'Authorization', value: 'Bearer real' })
  })

  it('keeps a re-typed row secret verbatim', () => {
    const merged = mergeSecrets(
      request(
        { headers: [{ name: 'A', value: 'old' }] },
        { headers: [{ name: 'A', value: 'new' }] },
      ),
    )
    expect((merged['headers'] as Array<Record<string, unknown>>)[0]!['value']).toBe('new')
  })

  it('drops the marker for a brand-new row with no prior secret', () => {
    const merged = mergeSecrets(
      request({ headers: [] }, { headers: [{ name: 'A', value: REDACTED_MARKER }] }),
    )
    const row = (merged['headers'] as Array<Record<string, unknown>>)[0]!
    expect('value' in row).toBe(false)
    expect(row['name']).toBe('A')
  })
})
