/**
 * What the install guide knows by heart: the official template locations and
 * the rules of the public install docs. The file BODIES are never kept here —
 * they are fetched live from the official repositories on every call.
 */
import { z } from 'zod'

export const HOST_KINDS = [
  'docker-compose',
  'docker',
  'unraid',
  'proxmox-lxc',
  'macos-desktop',
] as const
export const HostKindSchema = z.enum(HOST_KINDS)
export type HostKind = z.infer<typeof HostKindSchema>

export const ROLES = ['hub', 'agent'] as const
export const RoleSchema = z.enum(ROLES)
export type Role = z.infer<typeof RoleSchema>

export const ACCELERATORS = ['intel', 'amd', 'coral', 'apple', 'cpu'] as const
export const AcceleratorSchema = z.enum(ACCELERATORS)
export type Accelerator = z.infer<typeof AcceleratorSchema>

export const InstallPathsSchema = z.object({
  data: z.string().min(1),
  recordings: z.string().min(1),
  config: z.string().min(1).optional(),
  backups: z.string().min(1).optional(),
})
export type InstallPaths = z.infer<typeof InstallPathsSchema>

export const InstallGuideInputSchema = z.object({
  hostKind: HostKindSchema.optional(),
  role: RoleSchema.optional(),
  accelerator: AcceleratorSchema.optional(),
  paths: InstallPathsSchema.optional(),
  /** Agents only: the hub the agent should dial (host or IP). */
  hubAddress: z.string().min(1).optional(),
})
export type InstallGuideInput = z.infer<typeof InstallGuideInputSchema>

const RAW = 'https://raw.githubusercontent.com/camstack'

/** The official templates, by route and role. */
export const TEMPLATE_URLS = {
  compose: {
    hub: `${RAW}/proxmox/main/compose/hub.yml`,
    agent: `${RAW}/proxmox/main/compose/agent.yml`,
  },
  proxmoxInstaller: `${RAW}/proxmox/main/install-camstack-proxmox.sh`,
  unraid: {
    hub: `${RAW}/unraid-templates/main/templates/camstack.xml`,
    agent: `${RAW}/unraid-templates/main/templates/camstack-agent.xml`,
  },
  latestRelease: 'https://api.github.com/repos/camstack/server/releases/latest',
} as const

export const IMAGE_REPOSITORY = 'ghcr.io/camstack/camstack'

/**
 * Rules from the public install docs, `camstack/docs`
 * `content/docs/installation/index.mdx` ("Choosing a tag" and "What must be
 * true, and why"). That repository is private, so the rules are encoded here:
 * re-read the page when it changes.
 */
export const IMAGE_TAG_BY_ACCELERATOR: Readonly<Record<Accelerator, string>> = {
  intel: 'intel-latest',
  amd: 'amd-latest',
  // No Coral- or CPU-specific image: Intel hosts and the Unraid templates track intel-latest.
  coral: 'intel-latest',
  cpu: 'intel-latest',
  apple: 'intel-latest',
}

export const NO_BARE_LATEST =
  'There is no bare :latest tag: use intel-<version>/intel-latest or amd-<version>/amd-latest, and never mix them across vendors.'

/** Settings whose absence breaks CamStack in ways that do not look like the setting. */
export const MUST_NOT_OMIT: readonly string[] = [
  '--pids-limit=8192 (pids_limit: 8192): the default 2048 counts threads and silently stops media on a busy hub.',
  'CAMSTACK_MEDIA_ROOT=/recordings: without it recordings land in /data and fill the cache drive.',
  '/config mapped: it is a VOLUME, so an unmapped path mints an anonymous volume on every re-create.',
  '--restart unless-stopped: the NVR must come back after a host reboot.',
  'CAMSTACK_MOLECULER_USE_HOSTNAME=false: otherwise a multi-machine cluster never forms.',
  'Coral USB: /dev/bus/usb AND the device-cgroup rule c 189:* rmw.',
]

/** Marker tags the official compose files carry on the lines an accelerator enables. */
export const COMPOSE_MARKERS_BY_ACCELERATOR: Readonly<Record<Accelerator, readonly string[]>> = {
  intel: ['devices', 'dri', 'accel'],
  amd: ['devices', 'dri'],
  coral: ['devices', 'usb'],
  cpu: [],
  apple: [],
}

export function firstRunHub(host: string): readonly string[] {
  return [
    `Open https://${host}:4443 (a self-signed certificate: accept the browser warning).`,
    'Sign in as admin / changeme; CamStack asks for a new password at once. Change it now.',
    `Then, where your MCP client runs: camstack login ${host}`,
  ]
}
