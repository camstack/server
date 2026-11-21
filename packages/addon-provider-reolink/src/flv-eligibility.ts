/**
 * Whether a Reolink camera can serve HTTP-FLV. FLV is pulled from the
 * camera's own web server (`http://<host>/flv?...`), so the camera's stored
 * network-port snapshot (`deviceCache.netPortSnapshot`, read from the camera)
 * is the evidence: an HTTP server that reports itself disabled serves no FLV.
 * Battery cameras that stream over Baichuan only report exactly that.
 *
 * When the snapshot has no verdict for HTTP (never read), a battery camera is
 * assumed not to serve FLV; a mains camera keeps the option.
 */

export interface FlvEvidence {
  readonly netPortSnapshot?: { readonly http?: { readonly enable?: boolean } }
  readonly isBattery: boolean
}

export function cameraServesFlv(evidence: FlvEvidence): boolean {
  const httpEnabled = evidence.netPortSnapshot?.http?.enable
  if (httpEnabled !== undefined) return httpEnabled
  return !evidence.isBattery
}
