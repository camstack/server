/**
 * The addon a grouped child acts for (the records owner).
 *
 * A grouped runner is stamped with its GROUP id by the transport, and the group can change when
 * the grouping does; the data of the caps below is keyed by the ADDON, which never changes. The
 * child therefore claims the addon it acts for, and the parent checks the claim against its own
 * runner map before it stamps the call with it.
 */

/** The caps whose rows and secret refs are keyed by the calling ADDON, not by its runner. */
export const ADDON_KEYED_CAPS: readonly string[] = ['records']

/** A child claimed an addon its runner does not host. Typed so a caller can tell it from a crash. */
export class ActingAddonRefusedError extends Error {
  readonly code = 'acting-addon-not-hosted'
  constructor(
    readonly runnerId: string,
    readonly claimedAddonId: string,
  ) {
    super(
      `acting-addon-not-hosted: runner "${runnerId}" does not host addon "${claimedAddonId}"; the call is refused`,
    )
    this.name = 'ActingAddonRefusedError'
  }
}
