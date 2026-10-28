/**
 * Agent UI update surface — the routes behind the agent-ui's Updates card.
 *
 * ── What can actually be done from an ISOLATED node ───────────────────────
 * The agent UI exists for the node nobody else can reach. So the split here
 * is not cosmetic:
 *
 *   • FRAMEWORK (`@camstack/server`) — fully local. `RootUpdateService`
 *     resolves `latest` with `npm view` and stages the closure with
 *     `npm install` straight from the registry (`node-root/root-update-service.ts`),
 *     then arms a swap-on-restart. The hub is not in that path at ANY point:
 *     a node left behind repairs itself. This is the high-value control.
 *
 *   • ADDONS — through the HUB. The hub's installed version is what every
 *     reconnect restores, so the only update that stays is "bring this node to
 *     the hub's version", asked of the hub over the mesh channel
 *     (`agent-hub-addon-update.ts`, D840). A newer published release is a
 *     hub-level decision.
 *
 * ── Registration + auth ──────────────────────────────────────────────────
 * Every path below sits under `/api/`, so `createAgentHttpServer`'s
 * `onRequest` hook gates it fail-closed (loopback, or
 * a hub-unlocked session Bearer). They are deliberately NOT in
 * `isPairingRequest`: an UNPAIRED agent must never let an unauthenticated
 * remote caller install code on it.
 *
 * And `applyServerUpdate` is reached with NO caller-supplied version — the
 * route always applies registry `latest`. An endpoint that installs an
 * arbitrary version string is a remote-code-execution primitive; the
 * dev-channel path (`camstack deploy-server`, which does take a version) stays
 * where it already is, on the hub's authenticated tRPC surface.
 */
import type { FastifyInstance } from 'fastify'
import type {
  ServerPackageStatus,
  ServerUpdateActionResult,
  ServerUpdateCheckResult,
} from '@camstack/types'
import type { AgentAddonUpdateEntry, AgentAddonUpdateReport } from './agent-addon-updates.js'
import {
  type AgentHubAddonControls,
  isBehindHub,
  type PackageUpdateProgress,
  type StartResult,
} from './agent-hub-addon-update.js'

// ---------------------------------------------------------------------------
// Engine seam
// ---------------------------------------------------------------------------

/**
 * The slice of `RootUpdateService` these routes use. Structural on purpose:
 * `AgentUpdateService` satisfies it as-is (no cast at the wiring site) and a
 * test supplies a plain object.
 */
export interface ServerUpdateEngine {
  getServerPackageStatus: () => Promise<ServerPackageStatus>
  checkServerUpdate: () => Promise<ServerUpdateCheckResult>
  applyServerUpdate: (input: { version?: string }) => Promise<ServerUpdateActionResult>
}

// ---------------------------------------------------------------------------
// View + result shapes
// ---------------------------------------------------------------------------

/** Everything the UI needs for the framework card, in one poll. */
export interface AgentServerUpdateView {
  readonly status: ServerPackageStatus
  /**
   * Why the last registry check produced no answer, or `null`. Separate from
   * the status because `getServerPackageStatus` cannot fail — a null
   * `latestVersion` with no error reads as "up to date", which is the exact
   * silence that made the desktop updater's failed checks invisible.
   */
  readonly lastCheckError: string | null
  /**
   * The outcome of the most recent apply, VERBATIM — refusals included
   * ("Refused: another operation is in flight (staging).",
   * "Refused: @camstack/server@X is already running."). These are the useful
   * sentences; the UI renders them rather than swallowing them.
   */
  readonly lastApply: ServerUpdateActionResult | null
  /** True while a stage is running — the UI's progress signal. */
  readonly applyInFlight: boolean
}

/** Discriminated so the UI can SAY why the card is empty. */
export type AgentServerUpdateResponse =
  | ({ readonly available: true } & AgentServerUpdateView)
  | { readonly available: false; readonly reason: string }

/**
 * One addon package as the agent UI lists it: this node's version, the
 * published release, the HUB's version (the authority for this node, D840) and
 * the state of the last Update pressed on it.
 */
export interface AgentAddonUpdateRow extends AgentAddonUpdateEntry {
  /** The version the hub has installed; `null` when the hub has none or was not asked. */
  readonly hubVersion: string | null
  /** The hub's version is newer than this node's: Update is offered. */
  readonly behindHub: boolean
  readonly update: PackageUpdateProgress | null
}

export interface AgentAddonUpdateView extends Omit<AgentAddonUpdateReport, 'entries'> {
  readonly entries: readonly AgentAddonUpdateRow[]
  /**
   * Whether the hub's versions are known: `unpaired` (not asked at all) or `unanswered`
   * (asked, no answer). Unknown is never "aligned".
   */
  readonly hubVersions: 'known' | 'unpaired' | 'unanswered'
}

export type AgentAddonUpdateResponse =
  | ({ readonly available: true } & AgentAddonUpdateView)
  | { readonly available: false; readonly reason: string }

/**
 * Reply to "start an apply". The apply itself is NOT awaited by the request:
 * staging is an `npm install` bounded at 15 minutes, and a request held open
 * that long shows the operator nothing. The caller polls the view instead —
 * `status.updateState` walks `staging` → `pending-restart` and `lastApply`
 * lands the final sentence.
 */
export interface AgentServerUpdateStartResult {
  readonly started: boolean
  /** Non-null when the START was refused (something is already running). */
  readonly message: string | null
}

/** The message a second concurrent apply gets. Exported so the test names it once. */
export const APPLY_ALREADY_RUNNING_MESSAGE = 'Refused: an update is already in flight on this node.'

// ---------------------------------------------------------------------------
// Controls
// ---------------------------------------------------------------------------

export interface AgentServerUpdateControls {
  getView: () => Promise<AgentServerUpdateView>
  check: () => Promise<ServerUpdateCheckResult>
  /** Always applies registry `latest` — no caller-supplied version. */
  applyLatest: () => AgentServerUpdateStartResult
}

export interface AgentAddonUpdateControls {
  getReport: () => Promise<AgentAddonUpdateReport>
  /** Asking the hub to update a package on this node (D840). Absent = report only. */
  readonly hub?: AgentHubAddonControls
}

/** Optional wiring passed through `AgentHttpConfig`. */
export interface AgentUpdateControls {
  readonly server?: AgentServerUpdateControls
  readonly addons?: AgentAddonUpdateControls
}

/**
 * Bind the routes' controls to a real update engine.
 *
 * The two remembered cells (`lastCheckError`, `lastApply`) mirror the engine's
 * own `checkCache`: an outcome an operator never sees is an outcome that did
 * not happen, and both of these arrive on a different tick from the poll that
 * has to render them.
 */
export function createAgentServerUpdateControls(
  engine: ServerUpdateEngine,
  onError?: (message: string) => void,
): AgentServerUpdateControls {
  let lastCheckError: string | null = null
  let lastApply: ServerUpdateActionResult | null = null
  let applyInFlight = false

  return {
    getView: async (): Promise<AgentServerUpdateView> => ({
      status: await engine.getServerPackageStatus(),
      lastCheckError,
      lastApply,
      applyInFlight,
    }),
    check: async (): Promise<ServerUpdateCheckResult> => {
      const result = await engine.checkServerUpdate()
      lastCheckError = result.error
      return result
    },
    applyLatest: (): AgentServerUpdateStartResult => {
      if (applyInFlight) {
        return { started: false, message: APPLY_ALREADY_RUNNING_MESSAGE }
      }
      applyInFlight = true
      lastApply = null
      void engine
        .applyServerUpdate({})
        .then((result) => {
          lastApply = result
          if (!result.accepted) onError?.(result.message)
        })
        .catch((err: unknown) => {
          const message = err instanceof Error ? err.message : String(err)
          lastApply = {
            accepted: false,
            targetVersion: null,
            restarting: false,
            message: `Update failed: ${message}`,
          }
          onError?.(message)
        })
        .finally(() => {
          applyInFlight = false
        })
      return { started: true, message: null }
    },
  }
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

/** Why the framework card renders empty when nothing was wired. */
export const SERVER_UPDATE_UNAVAILABLE_REASON =
  'Framework updates are not available on this agent build.'

/** Why the addon report renders empty when nothing was wired. */
export const ADDON_UPDATE_UNAVAILABLE_REASON =
  'The addon roster is not available on this agent build.'

/** Why the Update action is absent when the hub channel was not wired. */
export const ADDON_HUB_UPDATE_UNAVAILABLE_REASON =
  'Updating an addon through the hub is not available on this agent build.'

async function withHubVersions(
  report: AgentAddonUpdateReport,
  hub: AgentHubAddonControls | undefined,
): Promise<AgentAddonUpdateView> {
  const versions = hub === undefined ? null : await hub.getHubVersions()
  const progress = hub?.progress()
  return {
    ...report,
    hubVersions: versions === null || versions.ok ? 'known' : versions.reason,
    entries: report.entries.map((entry) => {
      const hubVersion =
        versions?.ok === true ? (versions.versions.get(entry.packageName) ?? null) : null
      return {
        ...entry,
        hubVersion,
        behindHub: isBehindHub(entry.installedVersion, hubVersion),
        update: progress?.get(entry.packageName) ?? null,
      }
    }),
  }
}

/**
 * Mount the update routes on an already-built agent HTTP server. Called from
 * `createAgentHttpServer` AFTER the auth hook, so every path here inherits it.
 */
export function registerAgentUpdateRoutes(
  app: FastifyInstance,
  controls: AgentUpdateControls,
): void {
  const server = controls.server
  const addons = controls.addons

  app.get('/api/agent/server-update', async (): Promise<AgentServerUpdateResponse> => {
    if (server === undefined) {
      return { available: false, reason: SERVER_UPDATE_UNAVAILABLE_REASON }
    }
    return { available: true, ...(await server.getView()) }
  })

  app.post('/api/agent/server-update/check', async (_req, reply) => {
    if (server === undefined) {
      return reply.status(503).send({ error: SERVER_UPDATE_UNAVAILABLE_REASON })
    }
    return server.check()
  })

  // No request body is read: the target is always registry `latest`.
  app.post('/api/agent/server-update/apply', async (_req, reply) => {
    if (server === undefined) {
      return reply.status(503).send({ error: SERVER_UPDATE_UNAVAILABLE_REASON })
    }
    return server.applyLatest()
  })

  app.get('/api/agent/addon-updates', async (): Promise<AgentAddonUpdateResponse> => {
    if (addons === undefined) {
      return { available: false, reason: ADDON_UPDATE_UNAVAILABLE_REASON }
    }
    const report = await addons.getReport()
    return { available: true, ...(await withHubVersions(report, addons.hub)) }
  })

  app.post<{ Body: { packageName?: unknown } }>(
    '/api/agent/addon-updates/update',
    async (req, reply): Promise<StartResult | undefined> => {
      if (addons?.hub === undefined) {
        return reply.status(503).send({ error: ADDON_HUB_UPDATE_UNAVAILABLE_REASON })
      }
      const packageName = req.body?.packageName
      if (typeof packageName !== 'string' || packageName.length === 0) {
        return reply.status(400).send({ error: 'packageName required' })
      }
      const report = await addons.getReport()
      return addons.hub.start(
        packageName,
        report.entries.map((e) => e.packageName),
      )
    },
  )
}
