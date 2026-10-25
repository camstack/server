/**
 * The spawn a one-shot ffmpeg site uses: the spec's seam when one is injected,
 * else the node's PINNED binary (D540), else `null` — and the site refuses by
 * name. There is no fourth answer: the `?? 'ffmpeg'` this replaces made "no
 * pinned build" mean "run the host's", silently, at every clip site that had it.
 *
 * Node-only (`node:child_process`), so it lives under `@camstack/types/node`.
 */
import { type ChildProcess, spawn, type SpawnOptions } from 'node:child_process'

/** One ffmpeg child from its argv. */
export type FfmpegArgvSpawn = (args: readonly string[]) => ChildProcess

/** The detail a site refusing for want of a binary puts in its refusal. */
export const NO_PINNED_FFMPEG_DETAIL = 'no pinned ffmpeg on this node'

/** What a site gets when it asks for its spawn: one, or the refusal to name. */
export type PinnedFfmpegSpawnAnswer =
  | { readonly kind: 'ready'; readonly spawn: FfmpegArgvSpawn }
  | { readonly kind: 'refused'; readonly detail: string }

/**
 * {@link pinnedFfmpegSpawner}, asked at the point of use through the node's
 * resolver (`memoizePinnedFfmpeg`). A site that keeps the RESOLVER rather than
 * a path captured at init recovers when a later resolution succeeds; a path
 * captured as `null` at boot stayed `null` until the runner restarted.
 */
export async function resolvePinnedFfmpegSpawner(
  seam: FfmpegArgvSpawn | undefined,
  resolveFfmpeg: () => Promise<string>,
  options: SpawnOptions,
): Promise<PinnedFfmpegSpawnAnswer> {
  if (seam !== undefined) return { kind: 'ready', spawn: seam }
  let ffmpegBinaryPath: string
  try {
    ffmpegBinaryPath = await resolveFfmpeg()
  } catch (err: unknown) {
    const reason = err instanceof Error ? err.message : String(err)
    return { kind: 'refused', detail: `${NO_PINNED_FFMPEG_DETAIL}: ${reason}` }
  }
  return { kind: 'ready', spawn: (args) => spawn(ffmpegBinaryPath, [...args], options) }
}

export function pinnedFfmpegSpawner(
  seam: FfmpegArgvSpawn | undefined,
  ffmpegBinaryPath: string | null,
  options: SpawnOptions,
): FfmpegArgvSpawn | null {
  if (seam !== undefined) return seam
  if (ffmpegBinaryPath === null) return null
  return (args) => spawn(ffmpegBinaryPath, [...args], options)
}
