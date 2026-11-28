/**
 * The sticky Save / Discard bar lives in the library (`FormSaveBar`), so every
 * form that saves on request — here and in an addon page — shares one bar on an
 * opaque surface. This module keeps the admin-ui import path.
 */
export { FormSaveBar } from '@dominevo/ui-library'
export type { FormSaveBarProps } from '@dominevo/ui-library'
