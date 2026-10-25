import type { AddonApi, AddonContext, IScopedLogger } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import type { VerifiedDirectiveIdentity } from '../directive-router.js'
import { handleArm, handleDisarm, type SecurityPanelContext } from '../handlers/security-panel.js'
import type { DirectiveHeader } from '../handlers/types.js'

const header = (name: 'Arm' | 'Disarm'): DirectiveHeader => ({
  namespace: 'Alexa.SecurityPanelController',
  name,
  messageId: 'msg-1',
  correlationToken: 'corr-1',
  payloadVersion: '3',
})

const identity: VerifiedDirectiveIdentity = { userId: 'u', username: 'u', scopes: [] }

interface LogLine {
  readonly level: string
  readonly message: string
  readonly tags: Record<string, unknown>
}

interface Calls {
  readonly arm: Array<{ deviceId: number; mode: string; code?: string }>
  readonly disarm: Array<{ deviceId: number; code?: string }>
}

interface PanelStatus {
  readonly state: string
  readonly availableModes: readonly string[]
  readonly requiresCode: boolean
  readonly lastChangedAt: number
}

interface HarnessOpts {
  readonly status?: PanelStatus | null
  /** Status reads after the command — defaults to the same status. */
  readonly statusAfter?: PanelStatus | null
  readonly failStatus?: boolean
  readonly failCommand?: boolean
}

function harness(opts: HarnessOpts = {}) {
  const logs: LogLine[] = []
  const calls: Calls = { arm: [], disarm: [] }
  let reads = 0
  const status = opts.status ?? {
    state: 'disarmed',
    availableModes: ['home', 'away', 'night'],
    requiresCode: false,
    lastChangedAt: 1,
  }
  const record =
    (level: string) =>
    (message: string, extra?: { tags?: Record<string, unknown> }): void => {
      logs.push({ level, message, tags: extra?.tags ?? {} })
    }
  // Documented type boundary: the addon-facing `AddonApi` / `IScopedLogger`
  // surfaces are enormous and this suite exercises two methods of one cap.
  const logger = {
    info: record('info'),
    warn: record('warn'),
    debug: record('debug'),
    error: record('error'),
    withTags: () => logger,
  } as unknown as IScopedLogger
  const api = {
    alarmPanel: {
      getStatus: {
        query: async () => {
          reads += 1
          if (opts.failStatus === true) throw new Error('provider not available')
          return reads === 1 ? status : (opts.statusAfter ?? status)
        },
      },
      arm: {
        mutate: async (input: { deviceId: number; mode: string; code?: string }) => {
          if (opts.failCommand === true) throw new Error('panel refused')
          calls.arm.push(input)
        },
      },
      disarm: {
        mutate: async (input: { deviceId: number; code?: string }) => {
          if (opts.failCommand === true) throw new Error('panel refused')
          calls.disarm.push(input)
        },
      },
    },
  } as unknown as AddonApi
  const deps: SecurityPanelContext = {
    ctx: { api } as unknown as AddonContext,
    logger,
  }
  return { deps, logs, calls }
}

const endpoint = (id = '102__alarm'): unknown => ({
  endpointId: id,
  scope: { type: 'BearerToken', token: 't' },
})

function errorType(body: unknown): string | undefined {
  const payload = (body as { event?: { payload?: { type?: string } } }).event?.payload
  return payload?.type
}

function errorNamespace(body: unknown): string | undefined {
  return (body as { event?: { header?: { namespace?: string } } }).event?.header?.namespace
}

function armStateOf(body: unknown): unknown {
  const props = (body as { context?: { properties?: Array<{ name: string; value: unknown }> } })
    .context?.properties
  return props?.find((p) => p.name === 'armState')?.value
}

describe('Arm', () => {
  it('arms the panel with the mode behind Alexa’s arm state', async () => {
    const h = harness()
    await handleArm(header('Arm'), endpoint(), { armState: 'ARMED_AWAY' }, h.deps, identity)
    expect(h.calls.arm).toEqual([{ deviceId: 102, mode: 'away' }])
  })

  it('sends the mode the PANEL takes when the primary is not available', async () => {
    const h = harness({
      status: {
        state: 'disarmed',
        availableModes: ['custom_bypass'],
        requiresCode: false,
        lastChangedAt: 1,
      },
    })
    await handleArm(header('Arm'), endpoint(), { armState: 'ARMED_STAY' }, h.deps, identity)
    expect(h.calls.arm).toEqual([{ deviceId: 102, mode: 'custom_bypass' }])
  })

  it('REFUSES an arm state the panel accepts no mode for, and says so', async () => {
    const h = harness({
      status: {
        state: 'disarmed',
        availableModes: ['away'],
        requiresCode: false,
        lastChangedAt: 1,
      },
    })
    const body = await handleArm(
      header('Arm'),
      endpoint(),
      { armState: 'ARMED_NIGHT' },
      h.deps,
      identity,
    )
    expect(h.calls.arm).toEqual([])
    expect(errorType(body)).toBe('NOT_READY_FOR_ARM')
    expect(errorNamespace(body)).toBe('Alexa.SecurityPanelController')
    const warn = h.logs.find((l) => l.level === 'warn')
    expect(warn?.tags.deviceId).toBe(102)
  })

  it('REFUSES to arm a panel that requires a PIN — Alexa’s Arm carries none', async () => {
    // Alexa's Arm directive has no authorization field. Attempting the arm
    // code-less would be a guaranteed refusal from the panel, indistinguishable
    // in the log from a broken panel, so it is refused here with the error
    // Alexa defines for exactly this and a WARN naming the device.
    const h = harness({
      status: {
        state: 'disarmed',
        availableModes: ['away'],
        requiresCode: true,
        lastChangedAt: 1,
      },
    })
    const body = await handleArm(
      header('Arm'),
      endpoint(),
      { armState: 'ARMED_AWAY' },
      h.deps,
      identity,
    )
    expect(h.calls.arm).toEqual([])
    expect(errorType(body)).toBe('AUTHORIZATION_REQUIRED')
    const warn = h.logs.find((l) => l.level === 'warn')
    expect(warn?.message).toMatch(/PIN/i)
    expect(warn?.tags.deviceId).toBe(102)
  })

  it('reports what the panel SAYS afterwards, not what was asked for', async () => {
    // A panel in its exit delay is not armed. `arming` → DISARMED is the same
    // refusal the HomeKit mapping makes, and an INFO says why Alexa will show
    // the panel as off for the length of the delay.
    const h = harness({
      statusAfter: {
        state: 'arming',
        availableModes: ['away'],
        requiresCode: false,
        lastChangedAt: 2,
      },
    })
    const body = await handleArm(
      header('Arm'),
      endpoint(),
      { armState: 'ARMED_AWAY' },
      h.deps,
      identity,
    )
    expect(armStateOf(body)).toBe('DISARMED')
    expect(h.logs.some((l) => l.message.includes('exit delay'))).toBe(true)
  })

  it('surfaces a panel that refused the command instead of claiming success', async () => {
    const h = harness({ failCommand: true })
    const body = await handleArm(
      header('Arm'),
      endpoint(),
      { armState: 'ARMED_AWAY' },
      h.deps,
      identity,
    )
    expect(errorType(body)).toBe('NOT_READY_FOR_ARM')
    expect(h.logs.some((l) => l.level === 'warn')).toBe(true)
  })

  it('rejects an endpoint that is not an alarm panel', async () => {
    const h = harness()
    const body = await handleArm(
      header('Arm'),
      endpoint('102'),
      { armState: 'ARMED_AWAY' },
      h.deps,
      identity,
    )
    expect(errorType(body)).toBe('INVALID_DIRECTIVE')
    expect(h.calls.arm).toEqual([])
  })

  it('rejects an arm state Alexa never defines', async () => {
    const h = harness()
    const body = await handleArm(
      header('Arm'),
      endpoint(),
      { armState: 'ARMED_VACATION' },
      h.deps,
      identity,
    )
    expect(errorType(body)).toBe('INVALID_DIRECTIVE')
    expect(h.calls.arm).toEqual([])
  })

  it('still arms when the panel’s status cannot be read — unknown is not "no modes"', async () => {
    const h = harness({ failStatus: true })
    await handleArm(header('Arm'), endpoint(), { armState: 'ARMED_AWAY' }, h.deps, identity)
    expect(h.calls.arm).toEqual([{ deviceId: 102, mode: 'away' }])
    expect(h.logs.some((l) => l.level === 'warn' && l.tags.deviceId === 102)).toBe(true)
  })
})

describe('Disarm', () => {
  it('passes the PIN Alexa collected straight through to the panel', async () => {
    const h = harness({
      status: {
        state: 'armed_away',
        availableModes: ['away'],
        requiresCode: true,
        lastChangedAt: 1,
      },
      statusAfter: {
        state: 'disarmed',
        availableModes: ['away'],
        requiresCode: true,
        lastChangedAt: 2,
      },
    })
    const body = await handleDisarm(
      header('Disarm'),
      endpoint(),
      { authorization: { type: 'FOUR_DIGIT_PIN', value: '1234' } },
      h.deps,
      identity,
    )
    expect(h.calls.disarm).toEqual([{ deviceId: 102, code: '1234' }])
    expect(armStateOf(body)).toBe('DISARMED')
  })

  it('asks Alexa for the PIN when the panel needs one and none came', async () => {
    const h = harness({
      status: {
        state: 'armed_away',
        availableModes: ['away'],
        requiresCode: true,
        lastChangedAt: 1,
      },
    })
    const body = await handleDisarm(header('Disarm'), endpoint(), {}, h.deps, identity)
    expect(h.calls.disarm).toEqual([])
    expect(errorType(body)).toBe('AUTHORIZATION_REQUIRED')
    expect(h.logs.find((l) => l.level === 'warn')?.tags.deviceId).toBe(102)
  })

  it('disarms without a code when the panel does not require one', async () => {
    const h = harness({
      status: {
        state: 'armed_away',
        availableModes: ['away'],
        requiresCode: false,
        lastChangedAt: 1,
      },
    })
    await handleDisarm(header('Disarm'), endpoint(), {}, h.deps, identity)
    expect(h.calls.disarm).toEqual([{ deviceId: 102 }])
  })

  it('calls a refused disarm that CARRIED a code UNAUTHORIZED so Alexa re-prompts', async () => {
    const h = harness({
      status: {
        state: 'armed_away',
        availableModes: ['away'],
        requiresCode: true,
        lastChangedAt: 1,
      },
      failCommand: true,
    })
    const body = await handleDisarm(
      header('Disarm'),
      endpoint(),
      { authorization: { type: 'FOUR_DIGIT_PIN', value: '0000' } },
      h.deps,
      identity,
    )
    expect(errorType(body)).toBe('UNAUTHORIZED')
  })

  it('does NOT blame the PIN for a failure where no PIN was involved', async () => {
    const h = harness({ failCommand: true })
    const body = await handleDisarm(header('Disarm'), endpoint(), {}, h.deps, identity)
    expect(errorType(body)).toBe('INTERNAL_ERROR')
    expect(errorNamespace(body)).toBe('Alexa')
  })

  it('never logs the PIN', async () => {
    const h = harness({
      status: {
        state: 'armed_away',
        availableModes: ['away'],
        requiresCode: true,
        lastChangedAt: 1,
      },
      failCommand: true,
    })
    await handleDisarm(
      header('Disarm'),
      endpoint(),
      { authorization: { type: 'FOUR_DIGIT_PIN', value: '9137' } },
      h.deps,
      identity,
    )
    expect(JSON.stringify(h.logs)).not.toContain('9137')
  })
})
