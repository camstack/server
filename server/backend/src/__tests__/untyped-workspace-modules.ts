/**
 * Workspace packages some backend specs load at runtime, which publish NO
 * type declarations to this package: addon builds emit JS only (an addon is
 * never imported by another package — CLAUDE.md), admin-ui's `./server/addon`
 * likewise, and `./stream-broker` is an `exports` subpath, which this
 * package's `moduleResolution: node` cannot follow.
 *
 * Shorthand ambient modules: their exports are `any` here. An ambient
 * declaration OVERRIDES real resolution for the whole program — including
 * production files, since D695 typechecks code and specs together. So
 * `check-specs-are-typechecked` allows these five only while no production
 * file of this package imports them. The literal `import('@camstack/…')`
 * specifiers in the specs stay literal so `check-spec-dynamic-imports-declared`
 * still sees them.
 */
declare module '@camstack/addon-admin-ui/server/addon'
declare module '@camstack/addon-auth/oidc'
declare module '@camstack/addon-benchmark'
declare module '@camstack/addon-mqtt-broker'
declare module '@camstack/addon-pipeline/stream-broker'
