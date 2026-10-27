import type { IScopedLogger, Notification, Target } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { ALEXA_SPEAK_ADDON_ID, ALEXA_SPEAK_KIND, SPEAK_MIN_GAP_MS } from '../speak/constants.js'
import { createAlexaNotificationProvider, type SpeakCommand } from '../speak/provider.js'
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

describe('alexa notification provider', () => {
  it('speaks plain text, collapses a repeat, and returns failure when the worker throws', async () => {
    const spoken: SpeakCommand[] = []
    let now = 10_000
    let devices = [echo()]
    const provider = createAlexaNotificationProvider({
      devices: () => devices,
      loggedIn: () => true,
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

  it('lists discovered Echo devices as targets', async () => {
    const provider = createAlexaNotificationProvider({
      devices: () => [
        echo(),
        echo({ id: 'grp', name: 'Downstairs', kind: 'group', family: 'WHA' }),
      ],
      loggedIn: () => false,
      now: () => 0,
      logger: logger(),
      loadTargets: () => [],
      saveTargets: () => {},
      speak: async () => [],
    })
    const found = await provider.discoverTargets({ kind: ALEXA_SPEAK_KIND })
    expect(found.map((row) => row.suggestedName)).toEqual(['Kitchen', 'Downstairs'])
    const probe = await provider.probeTargetConfig({ kind: ALEXA_SPEAK_KIND, config: {} })
    expect(probe.ok).toBe(false)
  })
})
