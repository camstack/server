/**
 * The trait catalog — one ROW per camstack capability, and that row is the
 * whole story for that capability: what SYNC declares, what QUERY reads, and
 * what EXECUTE writes.
 *
 * ## Why one row instead of three files
 *
 * `addon-export-alexa` splits the same three jobs across
 * `endpoints/builder.ts` (declare), `handlers/report-state.ts` (read) and
 * `handlers/power-controller.ts` + `handlers/brightness-controller.ts`
 * (write). Nothing binds them, so a capability can be declared and not
 * readable, or readable and not writable, and the compiler is happy either
 * way. That failure mode is already documented in this repo from the other
 * direction: `scripts/check-export-coverage.ts` exists because three
 * hand-written mapping tables (`CAP_ENTITY_MAP`, `SENSOR_MAP`,
 * `HAP_CAP_SERVICES`) drifted and disagree on field names to this day.
 *
 * Here declaration, read and write are three FIELDS of one object, so
 * "declared but unreadable" is not expressible: `buildSyncDevice`,
 * `projectQueryState` and `resolveExecuteCommand` all walk the same array.
 * `__tests__/trait-catalog.spec.ts` asserts the invariant over every row.
 *
 * ## What is deliberately absent
 *
 * Cameras. Google's `CameraStream` trait answers `GetCameraStream` with a
 * playable URL or a WebRTC signaling endpoint, and neither exists here yet, so
 * a camera would be declared and then fail every command. It is omitted rather
 * than declared — see docs/decisions/adr-0273-one-capability-is-one-trait-row-that-declares-reads-and-writes.md.
 */
import {
  BrightnessStatusSchema,
  CoverStatusSchema,
  DeviceFeature,
  LockControlStatusSchema,
  SwitchStatusSchema,
} from '@camstack/types'

import type { GoogleErrorCode, GoogleTraitName } from './protocol.js'

// ── Cap calls ───────────────────────────────────────────────────────

/**
 * A resolved capability call, as DATA. Pure trait code decides what to call;
 * `cap-dispatch.ts` is the single place that turns one of these into a typed
 * `ctx.api` invocation. Splitting it this way is what makes the whole mapping
 * testable without a tRPC client — and the union keeps `cap-dispatch` provably
 * exhaustive.
 */
export type CapCall =
  | { readonly kind: 'switch.setState'; readonly deviceId: number; readonly on: boolean }
  | {
      readonly kind: 'brightness.setBrightness'
      readonly deviceId: number
      readonly percentage: number
    }
  | { readonly kind: 'lockControl.lock'; readonly deviceId: number }
  | { readonly kind: 'lockControl.unlock'; readonly deviceId: number }
  | { readonly kind: 'cover.open'; readonly deviceId: number }
  | { readonly kind: 'cover.close'; readonly deviceId: number }
  | { readonly kind: 'cover.setPosition'; readonly deviceId: number; readonly position: number }

/** Which cap's `getStatus` a trait reads. Mirrors `CapCall`'s role for reads. */
export type CapStatusRead = 'switch' | 'brightness' | 'lockControl' | 'cover'

/**
 * The Google state a SUCCEEDED call establishes.
 *
 * EXECUTE echoes this rather than re-reading, and the reason is specific: a
 * lock that accepted `lock` sits in `locking` for seconds, so a read-back would
 * report `isLocked: false` and the Assistant would tell the operator the lock
 * did not work. The call resolved, so the intent was accepted — that is what is
 * being reported. It lives here, beside `CapCall`, so the fourth thing anyone
 * knows about a capability stays in the same file as the other three.
 */
export function statesAfterCall(call: CapCall): Readonly<Record<string, unknown>> {
  switch (call.kind) {
    case 'switch.setState':
      return { on: call.on }
    case 'brightness.setBrightness':
      return { brightness: Math.round(call.percentage) }
    case 'lockControl.lock':
      return { isLocked: true, isJammed: false }
    case 'lockControl.unlock':
      return { isLocked: false, isJammed: false }
    case 'cover.open':
      return { openPercent: 100 }
    case 'cover.close':
      return { openPercent: 0 }
    case 'cover.setPosition':
      return { openPercent: call.position }
    default: {
      const unreachable: never = call
      throw new Error(`unhandled cap call ${JSON.stringify(unreachable)}`)
    }
  }
}

// ── Resolution results ──────────────────────────────────────────────

export interface CommandCallResolution {
  readonly kind: 'call'
  readonly call: CapCall
}

/**
 * A command this trait will not perform. Carries the Google error code AND a
 * human reason — the reason is what gets LOGGED, because a branch that drops
 * work silently reads as "it never happened".
 */
export interface CommandRefusedResolution {
  readonly kind: 'refused'
  readonly errorCode: GoogleErrorCode
  readonly reason: string
}

export type CommandResolution = CommandCallResolution | CommandRefusedResolution

export interface TraitCommandInput {
  readonly deviceId: number
  readonly command: string
  readonly params: Readonly<Record<string, unknown>>
  /** `DeviceInfo.features` — gates positionable covers and PIN-locked locks. */
  readonly features: readonly string[]
}

/** A trait's contribution to one device's QUERY state, or `null` when the
 *  status payload did not parse as the cap's own schema. */
export type TraitState = Readonly<Record<string, unknown>> | null

export interface TraitDescriptor {
  /** camstack capability name, exactly as it appears in `getBindings`. */
  readonly capName: string
  readonly trait: GoogleTraitName
  /** Which cap status this trait's `projectState` consumes. */
  readonly reads: CapStatusRead
  /** SYNC attributes contributed by this trait for a device with `features`. */
  readonly attributes: (features: readonly string[]) => Readonly<Record<string, unknown>>
  /** Cap `getStatus` payload → Google state fields. `null` on a shape we do not recognise. */
  readonly projectState: (rawStatus: unknown) => TraitState
  /** Every `action.devices.commands.*` this trait answers. */
  readonly commands: readonly string[]
  readonly resolveCommand: (input: TraitCommandInput) => CommandResolution
}

// ── Param readers ───────────────────────────────────────────────────
//
// EXECUTE params arrive as `Record<string, unknown>` straight off the wire, so
// every read is typeof-guarded. No casts.

function readBoolean(params: Readonly<Record<string, unknown>>, key: string): boolean | null {
  const value = params[key]
  return typeof value === 'boolean' ? value : null
}

function readPercent(params: Readonly<Record<string, unknown>>, key: string): number | null {
  const value = params[key]
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  if (value < 0 || value > 100) return null
  return value
}

function unsupportedCommand(command: string): CommandRefusedResolution {
  return {
    kind: 'refused',
    errorCode: 'functionNotSupported',
    reason: `command ${command} is not answered by this trait`,
  }
}

// ── The catalog ─────────────────────────────────────────────────────

const onOffTrait: TraitDescriptor = {
  capName: 'switch',
  trait: 'action.devices.traits.OnOff',
  reads: 'switch',
  attributes: () => ({}),
  projectState: (rawStatus) => {
    const parsed = SwitchStatusSchema.safeParse(rawStatus)
    return parsed.success ? { on: parsed.data.on } : null
  },
  commands: ['action.devices.commands.OnOff'],
  resolveCommand: ({ deviceId, command, params }) => {
    if (command !== 'action.devices.commands.OnOff') return unsupportedCommand(command)
    const on = readBoolean(params, 'on')
    if (on === null) {
      return {
        kind: 'refused',
        errorCode: 'notSupported',
        reason: 'OnOff called without a boolean `on` param',
      }
    }
    return { kind: 'call', call: { kind: 'switch.setState', deviceId, on } }
  },
}

const brightnessTrait: TraitDescriptor = {
  capName: 'brightness',
  trait: 'action.devices.traits.Brightness',
  reads: 'brightness',
  attributes: () => ({}),
  projectState: (rawStatus) => {
    const parsed = BrightnessStatusSchema.safeParse(rawStatus)
    // Google's `brightness` is an integer 0..100; the cap allows fractions.
    return parsed.success ? { brightness: Math.round(parsed.data.level) } : null
  },
  commands: ['action.devices.commands.BrightnessAbsolute'],
  resolveCommand: ({ deviceId, command, params }) => {
    if (command !== 'action.devices.commands.BrightnessAbsolute') {
      // `BrightnessRelative` needs the CURRENT level to resolve, and this
      // function is pure by contract. Refusing is honest; guessing 0 is not.
      return unsupportedCommand(command)
    }
    const percentage = readPercent(params, 'brightness')
    if (percentage === null) {
      return {
        kind: 'refused',
        errorCode: 'valueOutOfRange',
        reason: 'BrightnessAbsolute called without a 0..100 `brightness` param',
      }
    }
    return { kind: 'call', call: { kind: 'brightness.setBrightness', deviceId, percentage } }
  },
}

const lockUnlockTrait: TraitDescriptor = {
  capName: 'lock-control',
  trait: 'action.devices.traits.LockUnlock',
  reads: 'lockControl',
  attributes: () => ({}),
  projectState: (rawStatus) => {
    const parsed = LockControlStatusSchema.safeParse(rawStatus)
    if (!parsed.success) return null
    // `locking` / `unlocking` are in-transit and Google has no representation
    // for them: report the STABLE fact (is it locked right now), never the
    // target, so a failed transition cannot leave Google saying "locked".
    return {
      isLocked: parsed.data.state === 'locked',
      isJammed: parsed.data.state === 'jammed',
    }
  },
  commands: ['action.devices.commands.LockUnlock'],
  resolveCommand: ({ deviceId, command, params, features }) => {
    if (command !== 'action.devices.commands.LockUnlock') return unsupportedCommand(command)
    if (features.includes(DeviceFeature.LockPinRequired)) {
      // The cap takes an optional `code`; Google's LockUnlock carries no PIN.
      // Dispatching anyway produces an upstream failure the operator cannot
      // read, so refuse where the reason is still known.
      return {
        kind: 'refused',
        errorCode: 'functionNotSupported',
        reason: 'lock requires a PIN and Google LockUnlock carries none',
      }
    }
    const lock = readBoolean(params, 'lock')
    if (lock === null) {
      return {
        kind: 'refused',
        errorCode: 'notSupported',
        reason: 'LockUnlock called without a boolean `lock` param',
      }
    }
    return {
      kind: 'call',
      call: lock
        ? { kind: 'lockControl.lock', deviceId }
        : { kind: 'lockControl.unlock', deviceId },
    }
  },
}

const openCloseTrait: TraitDescriptor = {
  capName: 'cover',
  trait: 'action.devices.traits.OpenClose',
  reads: 'cover',
  attributes: (features) => ({
    // A cover with no intermediate position is `discreteOnly`: Google then
    // only ever sends openPercent 0 or 100 and renders an open/close button
    // instead of a slider.
    discreteOnlyOpenClose: !features.includes(DeviceFeature.CoverPositionable),
  }),
  projectState: (rawStatus) => {
    const parsed = CoverStatusSchema.safeParse(rawStatus)
    if (!parsed.success) return null
    const { position, state } = parsed.data
    if (position !== null) return { openPercent: position }
    // Positionless cover: Google's discrete OpenClose has exactly two values,
    // so anything that is not closed (or on its way there) reads as open.
    const closed = state === 'closed' || state === 'closing'
    return { openPercent: closed ? 0 : 100 }
  },
  commands: ['action.devices.commands.OpenClose'],
  resolveCommand: ({ deviceId, command, params, features }) => {
    if (command !== 'action.devices.commands.OpenClose') return unsupportedCommand(command)
    if ('openRelativePercent' in params && !('openPercent' in params)) {
      // Relative moves need the current position, which a pure resolver does
      // not have. `discreteOnlyOpenClose` tells Google not to send these.
      return {
        kind: 'refused',
        errorCode: 'functionNotSupported',
        reason: 'openRelativePercent is not supported — send an absolute openPercent',
      }
    }
    const openPercent = readPercent(params, 'openPercent')
    if (openPercent === null) {
      return {
        kind: 'refused',
        errorCode: 'valueOutOfRange',
        reason: 'OpenClose called without a 0..100 `openPercent` param',
      }
    }
    if (features.includes(DeviceFeature.CoverPositionable)) {
      return { kind: 'call', call: { kind: 'cover.setPosition', deviceId, position: openPercent } }
    }
    return {
      kind: 'call',
      call: openPercent > 0 ? { kind: 'cover.open', deviceId } : { kind: 'cover.close', deviceId },
    }
  },
}

/**
 * Every capability this addon exports, in declaration order. SYNC emits traits
 * in this order, which keeps a device's trait list stable across syncs.
 */
export const TRAIT_CATALOG: readonly TraitDescriptor[] = [
  onOffTrait,
  brightnessTrait,
  lockUnlockTrait,
  openCloseTrait,
]

/** Capability names the catalog covers — the coverage question, answered once. */
export const EXPORTED_CAP_NAMES: readonly string[] = TRAIT_CATALOG.map((t) => t.capName)

/** Rows matching a device's bound capabilities, in catalog order. */
export function traitsForCaps(capNames: readonly string[]): readonly TraitDescriptor[] {
  return TRAIT_CATALOG.filter((descriptor) => capNames.includes(descriptor.capName))
}

/** The row that answers `command` for a device carrying `capNames`, or null. */
export function traitForCommand(
  capNames: readonly string[],
  command: string,
): TraitDescriptor | null {
  return traitsForCaps(capNames).find((descriptor) => descriptor.commands.includes(command)) ?? null
}
