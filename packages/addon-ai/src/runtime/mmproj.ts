/**
 * Which GGUF is a multimodal PROJECTOR — the one question both the Hugging
 * Face resolver and the llama-server launcher ask, answered in one place.
 *
 * A projector is recognised by `mmproj` as a NAME TOKEN anywhere in the file's
 * basename, delimited by `-`, `_`, `.` or the ends (a precision may be glued
 * on: `mmprojfp16.gguf`). It used to be recognised
 * only as a PREFIX (`mmproj-F16.gguf`), and Prism ML — like several other
 * publishers — names it `Ternary-Bonsai-2-27B-mmproj-Q8_0.gguf`: the resolver
 * then offered the projector as a model candidate, and a model installed with
 * it launched WITHOUT `--mmproj`, blind, with nothing said. We do not read GGUF
 * headers (`general.type` / `clip.*`), so the name is the only signal there is.
 */
import type { ModelExtraFile } from '@camstack/types'

/**
 * `mmproj`, optionally glued to a precision (`mmprojfp16`, `mmproj-q8_0`),
 * then a delimiter or the end. Tested on the LOWERCASED basename; a longer
 * word (`mmprojector`) is not the token.
 */
const MMPROJ_TOKEN = /(?:^|[-_.])mmproj(?:bf16|fp?16|fp?32|fp8|i?q\d[a-z0-9_]*)?(?:[-_.]|$)/

function basename(filePath: string): string {
  return filePath.slice(filePath.lastIndexOf('/') + 1)
}

/** `true` when the file (path or basename) is a multimodal projector. */
export function isMmprojFile(filePath: string): boolean {
  return MMPROJ_TOKEN.test(basename(filePath).toLowerCase())
}

/** How an install's extra files read, for the launcher. */
export interface ProjectorScan {
  /** The projector llama-server gets as `--mmproj`, or absent. */
  readonly projector?: string
  /**
   * Extras that are neither a projector nor a shard of the main file. The
   * launcher cannot tell what they are, so they are named in a log line —
   * never silently ignored — because an unrecognised projector is exactly the
   * shape that used to lose vision without a word.
   */
  readonly unrecognised: readonly string[]
}

/**
 * The projector among the extra files — by NAME, never by position — and what
 * else is there. `isShard` recognises a weights shard (`hf-ref.shardInfoOf`),
 * injected so this module imports nothing the resolver imports back.
 */
export function scanExtraFiles(
  extraFiles: readonly ModelExtraFile[] | undefined,
  isShard: (filename: string) => boolean,
): ProjectorScan {
  const files = extraFiles ?? []
  const projector = files.find((f) => isMmprojFile(f.filename))?.filename
  const unrecognised = files
    .map((f) => f.filename)
    .filter((name) => !isMmprojFile(name) && !isShard(name))
  return projector === undefined ? { unrecognised } : { projector, unrecognised }
}
