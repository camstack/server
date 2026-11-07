import type { AddonContext } from '@camstack/types'

/**
 * A spec builds only the members of the addon context its subject reads. The members the addon
 * needs to boot are checked at run time, so the stub is narrowed by a guard, not by a cast.
 */
function isAddonContext(value: unknown): value is AddonContext {
  if (typeof value !== 'object' || value === null) return false
  return 'id' in value && 'logger' in value && 'eventBus' in value && 'settings' in value
}

export function stubAddonContext(parts: object): AddonContext {
  if (!isAddonContext(parts))
    throw new Error('spec context stub is missing a member the addon needs')
  return parts
}
