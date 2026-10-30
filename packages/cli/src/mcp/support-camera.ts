/**
 * `support_diagnose_camera`: a brand or model, or an existing device that
 * fails. Which provider addons could serve it (installed first, then
 * published), and one verdict:
 *
 *  - `use-provider`    a brand provider matches by name, description or keywords;
 *  - `generic-fallback` no brand provider, but ONVIF / RTSP can carry a generic stream;
 *  - `unsupported`     neither: the way forward is an issue on the owning repository;
 *  - `unknown`         the provider list could not be read (never "none").
 *
 * A provider manifest declares no brand or model list, so matching is on text
 * and the verdict says so. Read-only.
 */
import { z } from 'zod'
import type { McpContext } from './context.js'
import {
  configureCameraProviders,
  type AvailableProvider,
  type InstalledProvider,
} from './configure-cameras.js'
import {
  readQuery,
  withHub,
  type NoSessionResult,
  type Read,
  type RefusedResult,
} from './ops-hub.js'

const DeviceSchema = z
  .looseObject({
    id: z.number(),
    name: z.string(),
    addonId: z.string().optional(),
    disabled: z.boolean().optional(),
    online: z.boolean().optional(),
  })
  .nullable()

export type CameraVerdict = 'use-provider' | 'generic-fallback' | 'unsupported' | 'unknown'

export interface ProviderPick {
  readonly installed: boolean
  readonly addonId: string | null
  readonly packageName: string
  readonly version: string
}

export interface CameraDeviceFact {
  readonly deviceId: number
  readonly name: string
  readonly providerAddonId: string | null
  readonly online: boolean | null
  readonly disabled: boolean | null
}

export interface CameraDiagnosis {
  readonly status: 'ok'
  readonly verdict: CameraVerdict
  readonly summary: string
  readonly provider: ProviderPick | null
  readonly genericProviders: readonly ProviderPick[]
  readonly device: CameraDeviceFact | null
  readonly steps: readonly string[]
  readonly matching: string
  readonly unavailable: { readonly [part: string]: string }
}

export interface CameraDiagnoseArgs {
  readonly brand?: string
  readonly model?: string
  readonly deviceId?: number
}

const GENERIC = /onvif|rtsp/i

function words(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 3)
}

function isGeneric(parts: readonly string[]): boolean {
  return parts.some((p) => GENERIC.test(p))
}

function installedPick(p: InstalledProvider): ProviderPick {
  return {
    installed: true,
    addonId: p.addonId,
    packageName: p.packageName,
    version: p.version,
  }
}

function availablePick(p: AvailableProvider): ProviderPick {
  return {
    installed: false,
    addonId: null,
    packageName: p.packageName,
    version: p.version,
  }
}

const MATCHING_NOTE =
  'A provider manifest declares no brand or model list: matching is on provider name, description and keywords, so a brand that is supported under another name can be missed.'

interface Pools {
  readonly installed: readonly InstalledProvider[]
  readonly available: readonly AvailableProvider[]
}

function matchIn(pools: Pools, tokens: readonly string[]): ProviderPick | null {
  if (tokens.length === 0) return null
  const hit = (parts: readonly string[]): boolean => {
    if (isGeneric(parts)) return false
    const joined = parts.join(' ').toLowerCase()
    return tokens.some((t) => joined.includes(t))
  }
  const installed = pools.installed.find((p) =>
    hit([p.addonId, p.name, p.description ?? '', p.packageName]),
  )
  if (installed) return installedPick(installed)
  const available = pools.available.find((p) => hit([p.packageName, p.description, ...p.keywords]))
  return available ? availablePick(available) : null
}

function genericIn(pools: Pools): readonly ProviderPick[] {
  return [
    ...pools.installed.filter((p) => isGeneric([p.addonId, p.packageName])).map(installedPick),
    ...pools.available.filter((p) => isGeneric([p.packageName])).map(availablePick),
  ]
}

function label(pick: ProviderPick): string {
  return pick.addonId ?? pick.packageName
}

function installStep(pick: ProviderPick): readonly string[] {
  return pick.installed
    ? []
    : [
        `Install it first: configure_addon_install with packageName ${pick.packageName} (version ${pick.version}).`,
      ]
}

export interface CameraInputs {
  readonly args: CameraDiagnoseArgs
  readonly pools: Read<Pools>
  readonly device: Read<z.infer<typeof DeviceSchema>> | null
}

/** Pure: the verdict from what was read. */
export function diagnoseCamera(input: CameraInputs): CameraDiagnosis {
  const unavailable: { [part: string]: string } = {}
  let device: CameraDeviceFact | null = null
  if (input.device !== null) {
    if (!input.device.ok) unavailable['device'] = input.device.reason
    else if (input.device.value === null) unavailable['device'] = 'the hub has no such device'
    else
      device = {
        deviceId: input.device.value.id,
        name: input.device.value.name,
        providerAddonId: input.device.value.addonId ?? null,
        online: input.device.value.online ?? null,
        disabled: input.device.value.disabled ?? null,
      }
  }
  const base = {
    status: 'ok' as const,
    device,
    matching: MATCHING_NOTE,
    unavailable,
  }
  if (!input.pools.ok) {
    return {
      ...base,
      verdict: 'unknown',
      summary: `The camera providers could not be read, so nothing can be said: ${input.pools.reason}`,
      provider: null,
      genericProviders: [],
      steps: [],
      unavailable: { ...unavailable, providers: input.pools.reason },
    }
  }
  const pools = input.pools.value
  const tokens = [
    ...words(`${input.args.brand ?? ''} ${input.args.model ?? ''}`),
    ...(input.args.brand === undefined && input.args.model === undefined && device !== null
      ? words(device.name)
      : []),
  ]
  const generic = genericIn(pools)
  const brand = matchIn(pools, tokens)
  const failing =
    device !== null
      ? [
          `Device ${device.deviceId} ("${device.name}") is ${device.online === false ? 'offline' : 'online'}${device.disabled === true ? ' and disabled' : ''} on provider ${device.providerAddonId ?? 'unknown'}. ops_device and ops_logs (deviceId ${device.deviceId}) say why it fails.`,
        ]
      : []
  if (brand !== null) {
    const same = device !== null && device.providerAddonId === brand.addonId
    return {
      ...base,
      verdict: 'use-provider',
      summary: `Provider ${label(brand)} (${brand.installed ? 'installed' : 'published, not installed'}) matches.`,
      provider: brand,
      genericProviders: generic,
      steps: [
        ...installStep(brand),
        ...(same
          ? [
              'The device is already on that provider, so the failure is not provider selection: check the camera address and credentials, then ops_device and ops_logs.',
            ]
          : [
              `Add the camera under ${label(brand)}: configure_camera_discover, then configure_camera_add (secrets are typed in the admin UI).`,
            ]),
        ...failing,
      ],
    }
  }
  if (generic.length > 0) {
    const first = generic[0]
    return {
      ...base,
      verdict: 'generic-fallback',
      summary:
        'No brand provider matches; the generic ONVIF / RTSP providers can carry the stream (live view and recording, without brand features).',
      provider: null,
      genericProviders: generic,
      steps: [
        ...(first ? installStep(first) : []),
        'Try ONVIF first: configure_camera_discover with the ONVIF provider, which finds cameras on the network and prefills the address.',
        "If discovery finds nothing, add the RTSP provider with the camera's RTSP URL (the manual in the camera's box or its web page lists it).",
        ...failing,
      ],
    }
  }
  return {
    ...base,
    verdict: 'unsupported',
    summary:
      'No brand provider matches and no ONVIF or RTSP provider is installed or published: the hub cannot serve this camera.',
    provider: null,
    genericProviders: [],
    steps: [
      'Draft an issue for the owner of the camera providers: support_draft_issue with kind "camera".',
      ...failing,
    ],
  }
}

export async function supportDiagnoseCamera(
  ctx: McpContext,
  args: CameraDiagnoseArgs,
): Promise<CameraDiagnosis | NoSessionResult | RefusedResult> {
  const listed = await configureCameraProviders(ctx, undefined)
  if (listed.status === 'no-session') return listed
  const pools: Read<Pools> =
    listed.status === 'ok'
      ? {
          ok: true,
          value: {
            installed: listed.installed ?? [],
            available: listed.available ?? [],
          },
        }
      : {
          ok: false,
          reason: listed.reason ?? 'the provider list is unavailable',
        }
  const deviceId = args.deviceId
  const device =
    deviceId === undefined
      ? null
      : await withHub(ctx, ({ client }) =>
          readQuery(client, 'deviceManager.getDevice', { deviceId }, DeviceSchema),
        )
  if (device !== null && 'status' in device) return device
  return diagnoseCamera({ args, pools, device })
}
