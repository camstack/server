/**
 * The sticky Save / Discard bar lives in the library (`FormSaveBar`), so every
 * form that saves on request — here and in an addon page — shares one bar on an
 * opaque surface. This module keeps the admin-ui import path.
 */
export { FormSaveBar } from '@camstack/ui-library'
export type { FormSaveBarProps } from '@camstack/ui-library'
