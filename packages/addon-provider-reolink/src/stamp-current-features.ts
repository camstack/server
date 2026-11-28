import type { CamStreamDescriptor } from '@dominevo/types'

/**
 * Stamp the camera's CURRENT feature list on every descriptor.
 *
 * A descriptor restored from the durable catalog slice carries the
 * `deviceFeatures` of whichever provider build wrote it (a pre-#459 build wrote
 * `battery-operated` without `sleeps`). Trusting that list made the broker open
 * a default prebuffer hold on a battery camera and keep it awake forever. The
 * features are a property of the camera NOW, never of the stored catalog, so a
 * stored list is never read.
 */
export function stampCurrentFeatures(
  descriptors: readonly CamStreamDescriptor[],
  features: readonly string[],
): CamStreamDescriptor[] {
  return descriptors.map((d) => ({ ...d, deviceFeatures: [...features] }))
}
