/**
 * The real stores, over the in-memory records world, wired to the real pruner —
 * for the deleted-device / deleted-target specs. Only the three OUTSIDE reads
 * are fakes: the device list, the per-device second read and the target
 * catalog, because those are exactly what the specs vary.
 */
import { ncRecordKinds } from '../record-kinds.js'
import { instrumentRecords } from '../../pipeline-analytics/__tests__/fake-records.js'
import { makeNcRecords, withNcFaults } from './support/nc-test-deps.js'
import type {
  InMemoryRecords,
  IScopedLogger,
  LogExtras,
  NcAlarmSettings,
  NcAlarmSettingsPatch,
} from '@camstack/types'
import { makeSilentLogger } from '../../pipeline-analytics/__tests__/test-helpers.js'
import { NcDeviceDirectory, type NcDeviceIdentity } from '../device-directory.js'
import { NcDeviceMuteStore } from '../device-mute-store.js'
import { makeFakeDeviceSettings } from './fake-device-settings.js'
import {
  NcDeletedSubjectPruner,
  type NcPruneAlarmPort,
  type NcPruneAlertPort,
} from '../device-prune-runner.js'
import { NcPruneLedger } from '../device-prune-ledger.js'
import type { NcTargetCatalogSnapshot, NcTargetRef } from '../dispatcher.js'
import { NcRuleStore } from '../rule-store.js'
import { NcSummaryStore } from '../summary/summary-store.js'
import { TimelapseStore } from '../timelapse/timelapse-store.js'

export interface PruneHarness {
  readonly world: InMemoryRecords
  /** Writes (put / patch / delete) every store in the world has sent so far. */
  writes(): number
  /** Called before each notification-rule write — a spec edits the world "meanwhile". */
  onRuleWrite: (() => void) | null
  readonly rules: NcRuleStore
  readonly timelapse: TimelapseStore
  readonly summary: NcSummaryStore
  readonly mutes: NcDeviceMuteStore
  readonly ledger: NcPruneLedger
  readonly directory: NcDeviceDirectory
  readonly pruner: NcDeletedSubjectPruner
  readonly lines: LogLine[]
  /** What `listDevices` answers next — an Error makes it throw. */
  devices: readonly number[] | Error
  /** The device ids whose `getDevice` answers null. */
  readonly gone: Set<number>
  /** `getDevice` throws for these. */
  readonly unreadable: Set<number>
  /** How many second reads were made. */
  secondReads: number
  /** What the dispatcher's cache holds now — `null` is "stale or never read". */
  catalog: NcTargetCatalogSnapshot | null
  alarm: FakeAlarm | null
  readonly alerts: FakeAlerts
}

/** The device-alert rows, as the prune sees them: which devices, and forget. */
export class FakeAlerts implements NcPruneAlertPort {
  readonly forgotten: number[] = []
  constructor(public held: number[] = []) {}

  deviceIds(): readonly number[] {
    return this.held
  }

  async forget(deviceId: number): Promise<number> {
    this.forgotten.push(deviceId)
    const before = this.held.length
    this.held = this.held.filter((id) => id !== deviceId)
    return before - this.held.length
  }
}

export interface LogLine {
  readonly level: 'debug' | 'info' | 'warn' | 'error'
  readonly message: string
  readonly tags: Readonly<Record<string, unknown>> | undefined
  readonly meta: Readonly<Record<string, unknown>> | undefined
}

/** A logger that keeps every line, and the lines it kept. */
export interface RecordedLog {
  readonly logger: IScopedLogger
  readonly lines: LogLine[]
}

export function makeRecordingLogger(): RecordedLog {
  const lines: LogLine[] = []
  const at =
    (level: LogLine['level']) =>
    (message: string, ctx?: LogExtras): void => {
      lines.push({ level, message, tags: ctx?.tags, meta: ctx?.meta })
    }
  const logger: IScopedLogger = {
    debug: at('debug'),
    info: at('info'),
    warn: at('warn'),
    error: at('error'),
    child: () => logger,
    withTags: () => logger,
  }
  return { logger, lines }
}

export class FakeAlarm implements NcPruneAlarmPort {
  readonly deviceId = 900
  current: NcAlarmSettings
  excluded: number[]
  readonly forgotten: number[] = []

  constructor(settings: NcAlarmSettings, excluded: readonly number[] = []) {
    this.current = settings
    this.excluded = [...excluded]
  }

  settings(): NcAlarmSettings {
    return this.current
  }

  async applySettings(patch: NcAlarmSettingsPatch): Promise<NcAlarmSettings> {
    this.current = {
      ...this.current,
      ...(patch.nonBlocking !== undefined ? { nonBlocking: patch.nonBlocking } : {}),
      ...(patch.announceTargets !== undefined
        ? { blocking: [], secureOnArmOff: [], announceTargets: patch.announceTargets }
        : {}),
    }
    return this.current
  }

  excludedDevices(): readonly number[] {
    return this.excluded
  }

  forgetExcluded(deviceId: number): void {
    this.forgotten.push(deviceId)
    this.excluded = this.excluded.filter((id) => id !== deviceId)
  }
}

function identity(deviceId: number): NcDeviceIdentity {
  return { deviceId, type: 'camera', name: `cam ${deviceId}`, isCamera: true }
}

export function target(id: string, addonId = 'notifiers'): NcTargetRef {
  return { id, addonId, name: id, kind: 'ntfy', enabled: true }
}

export interface PruneHarnessOptions {
  /** The prune ledger's first (and only) load FAILS — its guard never answers. */
  readonly ledgerLoadFails?: boolean
}

export async function makePruneHarness(options: PruneHarnessOptions = {}): Promise<PruneHarness> {
  const world = makeNcRecords()
  const hooks: { onRuleWrite: (() => void) | null } = { onRuleWrite: null }
  const hooked = withNcFaults(world, {
    write: (kind) => {
      if (kind === 'rules') hooks.onRuleWrite?.()
      return null
    },
  })
  const counted = instrumentRecords(hooked.records)
  const records = counted.records
  const silent = makeSilentLogger()
  const { logger, lines } = makeRecordingLogger()
  const rules = new NcRuleStore({ kind: records.kind(ncRecordKinds.rules), logger: silent })
  const timelapse = new TimelapseStore({
    kind: records.kind(ncRecordKinds['timelapse-rules']),
    logger: silent,
  })
  const summary = new NcSummaryStore({
    kind: records.kind(ncRecordKinds['summary-rules']),
    logger: silent,
  })
  const mutes = new NcDeviceMuteStore({ settings: makeFakeDeviceSettings(), logger: silent })
  const ledger = new NcPruneLedger({
    records,
    logger: silent,
  })
  const partial: Omit<PruneHarness, 'directory' | 'pruner'> & {
    directory?: NcDeviceDirectory
    pruner?: NcDeletedSubjectPruner
  } = {
    world,
    writes: () =>
      (['put', 'putMany', 'patch', 'delete', 'deleteMany', 'deleteWhere'] as const).reduce(
        (sum, method) => sum + counted.calls(method),
        0,
      ),
    get onRuleWrite() {
      return hooks.onRuleWrite
    },
    set onRuleWrite(fn) {
      hooks.onRuleWrite = fn
    },
    rules,
    timelapse,
    summary,
    mutes,
    ledger,
    lines,
    devices: [],
    gone: new Set(),
    unreadable: new Set(),
    secondReads: 0,
    catalog: null,
    alarm: null,
    alerts: new FakeAlerts(),
  }
  const h = partial
  const directory = new NcDeviceDirectory({
    logger: silent,
    listDevices: async () => {
      const answer = h.devices
      if (answer instanceof Error) throw answer
      return answer.map(identity)
    },
  })
  const pruner = new NcDeletedSubjectPruner({
    logger,
    now: () => 5_000,
    ledger,
    rules,
    timelapse,
    summary,
    mutes,
    alarm: () => h.alarm,
    alerts: h.alerts,
    directory,
    isDeviceDeleted: async (deviceId) => {
      h.secondReads += 1
      if (h.unreadable.has(deviceId)) throw new Error('device-manager unreachable')
      return h.gone.has(deviceId)
    },
    targetCatalog: () => h.catalog,
  })
  if (options.ledgerLoadFails === true) world.failReads(true)
  await ledger.load()
  world.failReads(false)
  return Object.assign(h, { directory, pruner })
}

/** The delivery path refreshed its cache: a NEW answered catalog. */
export function publishCatalog(h: PruneHarness, targets: readonly NcTargetRef[]): void {
  h.catalog = { generation: (h.catalog?.generation ?? 0) + 1, at: 0, targets }
}

/** Two answered directory refreshes that both lack `missing`. */
export async function answerTwiceWithout(
  h: PruneHarness,
  present: readonly number[],
): Promise<void> {
  h.devices = present
  await h.directory.refresh()
  await h.directory.refresh()
}
