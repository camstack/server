import {
  type AlarmState,
  type IScopedLogger,
  type Notification,
  type NotificationTargetRef,
  type SendResult,
  type Target,
  type TargetKindCaps,
} from '@dominevo/types'
import { describe, expect, it } from 'vitest'
import { GROUP_CAPS } from '../group-descriptor.js'
import {
  createGroupNotificationOutputProvider,
  type MemberKindCaps,
} from '../group-notification-output.js'
import { MemberLedger } from '../member-ledger.js'

interface LogLine {
  readonly level: string
  readonly message: string
  readonly tags: Record<string, unknown> | undefined
  readonly meta: Record<string, unknown> | undefined
}

function recordingLogger(lines: LogLine[]): IScopedLogger {
  const note =
    (level: string) =>
    (
      message: string,
      options?: { tags?: Record<string, unknown>; meta?: Record<string, unknown> },
    ) => {
      lines.push({ level, message, tags: options?.tags, meta: options?.meta })
    }
  const logger: IScopedLogger = {
    debug: note('debug'),
    info: note('info'),
    warn: note('warn'),
    error: note('error'),
    child: () => logger,
    withTags: () => logger,
  }
  return logger
}

const NOTIFICATION: Notification = {
  title: 'Door',
  body: 'Front door opened',
  format: 'text',
  priority: 3,
  eventId: 'evt-1',
  attachments: [{ mediaType: 'image', url: '/a.jpg' }],
}

function ref(
  id: string,
  kind: string,
  over: Partial<NotificationTargetRef> = {},
): NotificationTargetRef {
  return { id, name: id, kind, addonId: `addon-${kind}`, enabled: true, ...over }
}

function group(members: readonly Record<string, unknown>[]): Target {
  return {
    id: 'g1',
    name: 'G',
    kind: 'group',
    addonId: 'core-notifier',
    enabled: true,
    config: { members },
  }
}

interface BuildOptions {
  readonly unreadable?: readonly { addonId: string; error: string }[]
  readonly listMemberKinds?: () => Promise<readonly MemberKindCaps[]>
}

interface Rig {
  readonly sent: { addonId: string; targetId: string; notification: Notification }[]
  readonly lines: LogLine[]
  readonly failing: Set<string>
  readonly alarm: { state: AlarmState | null }
  readonly clock: { now: number }
  readonly build: (
    targets: readonly NotificationTargetRef[],
    groups?: readonly Target[],
    kinds?: readonly MemberKindCaps[],
    options?: BuildOptions,
  ) => ReturnType<typeof createGroupNotificationOutputProvider>
}

function rig(): Rig {
  const sent: Rig['sent'] = []
  const lines: LogLine[] = []
  const failing = new Set<string>()
  const alarm: { state: AlarmState | null } = { state: 'armed_away' }
  const clock = { now: Date.UTC(2026, 10, 20, 12, 0) }
  const ledger = new MemberLedger({ now: () => clock.now })
  const build: Rig['build'] = (targets, groups = [], kinds = [], options = {}) =>
    createGroupNotificationOutputProvider({
      store: {
        list: async () => [...groups],
        getById: async (id: string) => groups.find((g) => g.id === id) ?? null,
      },
      listTargets: async () => ({ targets, unreadable: options.unreadable ?? [] }),
      listMemberKinds: options.listMemberKinds ?? (async () => kinds),
      sendToMember: async (input): Promise<SendResult> => {
        sent.push(input)
        return failing.has(input.targetId) ? { success: false, error: 'boom' } : { success: true }
      },
      readAlarmState: async () => alarm.state,
      ledger,
      now: () => clock.now,
      logger: recordingLogger(lines),
    })
  return { sent, lines, failing, alarm, clock, build }
}

describe('group send', () => {
  it('fans out one send per member, addressed to the member provider, each shaped by its policy', async () => {
    const r = rig()
    const g = group([
      { targetId: 'alexa', fields: ['title'] },
      { targetId: 'zentik', templates: { body: 'B: {{body}}' } },
    ])
    const { provider } = r.build([ref('alexa', 'alexa'), ref('zentik', 'zentik')], [g])
    const result = await provider.send({ targetId: 'g1', notification: NOTIFICATION })
    expect(result.success).toBe(true)
    expect(r.sent.map((s) => [s.addonId, s.targetId])).toEqual([
      ['addon-alexa', 'alexa'],
      ['addon-zentik', 'zentik'],
    ])
    expect(r.sent[0]?.notification.body).toBe('')
    expect(r.sent[0]?.notification.attachments).toBeUndefined()
    expect(r.sent[1]?.notification.body).toBe('B: Front door opened')
  })

  it('refuses a nested group at send and logs the reason with the group tag', async () => {
    const r = rig()
    const { provider, deliver } = r.build(
      [ref('inner', 'group'), ref('a', 'ntfy')],
      [group([{ targetId: 'inner' }, { targetId: 'a' }])],
    )
    const report = await deliver(group([{ targetId: 'inner' }, { targetId: 'a' }]), NOTIFICATION)
    expect(report.outcomes).toEqual([
      { targetId: 'inner', status: 'skipped', reason: 'nested-group' },
      { targetId: 'a', status: 'sent' },
    ])
    expect(r.sent.map((s) => s.targetId)).toEqual(['a'])
    const line = r.lines.find((l) => l.meta?.['reason'] === 'nested-group')
    expect(line?.tags).toEqual({ groupId: 'g1' })
    expect(provider).toBeDefined()
  })

  it('an outbox retry re-sends only the members that failed', async () => {
    const r = rig()
    const g = group([{ targetId: 'a' }, { targetId: 'b' }])
    const { provider } = r.build([ref('a', 'ntfy'), ref('b', 'telegram')], [g])
    r.failing.add('b')
    const first = await provider.send({ targetId: 'g1', notification: NOTIFICATION })
    expect(first.success).toBe(false)
    expect(first.error).toContain('b: boom')
    r.failing.delete('b')
    r.sent.length = 0
    const retry = await provider.send({ targetId: 'g1', notification: NOTIFICATION })
    expect(retry.success).toBe(true)
    expect(r.sent.map((s) => s.targetId)).toEqual(['b'])
  })

  it('throttles a member to one delivery per window', async () => {
    const r = rig()
    const g = group([{ targetId: 'a', throttleSec: 60 }])
    const { provider } = r.build([ref('a', 'ntfy')], [g])
    await provider.send({ targetId: 'g1', notification: { ...NOTIFICATION, eventId: 'e1' } })
    await provider.send({ targetId: 'g1', notification: { ...NOTIFICATION, eventId: 'e2' } })
    expect(r.sent).toHaveLength(1)
    r.clock.now += 61_000
    await provider.send({ targetId: 'g1', notification: { ...NOTIFICATION, eventId: 'e3' } })
    expect(r.sent).toHaveLength(2)
  })

  it('an alarm member sends only while the panel is in its states, and names an unreadable panel', async () => {
    const r = rig()
    const member = { targetId: 'a', when: { kind: 'alarm', deviceId: 9, states: ['armed_away'] } }
    const { deliver } = r.build([ref('a', 'ntfy')], [])
    expect((await deliver(group([member]), NOTIFICATION)).outcomes[0]?.status).toBe('sent')
    r.alarm.state = 'disarmed'
    expect(
      (await deliver(group([member]), { ...NOTIFICATION, eventId: 'e2' })).outcomes[0],
    ).toEqual({ targetId: 'a', status: 'skipped', reason: 'alarm-state' })
    r.alarm.state = null
    expect(
      (await deliver(group([member]), { ...NOTIFICATION, eventId: 'e3' })).outcomes[0],
    ).toEqual({ targetId: 'a', status: 'skipped', reason: 'alarm-unreadable' })
  })

  it('a missing member on a COMPLETE read is skipped as unknown-target, logged with the group tag', async () => {
    const r = rig()
    const { deliver, provider } = r.build([], [group([{ targetId: 'gone' }])])
    const report = await deliver(group([{ targetId: 'gone' }]), NOTIFICATION)
    expect(report.outcomes).toEqual([
      { targetId: 'gone', status: 'skipped', reason: 'unknown-target' },
    ])
    expect(r.sent).toEqual([])
    const line = r.lines.find((l) => l.meta?.['reason'] === 'unknown-target')
    expect(line?.level).toBe('warn')
    expect(line?.tags).toEqual({ groupId: 'g1' })
    const sent = await provider.send({ targetId: 'g1', notification: NOTIFICATION })
    expect(sent.success).toBe(true)
  })

  it('a missing member on a PARTIAL read FAILS so the outbox retries (D49)', async () => {
    const r = rig()
    const g = group([{ targetId: 'gone' }])
    const { provider } = r.build([], [g], [], {
      unreadable: [{ addonId: 'addon-telegram', error: 'timeout' }],
    })
    const result = await provider.send({ targetId: 'g1', notification: NOTIFICATION })
    expect(result.success).toBe(false)
    expect(result.error).toContain('addon-telegram')
    expect(r.sent).toEqual([])
  })

  it('a member on a complete read after a partial one is delivered normally', async () => {
    const r = rig()
    const { deliver } = r.build([ref('a', 'ntfy')], [], [], {
      unreadable: [{ addonId: 'addon-telegram', error: 'timeout' }],
    })
    const report = await deliver(group([{ targetId: 'a' }]), NOTIFICATION)
    expect(report.outcomes[0]?.status).toBe('sent')
  })

  it('a schedule member sends inside its window and is skipped outside it', async () => {
    const r = rig()
    // 2026-11-20 is a Friday (day 5); the clock is 12:00 UTC = minute 720.
    const inside = {
      targetId: 'a',
      when: {
        kind: 'schedule',
        schedule: { timezone: 'UTC', windows: [{ days: [5], startMinute: 600, endMinute: 780 }] },
      },
    }
    const outside = {
      targetId: 'a',
      when: {
        kind: 'schedule',
        schedule: { timezone: 'UTC', windows: [{ days: [5], startMinute: 0, endMinute: 60 }] },
      },
    }
    const { deliver } = r.build([ref('a', 'ntfy')], [])
    expect((await deliver(group([inside]), NOTIFICATION)).outcomes[0]?.status).toBe('sent')
    expect(
      (await deliver(group([outside]), { ...NOTIFICATION, eventId: 'e2' })).outcomes[0],
    ).toEqual({ targetId: 'a', status: 'skipped', reason: 'schedule-inactive' })
  })

  it('tags every log line of a device notification with the group and the device', async () => {
    const r = rig()
    const { deliver } = r.build([ref('inner', 'group')], [])
    await deliver(group([{ targetId: 'inner' }]), { ...NOTIFICATION, deviceId: 42 })
    const line = r.lines.find((l) => l.meta?.['reason'] === 'nested-group')
    expect(line?.tags).toEqual({ groupId: 'g1', deviceId: 42 })
  })

  it('two rules on the same event are not deduplicated against each other', async () => {
    const r = rig()
    const { deliver } = r.build([ref('a', 'ntfy')], [])
    const g = group([{ targetId: 'a' }])
    const one = { ...NOTIFICATION, metadata: { ruleId: 'r1' } }
    const two = { ...NOTIFICATION, metadata: { ruleId: 'r2' } }
    await deliver(g, one)
    await deliver(g, two)
    expect(r.sent).toHaveLength(2)
    await deliver(g, one)
    expect(r.sent).toHaveLength(2)
  })

  it('without an event id or tag a retry is recognised by its content', async () => {
    const r = rig()
    const g = group([{ targetId: 'a' }, { targetId: 'b' }])
    const { provider } = r.build([ref('a', 'ntfy'), ref('b', 'telegram')], [g])
    const bare: Notification = {
      body: 'Motion',
      title: 'Cam',
      format: 'text',
      priority: 3,
      deviceId: 5,
    }
    r.failing.add('b')
    await provider.send({ targetId: 'g1', notification: bare })
    r.failing.delete('b')
    r.sent.length = 0
    await provider.send({ targetId: 'g1', notification: bare })
    expect(r.sent.map((x) => x.targetId)).toEqual(['b'])
    r.sent.length = 0
    await provider.send({ targetId: 'g1', notification: { ...bare, deviceId: 6 } })
    expect(r.sent.map((x) => x.targetId)).toEqual(['a', 'b'])
  })

  it('each member gets its OWN kind caps, not the union', async () => {
    const r = rig()
    const small: TargetKindCaps = {
      text: { title: true, body: true },
      attachments: { mediaTypes: [], mode: 'url', max: 0 },
      actions: 0,
      levels: [],
      format: ['text'],
      clickUrl: false,
      sound: false,
      ttl: false,
      bodyMaxLen: 5,
    }
    const big: TargetKindCaps = {
      ...small,
      attachments: { mediaTypes: ['image'], mode: 'url', max: 1 },
      bodyMaxLen: 500,
    }
    const g = group([{ targetId: 'sm' }, { targetId: 'bg' }])
    const { deliver } = r.build(
      [ref('sm', 'small'), ref('bg', 'big')],
      [g],
      [
        { kind: 'small', caps: small },
        { kind: 'big', caps: big },
      ],
    )
    await deliver(g, NOTIFICATION)
    const byTarget = new Map(r.sent.map((x) => [x.targetId, x.notification]))
    expect(byTarget.get('sm')?.body).toBe('Front')
    expect(byTarget.get('sm')?.attachments).toBeUndefined()
    expect(byTarget.get('bg')?.body).toBe('Front door opened')
    expect(byTarget.get('bg')?.attachments).toHaveLength(1)
  })
})

describe('group kind caps', () => {
  it('declares static permissive caps and reads no catalogue to answer', async () => {
    const r = rig()
    let reads = 0
    const { provider } = r.build([], [], [], {
      listMemberKinds: async () => {
        reads += 1
        return []
      },
    })
    const [kind] = await provider.listTargetKinds({})
    expect(kind?.kind).toBe('group')
    expect(kind?.caps).toEqual(GROUP_CAPS)
    expect(kind?.caps.attachments.mediaTypes).toEqual(['image', 'video', 'gif', 'audio', 'icon'])
    expect(reads).toBe(0)
  })

  it('a failed member-caps read warns and the member is sent unclamped, to degrade on its own', async () => {
    const r = rig()
    const g = group([{ targetId: 'a' }])
    const { deliver } = r.build([ref('a', 'ntfy')], [g], [], {
      listMemberKinds: async () => {
        throw new Error('catalogue down')
      },
    })
    const report = await deliver(g, NOTIFICATION)
    expect(report.outcomes[0]?.status).toBe('sent')
    expect(r.sent[0]?.notification.body).toBe('Front door opened')
    const line = r.lines.find((l) => l.message.includes('kind caps could not be read'))
    expect(line?.level).toBe('warn')
    expect(line?.tags).toEqual({ groupId: 'g1' })
  })
})

describe('group per-member outcome and the test press', () => {
  const targets = [ref('ok', 'x'), ref('bad', 'x'), ref('off', 'x', { enabled: false })]
  const members = [{ targetId: 'ok' }, { targetId: 'bad' }, { targetId: 'off' }]

  it('send returns one outcome per member: sent, failed and skipped with its reason', async () => {
    const r = rig()
    r.failing.add('bad')
    const { provider } = r.build(targets, [group(members)])
    const result = await provider.send({
      targetId: 'g1',
      notification: NOTIFICATION,
    })
    expect(result.success).toBe(false)
    expect(result.members).toEqual([
      { targetId: 'ok', status: 'sent' },
      { targetId: 'bad', status: 'failed', error: 'boom' },
      { targetId: 'off', status: 'skipped', reason: 'target-disabled' },
    ])
  })

  it('testTarget returns the same breakdown, and an all-skipped send stays a success', async () => {
    const r = rig()
    const { provider } = r.build(targets, [group([{ targetId: 'off' }])])
    const tested = await provider.testTarget({ targetId: 'g1' })
    expect(tested.members).toEqual([
      { targetId: 'off', status: 'skipped', reason: 'target-disabled' },
    ])
    const sent = await provider.send({
      targetId: 'g1',
      notification: NOTIFICATION,
    })
    expect(sent.success).toBe(true)
    expect(sent.members).toEqual([
      { targetId: 'off', status: 'skipped', reason: 'target-disabled' },
    ])
  })

  it('a second test press sends again: a test is not an outbox retry', async () => {
    const r = rig()
    const { provider } = r.build(targets, [group([{ targetId: 'ok' }])])
    await provider.testTarget({ targetId: 'g1' })
    const second = await provider.testTarget({ targetId: 'g1' })
    expect(r.sent).toHaveLength(2)
    expect(second.members).toEqual([{ targetId: 'ok', status: 'sent' }])
  })

  it('a test press neither reads nor writes the delivered-set: a later send still delivers', async () => {
    const r = rig()
    const { provider } = r.build(targets, [group([{ targetId: 'ok' }])])
    await provider.testTarget({ targetId: 'g1', sample: NOTIFICATION })
    const result = await provider.send({
      targetId: 'g1',
      notification: NOTIFICATION,
    })
    expect(result.members).toEqual([{ targetId: 'ok', status: 'sent' }])
  })

  it('a test press still honours the throttle and reports it', async () => {
    const r = rig()
    const { provider } = r.build(targets, [group([{ targetId: 'ok', throttleSec: 60 }])])
    await provider.testTarget({ targetId: 'g1' })
    const second = await provider.testTarget({ targetId: 'g1' })
    expect(second.members).toEqual([{ targetId: 'ok', status: 'skipped', reason: 'throttled' }])
  })

  it('send still dedups a retry of the same notification', async () => {
    const r = rig()
    const { provider } = r.build(targets, [group([{ targetId: 'ok' }])])
    await provider.send({ targetId: 'g1', notification: NOTIFICATION })
    const retry = await provider.send({
      targetId: 'g1',
      notification: NOTIFICATION,
    })
    expect(r.sent).toHaveLength(1)
    expect(retry.members).toEqual([
      { targetId: 'ok', status: 'skipped', reason: 'already-delivered' },
    ])
  })
})

describe('group escalation and content filter', () => {
  const targets = [ref('a', 'x'), ref('b', 'x')]
  const members = [{ targetId: 'a' }, { targetId: 'b', onlyIfUndelivered: ['a'] }]

  it('the fallback member is not tried when the primary was delivered, and says why', async () => {
    const r = rig()
    const { provider } = r.build(targets, [group(members)])
    const result = await provider.send({ targetId: 'g1', notification: NOTIFICATION })
    expect(r.sent.map((s) => s.targetId)).toEqual(['a'])
    expect(result.members).toEqual([
      { targetId: 'a', status: 'sent' },
      { targetId: 'b', status: 'skipped', reason: 'escalation-not-needed' },
    ])
    const line = r.lines.find((l) => l.meta?.['reason'] === 'escalation-not-needed')
    expect(line?.tags).toEqual({ groupId: 'g1' })
  })

  it('the fallback member is tried in the same send when the primary fails', async () => {
    const r = rig()
    r.failing.add('a')
    const { provider } = r.build(targets, [group(members)])
    const result = await provider.send({ targetId: 'g1', notification: NOTIFICATION })
    expect(r.sent.map((s) => s.targetId)).toEqual(['a', 'b'])
    expect(result.members?.[1]).toEqual({ targetId: 'b', status: 'sent' })
  })

  it('the fallback member is tried when the primary is skipped (disabled notifier)', async () => {
    const r = rig()
    const { provider } = r.build(
      [ref('a', 'x', { enabled: false }), ref('b', 'x')],
      [group(members)],
    )
    await provider.send({ targetId: 'g1', notification: NOTIFICATION })
    expect(r.sent.map((s) => s.targetId)).toEqual(['b'])
  })

  it('a retry after the primary was delivered does not escalate', async () => {
    const r = rig()
    const { provider } = r.build(targets, [group(members)])
    await provider.send({ targetId: 'g1', notification: NOTIFICATION })
    r.sent.length = 0
    await provider.send({ targetId: 'g1', notification: NOTIFICATION })
    expect(r.sent).toEqual([])
  })

  it('a filtered member gets only its event kind and class; a test press reaches it anyway', async () => {
    const r = rig()
    const g = group([{ targetId: 'a', filter: { eventKinds: ['detection'], classes: ['person'] } }])
    const { provider } = r.build(targets, [g])
    const car = await provider.send({
      targetId: 'g1',
      notification: { ...NOTIFICATION, metadata: { eventKind: 'detection', className: 'car' } },
    })
    expect(car.members).toEqual([{ targetId: 'a', status: 'skipped', reason: 'content-filter' }])
    const person = await provider.send({
      targetId: 'g1',
      notification: {
        ...NOTIFICATION,
        eventId: 'e-person',
        metadata: { eventKind: 'detection', className: 'person' },
      },
    })
    expect(person.members).toEqual([{ targetId: 'a', status: 'sent' }])
    const tested = await provider.testTarget({ targetId: 'g1' })
    expect(tested.members).toEqual([{ targetId: 'a', status: 'sent' }])
  })
})
