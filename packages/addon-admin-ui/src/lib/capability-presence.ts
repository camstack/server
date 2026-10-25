/**
 * `useCapabilityPresence`, re-exported.
 *
 * The hook MOVED to `@camstack/ui-library`
 * (`src/hooks/use-capability-presence.ts`) when a ui-library widget needed it:
 * `host/clips-browser` is mounted by the framework from the cap's own
 * `deviceConfig.ui` declaration (D14) and lives in the library, so a presence
 * gate that only the admin UI could reach would have been re-implemented
 * there — a second answer to a question the registry already answers, which
 * is the defect [D315](../../../../docs/decisions/adr-0315-a-ui-claims-something-is-absent-only-from-a-query-that-answered.md)
 * is about.
 *
 * This path is kept because it is what every admin-UI caller and every test
 * that mocks it already spells, and because `docs/architecture/ui.md` vouches
 * for it by name. There is ONE implementation, next door.
 */
export {
  classifyCapability,
  useCapabilityPresence,
  type CapabilityPresence,
} from '@camstack/ui-library'
