/**
 * `dominevo host-check`: run on the machine where Dominevo WILL run; it says
 * which accelerators that machine has, which ones Dominevo uses, the image
 * tag and the exact passthrough for Docker, Compose, Unraid and a Proxmox LXC.
 * Read-only, no root, no hub, nothing sent anywhere. The same report backs the
 * `setup_host_check` MCP tool.
 */
import { IMAGE_VARIANT_TABLE, IMAGE_VARIANTS, variantTag } from '../mcp/image-variants.js'
import {
  buildPassthrough,
  listAccelerators,
  pickImageTag,
  type DetectedAccelerator,
  type Passthrough,
} from './advise.js'
import {
  probeHost,
  type ContainerKind,
  type CpuInfo,
  type HostFs,
  type HostInventory,
} from './probe.js'

export type HostPlatform = 'linux' | 'darwin' | 'win32' | 'other'

export interface HostCheckInput {
  readonly platform: HostPlatform
  readonly fs: HostFs
  /** Output of `nvidia-smi -L`, or null when it is absent or failed. */
  readonly nvidiaSmi: string | null
}

export interface HostEnvironment {
  readonly container: ContainerKind | null
  readonly proxmoxHost: boolean
  readonly unraidHost: boolean
}

export interface HostCheckReport {
  readonly platform: HostPlatform
  /** Set on macOS / Windows: Dominevo runs as the native app, nothing to pass. */
  readonly nativeApp: string | null
  readonly environment: HostEnvironment
  readonly cpu: CpuInfo
  readonly accelerators: readonly DetectedAccelerator[]
  /** `ghcr.io/dominevo/dominevo:<imageTag>`; null for the native app. */
  readonly imageTag: string | null
  readonly passthrough: Passthrough
  readonly hints: readonly string[]
}

export const IMAGE_REPOSITORY = 'ghcr.io/dominevo/dominevo'

const NATIVE_APP: Readonly<Record<'darwin' | 'win32', string>> = {
  darwin:
    'macOS: install the Dominevo desktop app (Apple silicon runs detection on the Neural Engine). Nothing to pass.',
  win32:
    'Windows: install the Dominevo desktop app; it finds the hardware itself. Nothing to pass.',
}

const EMPTY_PASSTHROUGH: Passthrough = {
  devices: [],
  deviceCgroupRules: [],
  dockerRunFlags: [],
  compose: '',
  unraid: { deviceFields: [], extraParameters: '' },
  proxmoxLxc: [],
}

/** An Intel desktop SKU ending in F / KF has no integrated GPU at all. */
function intelCpuWithoutIgpu(model: string | null): boolean {
  return model !== null && /\b\d{3,5}K?F\b/.test(model)
}

function hintsFor(inv: HostInventory, accelerators: readonly DetectedAccelerator[]): string[] {
  const hints: string[] = []
  const used = accelerators.filter((a) => a.status === 'used')
  const has = (kind: DetectedAccelerator['kind']): boolean =>
    accelerators.some((a) => a.kind === kind)
  if (
    inv.cpu.vendor === 'GenuineIntel' &&
    !has('intel-gpu') &&
    !intelCpuWithoutIgpu(inv.cpu.model)
  ) {
    hints.push(
      'The CPU is Intel but no Intel GPU is on the PCI bus. If the CPU has an integrated GPU, enable it in the BIOS (often "iGPU Multi-Monitor" or "Primary display: auto"): a discrete card usually switches it off. Then run this check again.',
    )
  }
  if (used.some((a) => a.kind === 'nvidia')) {
    hints.push(
      'NVIDIA: the host needs the NVIDIA driver and nvidia-container-toolkit (`docker info` lists the nvidia runtime); without them --gpus all fails at container start.',
    )
  }
  if (inv.coralPcieUnbound > 0) {
    hints.push(
      'A PCIe/M.2 Coral has no apex driver bound: install the gasket/apex driver on the host (Unraid: the Coral driver plugin); /dev/apex_0 then appears.',
    )
  }
  if (used.length === 0) {
    hints.push(
      'No accelerator Dominevo can use: detection runs on the CPU (expect hundreds of milliseconds per frame).',
    )
  }
  const hidden = used.filter((a) => a.visibleHere === false)
  if (hidden.length > 0 && inv.container === 'lxc') {
    hints.push(
      `Inside an LXC, and ${hidden.map((a) => a.label).join(', ')} is not in it: add the Proxmox lines above to /etc/pve/lxc/<id>.conf on the Proxmox host, then reboot the CT and run this check again inside it.`,
    )
  } else if (hidden.length > 0 && inv.container !== null) {
    hints.push(
      `${hidden.map((a) => a.label).join(', ')}: not passed into this ${inv.container} container. Re-create it with the flags above.`,
    )
  }
  if (used.length > 0) {
    hints.push(
      'No group_add is needed: the image entrypoint hands every passed device node to the camstack user.',
    )
  }
  return hints
}

export function hostCheck(input: HostCheckInput): HostCheckReport {
  if (input.platform === 'darwin' || input.platform === 'win32') {
    return {
      platform: input.platform,
      nativeApp: NATIVE_APP[input.platform],
      environment: { container: null, proxmoxHost: false, unraidHost: false },
      cpu: { vendor: null, model: null },
      accelerators: [],
      imageTag: null,
      passthrough: EMPTY_PASSTHROUGH,
      hints: [],
    }
  }
  const inv = probeHost(input.fs, input.nvidiaSmi)
  const accelerators = listAccelerators(inv)
  return {
    platform: input.platform,
    nativeApp: null,
    environment: {
      container: inv.container,
      proxmoxHost: inv.proxmoxHost,
      unraidHost: inv.unraidHost,
    },
    cpu: inv.cpu,
    accelerators,
    imageTag: pickImageTag(accelerators),
    passthrough: buildPassthrough(accelerators, inv),
    hints: hintsFor(inv, accelerators),
  }
}

const STATUS_LABEL: Readonly<Record<DetectedAccelerator['status'], string>> = {
  used: 'USED',
  'detected-not-used': 'not used',
  unsupported: 'NOT SUPPORTED YET',
}

function where(env: HostEnvironment): string {
  if (env.container !== null) return `inside a ${env.container} container`
  if (env.proxmoxHost) return 'a Proxmox VE host'
  if (env.unraidHost) return 'an Unraid host'
  return 'a Linux host'
}

function section(title: string, body: readonly string[]): readonly string[] {
  return body.length === 0 ? [] : ['', title, ...body.map((l) => `  ${l}`)]
}

/** The human-readable report `dominevo host-check` prints. */
export function renderHostCheck(report: HostCheckReport): string {
  if (report.nativeApp !== null) return report.nativeApp
  const p = report.passthrough
  const lines: string[] = [
    `Dominevo host check — ${where(report.environment)}${report.cpu.model !== null ? `, ${report.cpu.model}` : ''}`,
    '',
    'Accelerators:',
  ]
  if (report.accelerators.length === 0) lines.push('  none found')
  for (const a of report.accelerators) {
    lines.push(`  [${STATUS_LABEL[a.status]}] ${a.label}`)
    lines.push(`      ${a.note}`)
  }
  const tag = report.imageTag ?? variantTag('intel')
  lines.push('', `Image: ${IMAGE_REPOSITORY}:${tag}`)
  const variant = IMAGE_VARIANTS.find((v) => variantTag(v) === tag)
  if (variant !== undefined) {
    const info = IMAGE_VARIANT_TABLE[variant]
    lines.push(`  For: ${info.hardware}.`, `  ${info.when}`)
    if (info.caveat !== undefined) lines.push(`  Caveat: ${info.caveat}`)
  }
  lines.push(
    ...section(
      'docker run flags:',
      p.dockerRunFlags.length > 0 ? [p.dockerRunFlags.join(' ')] : ['(none)'],
    ),
  )
  lines.push(
    ...section(
      'Compose (under the camstack service):',
      p.compose === '' ? [] : p.compose.split('\n').map((l) => l.slice(2)),
    ),
  )
  lines.push(
    ...section('Unraid template (device fields):', p.unraid.deviceFields),
    ...section(
      'Unraid Extra Parameters (instead of the fields):',
      p.unraid.extraParameters === '' ? [] : [p.unraid.extraParameters],
    ),
    ...section(
      'Proxmox LXC (/etc/pve/lxc/<id>.conf on the host; gid = the render group inside the CT):',
      p.proxmoxLxc,
    ),
    ...section('Notes:', report.hints),
  )
  return lines.join('\n')
}
