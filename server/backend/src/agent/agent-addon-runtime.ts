/**
 * ONE list for the agent UI: every addon on this node with the runner that
 * hosts it (D841). It used to be two lists — `$agent.status` addons and
 * `$process.list` runners — that the operator had to join by eye.
 *
 * The addon → runner link is the runner's own `addonIds`, which the process
 * service fills from the runner it actually spawned (`resolveRunnerId` at spawn
 * time). Nothing here (and nothing in the UI) re-derives a grouping: an addon
 * shares a runner exactly when the process service listed it in that runner's
 * `addonIds`. A runner hosting no known addon is still a row, so a stray
 * process stays visible.
 */

/** The slice of `$agent.status`'s addon rows this join reads. */
export interface RuntimeAddonInput {
  readonly id: string
  readonly status: string
  readonly version?: string
  readonly packageName?: string
}

/** The slice of a `$process.list` row this join reads. */
export interface RuntimeProcessInput {
  readonly name: string
  readonly pid: number
  readonly state: string
  readonly groupId: string
  readonly addonIds: readonly string[]
  readonly cpuPercent: number
  readonly memoryRss: number
  readonly uptimeSeconds: number
}

/** The runner an addon lives in, as the row shows it. */
export interface AddonRuntimeRunner {
  readonly name: string
  readonly pid: number
  readonly state: string
  /** The runner label (`resolveRunnerId`); the same label on several rows = one shared process. */
  readonly groupId: string
  readonly cpuPercent: number
  readonly memoryRss: number
  readonly uptimeSeconds: number
  /** Every addon in this runner, this one included. */
  readonly addonIds: readonly string[]
}

export interface AddonRuntimeRow {
  /** Stable row key: the addon id, or `runner:<name>` for a runner with no known addon. */
  readonly key: string
  readonly kind: 'addon' | 'runner'
  /** `null` on a runner row. */
  readonly addonId: string | null
  readonly packageName: string | null
  readonly version: string | null
  readonly status: string
  /** `null` = the addon runs inside the agent process itself. */
  readonly runner: AddonRuntimeRunner | null
}

function toRunner(p: RuntimeProcessInput): AddonRuntimeRunner {
  return {
    name: p.name,
    pid: p.pid,
    state: p.state,
    groupId: p.groupId,
    cpuPercent: p.cpuPercent,
    memoryRss: p.memoryRss,
    uptimeSeconds: p.uptimeSeconds,
    addonIds: p.addonIds,
  }
}

export function joinAddonRuntime(
  addons: readonly RuntimeAddonInput[],
  processes: readonly RuntimeProcessInput[],
): readonly AddonRuntimeRow[] {
  const runnerByAddon = new Map<string, RuntimeProcessInput>()
  for (const p of processes) {
    for (const id of p.addonIds) {
      if (!runnerByAddon.has(id)) runnerByAddon.set(id, p)
    }
  }
  const known = new Set(addons.map((a) => a.id))
  const addonRows: AddonRuntimeRow[] = addons.map((a) => {
    const runner = runnerByAddon.get(a.id)
    return {
      key: a.id,
      kind: 'addon',
      addonId: a.id,
      packageName: a.packageName ?? null,
      version: a.version ?? null,
      status: a.status,
      runner: runner === undefined ? null : toRunner(runner),
    }
  })
  const strayRunners: AddonRuntimeRow[] = processes
    .filter((p) => !p.addonIds.some((id) => known.has(id)))
    .map((p) => ({
      key: `runner:${p.name}`,
      kind: 'runner',
      addonId: null,
      packageName: null,
      version: null,
      status: p.state,
      runner: toRunner(p),
    }))
  return [...addonRows, ...strayRunners]
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

/** The addon rows of an `$agent.status` answer; unreadable rows are skipped. */
export function addonsFromStatus(status: unknown): readonly RuntimeAddonInput[] {
  const raw: unknown =
    status !== null && typeof status === 'object' ? Reflect.get(status, 'addons') : null
  if (!Array.isArray(raw)) return []
  const out: RuntimeAddonInput[] = []
  for (const item of raw) {
    if (item === null || typeof item !== 'object') continue
    const id = str(Reflect.get(item, 'id'))
    if (id === undefined) continue
    const version = str(Reflect.get(item, 'version'))
    const packageName = str(Reflect.get(item, 'packageName'))
    out.push({
      id,
      status: str(Reflect.get(item, 'status')) ?? 'unknown',
      ...(version !== undefined ? { version } : {}),
      ...(packageName !== undefined ? { packageName } : {}),
    })
  }
  return out
}

/** The runners of a `$process.list` answer; unreadable rows are skipped. */
export function processesFromList(list: unknown): readonly RuntimeProcessInput[] {
  if (!Array.isArray(list)) return []
  const out: RuntimeProcessInput[] = []
  for (const item of list) {
    if (item === null || typeof item !== 'object') continue
    const name = str(Reflect.get(item, 'name'))
    if (name === undefined) continue
    const ids: unknown = Reflect.get(item, 'addonIds')
    out.push({
      name,
      pid: num(Reflect.get(item, 'pid')),
      state: str(Reflect.get(item, 'state')) ?? 'unknown',
      groupId: str(Reflect.get(item, 'groupId')) ?? name,
      addonIds: Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string') : [],
      cpuPercent: num(Reflect.get(item, 'cpuPercent')),
      memoryRss: num(Reflect.get(item, 'memoryRss')),
      uptimeSeconds: num(Reflect.get(item, 'uptimeSeconds')),
    })
  }
  return out
}
