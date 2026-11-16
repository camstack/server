import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import {
  WorkloadOptionsSchema,
  WorkloadStatusSchema,
  deriveWorkloadControls,
  workloadCapability,
  workloadTransition,
  type IWorkloadProvider,
  type WorkloadOptions,
  type WorkloadStatus,
} from '../workload.cap.js'
import { switchCapability } from '../switch.cap.js'
import { resolveMethodAuth } from '../cap-router-predicates.js'
import type { CapabilityDefinition, CapabilityMethodAuth } from '../capability-definition.js'
import { CAP_VOCABULARY } from '../../generated/cap-vocabulary.js'
import { capUnitResolver } from '../../automation/normalize-units.js'
import type { CapNestedNumericPath } from '../../device/cap-vocabulary/types.js'
import { DeviceRole, DeviceType } from '../../device/device-type.js'
import { capAppliesToDeviceKind } from '../../device/device-kind.js'
import { DeviceRuntimeState } from '../../device/device-runtime-state.js'
import { buildPowerSwitch, powerServedBy, type PowerSwitchHost } from '../../device/power-switch.js'

const DEVICE_ID = 7

const NOTHING: WorkloadOptions = {
  supportsStart: false,
  supportsStop: false,
  supportsRestart: false,
  supportsPause: false,
  supportsForceStop: false,
  hasResources: false,
  hasPorts: false,
  hasAddresses: false,
  hasAutostart: false,
  hasUpdateCheck: false,
}

/** A Docker container as a provider would declare it: no force stop. */
const DOCKER: WorkloadOptions = {
  ...NOTHING,
  supportsStart: true,
  supportsStop: true,
  supportsRestart: true,
  supportsPause: true,
  hasResources: true,
  hasPorts: true,
  hasAutostart: true,
  hasUpdateCheck: true,
}

function status(patch: Partial<WorkloadStatus>): WorkloadStatus {
  return {
    state: null,
    since: null,
    hostDeviceId: null,
    image: null,
    os: null,
    version: null,
    autostart: null,
    resources: {
      cpuPercent: null,
      memoryUsedBytes: null,
      memoryLimitBytes: null,
      vcpus: null,
      diskUsedBytes: null,
      diskTotalBytes: null,
      netRxKbps: null,
      netTxKbps: null,
      load1: null,
      temperature: null,
    },
    ports: [],
    addresses: [],
    updateAvailable: null,
    lastFetchedAt: 1,
    ...patch,
  }
}

/** A fake provider: what Unraid / UniFi / CCU will implement, minus the I/O. */
function fakeProvider(options: WorkloadOptions): {
  readonly provider: IWorkloadProvider
  readonly calls: string[]
} {
  const calls: string[] = []
  const record = (name: string) => async (): Promise<void> => {
    calls.push(name)
  }
  const provider: IWorkloadProvider = {
    getStatus: async () => status({ state: 'running' }),
    getOptions: async () => options,
    ...(options.supportsStart ? { start: record('start') } : {}),
    ...(options.supportsStop ? { stop: record('stop') } : {}),
    ...(options.supportsRestart ? { restart: record('restart') } : {}),
  }
  return { provider, calls }
}

describe('workload cap — schema', () => {
  it('has no kind field: the role is the only discriminator (D4, D1056)', () => {
    const keys = (schema: z.ZodObject) => Object.keys(schema.shape)
    expect(keys(WorkloadStatusSchema)).not.toContain('kind')
    expect(keys(WorkloadOptionsSchema)).not.toContain('kind')
    expect(keys(WorkloadStatusSchema.shape.resources)).not.toContain('kind')
  })

  it('accepts an unknown state and unreported resources as null, never 0 / stopped (D393)', () => {
    const parsed = WorkloadStatusSchema.parse(status({}))
    expect(parsed.state).toBeNull()
    expect(parsed.resources.cpuPercent).toBeNull()
    expect(parsed.autostart).toBeNull()
  })

  it('carries memory as a percentage of the limit when bytes are not reported', () => {
    const meta = WorkloadStatusSchema.shape.resources.shape.memoryPercent.meta()
    expect(meta?.['quantity']).toBe('percentage')
    const parsed = WorkloadStatusSchema.parse(
      status({ resources: { ...status({}).resources, memoryPercent: 7 } }),
    )
    expect(parsed.resources.memoryPercent).toBe(7)
    expect(workloadCapability.history?.fields['resources.memoryPercent']?.kind).toBe('gauge')
  })

  it('refuses a state outside the lifecycle', () => {
    expect(WorkloadStatusSchema.safeParse({ ...status({}), state: 'exited' }).success).toBe(false)
  })

  it('carries a host reading (load, temperature) in the same schema', () => {
    const host = status({
      state: 'running',
      since: 1_000,
      resources: { ...status({}).resources, load1: 0.42, temperature: 51 },
    })
    expect(WorkloadStatusSchema.parse(host).resources.load1).toBe(0.42)
  })
})

describe('workload cap — roles narrow it (D1033)', () => {
  it('is offered on a workload device carrying one of the five roles', () => {
    for (const role of [
      DeviceRole.Vm,
      DeviceRole.AppContainer,
      DeviceRole.Lxc,
      DeviceRole.App,
      DeviceRole.Host,
    ]) {
      expect(capAppliesToDeviceKind(workloadCapability, DeviceType.Workload, role)).toBe(true)
    }
  })

  it('is not offered on a role-less workload, a foreign role, or another type', () => {
    expect(capAppliesToDeviceKind(workloadCapability, DeviceType.Workload, null)).toBe(false)
    expect(capAppliesToDeviceKind(workloadCapability, DeviceType.Workload, DeviceRole.Outlet)).toBe(
      false,
    )
    expect(capAppliesToDeviceKind(workloadCapability, DeviceType.Switch, DeviceRole.Host)).toBe(
      false,
    )
  })

  it('words a host restart as a reboot, by role', () => {
    const host = workloadCapability.vocabulary.overrides.byRole[DeviceRole.Host]
    expect(host.actions['workload.restart'].label.en).toBe('Reboot')
    expect(host.actions['workload.restart'].label.it).toBe('Riavvia')
  })

  it('words a host that answers again after going down as back online, not a crash recovery', () => {
    const host = workloadCapability.vocabulary.overrides.byRole[DeviceRole.Host]
    expect(host.events.onCrashed.label.en).toBe('Went down')
    expect(host.events.onRecovered.label.en).toBe('Back online')
    expect(host.events.onRecovered.label.it).toBe('Di nuovo in linea')
  })
})

describe('workload cap — the UI is derived from getOptions', () => {
  it('draws nothing a provider did not declare', () => {
    const derived = deriveWorkloadControls(NOTHING, 'running')
    expect(derived.controls).toEqual([])
    expect(Object.values(derived.sections).every((shown) => !shown)).toBe(true)
  })

  it('a Docker container: no force stop, pause and resume from one flag', () => {
    const derived = deriveWorkloadControls(DOCKER, 'running')
    expect(derived.controls.map((c) => c.action)).toEqual([
      'start',
      'stop',
      'restart',
      'pause',
      'resume',
    ])
    expect(derived.sections).toEqual({
      resources: true,
      ports: true,
      addresses: false,
      autostart: true,
      update: true,
    })
  })

  it('a host that offers only a restart shows only a restart', () => {
    const derived = deriveWorkloadControls({ ...NOTHING, supportsRestart: true }, 'running')
    expect(derived.controls).toEqual([{ action: 'restart', enabled: true }])
  })

  it('enables what the state allows', () => {
    const enabled = (state: Parameters<typeof deriveWorkloadControls>[1]) =>
      deriveWorkloadControls({ ...DOCKER, supportsForceStop: true }, state)
        .controls.filter((c) => c.enabled)
        .map((c) => c.action)
    expect(enabled('stopped')).toEqual(['start'])
    expect(enabled('crashed')).toEqual(['start'])
    expect(enabled('running')).toEqual(['stop', 'restart', 'pause', 'forceStop'])
    expect(enabled('paused')).toEqual(['stop', 'restart', 'resume', 'forceStop'])
    expect(enabled('stopping')).toEqual(['forceStop'])
    // Unknown: nothing state-bound is guessed, the rest stays reachable.
    expect(enabled(null)).toEqual(['start', 'stop', 'restart', 'forceStop'])
  })
})

describe('workload cap — the power hint derives the switch from state (#462)', () => {
  function harness(): { readonly host: PowerSwitchHost; readonly state: DeviceRuntimeState } {
    const state = DeviceRuntimeState.fromInitial({}, async () => {})
    state.installCapSchema(switchCapability.name, switchCapability.runtimeState)
    state.installCapSchema(workloadCapability.name, z.object({}).loose())
    const host: PowerSwitchHost = {
      deviceId: DEVICE_ID,
      runtimeState: state,
      registerNativeCap: vi.fn(),
      readHubSlice: async () => null,
    }
    return { host, state }
  }

  it('stopped and crashed are off, running / paused / starting / stopping on, unknown null', async () => {
    const { host, state } = harness()
    const { provider } = fakeProvider(DOCKER)
    const built = buildPowerSwitch(host, workloadCapability, provider)
    const on = async (value: WorkloadStatus['state']): Promise<boolean | null> => {
      state.setCapState(workloadCapability.name, { state: value })
      const read = built.provider.getStatus
      if (read === undefined) throw new Error('the switch serves no getStatus')
      const switchStatus = await read({ deviceId: DEVICE_ID })
      return switchStatus === null ? null : switchStatus.on
    }
    expect(await on('stopped')).toBe(false)
    expect(await on('crashed')).toBe(false)
    expect(await on('running')).toBe(true)
    expect(await on('paused')).toBe(true)
    expect(await on('starting')).toBe(true)
    expect(await on('stopping')).toBe(true)
    expect(await on(null)).toBeNull()
    built.dispose()
  })

  it('switch on / off calls start / stop on the owner', async () => {
    const { host } = harness()
    const { provider, calls } = fakeProvider(DOCKER)
    const built = buildPowerSwitch(host, workloadCapability, provider)
    await built.provider.setState({ deviceId: DEVICE_ID, on: true })
    await built.provider.setState({ deviceId: DEVICE_ID, on: false })
    expect(calls).toEqual(['start', 'stop'])
    built.dispose()
  })

  it('a provider without start / stop (a restart-only host) gets no switch', () => {
    const { provider } = fakeProvider({ ...NOTHING, supportsRestart: true })
    expect(powerServedBy(workloadCapability.power, provider)).toBe(false)
  })
})

describe('workload cap — transitions raise the events', () => {
  it('a first sight is not a change', () => {
    expect(workloadTransition(undefined, 'running')).toBeNull()
    expect(workloadTransition(undefined, 'crashed')).toBeNull()
  })

  it('stopped → running is started, crashed → running is recovered', () => {
    expect(workloadTransition('stopped', 'running')).toBe('started')
    expect(workloadTransition('crashed', 'running')).toBe('recovered')
  })

  it('running or paused → stopped is stopped; anything → crashed is crashed', () => {
    expect(workloadTransition('running', 'stopped')).toBe('stopped')
    expect(workloadTransition('paused', 'stopped')).toBe('stopped')
    expect(workloadTransition('running', 'crashed')).toBe('crashed')
    expect(workloadTransition('stopped', 'crashed')).toBe('crashed')
  })

  it('pause, resume, transitional and unknown states raise nothing', () => {
    expect(workloadTransition('running', 'paused')).toBeNull()
    expect(workloadTransition('paused', 'running')).toBeNull()
    expect(workloadTransition('running', 'stopping')).toBeNull()
    expect(workloadTransition('running', null)).toBeNull()
    expect(workloadTransition('crashed', 'crashed')).toBeNull()
  })
})

describe('workload cap — resource thresholds are rule triggers (D1056)', () => {
  it('offers CPU, memory and temperature as numeric triggers on their nested paths', () => {
    const numeric = (CAP_VOCABULARY.workload.state ?? [])
      .filter((trigger) => trigger.kind === 'numeric')
      .map((trigger) => trigger.field)
    expect(numeric).toEqual([
      'resources.cpuPercent',
      'resources.memoryPercent',
      'resources.temperature',
    ])
  })

  it('types a nested number as a trigger path, never an array item or a string', () => {
    const cpu: CapNestedNumericPath<'workload'> = 'resources.cpuPercent'
    // @ts-expect-error — `ports` is an array: no dotted path into it.
    const port: CapNestedNumericPath<'workload'> = 'ports.port'
    expect([cpu, port]).toHaveLength(2)
  })

  it('resolves each threshold field to its quantity, so a rule converts the unit', () => {
    const units = capUnitResolver([workloadCapability])
    expect(units.fieldQuantity('workload', 'resources.cpuPercent')).toBe('percentage')
    expect(units.fieldQuantity('workload', 'resources.temperature')).toBe('temperature')
  })
})

describe('workload cap — one tier per kind of act', () => {
  // The router reads a cap through its general definition, as codegen does.
  const workloadDef: CapabilityDefinition = workloadCapability
  const switchDef: CapabilityDefinition = switchCapability
  it('starting, stopping, restarting, pausing and resuming are protected, like the derived switch', () => {
    const { methods } = workloadCapability
    const tierOf = (m: { readonly auth?: CapabilityMethodAuth }) =>
      resolveMethodAuth(workloadDef, m)
    expect(
      [methods.start, methods.stop, methods.restart, methods.pause, methods.resume].map(tierOf),
    ).toEqual(['protected', 'protected', 'protected', 'protected', 'protected'])
    expect(resolveMethodAuth(switchDef, switchCapability.methods.setState)).toBe('protected')
  })

  it('a force stop, which can lose data, is admin', () => {
    expect(resolveMethodAuth(workloadDef, workloadCapability.methods.forceStop)).toBe('admin')
  })
})
