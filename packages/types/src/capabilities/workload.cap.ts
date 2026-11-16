import { z } from 'zod'
import {
  method,
  optionalMethod,
  type CapabilityDefinition,
  type InferProvider,
} from './capability-definition.js'
import { DeviceRole, DeviceType } from '../device/device-type.js'
import { readingMeta } from '../units/quantity.js'
import { t } from '../device/cap-vocabulary/l10n.js'
import { EventCategory } from '../enums/event-category.js'

/**
 * Workload (#585, D1056): ONE capability for everything that runs on a machine
 * and for the machine itself — a VM, an app container, an LXC, an app, a host.
 *
 * There is no `kind` field: the device ROLE is the only discriminator. It picks
 * the wording and icons (`vocabulary.overrides.byRole`) and `deviceRoles` keeps
 * the cap on `workload` devices that carry one of the five roles.
 *
 * What a device can do is declared by its provider through `getOptions`, probed,
 * never assumed: a Docker container has no force stop, a host may offer only a
 * restart. The derived UI shows only what is declared ({@link deriveWorkloadControls}).
 *
 * A value the provider did not report is `null`, never `0` / `false` (D393);
 * `state: null` is unknown, never stopped.
 */

/** The lifecycle of a workload. `crashed` = stopped without a request. */
export const WORKLOAD_STATES = [
  'running',
  'paused',
  'stopped',
  'starting',
  'stopping',
  'crashed',
] as const
export const WorkloadStateSchema = z.enum(WORKLOAD_STATES)
export type WorkloadState = z.infer<typeof WorkloadStateSchema>

/** The five kinds of workload, as roles of the `workload` device type (D1033). */
export const WORKLOAD_ROLES = [
  DeviceRole.Vm,
  DeviceRole.AppContainer,
  DeviceRole.Lxc,
  DeviceRole.App,
  DeviceRole.Host,
] as const satisfies readonly DeviceRole[]

/**
 * What the workload uses. Every value is `null` when not reported (D393). A host
 * fills `load1` and `temperature`; its uptime is `since` while it runs.
 */
export const WorkloadResourcesSchema = z.object({
  /** CPU use, percent of the CPUs it may use (0–100). */
  cpuPercent: z
    .number()
    .nullable()
    .meta(readingMeta('percentage', { precision: 1 })),
  memoryUsedBytes: z.number().nullable().meta(readingMeta('information')),
  /**
   * Memory use, percent of `memoryLimitBytes`, for a source that reports a share
   * and not bytes (a Docker container's stats). Absent or `null` = not reported.
   */
  memoryPercent: z
    .number()
    .nullable()
    .optional()
    .meta(readingMeta('percentage', { precision: 1 })),
  /** The memory it may use: the limit of a container, the RAM of a VM or host. */
  memoryLimitBytes: z.number().nullable().meta(readingMeta('information')),
  vcpus: z.number().nullable().meta(readingMeta('count')),
  diskUsedBytes: z.number().nullable().meta(readingMeta('information')),
  diskTotalBytes: z.number().nullable().meta(readingMeta('information')),
  /** Network received, kbit/s. */
  netRxKbps: z.number().nullable().meta(readingMeta('bitrate')),
  /** Network sent, kbit/s. */
  netTxKbps: z.number().nullable().meta(readingMeta('bitrate')),
  /** One-minute load average (a host). */
  load1: z
    .number()
    .nullable()
    .meta(readingMeta('index', { precision: 2 })),
  /** CPU / board temperature (a host). */
  temperature: z
    .number()
    .nullable()
    .meta(readingMeta('temperature', { precision: 1 })),
})
export type WorkloadResources = z.infer<typeof WorkloadResourcesSchema>

export const WorkloadPortProtocolSchema = z.enum(['tcp', 'udp'])
export type WorkloadPortProtocol = z.infer<typeof WorkloadPortProtocolSchema>

/** One published port: the workload's own port and where the host exposes it. */
export const WorkloadPortSchema = z.object({
  port: z.number().int().meta(readingMeta('none')),
  /** The host port it is published on; null = not published. */
  hostPort: z.number().int().nullable().meta(readingMeta('none')),
  /** The host address it is bound to; null = every address. */
  hostIp: z.string().nullable(),
  protocol: WorkloadPortProtocolSchema,
})
export type WorkloadPort = z.infer<typeof WorkloadPortSchema>

export const WorkloadStatusSchema = z.object({
  /** null = unknown, never stopped (D393). */
  state: WorkloadStateSchema.nullable().meta({ label: 'State' }),
  /** Epoch ms the current state began (uptime while running); null when unknown. */
  since: z.number().nullable().meta(readingMeta('none')),
  /** The `host` device this runs on, when the provider has adopted it. */
  hostDeviceId: z.number().int().nullable().meta(readingMeta('device')),
  /** The image a container runs (`nginx:1.27`). */
  image: z.string().nullable(),
  /** The operating system (a VM, an LXC, a host). */
  os: z.string().nullable(),
  /** The version or firmware it runs. */
  version: z.string().nullable(),
  /** Starts with its host; null when the platform does not say. */
  autostart: z.boolean().nullable(),
  resources: WorkloadResourcesSchema,
  ports: z.array(WorkloadPortSchema),
  /** The addresses it is reachable on (IPs or host names). */
  addresses: z.array(z.string()),
  /** A newer image / version exists. Installing it stays the `update` cap. */
  updateAvailable: z.boolean().nullable(),
  lastFetchedAt: z.number(),
})
export type WorkloadStatus = z.infer<typeof WorkloadStatusSchema>

/**
 * What this device can do, probed by its provider (D14 honesty): a flag is
 * `true` only when the platform really serves it for THIS device.
 */
export const WorkloadOptionsSchema = z.object({
  supportsStart: z.boolean(),
  supportsStop: z.boolean(),
  supportsRestart: z.boolean(),
  /** Pause AND resume. */
  supportsPause: z.boolean(),
  supportsForceStop: z.boolean(),
  hasResources: z.boolean(),
  hasPorts: z.boolean(),
  hasAddresses: z.boolean(),
  hasAutostart: z.boolean(),
  hasUpdateCheck: z.boolean(),
})
export type WorkloadOptions = z.infer<typeof WorkloadOptionsSchema>

const WorkloadDeviceInputSchema = z.object({ deviceId: z.number().int().nonnegative() })

const WorkloadTransitionEventDataSchema = z.object({
  deviceId: z.number(),
  state: WorkloadStateSchema,
  previous: WorkloadStateSchema,
  since: z.number().nullable(),
})
export type WorkloadTransitionEventData = z.infer<typeof WorkloadTransitionEventDataSchema>

// ── Derived UI ───────────────────────────────────────────────────────

export const WORKLOAD_ACTIONS = [
  'start',
  'stop',
  'restart',
  'pause',
  'resume',
  'forceStop',
] as const
export type WorkloadAction = (typeof WORKLOAD_ACTIONS)[number]

/** One control the UI draws: declared by `getOptions`, enabled by the state. */
export interface WorkloadControl {
  readonly action: WorkloadAction
  readonly enabled: boolean
}

/** Which read-only sections the UI draws. */
export interface WorkloadSections {
  readonly resources: boolean
  readonly ports: boolean
  readonly addresses: boolean
  readonly autostart: boolean
  readonly update: boolean
}

export interface WorkloadControls {
  readonly controls: readonly WorkloadControl[]
  readonly sections: WorkloadSections
}

function actionDeclared(options: WorkloadOptions, action: WorkloadAction): boolean {
  switch (action) {
    case 'start':
      return options.supportsStart
    case 'stop':
      return options.supportsStop
    case 'restart':
      return options.supportsRestart
    case 'pause':
    case 'resume':
      return options.supportsPause
    case 'forceStop':
      return options.supportsForceStop
  }
}

/** The states an action makes sense in. Unknown (`null`) allows what is not
 *  state-bound, never pause / resume. */
const ACTION_STATES: Readonly<Record<WorkloadAction, readonly WorkloadState[]>> = {
  start: ['stopped', 'crashed'],
  stop: ['running', 'paused', 'starting'],
  restart: ['running', 'paused'],
  pause: ['running'],
  resume: ['paused'],
  forceStop: ['running', 'paused', 'starting', 'stopping'],
}

function actionEnabled(action: WorkloadAction, state: WorkloadState | null): boolean {
  if (state === null) return action !== 'pause' && action !== 'resume'
  return ACTION_STATES[action].includes(state)
}

/**
 * The controls and sections of a workload, derived from what its provider
 * declared and the state it is in. An undeclared feature is absent — never a
 * disabled button that could never work.
 */
export function deriveWorkloadControls(
  options: WorkloadOptions,
  state: WorkloadState | null,
): WorkloadControls {
  const controls = WORKLOAD_ACTIONS.filter((action) => actionDeclared(options, action)).map(
    (action) => ({ action, enabled: actionEnabled(action, state) }),
  )
  return {
    controls,
    sections: {
      resources: options.hasResources,
      ports: options.hasPorts,
      addresses: options.hasAddresses,
      autostart: options.hasAutostart,
      update: options.hasUpdateCheck,
    },
  }
}

// ── Transitions (the events) ─────────────────────────────────────────

/** The settled states a transition is judged between; `starting` / `stopping`
 *  are on the way and never the "previous" of an event. */
export type WorkloadSettledState = Exclude<WorkloadState, 'starting' | 'stopping'>

export type WorkloadTransitionKind = 'started' | 'stopped' | 'crashed' | 'recovered'

export function isWorkloadSettled(state: WorkloadState): state is WorkloadSettledState {
  return state !== 'starting' && state !== 'stopping'
}

/**
 * The event a move from the last SETTLED state to `next` raises, or null.
 * A first sight (`previous` undefined) raises nothing: it is not a change.
 * Unknown (`next` null) raises nothing and is not remembered.
 */
export function workloadTransition(
  previous: WorkloadSettledState | undefined,
  next: WorkloadState | null,
): WorkloadTransitionKind | null {
  if (previous === undefined || next === null || next === previous) return null
  switch (next) {
    case 'running':
      if (previous === 'crashed') return 'recovered'
      return previous === 'stopped' ? 'started' : null
    case 'stopped':
      return previous === 'running' || previous === 'paused' ? 'stopped' : null
    case 'crashed':
      return 'crashed'
    case 'paused':
    case 'starting':
    case 'stopping':
      return null
  }
}

/** The bus category of each transition. */
export const WORKLOAD_TRANSITION_CATEGORY: Readonly<Record<WorkloadTransitionKind, EventCategory>> =
  {
    started: EventCategory.WorkloadStarted,
    stopped: EventCategory.WorkloadStopped,
    crashed: EventCategory.WorkloadCrashed,
    recovered: EventCategory.WorkloadRecovered,
  }

// ── The capability ───────────────────────────────────────────────────

export const workloadCapability = {
  name: 'workload',
  scope: 'device',
  deviceNative: true,
  mode: 'singleton',
  deviceTypes: [DeviceType.Workload],
  deviceRoles: { [DeviceType.Workload]: WORKLOAD_ROLES },
  /**
   * On / off is the state (#462): stopped or crashed is off, anything else on.
   * The owner registers `switch` through `registerPowerSwitch`; there is no
   * second on/off state. A device whose provider serves no start / stop gets no
   * switch.
   */
  power: {
    kind: 'methods',
    field: 'state',
    offValues: ['stopped', 'crashed'],
    on: 'start',
    off: 'stop',
  },
  methods: {
    start: optionalMethod(WorkloadDeviceInputSchema, z.void(), {
      kind: 'mutation',
      auth: 'protected',
      actions: [
        {
          id: 'workload.start',
          label: t('Start', 'Avvia'),
          phrase: t('Start {device}', 'Avvia {device}'),
          icon: 'play',
          effect: { field: 'state', value: 'running' },
        },
      ],
    }),
    stop: optionalMethod(WorkloadDeviceInputSchema, z.void(), {
      kind: 'mutation',
      auth: 'protected',
      actions: [
        {
          id: 'workload.stop',
          label: t('Stop', 'Arresta'),
          phrase: t('Stop {device}', 'Arresta {device}'),
          icon: 'square',
          effect: { field: 'state', value: 'stopped' },
        },
      ],
    }),
    restart: optionalMethod(WorkloadDeviceInputSchema, z.void(), {
      kind: 'mutation',
      auth: 'admin',
      actions: [
        {
          id: 'workload.restart',
          label: t('Restart', 'Riavvia'),
          phrase: t('Restart {device}', 'Riavvia {device}'),
          icon: 'rotate-ccw',
        },
      ],
    }),
    pause: optionalMethod(WorkloadDeviceInputSchema, z.void(), {
      kind: 'mutation',
      auth: 'protected',
      actions: [
        {
          id: 'workload.pause',
          label: t('Pause', 'Metti in pausa'),
          phrase: t('Pause {device}', 'Metti in pausa {device}'),
          icon: 'pause',
          effect: { field: 'state', value: 'paused' },
        },
      ],
    }),
    resume: optionalMethod(WorkloadDeviceInputSchema, z.void(), {
      kind: 'mutation',
      auth: 'protected',
      actions: [
        {
          id: 'workload.resume',
          label: t('Resume', 'Riprendi'),
          phrase: t('Resume {device}', 'Riprendi {device}'),
          icon: 'circle-play',
          effect: { field: 'state', value: 'running' },
        },
      ],
    }),
    forceStop: optionalMethod(WorkloadDeviceInputSchema, z.void(), {
      kind: 'mutation',
      auth: 'admin',
      actions: [
        {
          id: 'workload.forceStop',
          label: t('Force stop', 'Arresto forzato'),
          phrase: t('Force {device} to stop', 'Forza l’arresto di {device}'),
          icon: 'octagon-x',
          effect: { field: 'state', value: 'stopped' },
        },
      ],
    }),
    /** What THIS device can do, probed — the UI is derived from it. */
    getOptions: method(WorkloadDeviceInputSchema, WorkloadOptionsSchema, {
      auth: 'protected',
    }),
  },
  events: {
    onStarted: {
      data: WorkloadTransitionEventDataSchema,
      trigger: {
        category: EventCategory.WorkloadStarted,
        label: t('Started', 'Avviato'),
        phrase: t('When {device} starts', 'Quando {device} si avvia'),
        icon: 'play',
      },
    },
    onStopped: {
      data: WorkloadTransitionEventDataSchema,
      trigger: {
        category: EventCategory.WorkloadStopped,
        label: t('Stopped', 'Arrestato'),
        phrase: t('When {device} stops', 'Quando {device} si arresta'),
        icon: 'square',
      },
    },
    onCrashed: {
      data: WorkloadTransitionEventDataSchema,
      trigger: {
        category: EventCategory.WorkloadCrashed,
        label: t('Crashed', 'Arrestato in modo anomalo'),
        phrase: t(
          'When {device} stops without being asked',
          'Quando {device} si arresta senza che sia stato richiesto',
        ),
        icon: 'triangle-alert',
      },
    },
    onRecovered: {
      data: WorkloadTransitionEventDataSchema,
      trigger: {
        category: EventCategory.WorkloadRecovered,
        label: t('Recovered', 'Ripristinato'),
        phrase: t(
          'When {device} runs again after a crash',
          'Quando {device} riparte dopo un arresto anomalo',
        ),
        icon: 'heart-pulse',
      },
    },
  },
  status: {
    schema: WorkloadStatusSchema,
    kind: 'poll',
  },
  runtimeState: WorkloadStatusSchema,
  /**
   * Runtime-state durability: **session** — the provider answers on its next
   * poll; the series are recorded, so a restart that clears the slice loses
   * nothing a reader needs. The events are judged from the first state seen.
   */
  durability: 'session',
  /**
   * History (D850): the state as an enum, CPU / memory / network as gauges, so
   * the charts need no per-metric child device.
   */
  history: {
    primary: 'resources.cpuPercent',
    priority: 40,
    fields: {
      state: { kind: 'enum' },
      'resources.cpuPercent': {
        kind: 'gauge',
        unit: '%',
        deadband: 2,
        displayName: 'CPU',
      },
      'resources.memoryUsedBytes': {
        kind: 'gauge',
        unit: 'bytes',
        displayName: 'Memory used',
      },
      'resources.memoryPercent': {
        kind: 'gauge',
        unit: '%',
        deadband: 2,
        displayName: 'Memory',
      },
      'resources.netRxKbps': {
        group: 'network',
        kind: 'gauge',
        unit: 'kbps',
        displayName: 'Network received',
      },
      'resources.netTxKbps': {
        group: 'network',
        kind: 'gauge',
        unit: 'kbps',
        displayName: 'Network sent',
      },
    },
  },
  volatileStateFields: ['lastFetchedAt'],
  vocabulary: {
    noun: t('Workload', 'Carico di lavoro'),
    order: 2400,
    state: [
      {
        kind: 'enum',
        field: 'state',
        label: t('State', 'Stato'),
        values: [
          {
            value: 'running',
            label: t('Running', 'In esecuzione'),
            phrase: t('When {device} is running', 'Quando {device} è in esecuzione'),
          },
          { value: 'paused', label: t('Paused', 'In pausa') },
          {
            value: 'stopped',
            label: t('Stopped', 'Arrestato'),
            phrase: t('When {device} is stopped', 'Quando {device} è arrestato'),
          },
          { value: 'starting', label: t('Starting', 'In avvio') },
          { value: 'stopping', label: t('Stopping', 'In arresto') },
          {
            value: 'crashed',
            label: t('Crashed', 'Arrestato in modo anomalo'),
            phrase: t('When {device} has crashed', 'Quando {device} è arrestato in modo anomalo'),
          },
        ],
        icon: 'activity',
      },
    ],
    overrides: {
      byRole: {
        [DeviceRole.Vm]: {
          actions: { 'workload.start': { icon: 'monitor' } },
          state: { state: { icon: 'monitor' } },
        },
        [DeviceRole.AppContainer]: {
          actions: { 'workload.start': { icon: 'container' } },
          state: { state: { icon: 'container' } },
        },
        [DeviceRole.Lxc]: {
          actions: { 'workload.start': { icon: 'box' } },
          state: { state: { icon: 'box' } },
        },
        [DeviceRole.App]: {
          actions: { 'workload.start': { icon: 'app-window' } },
          state: { state: { icon: 'app-window' } },
        },
        [DeviceRole.Host]: {
          actions: {
            'workload.start': {
              label: t('Power on', 'Accendi'),
              phrase: t('Power on {device}', 'Accendi {device}'),
              icon: 'power',
            },
            'workload.stop': {
              label: t('Shut down', 'Spegni'),
              phrase: t('Shut down {device}', 'Spegni {device}'),
              icon: 'power-off',
            },
            'workload.restart': {
              label: t('Reboot', 'Riavvia'),
              phrase: t('Reboot {device}', 'Riavvia {device}'),
              icon: 'refresh-cw',
            },
          },
          state: { state: { icon: 'server' } },
          events: {
            onStarted: {
              label: t('Came online', 'Tornato in linea'),
              phrase: t('When {device} comes online', 'Quando {device} torna in linea'),
              icon: 'server',
            },
            onStopped: {
              label: t('Shut down', 'Spento'),
              phrase: t('When {device} shuts down', 'Quando {device} si spegne'),
              icon: 'server-off',
            },
            onCrashed: {
              label: t('Went down', 'Caduto'),
              phrase: t(
                'When {device} goes down unexpectedly',
                'Quando {device} cade inaspettatamente',
              ),
              icon: 'server-crash',
            },
          },
        },
      },
    },
  },
} as const satisfies CapabilityDefinition

export type IWorkloadProvider = InferProvider<typeof workloadCapability>
