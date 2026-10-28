import { describe, expect, it } from 'vitest'
import { EspServiceRunner } from '../esphome-services.js'
import { EspServiceError, type EspServiceInfo } from '../esphome-link.js'
import { FakeLink } from './fake-link.js'
import { captureLogger, type LogLine } from './fake-ctx.js'

const IR: EspServiceInfo = {
  name: 'send_raw_command',
  key: 7,
  args: [{ name: 'command', type: 'int[]' }],
}
const MIXED: EspServiceInfo = {
  name: 'mixed',
  key: 8,
  args: [
    { name: 'on', type: 'bool' },
    { name: 'level', type: 'int' },
    { name: 'gain', type: 'float' },
    { name: 'label', type: 'string' },
  ],
}

function setup(connected = true): {
  link: FakeLink
  lines: LogLine[]
  runner: EspServiceRunner
} {
  const link = new FakeLink([])
  link.services = [IR, MIXED]
  const lines: LogLine[] = []
  const runner = new EspServiceRunner({
    getLink: (id) => (connected && id === 'b1' ? link : null),
    logger: captureLogger(lines),
  })
  return { link, lines, runner }
}

async function reasonOf(p: Promise<unknown>): Promise<string> {
  try {
    await p
  } catch (err: unknown) {
    if (err instanceof EspServiceError) return err.reason
    throw err
  }
  return 'none'
}

describe('EspServiceRunner', () => {
  it('lists the services of a connected board', () => {
    const { runner } = setup()
    expect(runner.listServices('b1')).toEqual([IR, MIXED])
  })

  it('executes with validated args and logs board + service + deviceId', async () => {
    const { runner, link, lines } = setup()
    await runner.executeService('b1', 'send_raw_command', { command: [9000, 4500, 560] }, 42)
    expect(link.serviceCalls).toEqual([
      { name: 'send_raw_command', args: { command: [9000, 4500, 560] } },
    ])
    const text = JSON.stringify(lines.find((l) => l.message.includes('service executed'))?.extras)
    expect(text).toContain('send_raw_command')
    expect(text).toContain('b1')
    expect(text).toContain('"deviceId":42')
  })

  it('truncates a large payload in the log', async () => {
    const { runner, lines } = setup()
    await runner.executeService('b1', 'send_raw_command', {
      command: Array.from({ length: 2000 }, (_, i) => 1000 + i),
    })
    const extras = lines.find((l) => l.message.includes('service executed'))?.extras
    expect(JSON.stringify(extras).length).toBeLessThan(900)
  })

  it('refuses an unknown service', async () => {
    const { runner, link } = setup()
    expect(await reasonOf(runner.executeService('b1', 'nope', {}))).toBe('unknown-service')
    expect(link.serviceCalls).toHaveLength(0)
  })

  it('refuses a mismatched argument type', async () => {
    const { runner, link } = setup()
    expect(
      await reasonOf(runner.executeService('b1', 'send_raw_command', { command: [1.5] })),
    ).toBe('bad-argument')
    expect(await reasonOf(runner.executeService('b1', 'send_raw_command', { command: 'x' }))).toBe(
      'bad-argument',
    )
    expect(
      await reasonOf(
        runner.executeService('b1', 'mixed', {
          on: 1,
          level: 2,
          gain: 0.5,
          label: 's',
        }),
      ),
    ).toBe('bad-argument')
    expect(
      await reasonOf(
        runner.executeService('b1', 'mixed', {
          on: true,
          level: 2.5,
          gain: 1,
          label: 's',
        }),
      ),
    ).toBe('bad-argument')
    expect(link.serviceCalls).toHaveLength(0)
  })

  it('refuses a missing or unexpected argument', async () => {
    const { runner } = setup()
    expect(await reasonOf(runner.executeService('b1', 'send_raw_command', {}))).toBe('bad-argument')
    expect(
      await reasonOf(
        runner.executeService('b1', 'send_raw_command', {
          command: [1],
          extra: 1,
        }),
      ),
    ).toBe('bad-argument')
  })

  it('accepts a whole-number float and every scalar type', async () => {
    const { runner, link } = setup()
    await runner.executeService('b1', 'mixed', {
      on: true,
      level: 2,
      gain: 3,
      label: 's',
    })
    expect(link.serviceCalls).toHaveLength(1)
  })

  it('refuses a disconnected board with a reason', async () => {
    const { runner } = setup(false)
    expect(await reasonOf(runner.executeService('b1', 'send_raw_command', { command: [1] }))).toBe(
      'not-connected',
    )
    expect(() => runner.listServices('b1')).toThrow(/not connected/i)
  })
})
