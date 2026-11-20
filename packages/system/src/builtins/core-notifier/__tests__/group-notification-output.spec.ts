import {
  type AlarmState,
  type IScopedLogger,
  type Notification,
  type NotificationTargetRef,
  type SendResult,
  type Target,
  type TargetKindCaps,
} from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { EMPTY_GROUP_CAPS } from '../group-descriptor.js'
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
  ) => ReturnType<typeof createGroupNotificationOutputProvider>
}

function rig(): Rig {
  const sent: Rig['sent'] = []
  const lines: LogLine[] = []
  const failing = new Set<string>()
  const alarm: { state: AlarmState | null } = { state: 'armed_away' }
  const clock = { now: Date.UTC(2026, 10, 20, 12, 0) }
  const ledger = new MemberLedger({ now: () => clock.now })
  const build: Rig['build'] = (targets, groups = [], kinds = []) =>
    createGroupNotificationOutputProvider({
      store: {
        list: async () => [...groups],
        getById: async (id: string) => groups.find((g) => g.id === id) ?? null,
      },
      listTargets: async () => ({ targets, unreadable: [] }),
      listMemberKinds: async () => kinds,
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

  it('a missing member is skipped as unknown-target and logged', async () => {
    const r = rig()
    const { deliver } = r.build([], [])
    const report = await deliver(group([{ targetId: 'gone' }]), NOTIFICATION)
    expect(report.outcomes[0]).toEqual({
      targetId: 'gone',
      status: 'skipped',
      reason: 'unknown-target',
    })
    expect(r.lines.some((l) => l.level === 'warn' && l.tags?.['groupId'] === 'g1')).toBe(true)
  })
})

describe('group kind caps', () => {
  const titleOnly: TargetKindCaps = {
    text: { title: true, body: false },
    attachments: { mediaTypes: [], mode: 'url', max: 0 },
    actions: 0,
    levels: [],
    format: ['text'],
    clickUrl: false,
    sound: false,
    ttl: false,
    bodyMaxLen: 80,
  }
  const rich: TargetKindCaps = {
    attachments: { mediaTypes: ['image'], mode: 'url', max: 1 },
    actions: 3,
    levels: [],
    format: ['text'],
    clickUrl: true,
    sound: false,
    ttl: false,
    bodyMaxLen: 500,
  }

  it('is the union of what the members of the groups deliver', async () => {
    const r = rig()
    const { provider } = r.build(
      [ref('alexa', 'alexa'), ref('zentik', 'zentik'), ref('other', 'other')],
      [group([{ targetId: 'alexa' }, { targetId: 'zentik' }])],
      [
        { kind: 'alexa', caps: titleOnly },
        { kind: 'zentik', caps: rich },
        { kind: 'other', caps: { ...rich, actions: 9 } },
      ],
    )
    const [kind] = await provider.listTargetKinds({})
    expect(kind?.kind).toBe('group')
    expect(kind?.caps.actions).toBe(3)
    expect(kind?.caps.attachments.mediaTypes).toEqual(['image'])
    expect(kind?.caps.clickUrl).toBe(true)
  })

  it('serves title and body before any member is known', async () => {
    const r = rig()
    const { provider } = r.build([])
    const [kind] = await provider.listTargetKinds({})
    expect(kind?.caps).toEqual(EMPTY_GROUP_CAPS)
  })
})
