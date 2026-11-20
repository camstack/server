import {
  type DeviceErrorSeverity,
  type DeviceFault,
  ERROR_STATUS_COLD,
  type ErrorStatus,
} from '@camstack/types'
import type { HmSysVar, HmValue } from 'nodehomematic'

/**
 * PURE mapping of what a CCU reports as faulty to `error` cap readings, with no
 * session and no I/O: the WatchDog system variables of the box, and the
 * MAINTENANCE service flags of one device.
 *
 * A reading is UNKNOWN (`active: null`, the cold slice) until the CCU has said
 * something about the flags; "no fault" is only ever written from a value that
 * was read (D315, D393).
 *
 * The cap's `label` is a plain string the provider translates, and the server
 * has no per-operator language: the label carries the English words, and the
 * Italian beside it stays in the table for the surface that can pick one.
 */

/** The two languages of one fault, side by side so neither is forgotten. */
function words(en: string, it: string): FaultWords {
  return { en, it }
}

interface FaultWords {
  readonly en: string
  readonly it: string
}

/** One fault the mapping can raise. */
interface FaultRule {
  /** The code published on the cap. */
  readonly key: string
  readonly severity: DeviceErrorSeverity
  readonly words: FaultWords
}

const SEVERITY_ORDER: Readonly<Record<DeviceErrorSeverity, number>> = { error: 0, warning: 1 }

function toFault(rule: FaultRule): DeviceFault {
  return { code: rule.key, label: rule.words.en, severity: rule.severity }
}

/** Errors first, then warnings; the order inside a tier is the rule order. */
function rank(faults: readonly DeviceFault[]): DeviceFault[] {
  return [...faults].sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity])
}

function reading(faults: readonly DeviceFault[], now: number): ErrorStatus {
  const ranked = rank(faults)
  const principal = ranked[0]
  if (principal === undefined) {
    return { ...ERROR_STATUS_COLD, active: false, faults: [], lastFetchedAt: now }
  }
  return {
    active: true,
    code: principal.code,
    label: principal.label,
    severity: principal.severity,
    since: null,
    faults: ranked,
    lastFetchedAt: now,
  }
}

function unknown(now: number): ErrorStatus {
  return { ...ERROR_STATUS_COLD, lastFetchedAt: now }
}

/** A LOGIC value as the CCU hands it over: a boolean, 0/1, or its text. `null` is unread. */
function truthy(value: HmValue): boolean | null {
  if (value === null) return null
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') return value !== 0
  const text = value.trim().toLowerCase()
  return text === 'true' || text === '1' || text === 'on' || text === 'yes'
}

// ── the CCU box: WatchDog system variables ─────────────────────────────

/** The WatchDog add-on names its variables "SV WatchDog: <key>". */
const WATCHDOG_PREFIX = /^sv\s*watchdog\s*:\s*/i

export const WATCHDOG_FAULTS: readonly FaultRule[] = [
  {
    key: 'hb-rf-eth-connection',
    severity: 'error',
    words: words('HB-RF-ETH connection lost', 'Connessione HB-RF-ETH persa'),
  },
  {
    key: 'low-voltage',
    severity: 'error',
    words: words('CCU supply voltage low', 'Tensione di alimentazione della CCU bassa'),
  },
  {
    key: 'rfd-restart',
    severity: 'warning',
    words: words('The radio service restarted', 'Il servizio radio si è riavviato'),
  },
  {
    key: 'regahss-restart',
    severity: 'warning',
    words: words('The ReGa service restarted', 'Il servizio ReGa si è riavviato'),
  },
  {
    key: 'no-internet',
    severity: 'warning',
    words: words('The CCU has no internet', 'La CCU non ha internet'),
  },
  {
    key: 'unclean-shutdown',
    severity: 'warning',
    words: words('The CCU shut down uncleanly', 'La CCU si è spenta in modo anomalo'),
  },
]

/** Which WatchDog fault a system variable is, or `null` when it is not one of them. */
function watchdogRuleOf(name: string): FaultRule | null {
  const key = name.trim().replace(WATCHDOG_PREFIX, '').trim().toLowerCase()
  return WATCHDOG_FAULTS.find((rule) => rule.key === key) ?? null
}

/**
 * The gateway's reading from a system-variable snapshot. No WatchDog variable
 * with a value (no snapshot, no credentials, the add-on not installed) is
 * UNKNOWN, never "no fault".
 */
export function watchdogFaultReading(vars: readonly HmSysVar[], now: number): ErrorStatus {
  const faults: DeviceFault[] = []
  let known = 0
  for (const variable of vars) {
    const rule = watchdogRuleOf(variable.name)
    if (rule === null) continue
    const on = truthy(variable.value)
    if (on === null) continue
    known += 1
    if (on) faults.push(toFault(rule))
  }
  if (known === 0) return unknown(now)
  return reading(faults, now)
}

// ── a device: MAINTENANCE service flags ─────────────────────────────────

const MAINTENANCE_FAULTS: readonly FaultRule[] = [
  {
    key: 'UNREACH',
    severity: 'error',
    words: words('Device unreachable', 'Dispositivo non raggiungibile'),
  },
  {
    key: 'STICKY_UNREACH',
    severity: 'warning',
    words: words(
      'Device was unreachable (not acknowledged)',
      'Dispositivo stato non raggiungibile',
    ),
  },
  { key: 'LOW_BAT', severity: 'warning', words: words('Battery low', 'Batteria scarica') },
  { key: 'LOWBAT', severity: 'warning', words: words('Battery low', 'Batteria scarica') },
  {
    key: 'CONFIG_PENDING',
    severity: 'warning',
    words: words('Configuration pending', 'Configurazione in attesa'),
  },
  {
    key: 'DUTY_CYCLE',
    severity: 'warning',
    words: words('Radio duty cycle exhausted', 'Duty cycle radio esaurito'),
  },
]

/** Every `ERROR_*` boolean flag the device raises is its own fault (overheat, overload, jammed…). */
function errorFlagRule(param: string): FaultRule {
  const name = param.slice('ERROR_'.length).toLowerCase().replace(/_/g, ' ')
  return {
    key: param,
    severity: 'error',
    words: words(`Device error: ${name}`, `Errore del dispositivo: ${name}`),
  }
}

function maintenanceRuleOf(param: string, value: HmValue): FaultRule | null {
  const upper = param.toUpperCase()
  const fixed = MAINTENANCE_FAULTS.find((rule) => rule.key === upper)
  if (fixed !== undefined) return fixed
  // ERROR_CODE and the like are numbers, not flags: only a boolean is a fault here
  if (upper.startsWith('ERROR_') && typeof value === 'boolean') return errorFlagRule(upper)
  return null
}

/**
 * A device's reading from its MAINTENANCE channel values (parameter -> value).
 * Until a service flag has a value the reading is UNKNOWN.
 */
export function maintenanceFaultReading(
  values: ReadonlyMap<string, HmValue>,
  now: number,
): ErrorStatus {
  const faults: DeviceFault[] = []
  let known = 0
  for (const [param, value] of values) {
    const rule = maintenanceRuleOf(param, value)
    if (rule === null) continue
    const on = truthy(value)
    if (on === null) continue
    known += 1
    if (on) faults.push(toFault(rule))
  }
  if (known === 0) return unknown(now)
  return reading(faults, now)
}
