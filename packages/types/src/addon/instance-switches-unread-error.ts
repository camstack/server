/**
 * The registry could not be read for the switches of an addon that serves instance kinds, so its
 * instances read off (D1066). A forked runner treats it as a failed boot: the supervisor respawns
 * it, bounded and marked terminally failed (D6), rather than leave instances off silently.
 */
export const INSTANCE_SWITCHES_UNREAD_ERROR_NAME = 'InstanceSwitchesUnreadError'

export class InstanceSwitchesUnreadError extends Error {
  constructor(readonly ownerId: string) {
    super(
      `'${ownerId}': the registry did not answer for the instance switches; its instances stay off`,
    )
    this.name = INSTANCE_SWITCHES_UNREAD_ERROR_NAME
  }
}

/** By name, so a second copy of this module in a bundle still matches. */
export function isInstanceSwitchesUnreadError(err: unknown): err is InstanceSwitchesUnreadError {
  return err instanceof Error && err.name === INSTANCE_SWITCHES_UNREAD_ERROR_NAME
}
