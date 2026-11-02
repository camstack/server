import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { resolveRunnerId } from '@camstack/types'
import { z } from 'zod'

/**
 * The runner an addon runs in, for a process that has no kernel resolver.
 *
 * `ctx.kernel.runnerIdForAddon` exists only in hub in-process contexts. The
 * engine's own runner (`sqlite-settings`, `execution.isolate`) is forked: its
 * kernel has no resolver, yet a grouped owner (`homeassistant-export`, group
 * `integrations`) reaches it stamped with its RUNNER id. The answer is the one
 * the hub gives — `resolveRunnerId` over the addon's installed manifest — read
 * from the addons directory every node already has. An addon that is not
 * installed resolves to itself, so a stamp is never accepted for a stranger.
 */
const ManifestSchema = z.object({
  camstack: z
    .object({
      addons: z.array(
        z.object({
          id: z.string(),
          execution: z.object({ group: z.string().optional() }).passthrough().optional(),
        }),
      ),
    })
    .partial()
    .optional(),
})

type Declaration = Parameters<typeof resolveRunnerId>[0]

function packageDirs(addonsDir: string): readonly string[] {
  const dirs: string[] = []
  try {
    for (const entry of readdirSync(addonsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const entryDir = path.join(addonsDir, entry.name)
      if (!entry.name.startsWith('@')) {
        dirs.push(entryDir)
        continue
      }
      for (const scoped of readdirSync(entryDir, { withFileTypes: true })) {
        if (scoped.isDirectory()) dirs.push(path.join(entryDir, scoped.name))
      }
    }
  } catch {
    return dirs
  }
  return dirs
}

function declarationsIn(dir: string): readonly { id: string; decl: Declaration }[] {
  try {
    const parsed = ManifestSchema.safeParse(
      JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf-8')),
    )
    if (!parsed.success) return []
    return (parsed.data.camstack?.addons ?? []).map((addon) => ({
      id: addon.id,
      decl: addon.execution === undefined ? {} : { execution: addon.execution },
    }))
  } catch {
    return []
  }
}

export function installedRunnerResolver(addonsDir: string): (addonId: string) => string {
  return (addonId) => {
    for (const dir of packageDirs(addonsDir)) {
      for (const { id, decl } of declarationsIn(dir)) {
        if (id === addonId) return resolveRunnerId(decl, addonId)
      }
    }
    return addonId
  }
}

/** The kernel's resolver where the context has one (hub in-process), else the installed manifests. */
export function runnerResolverFor(
  kernelResolver: ((addonId: string) => string) | undefined,
  addonsDir: string,
): (addonId: string) => string {
  return kernelResolver ?? installedRunnerResolver(addonsDir)
}
