import type { UpdateResult } from '@camstack/types'

export interface StagedUpdateInput {
  readonly name: string
  readonly version: string
  readonly stagedPath: string
}

export interface StagedUpdateTarget {
  applyStagedAddonUpdate(name: string, version: string, stagedPath: string): Promise<UpdateResult>
}

/**
 * The lifecycle engine marks a task `done` whenever its apply callback returns,
 * and `applyStagedAddonUpdate` reports a failed or refused swap as
 * `{ success: false }` instead of throwing. This adapter turns that result into
 * a throw so the task ends `failed` with the reason.
 */
export async function applyStagedOrThrow(
  target: StagedUpdateTarget,
  input: StagedUpdateInput,
): Promise<void> {
  const result = await target.applyStagedAddonUpdate(input.name, input.version, input.stagedPath)
  if (!result.success) {
    throw new Error(
      `Staged update of ${input.name}@${input.version} failed: ${result.error ?? 'unknown error'}`,
    )
  }
}
