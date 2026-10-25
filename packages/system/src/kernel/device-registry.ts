import type { IDevice, IDeviceRegistry } from '@camstack/types'

export class DeviceRegistry implements IDeviceRegistry {
  /** Primary map: every registered device keyed by its progressive
   *  numeric id. Numeric id is the system-wide unique handle; stableId
   *  is integration-scoped and only used at external boundaries. */
  private readonly byId = new Map<number, IDevice>()
  /** Addon scoping index: addonId → set of numeric device ids owned
   *  by that addon. Lets `getAllForAddon` and per-addon teardown stay
   *  O(1) per lookup without a second primary table. */
  private readonly byAddon = new Map<string, Set<number>>()
  /** Inverse of byAddon for the single-device case. */
  private readonly idToAddon = new Map<number, string>()

  register(addonId: string, device: IDevice): void {
    const existingById = this.byId.get(device.id)
    if (existingById && existingById !== device) {
      throw new Error(
        `Device numeric id ${device.id} already registered (stableId=${existingById.stableId}); attempted to register ${device.stableId}`,
      )
    }
    this.byId.set(device.id, device)
    let idSet = this.byAddon.get(addonId)
    if (!idSet) {
      idSet = new Set()
      this.byAddon.set(addonId, idSet)
    }
    idSet.add(device.id)
    this.idToAddon.set(device.id, addonId)
  }

  /** Owning addonId for a registered numeric id, or null if not registered. */
  getAddonId(id: number): string | null {
    return this.idToAddon.get(id) ?? null
  }

  /** Look up any registered device by its progressive numeric id. */
  getById(id: number): IDevice | null {
    return this.byId.get(id) ?? null
  }

  getAllForAddon(addonId: string): readonly IDevice[] {
    const ids = this.byAddon.get(addonId)
    if (!ids) return []
    const result: IDevice[] = []
    for (const id of ids) {
      const device = this.byId.get(id)
      if (device) result.push(device)
    }
    return result
  }

  getChildren(parentDeviceId: number): readonly IDevice[] {
    return this.getAll().filter((d) => d.parentDeviceId === parentDeviceId)
  }

  remove(deviceId: number): void {
    const device = this.byId.get(deviceId)
    if (!device) return
    const addonId = this.idToAddon.get(deviceId)
    this.byId.delete(deviceId)
    this.idToAddon.delete(deviceId)
    if (addonId) {
      const idSet = this.byAddon.get(addonId)
      idSet?.delete(deviceId)
      if (idSet && idSet.size === 0) this.byAddon.delete(addonId)
    }
  }

  getAll(): readonly IDevice[] {
    return [...this.byId.values()]
  }

  /** All devices with their owning addonId. */
  getAllWithAddonId(): readonly { addonId: string; device: IDevice }[] {
    const result: { addonId: string; device: IDevice }[] = []
    for (const [addonId, ids] of this.byAddon.entries()) {
      for (const id of ids) {
        const device = this.byId.get(id)
        if (device) result.push({ addonId, device })
      }
    }
    return result
  }

  /** All addonIds that have at least one registered device. */
  getAddonIds(): readonly string[] {
    return [...this.byAddon.keys()]
  }
}
