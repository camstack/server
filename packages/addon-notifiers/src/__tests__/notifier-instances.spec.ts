/**
 * The notifiers' half of the target instance door: an email target is refused without a sender, every
 * kind can be tested while editing (a credential probe where the kind has one, else the canned test
 * notification with the form's values), and each kind carries its brand icon.
 */
import {
  buildUserScopedNotificationTargetInstances,
  type CapCaller,
  type IIntegrationInstancesProvider,
  type IScopedLogger,
  notificationTargetKinds,
  type ProbeTargetConfigResult,
  type SendResult,
} from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { NOTIFIER_ADAPTERS } from '../adapters/registry.js'
import { iconMediaTypeFor, iconUrlFor } from '../icon-routes.js'
import { notifierInstancesSpec } from '../notifier-instances.js'
import type { DraftTestInput } from '../provider.js'
import { notifierDescriptors } from '../record-kinds.js'
import { makeFakeNotifiersRecords } from './fake-records.js'

const ADMIN: CapCaller = { userId: 'root', isAdmin: true }

const silentLogger: IScopedLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => silentLogger,
  withTags: () => silentLogger,
}

interface Door {
  readonly door: IIntegrationInstancesProvider
  readonly probed: DraftTestInput[]
  readonly sent: DraftTestInput[]
}

async function door(sentResult: SendResult = { success: true }): Promise<Door> {
  const world = makeFakeNotifiersRecords()
  const descriptors = notifierDescriptors()
  const kinds = notificationTargetKinds(descriptors)
  await world.records.declare(kinds)
  const probed: DraftTestInput[] = []
  const sent: DraftTestInput[] = []
  let seq = 0
  const provider = buildUserScopedNotificationTargetInstances(
    world.records,
    notifierInstancesSpec({
      adapters: NOTIFIER_ADAPTERS,
      descriptors,
      kinds,
      mintId: () => `t-${++seq}`,
      probeCredentials: async (input): Promise<ProbeTargetConfigResult> => {
        probed.push(input)
        return { ok: true, resolvedUrl: '' }
      },
      testDraft: async (input) => {
        sent.push(input)
        return sentResult
      },
      iconUrlFor,
      iconMediaTypeFor,
    }),
    silentLogger,
  )
  return { door: provider, probed, sent }
}

describe('notifier instances: the email save rule', () => {
  it('refuses to save an email target without a sender, and saves one that links a sender', async () => {
    const { door: d } = await door()
    const created = await d.createInstance({ name: 'Ops', kind: 'email', caller: ADMIN })
    await expect(
      d.updateInstance({ id: created.id, values: { to: 'ops@example.com' }, caller: ADMIN }),
    ).rejects.toThrow(/Send with/)
    await d.updateInstance({
      id: created.id,
      values: { to: 'ops@example.com', sendWith: 'acct-1' },
      caller: ADMIN,
    })
    expect((await d.getInstance({ id: created.id, caller: ADMIN }))?.formValues).toMatchObject({
      to: 'ops@example.com',
      sendWith: 'acct-1',
    })
  })
})

describe('notifier instances: test while editing', () => {
  it('declares every kind testable', async () => {
    const { door: d } = await door()
    const kinds = (await d.describe()).kinds ?? []
    expect(kinds.length).toBeGreaterThan(0)
    expect(kinds.filter((kind) => kind.canTest !== true).map((kind) => kind.id)).toEqual([])
  })

  it('sends the canned test with the unsaved values of a kind that has no credential probe', async () => {
    const { door: d, sent, probed } = await door()
    const result = await d.testInstance?.({
      id: null,
      kind: 'ntfy',
      values: { serverUrl: 'https://ntfy.example', topic: 'draft-topic' },
      caller: ADMIN,
    })
    expect(result).toMatchObject({ success: true })
    expect(sent).toEqual([
      {
        kind: 'ntfy',
        config: { serverUrl: 'https://ntfy.example', topic: 'draft-topic' },
        targetId: undefined,
      },
    ])
    expect(probed).toEqual([])
  })

  it('reports a failed send as a failed test, with its reason', async () => {
    const { door: d } = await door({ success: false, error: 'topic rejected' })
    const result = await d.testInstance?.({
      id: null,
      kind: 'ntfy',
      values: { topic: 'x' },
      caller: ADMIN,
    })
    expect(result).toMatchObject({ success: false })
    expect(JSON.stringify(result)).toMatch(/topic rejected/)
  })

  it('runs the credential probe of a kind that has one, and sends nothing', async () => {
    const { door: d, sent, probed } = await door()
    await d.testInstance?.({
      id: null,
      kind: 'whatsapp',
      values: { idInstance: '1', apiTokenInstance: 'tok', chatId: '39' },
      caller: ADMIN,
    })
    expect(probed.map((input) => input.kind)).toEqual(['whatsapp'])
    expect(sent).toEqual([])
  })
})

describe('notifier instances: icons', () => {
  it('each kind the addon bundles an icon for carries it', async () => {
    const { door: d } = await door()
    const email = ((await d.describe()).kinds ?? []).find((kind) => kind.id === 'email')
    expect(email?.iconUrl).toBe('/addon/notifiers/icons/email')
    expect(email?.iconMediaType).toBe(iconMediaTypeFor('email'))
  })
})
