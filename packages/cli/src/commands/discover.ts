/**
 * `camstack discover` — list the hubs `camstack login` would offer (D838):
 * the ones the LAN announces over mDNS (`_camstack._tcp`, the hub's HTTPS
 * endpoint) plus the ones this machine already knows, reachable ones only,
 * each with the SOURCE that named it.
 *
 * Mesh UDP discovery (239.0.0.0:4445) is gone from here: D826 turned it off on
 * every hub, so listening to it could only ever show pre-D826 hubs.
 */
import { parseArgs } from 'node:util'

import { describeHub, findHubs } from '../discovery/hub-finder.js'

const DEFAULT_LISTEN_SECONDS = 3

/** Sub-command entrypoint — `camstack discover`. */
export async function runDiscover(args: readonly string[]): Promise<void> {
  const { values } = parseArgs({
    args: [...args],
    options: {
      // Accepted and ignored: the namespace belonged to the retired mesh channel.
      namespace: { type: 'string', short: 'n' },
      timeout: { type: 'string', short: 't' },
      json: { type: 'boolean' },
    },
    strict: true,
    allowPositionals: false,
  })
  if (typeof values.namespace === 'string') {
    console.warn(
      '[camstack] --namespace is ignored: hubs are found over mDNS, not the mesh channel.',
    )
  }
  const seconds =
    typeof values.timeout === 'string'
      ? Number.parseInt(values.timeout, 10)
      : DEFAULT_LISTEN_SECONDS
  if (!Number.isFinite(seconds) || seconds < 1)
    throw new Error('--timeout must be a number of seconds >= 1.')

  if (values.json !== true) {
    console.log(`[camstack] Looking for hubs (LAN mDNS + known hubs, ${seconds}s)…`)
  }
  const hubs = await findHubs({
    workspaceRoot: process.cwd(),
    mdnsTimeoutMs: seconds * 1000,
    onProblem: (message) => console.warn(`[camstack] mDNS: ${message}`),
  })

  if (values.json === true) {
    console.log(JSON.stringify(hubs, null, 2))
    return
  }
  if (hubs.length === 0) {
    console.log(
      '[camstack] No hub responded. Pass --server https://<host>:<port> to `camstack login`, ' +
        'or check the hub is reachable (mDNS needs UDP 5353 multicast on the LAN).',
    )
    return
  }
  console.log(`[camstack] Found ${hubs.length} hub(s):`)
  for (const hub of hubs) {
    console.log(`  • ${describeHub(hub)}`)
    console.log(`      → camstack login -s ${hub.url}`)
  }
}
