/**
 * The allowlist of programs an operator may open. The capability accepts a
 * `profileId`, never a command string: a free-form command would be remote code
 * execution as the server's user, on a camera server. See
 * docs/design/2026-07-26-terminal-session-design.md ("profileId, not a command").
 */
import { z } from 'zod'

const ProfileIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[a-z][a-z0-9-]*$/, 'must be a lowercase slug')

export const ConfiguredTerminalProfileSchema = z.object({
  enabled: z.boolean().default(true),
  profileId: ProfileIdSchema.refine((id) => !['monitor', 'top', 'glances', 'shell'].includes(id), {
    message: 'monitor, top, glances and shell are reserved profile IDs',
  }),
  label: z.string().trim().min(1).max(100),
  description: z.string().trim().max(500).optional().default(''),
  executable: z
    .string()
    .trim()
    .min(1)
    .max(1024)
    .refine((value) => !value.includes('\0'), {
      message: 'must not contain NUL bytes',
    }),
  args: z
    .array(
      z
        .string()
        .max(2048)
        .refine((value) => !value.includes('\0')),
    )
    .max(64)
    .default([]),
  cwd: z.string().trim().max(1024).optional().default(''),
  environment: z
    .array(
      z
        .string()
        .max(4096)
        .regex(/^[A-Za-z_][A-Za-z0-9_]*=.*/, 'must use NAME=value syntax'),
    )
    .max(64)
    .default([]),
})

export type ConfiguredTerminalProfile = z.infer<typeof ConfiguredTerminalProfileSchema>

export interface TerminalProfile {
  readonly profileId: string
  readonly label: string
  readonly description?: string
  /** Executable to spawn (resolved from PATH or an absolute path from config). */
  readonly file: string
  readonly args: readonly string[]
  readonly fallbacks?: readonly {
    readonly file: string
    readonly args: readonly string[]
  }[]
  readonly cwd?: string
  readonly env?: Readonly<Record<string, string>>
}

/**
 * Build the active profile list. `btmPath` overrides the monitor binary
 * location; `allowShell` adds an explicitly-labelled interactive shell, which is
 * OFF by default because it is the one profile that is genuinely a command
 * surface.
 */
export function buildProfiles(options: {
  readonly btmPath: string
  readonly btmEnabled?: boolean
  readonly btmArgs?: readonly string[]
  readonly topEnabled?: boolean
  readonly topPath?: string
  readonly topArgs?: readonly string[]
  readonly glancesEnabled?: boolean
  readonly glancesPath?: string
  readonly glancesArgs?: readonly string[]
  readonly glancesPythonPath?: string
  /** Extra spawn env for glances (e.g. the macOS curses shim's PYTHONPATH). */
  readonly glancesEnv?: Readonly<Record<string, string>>
  readonly allowShell: boolean
  readonly shellPath: string
  readonly customProfiles?: readonly unknown[]
  readonly onInvalid?: (message: string) => void
}): readonly TerminalProfile[] {
  const profiles: TerminalProfile[] = []
  if (options.btmEnabled !== false) {
    profiles.push({
      profileId: 'monitor',
      label: 'BTM',
      description: 'bottom (btm) — CPU, memory, network and process monitor',
      file: options.btmPath.trim().length > 0 ? options.btmPath.trim() : 'btm',
      args: options.btmArgs ?? [],
    })
  }
  if (options.topEnabled !== false) {
    profiles.push({
      profileId: 'top',
      label: 'Top',
      description: 'The operating system process and resource monitor',
      file: options.topPath?.trim() || 'top',
      args: options.topArgs ?? [],
    })
  }
  if (options.glancesEnabled !== false) {
    const configuredPath = options.glancesPath?.trim()
    const pythonPath = options.glancesPythonPath?.trim()
    profiles.push({
      profileId: 'glances',
      label: 'Glances',
      description: 'Cross-platform curses monitor installed in CamStack embedded Python',
      file: configuredPath || pythonPath || 'glances',
      args:
        configuredPath || !pythonPath
          ? (options.glancesArgs ?? [])
          : ['-m', 'glances', ...(options.glancesArgs ?? [])],
      ...(options.glancesEnv && Object.keys(options.glancesEnv).length > 0
        ? { env: options.glancesEnv }
        : {}),
    })
  }
  if (options.allowShell) {
    profiles.push({
      profileId: 'shell',
      label: 'Shell (interactive)',
      description: 'A full interactive login shell. Grants command execution as the server user.',
      file: options.shellPath.trim().length > 0 ? options.shellPath.trim() : '/bin/bash',
      args: ['-l'],
    })
  }
  const seen = new Set(profiles.map((profile) => profile.profileId))
  for (const raw of options.customProfiles ?? []) {
    const parsed = ConfiguredTerminalProfileSchema.safeParse(raw)
    if (!parsed.success) {
      options.onInvalid?.(
        `Invalid terminal profile: ${parsed.error.issues.map((issue) => issue.message).join('; ')}`,
      )
      continue
    }
    const configured = parsed.data
    if (!configured.enabled) continue
    if (seen.has(configured.profileId)) {
      options.onInvalid?.(`Duplicate terminal profile ID: ${configured.profileId}`)
      continue
    }
    seen.add(configured.profileId)
    const env = Object.fromEntries(
      configured.environment.map((entry) => {
        const separator = entry.indexOf('=')
        return [entry.slice(0, separator), entry.slice(separator + 1)]
      }),
    )
    profiles.push({
      profileId: configured.profileId,
      label: configured.label,
      ...(configured.description ? { description: configured.description } : {}),
      file: configured.executable,
      args: configured.args,
      ...(configured.cwd ? { cwd: configured.cwd } : {}),
      ...(Object.keys(env).length > 0 ? { env } : {}),
    })
  }
  return profiles
}

export function findProfile(
  profiles: readonly TerminalProfile[],
  profileId: string,
): TerminalProfile | undefined {
  return profiles.find((p) => p.profileId === profileId)
}
