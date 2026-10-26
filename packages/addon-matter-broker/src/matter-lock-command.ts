/**
 * DoorLock.lockDoor / unlockDoor arguments. The PIN is passed through on the
 * command only. It is never returned, logged, or stored — a lock that does
 * not require a PIN is invoked with an empty argument object.
 */

export type DoorLockCommandArgs = Record<string, never> | { readonly pinCode: string }

export type DoorLockCommandPlan =
  | { readonly ok: true; readonly args: DoorLockCommandArgs }
  | { readonly ok: false; readonly reason: 'pin-required' }

/**
 * Decide the command arguments. `pinRequired` comes from the live
 * RequirePinForRemoteOperation attribute, not from a stored secret.
 */
export function planDoorLockCommand(input: {
  readonly pinRequired: boolean
  readonly code: string | undefined
}): DoorLockCommandPlan {
  const code = input.code?.trim() ?? ''
  if (input.pinRequired && code.length === 0) {
    return { ok: false, reason: 'pin-required' }
  }
  if (code.length > 0) return { ok: true, args: { pinCode: code } }
  return { ok: true, args: {} }
}
