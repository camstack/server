/**
 * `setup_core_addons`: which of the addons a working install needs are there,
 * which are set up, and the ONE thing to do next.
 *
 * The list is not written here. It is the `coreAddons` of the onboarding
 * manifest — the same table the docs page renders — so a group added to the
 * docs shows up in this tool without a line of code. What this file owns is how
 * a group is judged against a hub:
 *
 *   - `seeded` ships with the hub: all of its addons must be present.
 *   - `required` is satisfied by any one addon with a working instance.
 *   - `remote` is `required` once the operator says the hub is used away from
 *     home, `not-needed` when they say it is not, and a question until then.
 *   - `suggested` never blocks.
 *
 * Read-only. An addon that needs an account token is configured by the person
 * in the admin UI: this tool only says where. It never reads TURN credentials
 * (`turnProvider.getTurnServers` answers with them) — an instance's status is
 * enough to tell a relay is set up.
 */
import type { HubClient } from '@camstack/develop'
import { z } from 'zod'
import { manifestOf } from '../onboarding/context.js'
import type { CoreAddonGroup, CoreAddonRef, UiLocation } from '../onboarding/manifest-schema.js'
import type { ManifestSource } from '../onboarding/manifest.js'
import type { McpContext } from './context.js'
import { readQuery, withHub, type NoSessionResult, type Read } from './ops-hub.js'
import { READ_CONCURRENCY, mapLimit } from './setup-assist-common.js'
import { readRemoteAccessStatus } from './setup-wizard-reads.js'

export const CORE_ADDONS_TOOL = 'setup_core_addons'
const INSTALL_TOOL = 'configure_addon_install'
const REMOTE_ACCESS_GROUP = 'remote-access'

export const CoreAddonsArgsShape = {
  remoteAccess: z
    .boolean()
    .optional()
    .describe(
      'Whether CamStack will be opened away from home. Ask the person; leave it out until they answered.',
    ),
} as const

export type AddonState = 'configured' | 'installed' | 'missing' | 'failed' | 'unknown'
export type GroupStatus = AddonState | 'suggested' | 'not-needed'

export interface AddonFinding {
  readonly id: string
  readonly package: string
  readonly state: AddonState
  readonly detail?: string
}

export interface CoreAddonAction {
  readonly text: string
  readonly tool?: string
  readonly args?: { readonly [key: string]: unknown }
  readonly ui?: UiLocation
}

export interface GroupFinding {
  readonly id: string
  readonly title: string
  readonly need: CoreAddonGroup['need']
  readonly status: GroupStatus
  readonly reason?: string
  readonly why: string
  readonly page: string
  readonly addons: readonly AddonFinding[]
  readonly nextAction: CoreAddonAction | null
}

export interface CoreAddonsNextAction extends CoreAddonAction {
  readonly group: string
}

export interface CoreAddonsAssessment {
  /** What the caller said about using the hub away from home; null = not asked yet. */
  readonly remoteAccess: boolean | null
  readonly groups: readonly GroupFinding[]
  /** The first thing that blocks a working install; null when nothing does. */
  readonly nextAction: CoreAddonsNextAction | null
}

export interface CoreAddonsResult extends CoreAddonsAssessment {
  readonly status: 'ok'
  readonly manifest: {
    readonly source: ManifestSource
    readonly revision: number
  }
}

const InstalledSchema = z.array(z.looseObject({ manifest: z.looseObject({ id: z.string() }) }))

const InstanceListSchema = z.array(
  z.looseObject({
    enabled: z.boolean().optional(),
    status: z.looseObject({ state: z.string(), detail: z.string().optional() }).optional(),
  }),
)
type InstanceList = z.infer<typeof InstanceListSchema>

function judgeInstances(ref: CoreAddonRef, read: Read<InstanceList>): AddonFinding {
  const base = { id: ref.id, package: ref.package }
  if (!read.ok) return { ...base, state: 'unknown', detail: read.reason }
  const enabled = read.value.filter((i) => i.enabled !== false)
  if (enabled.length === 0) {
    return {
      ...base,
      state: 'installed',
      detail:
        read.value.length === 0
          ? 'installed, nothing set up yet'
          : 'installed, every entry is switched off',
    }
  }
  const working = enabled.filter((i) => i.status?.state !== 'error')
  if (working.length > 0) return { ...base, state: 'configured' }
  const detail = enabled.map((i) => i.status?.detail).find((d) => d !== undefined)
  return {
    ...base,
    state: 'failed',
    detail: detail ?? 'its last check failed',
  }
}

const WANTED_TEXT = (group: CoreAddonGroup): string =>
  group.addons.length === 1
    ? `Install ${group.addons[0]?.package ?? group.title}.`
    : `Ask the person which one fits, then install its package: ${group.addons.map((a) => `${a.id} (${a.package})`).join(', ')}.`

function uiText(ui: UiLocation | undefined): string {
  return ui === undefined ? 'the admin UI' : `the admin UI: ${ui.nav.join(' → ')}`
}

function actionFor(
  group: CoreAddonGroup,
  status: GroupStatus,
  addons: readonly AddonFinding[],
  remoteAccess: boolean | null,
  canInstall: boolean,
): CoreAddonAction | null {
  const ui = group.ui === undefined ? {} : { ui: group.ui }
  if (status === 'configured' || status === 'not-needed' || status === 'unknown') return null
  if (status === 'failed') {
    const failed = addons.find((a) => a.state === 'failed')
    return {
      text: `${failed?.id ?? group.title} is set up but its last check failed (${failed?.detail ?? 'no detail'}). The person fixes it in ${uiText(group.ui)}.`,
      ...ui,
    }
  }
  if (status === 'installed') {
    const present = addons.filter((a) => a.state === 'installed').map((a) => a.id)
    return {
      text: `${present.join(', ')} is installed but not set up. The person adds it in ${uiText(group.ui)}; an account token or a password is typed there, never into this conversation.`,
      ...ui,
    }
  }
  if (group.need === 'remote' && remoteAccess === null) {
    return {
      text: `Ask the person whether they will open CamStack away from home, then call ${CORE_ADDONS_TOOL} again with remoteAccess set to their answer.`,
      tool: CORE_ADDONS_TOOL,
      args: { remoteAccess: true },
    }
  }
  const only = group.addons.length === 1 ? group.addons[0] : undefined
  if (!canInstall) {
    return {
      text: `${WANTED_TEXT(group)} This server was started without the configure toolset, so the person installs it in the admin UI: Cluster → Addons.`,
      ui: { route: '/system/addons', nav: ['Cluster', 'Addons'] },
    }
  }
  return {
    text: WANTED_TEXT(group),
    tool: INSTALL_TOOL,
    ...(only === undefined ? {} : { args: { packageName: only.package } }),
  }
}

function judgeGroup(
  group: CoreAddonGroup,
  addons: readonly AddonFinding[],
  remoteAccess: boolean | null,
  remoteConnected: boolean,
): { readonly status: GroupStatus; readonly reason?: string } {
  const has = (state: AddonState): boolean => addons.some((a) => a.state === state)
  if (group.need === 'seeded') {
    const absent = addons.filter((a) => a.state === 'missing').map((a) => a.id)
    return absent.length === 0
      ? { status: 'configured' }
      : { status: 'missing', reason: `not on this hub: ${absent.join(', ')}` }
  }
  if (has('configured')) return { status: 'configured' }
  if (group.id === REMOTE_ACCESS_GROUP && remoteConnected) {
    return {
      status: 'configured',
      reason: 'the hub reports a connected remote access',
    }
  }
  if (has('failed')) {
    return {
      status: 'failed',
      reason: addons.find((a) => a.state === 'failed')?.detail,
    }
  }
  const wanted = group.need === 'required' || (group.need === 'remote' && remoteAccess === true)
  if (group.need === 'remote' && remoteAccess === false) {
    return {
      status: 'not-needed',
      reason: 'the hub is not used away from home',
    }
  }
  if (has('unknown')) {
    return {
      status: 'unknown',
      reason: addons.find((a) => a.state === 'unknown')?.detail,
    }
  }
  if (!wanted) return { status: 'suggested' }
  return { status: has('installed') ? 'installed' : 'missing' }
}

const BLOCKING: readonly GroupStatus[] = ['failed', 'missing', 'installed']

/** Judge every group of the manifest against one hub. Never throws. */
export async function assessCoreAddons(
  client: HubClient,
  groups: readonly CoreAddonGroup[],
  remoteAccess: boolean | null,
  canInstall: boolean,
): Promise<CoreAddonsAssessment> {
  const installed = await readQuery(client, 'addons.list', {}, InstalledSchema)
  if (!installed.ok) {
    return {
      remoteAccess,
      nextAction: null,
      groups: groups.map((g) => ({
        id: g.id,
        title: g.title,
        need: g.need,
        status: 'unknown',
        reason: installed.reason,
        why: g.why,
        page: g.page,
        addons: g.addons.map((a) => ({ ...a, state: 'unknown' })),
        nextAction: null,
      })),
    }
  }
  const present = new Set(installed.value.map((a) => a.manifest.id))
  const toProbe = [
    ...new Set(
      groups
        .filter((g) => g.need !== 'seeded')
        .flatMap((g) => g.addons.map((a) => a.id))
        .filter((id) => present.has(id)),
    ),
  ]
  const probed = new Map(
    await mapLimit(toProbe, READ_CONCURRENCY, async (addonId) => {
      const read = await readQuery(
        client,
        'integrationInstances.listInstances',
        { addonId },
        InstanceListSchema,
      )
      return [addonId, read] as const
    }),
  )
  const remote = await readRemoteAccessStatus(client)
  const remoteConnected = remote.ok && remote.value.connected

  const findings = groups.map((group): GroupFinding => {
    const addons = group.addons.map((ref): AddonFinding => {
      if (!present.has(ref.id)) return { ...ref, state: 'missing' }
      if (group.need === 'seeded') return { ...ref, state: 'configured' }
      const read = probed.get(ref.id)
      return read === undefined
        ? { ...ref, state: 'unknown', detail: 'not probed' }
        : judgeInstances(ref, read)
    })
    const verdict = judgeGroup(group, addons, remoteAccess, remoteConnected)
    return {
      id: group.id,
      title: group.title,
      need: group.need,
      status: verdict.status,
      ...(verdict.reason === undefined ? {} : { reason: verdict.reason }),
      why: group.why,
      page: group.page,
      addons,
      nextAction: actionFor(group, verdict.status, addons, remoteAccess, canInstall),
    }
  })

  const blocking =
    findings.find((g) => BLOCKING.includes(g.status)) ??
    (remoteAccess === null
      ? findings.find((g) => g.need === 'remote' && g.status === 'suggested')
      : undefined)
  return {
    remoteAccess,
    groups: findings,
    nextAction:
      blocking?.nextAction == null ? null : { group: blocking.id, ...blocking.nextAction },
  }
}

/** Whether a tool is served by this server; not known counts as served. */
export async function toolServed(ctx: McpContext, name: string): Promise<boolean> {
  if (ctx.registeredTools === undefined) return true
  return (await ctx.registeredTools()).has(name)
}

export async function setupCoreAddons(
  ctx: McpContext,
  args: { readonly remoteAccess?: boolean },
): Promise<CoreAddonsResult | NoSessionResult> {
  return withHub(ctx, async (connection) => {
    const { manifest, source } = await manifestOf(ctx)()
    const assessment = await assessCoreAddons(
      connection.client,
      manifest.coreAddons,
      args.remoteAccess ?? null,
      await toolServed(ctx, INSTALL_TOOL),
    )
    return {
      status: 'ok',
      manifest: { source, revision: manifest.revision },
      ...assessment,
    }
  })
}
