/**
 * Legacy path — the real hook lives in `@camstack/ui-library`
 * (`use-event-invalidation.ts`), which carries the trailing coalesce window
 * added 2026-08-19: without it, one open admin tab refetched listClients
 * ~70×/s off the per-broker metrics-snapshot events and produced 2 028 UDS
 * timeouts during a boot. This file was a byte-copy that would have kept the
 * storm alive for its nine importers; a re-export cannot drift.
 */
export { useEventInvalidation } from '@camstack/ui-library'
