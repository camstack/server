/**
 * `dominevo host-check` — run it on the machine where Dominevo WILL run, before
 * installing: which accelerators it has, which ones Dominevo uses, the image tag
 * and the device flags to paste. Needs no hub, no login and no root; read-only.
 */
import { parseArgs } from 'node:util'
import { renderHostCheck } from '../host-check/host-check.js'
import {
  CODECS,
  MAIN_STREAMS,
  RECORDING_MODES,
  assessFeasibility,
  renderFeasibility,
  type SizingRequest,
} from '../host-check/sizing.js'
import type { HostProbe } from '../mcp/context.js'
import { realHost } from '../onboarding/context.js'
import { hardwareReportLink } from '../onboarding/hardware-report.js'
import { createManifestProvider, type ManifestProvider } from '../onboarding/manifest.js'

export const HOST_CHECK_HELP = [
  'Usage: dominevo host-check [--json] [--cameras <n> [sizing options]]',
  '',
  'Run on the machine where Dominevo will run (also works as `npx dominevo host-check`).',
  'Reads /sys, /dev and /etc only: no hub, no login, no root, nothing sent anywhere.',
  'Prints the accelerators found, which ones Dominevo uses, the image tag, and the',
  'passthrough for docker run, Compose, the Unraid template and a Proxmox LXC.',
  '',
  'Options:',
  '  --json                   Emit the report as JSON',
  '',
  'Sizing (adds memory, CPU, disk and a hub-only / hub-plus-agents verdict):',
  '  --cameras <n>            How many cameras you plan',
  `  --main-stream <res>      ${MAIN_STREAMS.join(' | ')} (default 4k)`,
  `  --codec <codec>          ${CODECS.join(' | ')} (default h265)`,
  `  --recording <mode>       ${RECORDING_MODES.join(' | ')} (default continuous)`,
  '  --retention-days <n>     Days of footage to keep (default 14)',
  '  --bitrate-mbit <n>       The main-stream bitrate your cameras send, if you know it',
  '  --recordings-path <dir>  A directory on the recording volume, to read its free space',
  '  --no-docs-fetch          Use the sizing figures bundled in this CLI, never the docs site',
].join('\n')

export interface HostCheckDeps {
  readonly host?: HostProbe
  readonly manifest?: ManifestProvider
  readonly write?: (text: string) => void
}

function oneOf<T extends string>(
  flag: string,
  value: string | undefined,
  allowed: readonly T[],
  fallback: T,
): T {
  if (value === undefined) return fallback
  const hit = allowed.find((a) => a === value)
  if (hit === undefined) throw new Error(`--${flag} must be one of: ${allowed.join(', ')}`)
  return hit
}

function positive(
  flag: string,
  value: string | undefined,
  fallback: number | undefined,
): number | undefined {
  if (value === undefined) return fallback
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) throw new Error(`--${flag} must be a positive number`)
  return n
}

export async function runHostCheck(
  args: readonly string[],
  deps: HostCheckDeps = {},
): Promise<void> {
  const { values } = parseArgs({
    args: [...args],
    options: {
      json: { type: 'boolean' },
      cameras: { type: 'string' },
      'main-stream': { type: 'string' },
      codec: { type: 'string' },
      recording: { type: 'string' },
      'retention-days': { type: 'string' },
      'bitrate-mbit': { type: 'string' },
      'recordings-path': { type: 'string' },
      'no-docs-fetch': { type: 'boolean' },
    },
    strict: true,
    allowPositionals: false,
  })
  const write = deps.write ?? ((text: string): void => void process.stdout.write(text))
  const host = deps.host ?? realHost
  const report = host.check()
  const cameras = positive('cameras', values.cameras, undefined)
  if (cameras === undefined) {
    write(`${values.json === true ? JSON.stringify(report, null, 2) : renderHostCheck(report)}\n`)
    return
  }
  const bitrateMbit = positive('bitrate-mbit', values['bitrate-mbit'], undefined)
  const request: SizingRequest = {
    cameras: Math.round(cameras),
    mainStream: oneOf('main-stream', values['main-stream'], MAIN_STREAMS, '4k'),
    codec: oneOf('codec', values.codec, CODECS, 'h265'),
    recording: oneOf('recording', values.recording, RECORDING_MODES, 'continuous'),
    retentionDays: Math.round(positive('retention-days', values['retention-days'], 14) ?? 14),
    ...(bitrateMbit !== undefined ? { bitrateMbit } : {}),
  }
  const provider =
    deps.manifest ??
    createManifestProvider({
      fetch: (url, init) => fetch(url, init),
      live: values['no-docs-fetch'] !== true,
    })
  const { manifest } = await provider()
  const facts = host.facts(values['recordings-path'] ?? null)
  const feasibility = assessFeasibility(request, facts, report, manifest.sizing)
  const link = feasibility.hardware.measured
    ? null
    : hardwareReportLink(manifest.hardwareReport, {
        check: { ...report, cpu: { ...report.cpu, model: feasibility.hardware.cpuModel } },
        ramGb: facts.ramGb,
        cores: facts.cores,
      })
  if (values.json === true) {
    write(`${JSON.stringify({ ...report, feasibility, hardwareReport: link }, null, 2)}\n`)
    return
  }
  const share = link === null ? '' : `\n\n${link.text}\nShare your results: ${link.url}`
  write(`${renderHostCheck(report)}\n\n${renderFeasibility(feasibility)}${share}\n`)
}
