/**
 * Workspace confinement for every path a tool reads from an argument or writes
 * to (plan §3.10: "writes are confined to the workspace root").
 *
 * Lexical containment is not enough: a symlink inside the workspace can point
 * out of it. An existing path is therefore resolved with `realpath` before it
 * is compared; a path that does not exist yet is judged by its nearest
 * existing ancestor.
 */
import * as fs from 'node:fs'
import * as path from 'node:path'

export class ConfinementError extends Error {
  constructor(candidate: string) {
    super(`path is outside the workspace: ${candidate}`)
    this.name = 'ConfinementError'
  }
}

function inside(root: string, abs: string): boolean {
  const rel = path.relative(root, abs)
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

function realOfNearestAncestor(abs: string): string {
  let current = abs
  const tail: string[] = []
  for (;;) {
    try {
      return path.join(fs.realpathSync(current), ...tail.toReversed())
    } catch {
      const parent = path.dirname(current)
      if (parent === current) return abs
      tail.push(path.basename(current))
      current = parent
    }
  }
}

/** Absolute path of `candidate` under `root`, or throws {@link ConfinementError}. */
export function confine(root: string, candidate: string): string {
  const realRoot = fs.realpathSync(root)
  const abs = path.resolve(root, candidate)
  if (!inside(path.resolve(root), abs)) throw new ConfinementError(candidate)
  const real = realOfNearestAncestor(abs)
  if (!inside(realRoot, real)) throw new ConfinementError(candidate)
  return abs
}
