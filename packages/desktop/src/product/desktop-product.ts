/**
 * WHICH of the two products this binary is — the whole answer, in one place.
 *
 * One source tree ships twice (ADR-0402):
 *
 *   - `node`   — the full app. Stages the `@camstack/server` closure into
 *                `Resources/` and runs a hub or an agent.
 *   - `viewer` — the reduced app (no closure, no Node runtime). It only ever
 *                watches a hub, so its role is fixed by CONSTRUCTION and its
 *                setup window is one field.
 *
 * The read is `app.getName()`, and it is made exactly once (`main.ts`, module
 * top) — every other module takes the answer as a parameter.
 *
 * Why `app.getName()` and not the packaged `package.json` or an env marker:
 * `electron-builder.viewer.json` sets `extraMetadata.name` /
 * `extraMetadata.productName`, and electron-builder writes BOTH into the
 * packaged app's `package.json` — which is precisely the file Electron derives
 * `app.getName()` from (`productName` preferred over `name`). So the name IS
 * the build config, with no second file to read, no fs access, and it is
 * available before `app.whenReady` — which the certificate-switch decision
 * requires. Matching both spellings means it does not matter which of the two
 * fields Electron picks on a given platform.
 *
 * The match is POSITIVE on the reduced product and everything else is `node`.
 * That direction is deliberate: an unrecognised name must fall to the product
 * that keeps working (the node app's certificate posture is the pre-existing
 * one), never to a viewer that silently stops offering the roles it can run.
 *
 * UNPACKAGED (`npm run dev`, `electron .`): neither `extraMetadata` nor any
 * packaged metadata exists, so there is nothing to read and the answer is
 * `node` — the product a developer running the workspace almost always means.
 * To see the reduced product's UI in development, set
 * `CAMSTACK_DESKTOP_PRODUCT=viewer`. That override is honoured ONLY when
 * unpackaged: in a shipped app the product is the build and an environment
 * variable must never be able to turn a viewer install into one that appends
 * `ignore-certificate-errors`.
 */

/** The two products built from this source tree. */
export type DesktopProduct = 'node' | 'viewer'

/** `extraMetadata.name` in `electron-builder.viewer.json`. */
export const VIEWER_APP_NAME = 'camstack-viewer'

/** `extraMetadata.productName` in `electron-builder.viewer.json`. */
export const VIEWER_PRODUCT_NAME = 'CamStack Viewer'

/** Development-only product override; ignored in a packaged app. */
export const PRODUCT_OVERRIDE_ENV_VAR = 'CAMSTACK_DESKTOP_PRODUCT'

export interface ProductEnvironment {
  /** `app.getName()` — the packaged `productName`, else `name`. */
  readonly appName: string
  /** `app.isPackaged`. */
  readonly isPackaged: boolean
  /** `process.env[PRODUCT_OVERRIDE_ENV_VAR]`, unpackaged runs only. */
  readonly override: string | undefined
}

/** Pure: the product, from what Electron can tell us about this binary. */
export function resolveDesktopProduct(environment: ProductEnvironment): DesktopProduct {
  if (!environment.isPackaged) {
    return environment.override === 'viewer' ? 'viewer' : 'node'
  }
  if (environment.appName === VIEWER_APP_NAME || environment.appName === VIEWER_PRODUCT_NAME) {
    return 'viewer'
  }
  return 'node'
}
