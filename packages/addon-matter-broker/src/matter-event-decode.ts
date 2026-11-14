/**
 * Pure Matter EVENT decoder. A Matter event is something that happened once
 * (a keypad unlock, a button press), unlike an attribute, which is a state that
 * can be re-read. It maps onto the `event-emitter` cap: a token (`eventType`)
 * plus a small `data` record. No matter.js import — plain decoded payloads in,
 * plain tokens out, so it is unit-testable (mirrors `matter-attr-decode.ts`).
 *
 * An event this decoder does not map is returned as `dropped` WITH a reason: the
 * caller logs it (D391 — a branch that drops work names why), it never vanishes.
 */

import { MatterClusterId } from './matter-cluster-mapping.js'

/** DoorLock event ids. */
export const DoorLockEventId = {
  DoorLockAlarm: 0x00,
  DoorStateChange: 0x01,
  LockOperation: 0x02,
  LockOperationError: 0x03,
  LockUserChange: 0x04,
} as const

/** Switch event ids. */
export const SwitchEventId = {
  SwitchLatched: 0x00,
  InitialPress: 0x01,
  LongPress: 0x02,
  ShortRelease: 0x03,
  LongRelease: 0x04,
  MultiPressOngoing: 0x05,
  MultiPressComplete: 0x06,
} as const

export interface DecodedMatterEvent {
  readonly kind: 'event'
  /** The `event-emitter` token. Stable, kebab-case. */
  readonly eventType: string
  /** Serialisable detail (operation source, user index, press count…). */
  readonly data: Readonly<Record<string, string | number | boolean | null>>
}

export interface DroppedMatterEvent {
  readonly kind: 'dropped'
  /** Why nothing was emitted. Logged by the caller. */
  readonly reason: string
}

export type MatterEventDecoding = DecodedMatterEvent | DroppedMatterEvent

/** Every token a DoorLock endpoint can fire — the `event-emitter` vocabulary. */
export const LOCK_EVENT_TYPES: readonly string[] = [
  'locked',
  'unlocked',
  'unlatched',
  'user-event',
  'operation-error',
  'door-opened',
  'door-closed',
  'alarm-jammed',
  'alarm-factory-reset',
  'alarm-radio-power-cycled',
  'alarm-wrong-code-lockout',
  'alarm-tamper',
  'alarm-forced-open',
  'alarm-door-ajar',
  'alarm-forced-user',
]

/** Every token a Switch endpoint can fire. `multi-press-N` is open-ended. */
export const SWITCH_EVENT_TYPES: readonly string[] = [
  'latched',
  'initial-press',
  'long-press',
  'short-release',
  'long-release',
  'double-press',
]

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function num(payload: Record<string, unknown>, key: string): number | null {
  const v = payload[key]
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'bigint') return Number(v)
  return null
}

/** DoorLock.OperationSourceEnum. */
const OPERATION_SOURCE: ReadonlyMap<number, string> = new Map([
  [0, 'unspecified'],
  [1, 'manual'],
  [2, 'remote'],
  [3, 'keypad'],
  [4, 'auto'],
  [5, 'button'],
  [6, 'schedule'],
  [7, 'remote'],
  [8, 'rfid'],
  [9, 'biometric'],
])

/** DoorLock.LockOperationTypeEnum → token. */
const LOCK_OPERATION: ReadonlyMap<number, string> = new Map([
  [0, 'locked'],
  [1, 'unlocked'],
  [2, 'user-event'],
  [3, 'user-event'],
  [4, 'unlatched'],
])

/** DoorLock.OperationErrorEnum. */
const OPERATION_ERROR: ReadonlyMap<number, string> = new Map([
  [0, 'unspecified'],
  [1, 'invalid-credential'],
  [2, 'disabled-user-denied'],
  [3, 'restricted'],
  [4, 'insufficient-battery'],
])

/** DoorLock.AlarmCodeEnum → token. */
const ALARM_CODE: ReadonlyMap<number, string> = new Map([
  [0, 'alarm-jammed'],
  [1, 'alarm-factory-reset'],
  [3, 'alarm-radio-power-cycled'],
  [4, 'alarm-wrong-code-lockout'],
  [5, 'alarm-tamper'],
  [6, 'alarm-forced-open'],
  [7, 'alarm-door-ajar'],
  [8, 'alarm-forced-user'],
])

/** DoorLock.DoorStateEnum for DoorStateChange: open / closed are events, the rest are faults. */
function doorStateToken(doorState: number): string | null {
  if (doorState === 0) return 'door-opened'
  if (doorState === 1) return 'door-closed'
  return null
}

function decodeLockEvent(eventId: number, p: Record<string, unknown>): MatterEventDecoding {
  switch (eventId) {
    case DoorLockEventId.LockOperation: {
      const type = num(p, 'lockOperationType')
      const token = type === null ? undefined : LOCK_OPERATION.get(type)
      if (token === undefined) return { kind: 'dropped', reason: `lock-operation type ${type}` }
      const source = num(p, 'operationSource')
      return {
        kind: 'event',
        eventType: token,
        data: {
          source: (source !== null ? OPERATION_SOURCE.get(source) : undefined) ?? 'unspecified',
          userIndex: num(p, 'userIndex'),
        },
      }
    }
    case DoorLockEventId.LockOperationError: {
      const err = num(p, 'operationError')
      const source = num(p, 'operationSource')
      return {
        kind: 'event',
        eventType: 'operation-error',
        data: {
          error: (err !== null ? OPERATION_ERROR.get(err) : undefined) ?? 'unspecified',
          source: (source !== null ? OPERATION_SOURCE.get(source) : undefined) ?? 'unspecified',
          userIndex: num(p, 'userIndex'),
        },
      }
    }
    case DoorLockEventId.DoorLockAlarm: {
      const code = num(p, 'alarmCode')
      const token = code === null ? undefined : ALARM_CODE.get(code)
      if (token === undefined) return { kind: 'dropped', reason: `lock alarm code ${code}` }
      return { kind: 'event', eventType: token, data: {} }
    }
    case DoorLockEventId.DoorStateChange: {
      const state = num(p, 'doorState')
      const token = state === null ? null : doorStateToken(state)
      // Jammed / forced / ajar also fire DoorLockAlarm or the DoorState attribute.
      if (token === null)
        return {
          kind: 'dropped',
          reason: `door-state-change ${state} (attribute/alarm carries it)`,
        }
      return { kind: 'event', eventType: token, data: {} }
    }
    case DoorLockEventId.LockUserChange:
      return {
        kind: 'dropped',
        reason: 'lock-user-change (credential administration, not an access event)',
      }
    default:
      return { kind: 'dropped', reason: `unknown DoorLock event 0x${eventId.toString(16)}` }
  }
}

function decodeSwitchEvent(eventId: number, p: Record<string, unknown>): MatterEventDecoding {
  switch (eventId) {
    case SwitchEventId.InitialPress:
      return {
        kind: 'event',
        eventType: 'initial-press',
        data: { position: num(p, 'newPosition') },
      }
    case SwitchEventId.LongPress:
      return { kind: 'event', eventType: 'long-press', data: { position: num(p, 'newPosition') } }
    case SwitchEventId.ShortRelease:
      return {
        kind: 'event',
        eventType: 'short-release',
        data: { position: num(p, 'previousPosition') },
      }
    case SwitchEventId.LongRelease:
      return {
        kind: 'event',
        eventType: 'long-release',
        data: { position: num(p, 'previousPosition') },
      }
    case SwitchEventId.SwitchLatched:
      return { kind: 'event', eventType: 'latched', data: { position: num(p, 'newPosition') } }
    case SwitchEventId.MultiPressComplete: {
      const count = num(p, 'totalNumberOfPressesCounted')
      if (count === null || count < 1)
        return { kind: 'dropped', reason: 'multi-press-complete without a count' }
      // A single press is already reported by initial-press / short-release.
      if (count === 1)
        return {
          kind: 'dropped',
          reason: 'multi-press-complete of 1 (initial-press already fired)',
        }
      return {
        kind: 'event',
        eventType: count === 2 ? 'double-press' : `multi-press-${count}`,
        data: { count, position: num(p, 'previousPosition') },
      }
    }
    case SwitchEventId.MultiPressOngoing:
      return {
        kind: 'dropped',
        reason: 'multi-press-ongoing (the complete event carries the count)',
      }
    default:
      return { kind: 'dropped', reason: `unknown Switch event 0x${eventId.toString(16)}` }
  }
}

/** Decode one event. Pure + total: an unmapped event is `dropped` with a reason. */
export function decodeMatterEvent(input: {
  readonly clusterId: number
  readonly eventId: number
  readonly value: unknown
}): MatterEventDecoding {
  const payload = isRecord(input.value) ? input.value : {}
  if (input.clusterId === MatterClusterId.DoorLock) return decodeLockEvent(input.eventId, payload)
  if (input.clusterId === MatterClusterId.Switch) return decodeSwitchEvent(input.eventId, payload)
  return {
    kind: 'dropped',
    reason: `no event mapping for cluster 0x${input.clusterId.toString(16)} event 0x${input.eventId.toString(16)}`,
  }
}
