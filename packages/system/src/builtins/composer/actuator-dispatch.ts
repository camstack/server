/**
 * The composed device calls this when an operator or an automation commands
 * the group. The composer installs the one dispatcher for the process.
 */
export interface ActuatorDispatchInput {
  readonly groupDeviceId: number
  readonly cap: string
  readonly method: string
  readonly args: Readonly<Record<string, unknown>>
}

export type ActuatorDispatcher = (input: ActuatorDispatchInput) => Promise<void>

let dispatcher: ActuatorDispatcher | null = null

export function setActuatorDispatcher(next: ActuatorDispatcher | null): void {
  dispatcher = next
}

export function actuatorDispatcher(): ActuatorDispatcher | null {
  return dispatcher
}
