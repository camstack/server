/**
 * The command follow-up (D1062): the work a device command waits for before
 * its caller hears the answer.
 *
 * The D1022 seams that observe a command (the hub tRPC mount, the UDS parent,
 * an in-process hub addon's `ctx.api`) also await this hook once the
 * provider's call settled — the hub's state-refresh scheduler re-reads the
 * device there, so the command returns after the real state was pushed.
 *
 * Unlike the observation (telemetry, D8) this one is awaited, but it is never
 * a gate: a follow-up that throws is swallowed here, and the call's own result
 * or error is what the caller gets. Cost when nothing is registered: one
 * undefined check (D181).
 */
import { isCommand } from '@camstack/types/addon'

/** The device command a follow-up is about. */
export interface CommandFollowUpTarget {
  readonly deviceId: number
  readonly capName: string
  readonly method: string
}

/** How the provider's call ended. */
export type CommandCallOutcome = 'ok' | 'failed'

export type CommandFollowUp = (
  target: CommandFollowUpTarget,
  outcome: CommandCallOutcome,
) => Promise<void>

/** The one follow-up of this process (the hub's device-manager installs it). */
export class CommandFollowUpRegistry {
  private handler: CommandFollowUp | null = null

  /** Install (or, with `null`, remove) the follow-up. Returns the uninstall. */
  set(handler: CommandFollowUp | null): () => void {
    this.handler = handler
    return () => {
      if (this.handler === handler) this.handler = null
    }
  }

  /** Run the follow-up for a settled command. Never throws. */
  async run(target: CommandFollowUpTarget, outcome: CommandCallOutcome): Promise<void> {
    const handler = this.handler
    if (handler === null) return
    try {
      await handler(target, outcome)
    } catch {
      // The follow-up logs its own failures; it never fails the command.
    }
  }
}

let registry: CommandFollowUpRegistry | undefined

/** The process-wide registry. */
export function getCommandFollowUpRegistry(): CommandFollowUpRegistry {
  registry ??= new CommandFollowUpRegistry()
  return registry
}

/** Test seam: forget the handler. */
export function __resetCommandFollowUpRegistryForTests(): void {
  registry = undefined
}

/** The target of a call when it is a device command naming a device, else `null`. */
export function commandFollowUpTarget(
  capName: string,
  method: string,
  deviceId: number | undefined,
): CommandFollowUpTarget | null {
  if (deviceId === undefined || !Number.isInteger(deviceId)) return null
  if (!isCommand(capName, method)) return null
  return { deviceId, capName, method }
}

/** The `deviceId` an args object names, or `undefined`. */
export function deviceIdOfArgs(args: unknown): number | undefined {
  if (args === null || typeof args !== 'object' || Array.isArray(args)) return undefined
  const deviceId: unknown = Reflect.get(args, 'deviceId')
  return typeof deviceId === 'number' && Number.isInteger(deviceId) ? deviceId : undefined
}

/**
 * Await `result`, then the follow-up, then answer with `result` — its value, or
 * its error rethrown. Without a follow-up or a target, `result` is returned
 * untouched.
 */
export function withCommandFollowUp<T>(
  followUp: CommandFollowUp | undefined,
  target: CommandFollowUpTarget | null,
  result: T,
): T | Promise<Awaited<T>> {
  if (followUp === undefined || target === null) return result
  return settleThenFollowUp(followUp, target, result)
}

async function settleThenFollowUp<T>(
  followUp: CommandFollowUp,
  target: CommandFollowUpTarget,
  result: T,
): Promise<Awaited<T>> {
  let value: Awaited<T>
  try {
    value = await result
  } catch (err: unknown) {
    await runCommandFollowUp(followUp, target, 'failed')
    throw err
  }
  await runCommandFollowUp(followUp, target, 'ok')
  return value
}

/** Run `followUp` for a settled command, swallowing its failure. */
export async function runCommandFollowUp(
  followUp: CommandFollowUp,
  target: CommandFollowUpTarget,
  outcome: CommandCallOutcome,
): Promise<void> {
  try {
    await followUp(target, outcome)
  } catch {
    // Never a gate, see the module doc.
  }
}
