/**
 * Who may see, and who may mint, an integration.
 *
 * The integration store is shared by every addon on the node, so the registry
 * handed out to callers is a VIEW: rows whose declaring addon is not installed
 * are hidden, and the data stays in the database so a reinstall reconnects to
 * it rather than starting empty.
 *
 * That filter had a hole, and it was the silent, accumulating kind. Extracted
 * here verbatim from `AddonRegistryService.createFilteredRegistry` so the rule
 * is testable on its own.
 */

import type {
  CreateIntegrationInput,
  IIntegrationRegistry,
  Integration,
  IScopedLogger,
} from '@camstack/types'
import { bareAddonId } from '@camstack/types'

export interface IntegrationVisibilityDeps {
  /** The unfiltered store. */
  readonly raw: IIntegrationRegistry
  /**
   * The one predicate. Every read is gated on it — and, since 2026-08-09, so
   * is the write. Called with the bare manifest id.
   */
  readonly isAddonInstalled: (addonId: string) => boolean
  readonly logger: IScopedLogger
}

/**
 * Wrap `raw` in the installed-addon view.
 *
 * Two rules, and they are the same rule read in both directions:
 *
 * 1. **A principal that cannot READ an integration may not CREATE one.**
 *    Until this guard existed, `createIntegration` was the only unfiltered
 *    entry point in the whole surface. A core block — addon id
 *    `core-block-<uuid>`, never in the installed set — therefore minted a fresh
 *    row on EVERY start: `getIntegrationByAddonId` answered null forever, so
 *    the get-or-create above it never found what it had just made.
 *    `listIntegrations` hid the row from the operator and `integrations.delete`
 *    answered *"not found"* for the same reason, so nothing could ever remove
 *    it. Measured on the live hub: `int_0021` and `int_0022`, two starts of one
 *    block, invisible and undeletable. A declarer that is not an installed
 *    addon hangs its devices off an integration somebody else owns —
 *    `DeclaredDevicesSpec.integrationId`.
 *
 * 2. **Hidden is not absent.** A read that suppresses a row that EXISTS logs
 *    it. Both branches returned a bare `null`, and that indistinguishability is
 *    precisely what kept rule 1's breach invisible for as long as it lasted.
 */
export function createFilteredIntegrationRegistry(
  deps: IntegrationVisibilityDeps,
): IIntegrationRegistry {
  const { raw, logger } = deps
  // A co-located builtin's `ctx.id` is `addon:<manifest id>`; every registry
  // key is bare (D72). Normalise on the way in, or the create guard rejects
  // exactly the builtins that legitimately declare an integration.
  const isInstalled = (addonId: string): boolean => deps.isAddonInstalled(bareAddonId(addonId))

  /** The suppression log line. Only ever called when the row EXISTS. */
  const logHidden = (integration: Integration, phase: string): void => {
    logger.warn(
      'integration hidden — its addon is not installed, so this read answers null even though the row exists',
      {
        tags: { integrationId: integration.id, addonId: integration.addonId },
        meta: { phase, name: integration.name },
      },
    )
  }

  const createIntegration = async (input: CreateIntegrationInput): Promise<Integration> => {
    if (!isInstalled(input.addonId)) {
      // Refuse, loudly. The alternative is not "it works": it is a row this
      // same wrapper will hide from every later read, from the operator's list
      // and from delete — the row can only accumulate.
      logger.error('refused to mint an integration for a principal that cannot read one', {
        tags: { addonId: input.addonId },
        meta: { phase: 'create', name: input.name },
      })
      throw new Error(
        `addon "${input.addonId}" is not installed, so it cannot read an integration — ` +
          'and a principal that cannot read one must not create one (it would be invisible ' +
          'and undeletable). Hang the devices off an existing integration instead: ' +
          'DeclaredDevicesSpec.integrationId.',
      )
    }
    return raw.createIntegration(input)
  }

  return {
    createIntegration,
    getIntegration: async (id) => {
      const i = await raw.getIntegration(id)
      if (i === null) return null
      if (isInstalled(i.addonId)) return i
      logHidden(i, 'getIntegration')
      return null
    },
    getIntegrationByAddonId: async (addonId) => {
      const i = await raw.getIntegrationByAddonId(addonId)
      if (i === null) return null
      if (isInstalled(i.addonId)) return i
      logHidden(i, 'getIntegrationByAddonId')
      return null
    },
    listIntegrations: async () => {
      const all = await raw.listIntegrations()
      return all.filter((i) => isInstalled(i.addonId))
    },
    updateIntegration: (id, updates) => raw.updateIntegration(id, updates),
    deleteIntegration: (id) => raw.deleteIntegration(id),

    // Integration settings: passthrough (already gated by getIntegration)
    getIntegrationSettings: (id) => raw.getIntegrationSettings(id),
    setIntegrationSetting: (id, key, value) => raw.setIntegrationSetting(id, key, value),
    setIntegrationSettings: (id, settings) => raw.setIntegrationSettings(id, settings),
  }
}
