/**
 * Census rows marked **X** in docs/design/entries-census.md (B0). No code reads
 * these addon-settings rows; they are deleted by the operator after verify.
 *
 * The live shape scan (`scan-raw-secrets.ts`) reports them until this script
 * runs; the static D879 guard cannot see them because nothing in the repo
 * writes them any more.
 */

export const ADDON_SETTINGS = 'addon-settings'

/** Dreame moved to integrations; the password marker must live on this id (prod). */
export const DREAME_INTEGRATION_ID = 'int_0009'
export const DREAME_LEGACY_BROKERS_KEY = 'provider-dreame.brokers'

export interface LeftoverRowTarget {
  readonly censusId: string
  readonly collection: string
  readonly key: string
  readonly note: string
}

export const LEFTOVER_ROW_TARGETS: readonly LeftoverRowTarget[] = [
  {
    censusId: 'C10',
    collection: ADDON_SETTINGS,
    key: DREAME_LEGACY_BROKERS_KEY,
    note: 'legacy brokers[] after int_0009 integration',
  },
  {
    censusId: 'C11',
    collection: ADDON_SETTINGS,
    key: 'provider-ecowitt.brokers',
    note: 'legacy brokers[] after int_0008 integration',
  },
  {
    censusId: 'C12',
    collection: ADDON_SETTINGS,
    key: 'provider-gree.brokers',
    note: 'legacy brokers[] after int_0011 integration',
  },
  ...(
    [
      'tokenId',
      'tokenSecret',
      'environment',
      'gpuType',
      'region',
      'costCapUsd',
      'maxRuntimeHours',
      'failedDatasetGraceHours',
    ] as const
  ).map(
    (field): LeftoverRowTarget => ({
      censusId: 'C14',
      collection: ADDON_SETTINGS,
      key: `training-modal.${field}`,
      note: 'pre-entries[] flat Modal account fields',
    }),
  ),
  {
    censusId: 'N3',
    collection: ADDON_SETTINGS,
    key: 'local-network.viewerBaseUrls',
    note: 'pre-D734 role-name URL list (ignored by address book)',
  },
  {
    censusId: 'N3',
    collection: ADDON_SETTINGS,
    key: 'local-network.notificationBaseUrl',
    note: 'pre-D734 notification base URL (ignored by address book)',
  },
]

/** Row ids the shape scan may report until B0 delete runs (hints only). */
export const LEFTOVER_ROW_IDS: ReadonlySet<string> = new Set(LEFTOVER_ROW_TARGETS.map((t) => t.key))
