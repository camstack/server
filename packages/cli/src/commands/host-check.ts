/**
 * `camstack host-check` — run it on the machine where CamStack WILL run, before
 * installing: which accelerators it has, which ones CamStack uses, the image tag
 * and the device flags to paste. Needs no hub, no login and no root; read-only.
 */
import { parseArgs } from 'node:util'
import { hostCheck, renderHostCheck } from '../host-check/host-check.js'
import { currentPlatform, nodeHostFs, readNvidiaSmi } from '../host-check/node-host.js'

export const HOST_CHECK_HELP = [
  'Usage: camstack host-check [--json]',
  '',
  'Run on the machine where CamStack will run (also works as `npx camstack host-check`).',
  'Reads /sys, /dev and /etc only: no hub, no login, no root, nothing sent anywhere.',
  'Prints the accelerators found, which ones CamStack uses, the image tag, and the',
  'passthrough for docker run, Compose, the Unraid template and a Proxmox LXC.',
  '',
  'Options:',
  '  --json    Emit the report as JSON',
].join('\n')

export function runHostCheck(args: readonly string[]): void {
  const { values } = parseArgs({
    args: [...args],
    options: { json: { type: 'boolean' } },
    strict: true,
    allowPositionals: false,
  })
  const platform = currentPlatform()
  const report = hostCheck({
    platform,
    fs: nodeHostFs,
    nvidiaSmi: platform === 'linux' ? readNvidiaSmi() : null,
  })
  process.stdout.write(
    `${values.json === true ? JSON.stringify(report, null, 2) : renderHostCheck(report)}\n`,
  )
}
