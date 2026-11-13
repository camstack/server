import { z } from 'zod'
import { method, type CapabilityDefinition, type InferProvider } from './capability-definition.js'
import { DeviceType } from '../device/device-type.js'
import { readingMeta } from '../units/quantity.js'
import { t } from '../device/cap-vocabulary/l10n.js'

/**
 * Smart-dishwasher cap — program lifecycle, door / remote-start gates and
 * common program options. Salt and rinse aid are NOT here: they are items of
 * the device's `consumables` cap, like every other device's (D915).
 *
 * Sources: native Bosch Home Connect (`dishwasher` device type). Reusable
 * by any integration that exposes the same program / option surface.
 *
 * `kind: 'poll'` — cloud REST APIs typically have no push channel; the
 * provider refreshes the slice on an interval and eagerly after commands.
 *
 * UNKNOWN IS NOT OFF. Every field the appliance reports separately is
 * nullable: `null` means "not known right now" (the appliance has not said,
 * the link is down, or the description does not carry it) and is never
 * rendered or exported as `false` / `0`. `availability` says why.
 */

export const DishwasherStateSchema = z.enum([
  'idle',
  'running',
  'paused',
  'finished',
  'error',
  'unavailable',
])
export type DishwasherState = z.infer<typeof DishwasherStateSchema>

/**
 * The appliance's own operation state, uncollapsed. `state` above is the coarse
 * view for compact surfaces; this is what the appliance said.
 */
export const DishwasherOperationStateSchema = z.enum([
  'Inactive',
  'Ready',
  'DelayedStart',
  'Run',
  'Pause',
  'ActionRequired',
  'Finished',
  'Error',
  'Aborting',
])
export type DishwasherOperationState = z.infer<typeof DishwasherOperationStateSchema>

/**
 * Why fields may be `null`:
 *  - `available`           — the link is up and the description is loaded;
 *  - `offline`             — the local link is down (values are unknown, not last-known);
 *  - `description-missing` — the link is up but the appliance's description could not
 *                            be loaded, so its values cannot be decoded.
 */
export const DishwasherAvailabilitySchema = z.enum(['available', 'offline', 'description-missing'])
export type DishwasherAvailability = z.infer<typeof DishwasherAvailabilitySchema>

export const DishwasherStatusSchema = z.object({
  availability: DishwasherAvailabilitySchema,
  /** Coarse state for compact surfaces; `unavailable` whenever the appliance state is not known. */
  state: DishwasherStateSchema,
  /** The appliance's operation state as reported; null when not known. */
  operationState: DishwasherOperationStateSchema.nullable(),
  /** Feature key of the ACTIVE (running) program, or null when none runs / not known. */
  program: z.string().nullable(),
  /** Feature key of the SELECTED program (what Start would run), or null when none / not known. */
  selectedProgram: z.string().nullable(),
  /** Feature keys of the programs the appliance currently offers — drives the UI selector. */
  availablePrograms: z.array(z.string()),
  /** Seconds remaining on the active cycle, or null when not running / not known. */
  remaining: z.number().int().nonnegative().nullable().meta(readingMeta('duration')),
  /** Seconds the delayed start is set to (time until the cycle starts), or null. */
  delayedStart: z.number().int().nonnegative().nullable().meta(readingMeta('duration')),
  /** Cycle completion 0..100, or null when not applicable. */
  progress: z.number().min(0).max(100).nullable().meta(readingMeta('percentage')),
  /** True when the door is reported open; null when the door state is not known. */
  doorOpen: z.boolean().nullable(),
  /** True when the door is latched (locked) during a cycle; null when not reported. */
  doorLocked: z.boolean().nullable(),
  /** True when remote start is allowed (door closed, power on, etc.); null when not known. */
  remoteStartAllowed: z.boolean().nullable(),
  /** True when the appliance accepts remote control now; null when not known. */
  remoteControlActive: z.boolean().nullable(),
  /** True while somebody operates the appliance at its panel; null when not reported. */
  localControlActive: z.boolean().nullable(),
  /** Main power / switched-on state; null when not known. */
  powerOn: z.boolean().nullable(),
  /** The raw power state (`On`, `Off`, `Standby`, …); null when not known. */
  powerState: z.string().nullable(),
  /**
   * True while the appliance asks for its filter to be cleaned (smart-filter, filter-system or
   * combined care-and-filter reminder raised); false when every such reminder reads clear; null
   * when none is reported. A cleared reminder is not an unknown one.
   */
  filterCleaningDue: z.boolean().nullable(),
  /** True while the machine-care (descaling / cleaning-program) reminder is raised; false when clear; null when not reported. */
  machineCareDue: z.boolean().nullable(),
  /** Program runs left before the machine-care reminder is due; null when the appliance does not say. */
  machineCareRemainingRuns: z.number().int().nonnegative().nullable().meta(readingMeta('count')),
  /** Option states: null when the appliance does not expose the option or has not said. */
  halfLoad: z.boolean().nullable(),
  hygienePlus: z.boolean().nullable(),
  /** Extra dry option when the appliance exposes it. */
  extraDry: z.boolean().nullable(),
  /** Intensive zone (lower basket) when the appliance exposes it. */
  intensiveZone: z.boolean().nullable(),
  /** VarioSpeed / VarioSpeed+ when the appliance exposes it. */
  varioSpeedPlus: z.boolean().nullable(),
  /** Child lock (controls disabled on the appliance); null when not known. */
  childLock: z.boolean().nullable(),
  /** Feature keys of the events currently raised (salt low, rinse aid low, program finished, …). */
  activeEvents: z.array(z.string()),
  /** Numeric error code when the appliance reports one; null otherwise. */
  errorCode: z.number().nullable().meta(readingMeta('none')),
  /** Name of the raised alert-level event while the appliance is in error; null otherwise. */
  errorLabel: z.string().nullable(),
  /** Ms epoch of the last value received from the appliance; 0 = never. */
  lastFetchedAt: z.number(),
})

export type DishwasherStatus = z.infer<typeof DishwasherStatusSchema>

const DeviceIdSchema = z.number().int().nonnegative()

/** A value a program option or setting can take. */
export const DishwasherValueSchema = z.union([z.boolean(), z.string(), z.number()])
export type DishwasherValue = z.infer<typeof DishwasherValueSchema>

export const DishwasherAccessSchema = z.enum([
  'none',
  'read',
  'readWrite',
  'writeOnly',
  'readStatic',
])
export type DishwasherAccess = z.infer<typeof DishwasherAccessSchema>

/**
 * One option or setting the appliance declares, with the constraints its description
 * gives. A `readWrite` descriptor that is `available` is what `setOption` accepts.
 */
export const DishwasherOptionDescriptorSchema = z.object({
  /** Feature key (`Dishcare.Dishwasher.Option.ExtraDry`). */
  key: z.string(),
  /** Last segment of the key, for display. */
  name: z.string(),
  type: z.enum(['boolean', 'number', 'enum', 'string']),
  access: DishwasherAccessSchema,
  /** The appliance reports this entity as currently available. */
  available: z.boolean(),
  /** Unit the description declares for a number; null when it declares none. */
  unit: z.string().nullable(),
  min: z.number().nullable(),
  max: z.number().nullable(),
  step: z.number().nullable(),
  /** Allowed members of an enum; null for other types. */
  enumValues: z.array(z.string()).nullable(),
  defaultValue: DishwasherValueSchema.nullable(),
})
export type DishwasherOptionDescriptor = z.infer<typeof DishwasherOptionDescriptorSchema>

export const DishwasherProgramSchema = z.object({
  /** Feature key (`Dishcare.Dishwasher.Program.Eco50`) — what `setProgram` / `start` take. */
  key: z.string(),
  name: z.string(),
  /** The appliance currently offers this program. */
  available: z.boolean(),
  /** The options this program lists, with the program-level access / availability / default. */
  options: z.array(DishwasherOptionDescriptorSchema),
})
export type DishwasherProgram = z.infer<typeof DishwasherProgramSchema>

export const DishwasherOptionsSchema = z.object({
  availability: DishwasherAvailabilitySchema,
  /** What the appliance can be told to do, from the commands its description declares. */
  supportsStart: z.boolean(),
  supportsPause: z.boolean(),
  supportsResume: z.boolean(),
  supportsStop: z.boolean(),
  supportsPower: z.boolean(),
  /** Every program the description lists, with its options. */
  programs: z.array(DishwasherProgramSchema),
  /** Every option and setting entity the description lists (programs reference these by key). */
  options: z.array(DishwasherOptionDescriptorSchema),
})
export type DishwasherOptions = z.infer<typeof DishwasherOptionsSchema>

export const dishwasherCapability = {
  name: 'dishwasher',
  scope: 'device',
  deviceNative: true,
  mode: 'singleton',
  deviceTypes: [DeviceType.Dishwasher],
  methods: {
    /**
     * Start a program. Without `program` the selected one starts. `options` are
     * option feature keys; each is checked against the program's constraints.
     */
    start: method(
      z.object({
        deviceId: DeviceIdSchema,
        program: z.string().min(1).optional(),
        options: z.record(z.string(), DishwasherValueSchema).optional(),
      }),
      z.void(),
      {
        kind: 'mutation',
        auth: 'protected',
        actions: [
          {
            id: 'dishwasher.start',
            label: t('Start cycle', 'Avvia il lavaggio'),
            phrase: t('Start {device}', 'Avvia {device}'),
            icon: 'play',
            openArgs: [
              {
                key: 'program',
                label: t('Programme', 'Programma'),
                offer: {
                  kind: 'dynamic',
                  from: 'status',
                  field: 'availablePrograms',
                },
                optional: true,
              },
            ],
          },
        ],
      },
    ),
    pause: method(z.object({ deviceId: DeviceIdSchema }), z.void(), {
      kind: 'mutation',
      auth: 'protected',
      actions: [
        {
          id: 'dishwasher.pause',
          label: t('Pause', 'Metti in pausa'),
          phrase: t('Pause {device}', 'Metti in pausa {device}'),
          icon: 'pause',
        },
      ],
    }),
    resume: method(z.object({ deviceId: DeviceIdSchema }), z.void(), {
      kind: 'mutation',
      auth: 'protected',
      actions: [
        {
          id: 'dishwasher.resume',
          label: t('Resume', 'Riprendi'),
          phrase: t('Resume {device}', 'Riprendi il lavaggio di {device}'),
          icon: 'play',
        },
      ],
    }),
    stop: method(z.object({ deviceId: DeviceIdSchema }), z.void(), {
      kind: 'mutation',
      auth: 'protected',
      actions: [
        {
          id: 'dishwasher.stop',
          label: t('Stop', 'Ferma'),
          phrase: t('Stop {device}', 'Ferma {device}'),
          icon: 'square',
        },
      ],
    }),
    /** Select (not start) a program; refused when the appliance does not offer it. */
    setProgram: method(
      z.object({
        deviceId: DeviceIdSchema,
        program: z.string().min(1),
      }),
      z.void(),
      {
        kind: 'mutation',
        auth: 'protected',
        actions: [
          {
            id: 'dishwasher.program',
            label: t('Choose programme', 'Scegli il programma'),
            phrase: t(
              'Select the {program} programme on {device}',
              'Seleziona il programma {program} su {device}',
            ),
            icon: 'list',
            openArgs: [
              {
                key: 'program',
                label: t('Programme', 'Programma'),
                offer: {
                  kind: 'dynamic',
                  from: 'status',
                  field: 'availablePrograms',
                },
              },
            ],
          },
        ],
      },
    ),
    setPower: method(z.object({ deviceId: DeviceIdSchema, on: z.boolean() }), z.void(), {
      kind: 'mutation',
      auth: 'protected',
      actions: [
        {
          id: 'dishwasher.powerOn',
          label: t('Power on', 'Accendi'),
          phrase: t('Turn on {device}', 'Accendi {device}'),
          icon: 'power',
          args: { on: true },
        },
        {
          id: 'dishwasher.powerOff',
          label: t('Power off', 'Spegni'),
          phrase: t('Turn off {device}', 'Spegni {device}'),
          icon: 'power-off',
          args: { on: false },
        },
      ],
    }),
    setHalfLoad: method(z.object({ deviceId: DeviceIdSchema, on: z.boolean() }), z.void(), {
      kind: 'mutation',
      auth: 'protected',
      actions: [
        {
          id: 'dishwasher.halfLoadOn',
          label: t('Half load on', 'Mezzo carico attivo'),
          phrase: t('Turn on half load on {device}', 'Attiva il mezzo carico su {device}'),
          icon: 'contrast',
          args: { on: true },
        },
        {
          id: 'dishwasher.halfLoadOff',
          label: t('Half load off', 'Mezzo carico spento'),
          phrase: t('Turn off half load on {device}', 'Disattiva il mezzo carico su {device}'),
          icon: 'contrast',
          args: { on: false },
        },
      ],
    }),
    setHygienePlus: method(z.object({ deviceId: DeviceIdSchema, on: z.boolean() }), z.void(), {
      kind: 'mutation',
      auth: 'protected',
      actions: [
        {
          id: 'dishwasher.hygienePlusOn',
          label: t('Hygiene Plus on', 'Igiene Plus attiva'),
          phrase: t('Turn on Hygiene Plus on {device}', 'Attiva Igiene Plus su {device}'),
          icon: 'sparkles',
          args: { on: true },
        },
        {
          id: 'dishwasher.hygienePlusOff',
          label: t('Hygiene Plus off', 'Igiene Plus spenta'),
          phrase: t('Turn off Hygiene Plus on {device}', 'Disattiva Igiene Plus su {device}'),
          icon: 'sparkles',
          args: { on: false },
        },
      ],
    }),
    setExtraDry: method(z.object({ deviceId: DeviceIdSchema, on: z.boolean() }), z.void(), {
      kind: 'mutation',
      auth: 'protected',
      actions: [
        {
          id: 'dishwasher.extraDryOn',
          label: t('Extra dry on', 'Asciugatura extra attiva'),
          phrase: t('Turn on extra dry on {device}', 'Attiva l’asciugatura extra su {device}'),
          icon: 'sun',
          args: { on: true },
        },
        {
          id: 'dishwasher.extraDryOff',
          label: t('Extra dry off', 'Asciugatura extra spenta'),
          phrase: t('Turn off extra dry on {device}', 'Disattiva l’asciugatura extra su {device}'),
          icon: 'sun',
          args: { on: false },
        },
      ],
    }),
    setIntensiveZone: method(z.object({ deviceId: DeviceIdSchema, on: z.boolean() }), z.void(), {
      kind: 'mutation',
      auth: 'protected',
      actions: [
        {
          id: 'dishwasher.intensiveZoneOn',
          label: t('Intensive zone on', 'Zona intensiva attiva'),
          phrase: t(
            'Turn on the intensive zone on {device}',
            'Attiva la zona intensiva su {device}',
          ),
          icon: 'flame',
          args: { on: true },
        },
        {
          id: 'dishwasher.intensiveZoneOff',
          label: t('Intensive zone off', 'Zona intensiva spenta'),
          phrase: t(
            'Turn off the intensive zone on {device}',
            'Disattiva la zona intensiva su {device}',
          ),
          icon: 'flame',
          args: { on: false },
        },
      ],
    }),
    setVarioSpeedPlus: method(z.object({ deviceId: DeviceIdSchema, on: z.boolean() }), z.void(), {
      kind: 'mutation',
      auth: 'protected',
      actions: [
        {
          id: 'dishwasher.varioSpeedOn',
          label: t('Speed boost on', 'Lavaggio rapido attivo'),
          phrase: t('Turn on the speed boost on {device}', 'Attiva il lavaggio rapido su {device}'),
          icon: 'zap',
          args: { on: true },
        },
        {
          id: 'dishwasher.varioSpeedOff',
          label: t('Speed boost off', 'Lavaggio rapido spento'),
          phrase: t(
            'Turn off the speed boost on {device}',
            'Disattiva il lavaggio rapido su {device}',
          ),
          icon: 'zap',
          args: { on: false },
        },
      ],
    }),
    setChildLock: method(z.object({ deviceId: DeviceIdSchema, on: z.boolean() }), z.void(), {
      kind: 'mutation',
      auth: 'protected',
      actions: [
        {
          id: 'dishwasher.childLockOn',
          label: t('Child lock on', 'Blocco bambini attivo'),
          phrase: t('Turn on the child lock of {device}', 'Attiva il blocco bambini di {device}'),
          icon: 'lock',
          args: { on: true },
        },
        {
          id: 'dishwasher.childLockOff',
          label: t('Child lock off', 'Blocco bambini spento'),
          phrase: t(
            'Turn off the child lock of {device}',
            'Disattiva il blocco bambini di {device}',
          ),
          icon: 'lock-open',
          args: { on: false },
        },
      ],
    }),
    /**
     * Write any option or setting by feature key. Refused when the description does
     * not list it, it is not writable or not available now, or the value is outside
     * its declared range / members.
     */
    setOption: method(
      z.object({
        deviceId: DeviceIdSchema,
        key: z.string().min(1),
        value: DishwasherValueSchema,
      }),
      z.void(),
      {
        kind: 'mutation',
        auth: 'protected',
        notOperatorFacing:
          'a raw appliance option key/value; every option worth naming has its own action above',
      },
    ),
    /** What this appliance can do, from its own description — the UI is derived from it. */
    getOptions: method(z.object({ deviceId: DeviceIdSchema }), DishwasherOptionsSchema, {
      auth: 'protected',
    }),
  },
  status: {
    schema: DishwasherStatusSchema,
    kind: 'poll',
  },
  runtimeState: DishwasherStatusSchema,
  durability: 'session',
  history: {
    fields: {
      progress: { kind: 'gauge', unit: '%', deadband: 2 },
      // The coarse and the appliance's own state: change-only enums.
      state: { kind: 'enum' },
      operationState: { kind: 'enum' },
      // Counts down every poll; one point a minute draws a cycle exactly enough.
      remaining: { kind: 'gauge', unit: 's', minIntervalMs: 60_000 },
      doorOpen: { kind: 'boolean' },
      powerOn: { kind: 'boolean' },
    },
  },
  vocabulary: {
    noun: t('Dishwasher', 'Lavastoviglie'),
    order: 2020,
    state: [
      {
        kind: 'enum',
        field: 'state',
        label: t('Cycle', 'Ciclo'),
        values: [
          { value: 'idle', label: t('Idle', 'Inattiva') },
          {
            value: 'running',
            label: t('Running', 'In funzione'),
            phrase: t('When {device} starts a cycle', 'Quando {device} inizia un lavaggio'),
          },
          { value: 'paused', label: t('Paused', 'In pausa') },
          {
            value: 'finished',
            label: t('Finished', 'Terminato'),
            phrase: t('When {device} finishes', 'Quando {device} finisce il lavaggio'),
          },
          {
            value: 'error',
            label: t('Error', 'Errore'),
            phrase: t('When {device} reports an error', 'Quando {device} segnala un errore'),
          },
          { value: 'unavailable', label: t('Unavailable', 'Non disponibile') },
        ],
        icon: 'washing-machine',
      },
      {
        kind: 'numeric',
        field: 'progress',
        quantity: t('the cycle progress', 'l’avanzamento del lavaggio'),
        label: t('Progress', 'Avanzamento'),
        unit: '%',
        icon: 'loader',
      },
      {
        kind: 'boolean',
        field: 'doorOpen',
        label: t('Door open', 'Sportello aperto'),
        whenTrue: t('When the door of {device} opens', 'Quando si apre lo sportello di {device}'),
        whenFalse: t(
          'When the door of {device} closes',
          'Quando si chiude lo sportello di {device}',
        ),
        icon: 'door-open',
      },
      {
        kind: 'boolean',
        field: 'filterCleaningDue',
        label: t('Filter cleaning due', 'Pulizia filtro da fare'),
        whenTrue: t(
          'When {device} asks for its filter to be cleaned',
          'Quando {device} chiede di pulire il filtro',
        ),
        whenFalse: t(
          'When the filter reminder of {device} clears',
          'Quando l’avviso filtro di {device} rientra',
        ),
        icon: 'funnel',
      },
      {
        kind: 'boolean',
        field: 'machineCareDue',
        label: t('Machine care due', 'Manutenzione da fare'),
        whenTrue: t(
          'When {device} asks for a machine-care cycle',
          'Quando {device} chiede un ciclo di manutenzione',
        ),
        whenFalse: t(
          'When the machine-care reminder of {device} clears',
          'Quando l’avviso di manutenzione di {device} rientra',
        ),
        icon: 'wrench',
      },
    ],
  },
} as const satisfies CapabilityDefinition

export type IDishwasherProvider = InferProvider<typeof dishwasherCapability>
