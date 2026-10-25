import { lookup as dnsLookup } from 'node:dns/promises'
import { errMsg } from '@camstack/types'
import type { Logger } from './types.js'

/**
 * Rewrite mDNS (`*.local`) candidates in an SDP by resolving each
 * hostname to an IP via the OS resolver.
 *
 * Chrome emits anonymised `<uuid>.local` host candidates by default
 * for privacy; werift's ICE agent has no mDNS resolver, so those
 * candidates never pair and the session sits at "checking" forever.
 *
 * On macOS the OS resolver delegates `.local` to Bonjour (built in); on
 * Linux it usually requires Avahi's NSS module. We parallelise the
 * lookups and silently drop candidates that don't resolve — a failed
 * lookup is the same as "werift didn't use it", so we're not making
 * the worst case worse. The original line is replaced in place, keeping
 * the rest of the candidate fields (priority, ufrag, type, …) intact.
 *
 * Used by both `AdaptiveSession` and `SharedSession` — pulled out into
 * its own module so the two paths stay identical.
 */
export async function resolveMdnsCandidatesInSdp(
  sdp: string,
  logger: Logger,
  sessionTag: string,
): Promise<string> {
  const mdnsHostRe = /([0-9a-fA-F-]+\.local)/g
  const hosts = new Set<string>()
  for (const match of sdp.matchAll(mdnsHostRe)) hosts.add(match[1]!)
  if (hosts.size === 0) return sdp

  // Cap each lookup hard. A `.local` from a REMOTE peer (cellular/Tailscale)
  // is unresolvable here, and the OS resolver (getaddrinfo) blocks ~5s before
  // giving up — that delay stalls `setRemoteDescription` and breaks the whole
  // ICE flow even when the answer ALSO carries usable srflx/relay candidates
  // (the remote case). A same-LAN peer's `.local` resolves via Bonjour/Avahi
  // in a few ms, so a short cap keeps the LAN benefit while never blocking ICE
  // on the (pointless-for-remote) host candidates.
  const MDNS_LOOKUP_TIMEOUT_MS = 400
  const replacements = await Promise.all(
    [...hosts].map(async (host) => {
      try {
        const address = await Promise.race([
          dnsLookup(host, { family: 4 }).then((r) => r.address),
          new Promise<never>((_, reject) =>
            setTimeout(
              () => reject(new Error(`mDNS lookup timed out after ${MDNS_LOOKUP_TIMEOUT_MS}ms`)),
              MDNS_LOOKUP_TIMEOUT_MS,
            ).unref?.(),
          ),
        ])
        logger.info('mDNS resolve succeeded', { meta: { sessionTag, host, address } })
        return [host, address] as const
      } catch (err) {
        logger.warn('mDNS resolve failed (dropping host candidate, srflx/relay still used)', {
          meta: { sessionTag, host, error: errMsg(err) },
        })
        return [host, null] as const
      }
    }),
  )

  let rewritten = sdp
  for (const [host, address] of replacements) {
    if (!address) continue
    const escaped = host.replace(/\./g, '\\.')
    rewritten = rewritten.replace(new RegExp(escaped, 'g'), address)
  }
  return rewritten
}
