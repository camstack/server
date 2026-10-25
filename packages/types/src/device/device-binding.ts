/**
 * Per-device capability binding record. For each capability a device supports,
 * one entry tells consumers which addon+node currently serves it (native or
 * wrapper) and which addon provides the underlying native in case a wrapper is
 * active.
 */
export interface DeviceBindingEntry {
  capName: string
  /**
   * Which shape of provider serves the cap. UI metadata only — consumers must
   * never branch on it for routing (D13); resolve a `(cap, device)` pair
   * through `getProviderForDevice`.
   *
   * There were three. `linked` denoted a cap SYNTHESIZED from device-links with
   * no provider at all, and it existed so a link-only cap would still render a
   * panel — a fifth binding kind and a virtual-binding path the kernel paid for
   * one feature. Wiring was deleted on 2026-08-08 (0 links across 302 devices)
   * and the kind went with it: a composed device's caps are native to it, so
   * nothing needs to be synthesized out of nowhere.
   */
  kind: 'native' | 'wrapped'
  /** Currently-active provider. For kind='native', equal to `nativeAddonId`.
   *  For kind='wrapped', the wrapper addon id. */
  providerAddonId: string
  /** Node where the active provider runs. 'hub' for native; may vary for wrappers. */
  providerNodeId: string
  /** Always the addon id of the underlying native provider for the device. */
  nativeAddonId: string
}

export interface DeviceBinding {
  /** Numeric device id — matches `IDevice.id`. */
  deviceId: number
  entries: DeviceBindingEntry[]
}
