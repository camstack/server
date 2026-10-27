import type { IScopedLogger, Notification, Target } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { ALEXA_SPEAK_ADDON_ID, ALEXA_SPEAK_KIND, SPEAK_MIN_GAP_MS } from '../speak/constants.js'
import {
  alexaTargetKind,
  createAlexaNotificationProvider,
  type AlexaSpeakPorts,
  type SpeakBrokerView,
  type SpeakCommand,
} from '../speak/provider.js'
import type { EchoDevice } from '../speak/worker-protocol.js'

const echo = (patch: Partial<EchoDevice> = {}): EchoDevice => ({
  id: 'echo-1',
  name: 'Kitchen',
  family: 'ECHO',
  online: true,
  kind: 'device',
  dnd: false,
  deviceType: 'T',
  ...patch,
})

function logger(): IScopedLogger {
  const value: IScopedLogger = {
    debug() {},
    info() {},
    warn() {},
    error() {},
    child() {
      return value
    },
    withTags() {
      return value
    },
  }
  return value
}

function target(config: Record<string, unknown> = {}): Target {
  return {
    id: 't1',
    name: 'Kitchen',
    kind: ALEXA_SPEAK_KIND,
    addonId: ALEXA_SPEAK_ADDON_ID,
    enabled: true,
    config: { echoId: 'echo-1', mode: 'speak', volume: 40, respectDnd: true, ...config },
  }
}

const note = (body: string): Notification => ({ body, format: 'text', priority: 3, deviceId: 7 })

const broker = (
  id: string,
  name: string,
  devices: readonly EchoDevice[],
  ready = true,
): SpeakBrokerView => ({ id, name, ready, devices })

function ports(): AlexaSpeakPorts {
  return {
    brokers: () => [],
    now: () => 0,
    logger: logger(),
    loadTargets: () => [],
    saveTargets: () => {},
    speak: async () => [],
  }
}

describe('alexa notification provider', () => {
  it('speaks plain text, collapses a repeat, and returns failure when the worker throws', async () => {
    const spoken: SpeakCommand[] = []
    let now = 10_000
    let devices = [echo()]
    const provider = createAlexaNotificationProvider({
      brokers: () => [broker('b1', 'Home', devices)],
      now: () => now,
      logger: logger(),
      loadTargets: () => [target()],
      saveTargets: () => {},
      speak: async (command) => {
        spoken.push(command)
        if (command.text.includes('down')) throw new Error('session down')
        return [{ targetId: command.targets[0] ?? '', ok: true }]
      },
    })
    const first = await provider.send({
      targetId: 't1',
      notification: note('**Person** at the door'),
    })
    expect(first.success).toBe(true)
    expect(spoken[0]?.text).toBe('Person at the door')
    expect(spoken[0]?.text).not.toContain('*')
    now += 1_000
    const collapsed = await provider.send({
      targetId: 't1',
      notification: note('**Person** at the door'),
    })
    expect(collapsed.success).toBe(true)
    expect(spoken).toHaveLength(1)
    expect(provider.deliveries.map((row) => row.outcome)).toContain('collapsed')
    now += SPEAK_MIN_GAP_MS
    const failed = await provider.send({
      targetId: 't1',
      notification: note('session down please'),
    })
    expect(failed.success).toBe(false)
    expect(failed.error).toBe('session down')
    devices = [echo({ dnd: true })]
    now += SPEAK_MIN_GAP_MS
    const quiet = await provider.send({ targetId: 't1', notification: note('after hours') })
    expect(quiet.success).toBe(true)
    expect(provider.deliveries.at(-1)?.outcome).toBe('dnd')
    expect(spoken.some((command) => command.text === 'after hours')).toBe(false)
  })

  it('lists discovered Echo devices as targets, per account', async () => {
    const provider = createAlexaNotificationProvider({
      ...ports(),
      brokers: () => [
        broker('b1', 'Home', [
          echo(),
          echo({ id: 'grp', name: 'Downstairs', kind: 'group', family: 'WHA' }),
        ]),
      ],
    })
    const found = await provider.discoverTargets({ kind: ALEXA_SPEAK_KIND })
    expect(found.map((row) => row.suggestedName)).toEqual(['Kitchen', 'Downstairs'])
    expect(found.every((row) => row.config['brokerId'] === 'b1')).toBe(true)
  })

  it('discovery skips an Echo that already has a target', async () => {
    const provider = createAlexaNotificationProvider({
      ...ports(),
      brokers: () => [broker('b1', 'Home', [echo(), echo({ id: 'echo-2', name: 'Hall' })])],
      loadTargets: () => [target({ brokerId: 'b1', echoId: 'echo-1' })],
    })
    const found = await provider.discoverTargets({ kind: ALEXA_SPEAK_KIND })
    expect(found.map((row) => row.config['echoId'])).toEqual(['echo-2'])
  })

  it('discovery keeps the same serial on another account', async () => {
    const provider = createAlexaNotificationProvider({
      ...ports(),
      brokers: () => [broker('b1', 'Home', [echo()]), broker('b2', 'Office', [echo()])],
      loadTargets: () => [target({ brokerId: 'b1', echoId: 'echo-1' })],
    })
    const found = await provider.discoverTargets({ kind: ALEXA_SPEAK_KIND })
    expect(found.map((row) => row.config['brokerId'])).toEqual(['b2'])
  })

  it('probes the account the config names', async () => {
    const provider = createAlexaNotificationProvider({
      ...ports(),
      brokers: () => [broker('b1', 'Home', [], true), broker('b2', 'Office', [], false)],
    })
    const ready = await provider.probeTargetConfig({
      kind: ALEXA_SPEAK_KIND,
      config: { brokerId: 'b1' },
    })
    const waiting = await provider.probeTargetConfig({
      kind: ALEXA_SPEAK_KIND,
      config: { brokerId: 'b2' },
    })
    expect(ready.ok).toBe(true)
    expect(waiting.ok).toBe(false)
  })
})

describe('the Alexa target kind', () => {
  const fieldsOf = (brokers: readonly SpeakBrokerView[]) =>
    alexaTargetKind(brokers).configSchema.sections.flatMap((section) => section.fields)

  it('carries the official brand icon', async () => {
    const [kind] = await createAlexaNotificationProvider(ports()).listTargetKinds({})
    expect(kind?.iconUrl).toBe('/addon/import-alexa/icons/alexa-echo')
    expect(kind?.iconMediaType).toBe('image/svg+xml')
  })

  it('offers the account Echoes as a select, with room and family, and no account field for one account', () => {
    const fields = fieldsOf([
      broker('b1', 'Home', [
        echo({ room: 'Living room' }),
        echo({ id: 'grp', name: 'Downstairs', kind: 'group', family: 'WHA' }),
      ]),
    ])
    const echoField = fields.find((field) => 'key' in field && field.key === 'echoId')
    expect(echoField?.type).toBe('select')
    expect(echoField && 'options' in echoField ? echoField.options : []).toEqual([
      { value: 'echo-1', label: 'Kitchen · Living room · ECHO' },
      { value: 'grp', label: 'Downstairs · Group' },
    ])
    expect(fields.some((field) => 'key' in field && field.key === 'brokerId')).toBe(false)
  })

  it('asks for the account first when there are several, and shows the Echoes of the chosen one', () => {
    const fields = fieldsOf([
      broker('b1', 'Home', [echo({ id: 'home-echo', name: 'Home echo' })]),
      broker('b2', 'Office', [echo({ id: 'office-echo', name: 'Office echo' })]),
    ])
    const account = fields.find((field) => 'key' in field && field.key === 'brokerId')
    expect(account && 'options' in account ? account.options.map((o) => o.value) : []).toEqual([
      'b1',
      'b2',
    ])
    const echoes = fields.filter((field) => 'key' in field && field.key === 'echoId')
    expect(echoes.map((field) => ('showWhen' in field ? field.showWhen : undefined))).toEqual([
      { field: 'brokerId', equals: 'b1' },
      { field: 'brokerId', equals: 'b2' },
    ])
    expect(
      echoes.map((field) => ('options' in field ? field.options.map((o) => o.value) : [])),
    ).toEqual([['home-echo'], ['office-echo']])
  })

  it('pins the account on save, so a second account added later does not move the target', async () => {
    const saved: Target[][] = []
    const provider = createAlexaNotificationProvider({
      ...ports(),
      brokers: () => [broker('b1', 'Home', [echo()])],
      saveTargets: (next) => saved.push([...next]),
    })
    await provider.upsertTarget({ target: { ...target({ echoId: 'echo-1' }) } })
    expect(saved[0]?.[0]?.config['brokerId']).toBe('b1')
  })

  it('refuses to save a target with no Echo, or with no account when several are linked', async () => {
    const provider = createAlexaNotificationProvider({
      ...ports(),
      brokers: () => [broker('b1', 'Home', [echo()]), broker('b2', 'Office', [echo()])],
    })
    await expect(provider.upsertTarget({ target: target({ echoId: '' }) })).rejects.toThrow(
      'Pick the Echo that should speak',
    )
    await expect(provider.upsertTarget({ target: target({ echoId: 'echo-1' }) })).rejects.toThrow(
      'Pick the Amazon account this Echo belongs to',
    )
  })

  it('speaks through the account the target names, not another', async () => {
    const spoken: SpeakCommand[] = []
    const provider = createAlexaNotificationProvider({
      ...ports(),
      brokers: () => [
        broker('b1', 'Home', [echo()]),
        broker('b2', 'Office', [echo({ id: 'echo-9' })]),
      ],
      loadTargets: () => [target({ brokerId: 'b2', echoId: 'echo-9' })],
      speak: async (command) => {
        spoken.push(command)
        return [{ targetId: command.targets[0] ?? '', ok: true }]
      },
    })
    const sent = await provider.send({ targetId: 't1', notification: note('hello') })
    expect(sent.success).toBe(true)
    expect(spoken[0]?.brokerId).toBe('b2')
  })

  it('refuses to guess when a target names no account and there are several', async () => {
    const provider = createAlexaNotificationProvider({
      ...ports(),
      brokers: () => [broker('b1', 'Home', []), broker('b2', 'Office', [])],
      loadTargets: () => [target({ echoId: 'unknown' })],
    })
    const sent = await provider.send({ targetId: 't1', notification: note('hello') })
    expect(sent.success).toBe(false)
    expect(sent.error).toBe('target has no Amazon account')
  })
})
