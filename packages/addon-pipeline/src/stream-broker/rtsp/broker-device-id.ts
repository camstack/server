/**
 * Parse the numeric deviceId out of a canonical brokerId
 * (`${deviceId}/${camStreamId}` or `${deviceId}/${profile}`). Returns
 * `undefined` for a malformed id — so every device-scoped log line on the RTSP
 * plane can carry `tags.deviceId` without risking a bogus tag value.
 *
 * Every log line about a device carries `tags: { deviceId }`, always the same
 * key and always the numeric id: a miss rate, a media gap or a routing fault is
 * always asked per-camera ("why is 102 worse than 101?"), and a line that omits
 * the tag cannot answer it.
 */
export function deviceIdFromBrokerId(brokerId: string): number | undefined {
  const parsed = Number(brokerId.split('/')[0])
  return Number.isFinite(parsed) ? parsed : undefined
}
