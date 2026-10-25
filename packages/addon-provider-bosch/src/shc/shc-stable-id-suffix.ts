/** Filesystem-safe stableId suffix fragment from a Bosch device id. */
export function shcStableIdSuffixFromDeviceId(shcDeviceId: string): string {
  return shcDeviceId.replace(/[^a-zA-Z0-9._-]+/g, '_')
}
