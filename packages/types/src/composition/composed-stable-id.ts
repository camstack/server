/**
 * A composed device's stableId is this prefix plus the block id. Its own module,
 * free of zod, so the addon runner can read it through `@camstack/types/addon`
 * without loading the schema barrel (D28).
 */
export const COMPOSED_DEVICE_STABLE_ID_PREFIX = 'composed-'
