/**
 * INTEGRATION-LEVEL SETTINGS — the client half of a core concept.
 *
 * An operator looking for "the Reolink SMTP port" looks under Reolink. The six
 * `emailPush*` keys configure ONE SMTP server in ONE provider process serving
 * every Reolink camera, so the integration page is an honest home for them: the
 * page is about the integration, and the value is one per integration.
 *
 * THE DECLARATION LIVES IN CORE, NOT HERE. An addon names the sections that are
 * its integration's configuration in `BaseAddon.integrationSettingSections()`,
 * and core answers `addonSettings.getIntegrationSettings` with exactly those
 * sections — already selected, already stripped of `perNode` fields, hydrated
 * from the same store. This module holds no policy about WHICH settings are
 * integration-level; it cannot, because it does not know. Its whole job is to
 * make the surface that renders them honest.
 *
 * WHAT THIS MUST NEVER BECOME. Surfacing settings on a second page must never
 * move them to a second SCOPE, and the page must SAY the scope it edits. This
 * repo has shipped the failure of each:
 *
 *   - `AddonCard` pinned `nodeId="hub"` while the node card wrote
 *     `<key>@<thatNode>` — two reachable controls, one label, two store keys,
 *     both showing a value (`lib/settings-field-scope.ts` records the fix);
 *   - `ProviderSettingsTab` (deleted) mounted an addon-wide `level: 'global'`
 *     schema inside ONE camera's page, where editing the SMTP port from camera
 *     102 reconfigured every Reolink.
 *
 * HOW BOTH ARE MADE IMPOSSIBLE RATHER THAN DISCOURAGED.
 *
 *  1. **One key, guaranteed upstream.** `getIntegrationSettings` returns a
 *     SUBSET of the global schema and the cap deliberately ships NO
 *     `updateIntegrationSettings` — the writer is `updateGlobalSettings`. A
 *     second store key is unreachable from this surface, not merely unused.
 *  2. **No node scope.** Core drops `perNode` fields before they leave the
 *     addon, so a node-scoped value cannot arrive here to be mis-attributed.
 *  3. **The surface refuses a device or node mount.** `NodeAddonsSettingsPanel`
 *     throws when `surface` is combined with `level: 'device'`, a `deviceId`,
 *     a non-null `nodeId`, or a `fieldScope`. A device page cannot mount this
 *     by accident, and the throw is louder than a review comment.
 *
 * There used to be a fourth mechanism — an on-screen paragraph, rendered by the
 * panel, stating that these values are shared by every device. It was removed on
 * operator request (2026-09-05) and it is not coming back: it explained a scope
 * the three mechanisms above already MAKE TRUE, and a sentence that describes
 * what the code enforces is the leftover this repo treats as worse than nothing.
 * `settings-surface-scope.spec.ts` pins its absence across all three files that
 * could reintroduce it.
 *
 * WHY `section.tab` IS NOT THE DECLARATION — the design this replaces.
 * The first version declared forwarding as `tab: 'integration'`, chosen because
 * `tab` already crossed the wire and a new `ConfigSection` key would have been
 * stripped by Zod until a framework publish shipped. It worked and it was
 * wrong: `tab` also feeds the settings tab bar, so the addon's own page grew a
 * tab labelled "integration" — the mechanism's name leaking into an
 * operator-facing label, because `tab` means "how to GROUP this visually" and
 * cannot also mean "where this lives". `tab` is now purely visual again, and
 * remains available to group sections WITHIN the integration page. See D269.
 */
import type { ConfigUISchemaWithValues } from '@camstack/types'

/**
 * A surface, other than the addon's own settings page, that renders a declared
 * subset of an addon's settings.
 *
 * One member today. It is a union rather than a boolean so a second surface
 * arrives as a new member, with its own entry in the panel's refusals, instead
 * of as a second parallel flag that can disagree with this one.
 */
export type SettingsSurface = 'integration'

/**
 * Did the addon declare any integration-level settings?
 *
 * `null` is core's answer for "declared none" — an addon that opts out gets no
 * panel, no heading and no empty state. A payload with no section means the
 * same thing and is treated the same, so a schema whose sections were all
 * dropped as `perNode` cannot render a bare heading.
 */
export function hasIntegrationSettings(
  schema: ConfigUISchemaWithValues | null | undefined,
): boolean {
  if (schema == null) return false
  return schema.sections.some((section) => section.fields.length > 0)
}
