/**
 * Overlay the fresh on-disk `declaration` onto a live addon instance's
 * `manifest` when building the rows returned by `listAddons()`.
 *
 * `loadNewAddons()` — invoked on every `camstack deploy` / package install —
 * refreshes `entry.declaration` from a fresh disk scan but DELIBERATELY leaves
 * the live `entry.addon` instance in place so `restartAddon` can shut the old
 * instance down cleanly. Manifest-affecting changes (a newly declared
 * capability, a new `brokerKind`) therefore land on `entry.declaration` while
 * `entry.addon.manifest` keeps the value captured at the addon's ORIGINAL load.
 *
 * Consumers of `listAddons()` — notably the integration picker's
 * `getAvailableTypes`, which gates a provider into the "+ New Integration" list
 * by its declared capability (`device-provider` / `device-adoption`) — must see
 * the post-deploy manifest. Otherwise a redeployed addon that gained
 * `device-adoption` (e.g. the Home Assistant provider after the broker rework)
 * stays invisible in the picker until a full backend restart re-reads the
 * manifest from disk.
 *
 * The on-disk `declaration` is parsed from `package.json` (no `undefined`
 * values), so the spread overlays only the keys the declaration actually
 * defines; the instance manifest fills any gaps.
 */
export function overlayDeclaration<M extends object>(
  instanceManifest: M,
  declaration: Partial<M> | undefined,
): M {
  return { ...instanceManifest, ...declaration }
}
