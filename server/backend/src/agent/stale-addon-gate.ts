/**
 * The support judgement for an addon whose package may be stale (#346, D989).
 *
 * After `applyServerUpdate` a node restarts with the addons already on disk. An
 * addon built for the previous framework may be BELOW what the new server
 * requires. It is still started - a held-back addon is invisible and loses its
 * function silently, and the `CrashSupervisor` (D6) bounds a crash loop - but
 * the operator is told: `judgeSupport` produces the facts of the alert (addon,
 * installed version, required minimum, server version) and the caller hands them
 * to the `UnsupportedAddonTracker`. The reconcile (D982) still moves the package
 * toward the required version.
 *
 * Unsupported means either:
 *   - the RUNNING server requires a newer version of this addon's package
 *     (`requires.addons` of the server), or
 *   - the addon's own `requires.server` is above the running server.
 *
 * A fact that cannot be read is UNKNOWN: no alert, the addon runs, and it is
 * reported in `unjudged` so the caller logs it. That covers a package whose own
 * `requires` cannot be read (missing, malformed or schema-invalid package.json)
 * and a running server version that cannot be read (the addon's own
 * `requires.server` is then unjudged; the addon-minimum check still runs).
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import {
  PackageRequiresSchema,
  describeUnmet,
  unmetRequirements,
  type PackageRequires,
  type UnmetRequirement,
} from '@camstack/types'
import type { UnsupportedAddonFacts, UnsupportedAddonTracker } from '@camstack/server/system'
import type { GroupCandidate } from './agent-group-runner.js'

/** What the gate needs to know about the node. */
export interface StaleGateContext {
  /** The running `@camstack/server`, or `null` when unreadable. */
  readonly serverVersion: string | null
  /** What the running server requires of addon packages (`requires.addons`). */
  readonly serverRequiresAddons: Readonly<Record<string, string>>
  /** Installed addon package versions, by package name. */
  readonly installedVersions: Readonly<Record<string, string | null>>
  /** The `camstack.requires` of the package in `addonDir`; `UnreadableRequires` when it cannot be read. */
  readonly requiresOfDir: (addonDir: string) => PackageRequires | UnreadableRequires | undefined
}

/** A package.json that could not be read as a `requires` source, and why. */
export interface UnreadableRequires {
  readonly unreadable: string
}

export function isUnreadableRequires(
  value: PackageRequires | UnreadableRequires | undefined,
): value is UnreadableRequires {
  return value !== undefined && 'unreadable' in value
}

export interface UnsupportedCandidate {
  readonly candidate: GroupCandidate
  readonly unmet: readonly UnmetRequirement[]
  /** One line naming the addon and both versions of every unmet requirement. */
  readonly reason: string
}

export interface SupportJudgement {
  /** Candidates below their minimum: they run, and the operator is alerted. */
  readonly unsupported: readonly UnsupportedCandidate[]
  /** Candidates run although a fact needed to judge them was unknown; one line each. */
  readonly unjudged: readonly string[]
}

export function judgeSupport(
  candidates: readonly GroupCandidate[],
  context: StaleGateContext,
): SupportJudgement {
  const unsupported: UnsupportedCandidate[] = []
  const unjudged: string[] = []
  for (const candidate of candidates) {
    const minimum = context.serverRequiresAddons[candidate.packageName]
    const fromServer = unmetRequirements(
      minimum === undefined ? undefined : { addons: { [candidate.packageName]: minimum } },
      { server: context.serverVersion, addons: context.installedVersions, wrapper: null },
    )
    const read = context.requiresOfDir(candidate.addonDir)
    const label = `addon "${candidate.addonId}" (${candidate.packageName}@${candidate.packageVersion})`
    if (isUnreadableRequires(read)) {
      unjudged.push(
        `${label} runs unjudged: its package requirements could not be read (${read.unreadable})`,
      )
      continue
    }
    const own = read
    if (context.serverVersion === null && own?.server !== undefined) {
      unjudged.push(
        `${label} runs unjudged: it requires server ${own.server} and the running server version is unknown`,
      )
    }
    const fromAddon =
      context.serverVersion === null
        ? []
        : unmetRequirements(own?.server === undefined ? undefined : { server: own.server }, {
            server: context.serverVersion,
            addons: {},
            wrapper: null,
          })
    const unmet = [...fromServer, ...fromAddon]
    if (unmet.length > 0) unsupported.push(unsupportedOf(candidate, label, unmet))
  }
  return { unsupported, unjudged }
}

function unsupportedOf(
  candidate: GroupCandidate,
  label: string,
  unmet: readonly UnmetRequirement[],
): UnsupportedCandidate {
  return {
    candidate,
    unmet,
    reason: `${label} runs below what this server requires: ${unmet.map(describeUnmet).join('; ')}`,
  }
}

/** The tracker's facts for one unsupported candidate. */
export function supportFactsOf(
  entry: UnsupportedCandidate,
  serverVersion: string | null,
): UnsupportedAddonFacts {
  const addonMinimum = entry.unmet.find((u) => u.kind === 'addon-too-old')
  return {
    packageName: entry.candidate.packageName,
    addonId: entry.candidate.addonId,
    installedVersion: entry.candidate.packageVersion,
    serverVersion,
    requiredMinimum: addonMinimum === undefined ? null : addonMinimum.required,
    unmet: entry.unmet.map(describeUnmet),
  }
}

/**
 * Judge `candidates`, log what could not be judged and what runs unsupported, and
 * hand the verdict to the tracker. EVERY candidate is spawned by the caller.
 */
export function reportSupport(
  candidates: readonly GroupCandidate[],
  context: StaleGateContext,
  tracker: UnsupportedAddonTracker,
  log: (line: string) => void,
): void {
  const { unsupported, unjudged } = judgeSupport(candidates, context)
  for (const line of unjudged) log(line)
  for (const entry of unsupported) log(entry.reason)
  tracker.observe(
    candidates.map((c) => c.packageName),
    unsupported.map((entry) => supportFactsOf(entry, context.serverVersion)),
  )
}

/**
 * `camstack.requires` of the package.json in `dir`: `undefined` when the package
 * declares none, `UnreadableRequires` when the file is missing, not JSON, or
 * declares a `requires` the schema rejects (never a pass).
 */
export function readPackageRequires(dir: string): PackageRequires | UnreadableRequires | undefined {
  let raw: unknown
  try {
    raw = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf-8'))
  } catch (err) {
    return { unreadable: `package.json: ${err instanceof Error ? err.message : String(err)}` }
  }
  if (typeof raw !== 'object' || raw === null)
    return { unreadable: 'package.json is not an object' }
  const camstack: unknown = Reflect.get(raw, 'camstack')
  if (camstack === undefined) return undefined
  if (typeof camstack !== 'object' || camstack === null) {
    return { unreadable: 'package.json "camstack" is not an object' }
  }
  const declared: unknown = Reflect.get(camstack, 'requires')
  if (declared === undefined) return undefined
  const parsed = PackageRequiresSchema.safeParse(declared)
  return parsed.success
    ? parsed.data
    : {
        unreadable: `camstack.requires is malformed: ${parsed.error.issues[0]?.message ?? 'invalid'}`,
      }
}
