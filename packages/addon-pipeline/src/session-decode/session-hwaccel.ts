/**
 * Which hardware decode backends a session decode worker may try (D926).
 *
 * The node's kernel hwaccel resolver (`ctx.kernel.hwaccel`) is the one place
 * that knows whether libva can initialise the VA driver; when it cannot, it
 * logs ONE error and withholds `vaapi` / `qsv`. The worker used to try its own
 * fixed `vaapi, qsv, cuda` list on every session and log each failure (722
 * lines a day on intel-1.2.509). The parent resolves the OFFER here and sends
 * it on `start`; the worker tries the platform order filtered by that offer.
 *
 * Kept free of `@camstack/types` VALUES: the child bundle imports the guard and
 * the candidate function, and must stay schema-free (D453).
 */
import type { HwAccelBackend, IKernelHwAccel } from '@camstack/types'

/**
 * The backends the resolver offers for decode, or `null` when nothing has
 * answered yet (no resolver on this node, or every resolve so far failed) —
 * the worker then uses its platform order, which is what it did before.
 */
export type SessionHwaccelOffer = readonly HwAccelBackend[] | null

const KNOWN_BACKENDS: readonly string[] = [
  'videotoolbox',
  'cuda',
  'nvdec',
  'vaapi',
  'qsv',
  'd3d11va',
  'dxva2',
  'amf',
  'vdpau',
  'drm',
]

function isHwAccelBackend(value: unknown): value is HwAccelBackend {
  return typeof value === 'string' && KNOWN_BACKENDS.includes(value)
}

/** Wire guard for the `start` message's `hwaccel` field. */
export function isSessionHwaccelOffer(value: unknown): value is SessionHwaccelOffer {
  return value === null || (Array.isArray(value) && value.every(isHwAccelBackend))
}

/** The worker's decode order per platform — first successful create() wins. */
export function platformDecodeOrder(platform: NodeJS.Platform): readonly HwAccelBackend[] {
  switch (platform) {
    case 'darwin':
      return ['videotoolbox']
    case 'linux':
      return ['vaapi', 'qsv', 'cuda']
    case 'win32':
      return ['d3d11va', 'dxva2', 'cuda']
    default:
      return []
  }
}

/**
 * The platform order, restricted to what the resolver offers. An empty offer
 * (VA init failed and no other GPU) means software, with no per-session try.
 */
export function sessionDecodeCandidates(
  platform: NodeJS.Platform,
  offer: SessionHwaccelOffer,
): readonly HwAccelBackend[] {
  const order = platformDecodeOrder(platform)
  if (offer === null) return order
  return order.filter((backend) => offer.includes(backend))
}

/**
 * The parent's copy of the resolver's auto answer, refreshed on the acquire
 * leg of every session spawn and read synchronously when `start` is sent. A
 * resolve that fails changes nothing (D49): the last answer stands.
 */
export class SessionHwaccelSource {
  private offer: SessionHwaccelOffer = null

  current(): SessionHwaccelOffer {
    return this.offer
  }

  async refresh(resolver: IKernelHwAccel | undefined): Promise<void> {
    if (!resolver) return
    try {
      const res = await resolver.resolve(null)
      this.offer = [...res.preferred]
    } catch {
      // Unknown is not "no hardware": keep the last answer (or null → platform order).
    }
  }
}
