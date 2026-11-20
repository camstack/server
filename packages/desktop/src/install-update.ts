/**
 * "Install the downloaded update and restart" — only when the native updater can do it.
 *
 * `quitAndInstall` emits `before-quit-for-update` BEFORE the native updater (Squirrel.Mac) decides,
 * and the shell marks itself as quitting on that event. An update that is downloaded but not
 * staged is refused ("The command is disabled and cannot be executed"), the app never quits, and
 * the mark sticks, so the node's next exit is not relaunched (2026-11-20, 3/3 server updates).
 * So a not-staged update is NEVER handed to `quitAndInstall`: the native updater is nudged and
 * the refusal is said. A throw from `quitAndInstall` is caught and said, never left unhandled.
 * Free of `electron`; `auto-updater.ts` supplies the effects.
 */
export type InstallOutcome =
  | { readonly kind: 'installing' }
  | { readonly kind: 'refused-not-staged' }
  | { readonly kind: 'failed'; readonly message: string }

export interface InstallUpdateDeps {
  /** null on a platform without a native staging step. */
  readonly isStaged: (() => boolean) | null
  readonly nudgeIfNotStaged: () => void
  readonly quitAndInstall: () => void
  readonly warn: (line: string) => void
}

export function installUpdateIfStaged(deps: InstallUpdateDeps): InstallOutcome {
  if (deps.isStaged !== null && !deps.isStaged()) {
    try {
      deps.nudgeIfNotStaged()
    } catch (err) {
      deps.warn(`[updater] nudging the native updater failed: ${errorText(err)}`)
    }
    deps.warn(
      '[updater] install refused: the native updater has not staged the downloaded update (it would answer "The command is disabled"); not quitting',
    )
    return { kind: 'refused-not-staged' }
  }
  try {
    deps.quitAndInstall()
    return { kind: 'installing' }
  } catch (err) {
    const message = errorText(err)
    deps.warn(`[updater] quitAndInstall failed: ${message}`)
    return { kind: 'failed', message }
  }
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
