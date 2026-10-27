import type {
  ConsumableItem,
  ConsumableStatus,
  DishwasherOperationState,
  DishwasherOptionDescriptor,
  DishwasherOptions,
  DishwasherProgram,
  DishwasherStatus,
  DishwasherValue,
} from '@camstack/types'
import { DishwasherOperationStateSchema } from '@camstack/types'
import type {
  HomeConnectDescriptionStore,
  HomeConnectEntityView,
} from './home-connect-description-store.js'
import type { HomeConnectEntityKind } from './home-connect-device-description.js'
import { featureShortName, resolveUnit, secondsFrom } from './home-connect-units.js'
import type { HomeConnectLinkState } from './home-connect-ws-client.js'

export type HomeConnectFeatureMap = ReadonlyMap<string, unknown>

/**
 * The slice of the world a mapping needs: the decoded values, the live description
 * and the state of the link. A mapping is a pure function of it.
 */
export interface HomeConnectView {
  readonly features: HomeConnectFeatureMap
  readonly description: HomeConnectDescriptionStore | null
  readonly link: HomeConnectLinkState
}

/** `OperationState` values the appliance reports when an event / flag is on. */
const EVENT_ACTIVE_VALUES: ReadonlySet<string> = new Set(['Present', 'Confirmed'])

/** An event entity carries its present state; `Present` and `Confirmed` both mean "still raised". */
export function eventActive(value: unknown): boolean | null {
  if (typeof value === 'string') {
    if (EVENT_ACTIVE_VALUES.has(value)) return true
    if (value === 'Off') return false
    return null
  }
  if (typeof value === 'boolean') return value
  return null
}

/** First entity of one of `kinds` whose last name segment is one of `shortNames`. */
export function findEntity(
  description: HomeConnectDescriptionStore | null,
  kinds: readonly HomeConnectEntityKind[],
  shortNames: readonly string[],
): HomeConnectEntityView | undefined {
  if (description === null) return undefined
  return description
    .entities()
    .find((e) => kinds.includes(e.kind) && shortNames.includes(featureShortName(e.name)))
}

function valueOf(view: HomeConnectView, entity: HomeConnectEntityView | undefined): unknown {
  return entity === undefined ? undefined : view.features.get(entity.name)
}

function boolOf(raw: unknown): boolean | null {
  return typeof raw === 'boolean' ? raw : null
}

function stringOf(raw: unknown): string | null {
  return typeof raw === 'string' && raw.length > 0 ? raw : null
}

function numberOf(raw: unknown): number | null {
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : null
}

function availabilityOf(view: HomeConnectView): DishwasherStatus['availability'] {
  if (view.link !== 'connected') return 'offline'
  if (view.description === null || view.description.state === 'missing')
    return 'description-missing'
  return 'available'
}

const OPERATION_TO_STATE: Readonly<Record<DishwasherOperationState, DishwasherStatus['state']>> = {
  Inactive: 'idle',
  Ready: 'idle',
  DelayedStart: 'idle',
  ActionRequired: 'idle',
  Run: 'running',
  Aborting: 'running',
  Pause: 'paused',
  Finished: 'finished',
  Error: 'error',
}

function operationStateOf(raw: unknown): DishwasherOperationState | null {
  const parsed = DishwasherOperationStateSchema.safeParse(raw)
  return parsed.success ? parsed.data : null
}

/** The reported state of EVERY listed event the description has — each read on its own. */
function eventStates(view: HomeConnectView, shortNames: readonly string[]): (boolean | null)[] {
  return (view.description?.entities() ?? [])
    .filter((e) => e.kind === 'event' && shortNames.includes(featureShortName(e.name)))
    .map((e) => eventActive(valueOf(view, e)))
}

/**
 * Any empty-class event raised → `empty`; else any nearly-empty one raised → `low`; else any of
 * them reading clear → `ok`; nothing reported → `null` (unknown, never `ok`).
 */
function consumableFromEvents(
  view: HomeConnectView,
  nearlyEmpty: readonly string[],
  empty: readonly string[],
): Extract<ConsumableStatus, 'ok' | 'low' | 'empty'> | null {
  const gone = eventStates(view, empty)
  const nearly = eventStates(view, nearlyEmpty)
  if (gone.includes(true)) return 'empty'
  if (nearly.includes(true)) return 'low'
  if (gone.includes(false) || nearly.includes(false)) return 'ok'
  return null
}

/** Any listed reminder raised → `true`; else any reading clear → `false`; none reported → `null`. */
function reminderDue(view: HomeConnectView, shortNames: readonly string[]): boolean | null {
  const states = eventStates(view, shortNames)
  if (states.includes(true)) return true
  return states.includes(false) ? false : null
}

/** A non-negative whole count, or `null`. */
function countOf(raw: unknown): number | null {
  return typeof raw === 'number' && Number.isInteger(raw) && raw >= 0 ? raw : null
}

function programKey(raw: unknown): string | null {
  return stringOf(raw)
}

/** Active events (raised right now) as feature keys. */
function activeEventsOf(view: HomeConnectView): readonly HomeConnectEntityView[] {
  return (view.description?.entities() ?? []).filter(
    (e) => e.kind === 'event' && eventActive(valueOf(view, e)) === true,
  )
}

function optionBool(view: HomeConnectView, shortNames: readonly string[]): boolean | null {
  return boolOf(valueOf(view, findEntity(view.description, ['option', 'setting'], shortNames)))
}

/** Programs the appliance currently offers, as feature keys. */
function availableProgramKeys(description: HomeConnectDescriptionStore): readonly string[] {
  return description
    .programs()
    .filter((p) => description.entityByName(p.uid)?.available !== false)
    .map((p) => p.uid)
}

export const COLD_DISHWASHER_STATUS: DishwasherStatus = {
  availability: 'offline',
  state: 'unavailable',
  operationState: null,
  program: null,
  selectedProgram: null,
  availablePrograms: [],
  remaining: null,
  delayedStart: null,
  progress: null,
  doorOpen: null,
  doorLocked: null,
  remoteStartAllowed: null,
  remoteControlActive: null,
  localControlActive: null,
  powerOn: null,
  powerState: null,
  filterCleaningDue: null,
  machineCareDue: null,
  machineCareRemainingRuns: null,
  halfLoad: null,
  hygienePlus: null,
  extraDry: null,
  intensiveZone: null,
  varioSpeedPlus: null,
  childLock: null,
  activeEvents: [],
  errorCode: null,
  errorLabel: null,
  lastFetchedAt: 0,
}

export interface DishwasherMappingInput extends HomeConnectView {
  /** Ms epoch of the last value the appliance sent; 0 = never. */
  readonly lastValueAt: number
}

/**
 * Map the decoded Home Connect values → {@link DishwasherStatus}. Pure — the only
 * place the dishwasher slice is assembled. A field the appliance has not reported
 * (or that the description does not list) is `null`; nothing is defaulted to
 * `false`, `0` or `Ready`.
 */
export function dishwasherStatusFromFeatures(input: DishwasherMappingInput): DishwasherStatus {
  const availability = availabilityOf(input)
  const description = input.description
  if (availability !== 'available' || description === null) {
    return {
      ...COLD_DISHWASHER_STATUS,
      availability,
      availablePrograms: description !== null ? [...availableProgramKeys(description)] : [],
      lastFetchedAt: input.lastValueAt,
    }
  }
  const op = operationStateOf(
    valueOf(input, findEntity(description, ['status'], ['OperationState'])),
  )
  const doorRaw = stringOf(valueOf(input, findEntity(description, ['status'], ['DoorState'])))
  const powerRaw = stringOf(valueOf(input, findEntity(description, ['setting'], ['PowerState'])))
  const events = activeEventsOf(input)
  const alert = events.find((e) => e.level === 'alert' || e.level === 'critical') ?? events[0]
  const state = op === null ? 'unavailable' : OPERATION_TO_STATE[op]
  const remaining = valueOf(input, findEntity(description, ['option'], ['RemainingProgramTime']))
  const delayed = valueOf(input, findEntity(description, ['option'], ['StartInRelative']))
  const progress = numberOf(
    valueOf(input, findEntity(description, ['option'], ['ProgramProgress'])),
  )
  const activeEntity = description.entityOfKind('activeProgram')
  const selectedEntity = description.entityOfKind('selectedProgram')
  return {
    availability,
    state,
    operationState: op,
    program: programKey(valueOf(input, activeEntity)),
    selectedProgram: programKey(valueOf(input, selectedEntity)),
    availablePrograms: [...availableProgramKeys(description)],
    remaining: secondsFrom(remaining),
    delayedStart: secondsFrom(delayed),
    progress: progress !== null && progress >= 0 && progress <= 100 ? progress : null,
    doorOpen: doorRaw === null ? null : doorRaw === 'Open',
    doorLocked: doorRaw === null ? null : doorRaw === 'Locked',
    remoteStartAllowed: boolOf(
      valueOf(input, findEntity(description, ['status'], ['RemoteControlStartAllowed'])),
    ),
    remoteControlActive: boolOf(
      valueOf(input, findEntity(description, ['status'], ['RemoteControlActive'])),
    ),
    localControlActive: boolOf(
      valueOf(input, findEntity(description, ['status'], ['LocalControlActive'])),
    ),
    powerOn: powerRaw === null ? null : powerRaw === 'On',
    powerState: powerRaw,
    filterCleaningDue: reminderDue(input, [
      'SmartFilterCleaningReminder',
      'CheckFilterSystem',
      'MachineCareAndFilterCleaningReminder',
    ]),
    machineCareDue: reminderDue(input, [
      'MachineCareReminder',
      'MachineCareAndFilterCleaningReminder',
    ]),
    machineCareRemainingRuns: countOf(
      valueOf(input, findEntity(description, ['status'], ['RemainingProgramRuns'])),
    ),
    halfLoad: optionBool(input, ['HalfLoad']),
    hygienePlus: optionBool(input, ['HygienePlus']),
    extraDry: optionBool(input, ['ExtraDry']),
    intensiveZone: optionBool(input, ['IntensivZone', 'IntensiveZone']),
    varioSpeedPlus: optionBool(input, ['VarioSpeedPlus', 'VarioSpeed']),
    childLock: boolOf(valueOf(input, findEntity(description, ['setting'], ['ChildLock']))),
    activeEvents: events.map((e) => e.name),
    errorCode: null,
    errorLabel: op === 'Error' ? (alert?.name ?? 'Error') : null,
    lastFetchedAt: input.lastValueAt,
  }
}

// ---------------------------------------------------------------------------
// getOptions — what the appliance's own description says it can do
// ---------------------------------------------------------------------------

function primitiveOrNull(raw: unknown): DishwasherValue | null {
  return typeof raw === 'boolean' || typeof raw === 'string' || typeof raw === 'number' ? raw : null
}

function descriptorType(
  entity: HomeConnectEntityView,
  current: unknown,
  fallback: unknown,
): DishwasherOptionDescriptor['type'] {
  if (entity.enumeration !== undefined) return 'enum'
  if (entity.valueType === 'number') return 'number'
  if (entity.valueType === 'boolean') return 'boolean'
  for (const sample of [current, fallback]) {
    if (typeof sample === 'boolean') return 'boolean'
    if (typeof sample === 'number') return 'number'
    if (typeof sample === 'string') return 'string'
  }
  return entity.min !== undefined || entity.max !== undefined ? 'number' : 'boolean'
}

function descriptorOf(
  entity: HomeConnectEntityView,
  features: HomeConnectFeatureMap,
  override?: {
    access?: DishwasherOptionDescriptor['access']
    available?: boolean
    defaultValue?: unknown
  },
): DishwasherOptionDescriptor {
  const defaultValue = override?.defaultValue ?? entity.defaultValue
  const type = descriptorType(entity, features.get(entity.name), defaultValue)
  return {
    key: entity.name,
    name: featureShortName(entity.name),
    type,
    access: override?.access ?? entity.access ?? 'read',
    available: (override?.available ?? entity.available) !== false,
    unit: type === 'number' ? resolveUnit(entity) : null,
    min: entity.min ?? null,
    max: entity.max ?? null,
    step: entity.stepSize ?? null,
    enumValues: entity.enumeration !== undefined ? Object.values(entity.enumeration) : null,
    defaultValue: primitiveOrNull(defaultValue),
  }
}

function commandAvailable(description: HomeConnectDescriptionStore, short: string): boolean {
  return findEntity(description, ['command'], [short])?.available === true
}

/** The honest descriptor of the appliance: programs with their options, every option / setting, the commands it takes. */
export function dishwasherOptionsFromDescription(input: HomeConnectView): DishwasherOptions {
  const availability = availabilityOf(input)
  const description = input.description
  if (description === null || description.state === 'missing') {
    return {
      availability,
      supportsStart: false,
      supportsPause: false,
      supportsResume: false,
      supportsStop: false,
      supportsPower: false,
      programs: [],
      options: [],
    }
  }
  const settable = description.entities().filter((e) => e.kind === 'option' || e.kind === 'setting')
  const power = findEntity(description, ['setting'], ['PowerState'])
  const programs: DishwasherProgram[] = description.programs().map((program) => {
    const entity = description.entityByName(program.uid)
    return {
      key: program.uid,
      name: program.name,
      available: entity?.available !== false,
      options: (program.options ?? []).flatMap((ref) => {
        const option = description.entityByName(ref.key)
        return option === undefined
          ? []
          : [
              descriptorOf(option, input.features, {
                ...(ref.access !== undefined ? { access: ref.access } : {}),
                ...(ref.available !== undefined ? { available: ref.available } : {}),
                ...(ref.defaultValue !== undefined ? { defaultValue: ref.defaultValue } : {}),
              }),
            ]
      }),
    }
  })
  return {
    availability,
    supportsStart: description.entityOfKind('activeProgram') !== undefined,
    supportsPause: commandAvailable(description, 'PauseProgram'),
    supportsResume: commandAvailable(description, 'ResumeProgram'),
    supportsStop: commandAvailable(description, 'AbortProgram'),
    supportsPower:
      power !== undefined && (power.access === 'readWrite' || power.access === 'writeOnly'),
    programs,
    options: settable.map((e) => descriptorOf(e, input.features)),
  }
}

/** Command entities by their short name — what pause / resume / stop write. */
export const HC_COMMAND_PAUSE = 'PauseProgram'
export const HC_COMMAND_RESUME = 'ResumeProgram'
export const HC_COMMAND_STOP = 'AbortProgram'

/** The dishwasher supplies, by the events that report them. */
const DISHWASHER_SUPPLIES: ReadonlyArray<{
  readonly key: string
  readonly label: string
  readonly nearlyEmpty: readonly string[]
  readonly empty: readonly string[]
}> = [
  {
    key: 'salt',
    label: 'Salt',
    nearlyEmpty: ['SaltNearlyEmpty'],
    empty: ['SaltEmpty', 'SaltLack'],
  },
  {
    key: 'rinseAid',
    label: 'Rinse aid',
    nearlyEmpty: ['RinseAidNearlyEmpty'],
    empty: ['RinseAidEmpty', 'RinseAidLack'],
  },
]

/**
 * The dishwasher's `consumables` items (D915): salt and rinse aid as `supply`
 * items, for each the appliance's description lists an event for. Their
 * status comes from those events (`consumableFromEvents`); none reported is
 * `null` (unknown), never `ok`. Neither is resettable — refilling is the reset.
 *
 * `null` while the appliance is offline or undescribed: nothing is known NOW,
 * and the `consumables` slice is restored — the last observation stays rather
 * than being overwritten with unknowns. Pure.
 */
export function dishwasherConsumablesFromFeatures(view: HomeConnectView): ConsumableItem[] | null {
  if (availabilityOf(view) !== 'available') return null
  return DISHWASHER_SUPPLIES.flatMap(({ key, label, nearlyEmpty, empty }) => {
    if (eventStates(view, [...nearlyEmpty, ...empty]).length === 0) return []
    return [
      {
        key,
        label,
        level: null,
        status: consumableFromEvents(view, nearlyEmpty, empty),
        kind: 'supply' as const,
        // Salt and rinse aid are bought and refilled: a product, not a tank.
        form: 'product' as const,
        lastResetAt: null,
        resettable: false,
      },
    ]
  })
}
