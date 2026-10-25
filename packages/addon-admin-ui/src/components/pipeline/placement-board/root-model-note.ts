/** Inputs for resolving the accelerator's object-detection root model id. */
export interface RootModelDeviceSource {
  readonly defaultModelId?: string
  readonly steps?: Readonly<Record<string, { readonly modelId?: string }>>
}

/** Per-(node, device) root model: object-detection step pin, else format default. */
export function rootModelIdForDevice(device: RootModelDeviceSource): string | null {
  const pinned = device.steps?.['object-detection']?.modelId
  if (typeof pinned === 'string' && pinned.length > 0) return pinned
  if (typeof device.defaultModelId === 'string' && device.defaultModelId.length > 0) {
    return device.defaultModelId
  }
  return null
}
