/**
 * Rules of `check-power-hint.ts` (#462 P1): `switch` is the one on/off control.
 *
 *  1. A cap with a `power` hint names members that EXIST (the field in its
 *     slice, the methods on its surface) and carries no OTHER on/off member —
 *     a second boolean power field or setter is a second power control.
 *  2. A file that registers a native provider for a hinted cap registers that
 *     device's `switch` through `registerPowerSwitch` for the same cap. The
 *     providers not yet moved are listed by path with the reason; an entry
 *     that no longer needs its exemption fails, so the list only shrinks.
 */
import * as path from 'node:path'
import { z } from 'zod'
import type { CapabilityDefinition } from '../packages/types/src/capabilities/capability-definition.ts'
import { type SourceFile, walkSources } from './lib/walk-sources.ts'

export type PowerGuardFile = Pick<SourceFile, 'rel' | 'code'>

const REPO_ROOT = path.resolve(import.meta.dirname ?? __dirname, '..')

/** Member names that mean "on/off" on a device surface. */
const ON_OFF_FIELDS: ReadonlySet<string> = new Set([
  'on',
  'isOn',
  'power',
  'powerOn',
  'powered',
  'pumpRunning',
])
const ON_OFF_METHODS: ReadonlySet<string> = new Set([
  'turnOn',
  'turnOff',
  'setOn',
  'setPower',
  'setPowered',
  'setPump',
])

/** Providers of a hinted cap that do not project `switch`, each with why (follow-ups of #462 P1 unless stated). */
export const PENDING_POWER_SWITCH: ReadonlyMap<string, string> = new Map([
  [
    'packages/system/src/builtins/composer/composed-device.ts',
    'a composition declares its own `switch` feature; the composer moves with P2',
  ],
  [
    'packages/addon-import-alexa/src/devices/alexa-echo-device.ts',
    'not a follow-up: an Echo has no power control (turnOn / turnOff refuse unsupported)',
  ],
  [
    'packages/addon-matter-broker/src/devices/matter-endpoint-device.ts',
    'follow-up: Matter thermostat endpoint',
  ],
  [
    'packages/addon-provider-homematic/src/devices/hm-actuator-device.ts',
    'follow-up: Homematic thermostat actuator',
  ],
])

function sliceKeys(cap: CapabilityDefinition): ReadonlySet<string> {
  const schema = cap.runtimeState ?? cap.status?.schema
  return schema instanceof z.ZodObject ? new Set(Object.keys(schema.shape)) : new Set()
}

export function checkHintedCaps(caps: readonly CapabilityDefinition[]): readonly string[] {
  const failures: string[] = []
  for (const cap of caps) {
    const hint = cap.power
    if (hint === undefined) continue
    const fields = sliceKeys(cap)
    const methods = new Set(Object.keys(cap.methods))
    const named =
      hint.kind === 'field'
        ? [hint.set]
        : hint.kind === 'methods'
          ? [hint.on, hint.off]
          : [hint.set]
    if (!fields.has(hint.field))
      failures.push(`${cap.name}: power hint names field '${hint.field}', absent from its slice`)
    if (hint.kind === 'mode' && !fields.has(hint.lastField)) {
      failures.push(
        `${cap.name}: power hint names lastField '${hint.lastField}', absent from its slice`,
      )
    }
    for (const m of named) {
      if (!methods.has(m))
        failures.push(`${cap.name}: power hint names method '${m}', absent from the cap`)
    }
    for (const f of fields) {
      if (ON_OFF_FIELDS.has(f) && f !== hint.field) {
        failures.push(
          `${cap.name}: '${f}' is a second on/off field beside the power hint's '${hint.field}'`,
        )
      }
    }
    for (const m of methods) {
      if (ON_OFF_METHODS.has(m) && !named.includes(m)) {
        failures.push(`${cap.name}: '${m}' is a second on/off setter beside the power hint`)
      }
    }
  }
  return failures
}

const REGISTER_NATIVE = /registerNativeCap\(\s*(\w+Capability)\b/g

/** `hinted` maps the exported identifier of every hinted cap (`humidifierCapability`) to its name. */
export function checkProviderWiring(
  files: readonly PowerGuardFile[],
  hinted: ReadonlyMap<string, string>,
  pending: ReadonlyMap<string, string> = PENDING_POWER_SWITCH,
): readonly string[] {
  const failures: string[] = []
  const stillPending = new Set<string>()
  for (const file of files) {
    for (const match of file.code.matchAll(REGISTER_NATIVE)) {
      const ident = match[1]
      if (ident === undefined || !hinted.has(ident)) continue
      const wired = new RegExp(`registerPowerSwitch\\(\\s*this\\s*,\\s*${ident}\\b`).test(file.code)
      if (wired) continue
      if (pending.has(file.rel)) {
        stillPending.add(file.rel)
        continue
      }
      failures.push(
        `${file.rel}: registers ${ident} (power-hinted cap '${hinted.get(ident)}') without ` +
          `registerPowerSwitch(this, ${ident}, …) — its switch would be missing`,
      )
    }
  }
  for (const rel of pending.keys()) {
    if (!stillPending.has(rel))
      failures.push(
        `${rel}: listed in PENDING_POWER_SWITCH but no longer needs it — remove the entry`,
      )
  }
  return failures
}

/** The real tree: production sources only (specs register fakes). */
export function collectPowerGuardFiles(): readonly PowerGuardFile[] {
  return walkSources(REPO_ROOT, ['packages', 'server']).filter(
    (f) => !f.rel.includes('/generated/'),
  )
}
