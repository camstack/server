import { describe, expect, it } from 'vitest'
import {
  configureNotificationTargets,
  configureNotifiers,
  testNotificationTarget,
  upsertNotificationTarget,
} from '../mcp/configure-notifiers.js'
import { ADDRESSES, asProtectedTier, dryRunOf, gatedHub, writes } from './configure-fixtures.js'

const ntfyKind = {
  kind: 'ntfy',
  label: 'ntfy',
  addonId: 'notifiers',
  supportsDiscovery: false,
  destinationKeys: ['serverUrl'],
  configSchema: {
    sections: [
      {
        id: 'connection',
        fields: [
          {
            type: 'text',
            key: 'serverUrl',
            label: 'Server URL',
            default: 'https://ntfy.sh',
          },
          { type: 'password', key: 'topic', label: 'Topic', required: true },
          { type: 'password', key: 'token', label: 'Access token' },
          {
            type: 'select',
            key: 'priority',
            label: 'Priority',
            options: [{ value: 'low' }, { value: 'high' }],
          },
        ],
      },
    ],
  },
}

const echoTarget = (input: unknown): unknown =>
  typeof input === 'object' && input !== null && 'target' in input ? input.target : null

const answers = (extra: { [path: string]: unknown } = {}): { [path: string]: unknown } => ({
  'notificationOutput.listTargetKinds': [ntfyKind],
  'notificationOutput.listTargets': [
    {
      id: 'ntfy-1',
      name: 'Phone',
      kind: 'ntfy',
      addonId: 'notifiers',
      enabled: true,
      config: {
        serverUrl: 'https://ntfy.sh',
        topic: '__redacted__',
        ownerUserId: 'u1',
      },
    },
    {
      id: 'ntfy-2',
      name: 'Bare',
      kind: 'ntfy',
      addonId: 'notifiers',
      enabled: true,
      config: { serverUrl: 'https://ntfy.sh' },
    },
  ],
  'localNetwork.getAddresses': ADDRESSES,
  ...extra,
})

describe('configure_notifiers / configure_notification_targets', () => {
  it('lists the form fields and marks the password fields secret', async () => {
    const { ctx } = gatedHub(answers())
    const out = await configureNotifiers(ctx)
    if (out.status !== 'ok') throw new Error('expected ok')
    const ntfy = out.notifiers?.find((n) => n.kind === 'ntfy')
    expect(ntfy?.secretFields).toEqual(['topic', 'token'])
    expect(ntfy?.fields?.find((f) => f.key === 'topic')).toMatchObject({
      secret: true,
      required: true,
    })
  })

  it('shows a stored secret only as set/unset and flags the incomplete target', async () => {
    const { ctx } = gatedHub(answers())
    const out = await configureNotificationTargets(ctx)
    if (out.status !== 'ok') throw new Error('expected ok')
    const [phone, bare] = out.targets ?? []
    expect(phone?.secrets).toEqual({ topic: 'set', token: 'unset' })
    expect(phone?.config).not.toHaveProperty('topic')
    expect(phone?.incomplete).toEqual([])
    expect(bare?.incomplete).toEqual(['topic'])
    expect(JSON.stringify(out)).not.toContain('__redacted__')
  })
})

describe('configure_notification_target_upsert', () => {
  const create = {
    kind: 'ntfy',
    name: 'Kitchen',
    config: { serverUrl: 'https://ntfy.example.test' },
  }

  it('previews without writing, then creates with the non-secret fields and reports the secret as required', async () => {
    const hub = gatedHub(answers({ 'notificationOutput.upsertTarget': echoTarget }))
    const dry = dryRunOf(await upsertNotificationTarget(hub.ctx, create, undefined))
    expect(writes(hub.calls)).toHaveLength(0)
    expect(JSON.stringify(dry.describe)).toContain('secret-required')
    expect(dry.token).toBeDefined()

    const done = await upsertNotificationTarget(hub.ctx, create, dry.token)
    const sent = writes(hub.calls)
    expect(sent).toHaveLength(1)
    expect(sent[0]?.path).toBe('notificationOutput.upsertTarget')
    expect(sent[0]?.input).toMatchObject({
      target: {
        kind: 'ntfy',
        name: 'Kitchen',
        addonId: 'notifiers',
        config: { serverUrl: 'https://ntfy.example.test' },
      },
    })
    expect(done).toMatchObject({
      status: 'executed',
      result: {
        created: true,
        incompleteUntilSecretSet: [{ status: 'secret-required', field: 'topic' }],
      },
    })
  })

  it('refuses a secret supplied as an argument, drops its value and names the admin link', async () => {
    const hub = gatedHub(answers())
    const out = await upsertNotificationTarget(
      hub.ctx,
      {
        ...create,
        config: {
          serverUrl: 'https://x.example.test',
          topic: 'hunter2-topic',
        },
      },
      undefined,
    )
    expect(dryRunOf(out).token).toBeUndefined()
    const shown = JSON.stringify(out)
    expect(shown).toContain('secret-required')
    expect(shown).toContain('https://hub.example.test/system/notifications')
    expect(shown).not.toContain('hunter2-topic')
    expect(writes(hub.calls)).toHaveLength(0)
  })

  it('a credential-named key the form does not know is treated as secret too', async () => {
    const hub = gatedHub(answers())
    const out = await upsertNotificationTarget(
      hub.ctx,
      { ...create, config: { anything_token: 'zzz-secret-value' } },
      undefined,
    )
    expect(dryRunOf(out).token).toBeUndefined()
    expect(JSON.stringify(out)).toContain('secret-required')
    expect(JSON.stringify(out)).not.toContain('zzz-secret-value')
  })

  it('validates against the kind schema: unknown field, bad select value', async () => {
    const hub = gatedHub(answers())
    const unknown = JSON.stringify(
      await upsertNotificationTarget(hub.ctx, { ...create, config: { nope: 1 } }, undefined),
    )
    expect(unknown).toContain('fields not in the \\"ntfy\\" form: nope')
    const bad = JSON.stringify(
      await upsertNotificationTarget(
        hub.ctx,
        { ...create, config: { priority: 'urgent' } },
        undefined,
      ),
    )
    expect(bad).toContain('priority')
    expect(bad).not.toContain('confirm_token')
  })

  it('an edit keeps the stored secret markers so the provider restores them', async () => {
    const hub = gatedHub(answers({ 'notificationOutput.upsertTarget': echoTarget }))
    const args = {
      targetId: 'ntfy-1',
      kind: 'ntfy',
      name: 'Phone 2',
      config: { priority: 'high' },
    }
    const dry = dryRunOf(await upsertNotificationTarget(hub.ctx, args, undefined))
    await upsertNotificationTarget(hub.ctx, args, dry.token)
    expect(writes(hub.calls)[0]?.input).toMatchObject({
      target: {
        id: 'ntfy-1',
        config: {
          topic: '__redacted__',
          priority: 'high',
          serverUrl: 'https://ntfy.sh',
        },
      },
    })
  })

  it('needs an admin session', async () => {
    const hub = gatedHub(answers())
    const out = await upsertNotificationTarget(await asProtectedTier(hub.ctx), create, undefined)
    expect(out).toMatchObject({ status: 'refused' })
    expect(hub.calls).toHaveLength(0)
  })
})

describe('configure_notification_target_test', () => {
  it('refuses an incomplete target, and sends only on confirm for a complete one', async () => {
    const hub = gatedHub(answers({ 'notificationOutput.testTarget': { success: true } }))
    const incomplete = await testNotificationTarget(hub.ctx, { targetId: 'ntfy-2' }, undefined)
    expect(JSON.stringify(incomplete)).toContain('secret-required')
    expect(dryRunOf(incomplete).token).toBeUndefined()

    const dry = dryRunOf(await testNotificationTarget(hub.ctx, { targetId: 'ntfy-1' }, undefined))
    expect(writes(hub.calls)).toHaveLength(0)
    const sent = await testNotificationTarget(hub.ctx, { targetId: 'ntfy-1' }, dry.token)
    expect(writes(hub.calls)).toHaveLength(1)
    expect(sent).toMatchObject({
      status: 'executed',
      result: { delivered: true },
    })
  })
})
