# `electron-builder.viewer.json` — the reduced product

The desktop shell builds **two** products from one source tree (D402,
`docs/design/2026-09-08-desktop-viewer-role.md`). This file is the second one.

The VIEWER product: the same shell source as CamStack, built without the
server closure. See D402 and docs/design/2026-09-08-desktop-viewer-role.md.
The whole point is the two things this file does NOT declare. The fat build
stages `.deps/runtime-node` (a full Node 24 binary) and `.deps/node_modules`
(the entire @camstack/server closure: system/types/sdk/ui-library,
every addon-*, fastify/moleculer/zod/winston and the native prebuilds for
better-sqlite3, node-av, sharp) into Resources/. A machine that only WATCHES
a hub runs none of it: the viewer role spawns no node process at all, so
`extraResources` is empty and `scripts/stage-deps.mjs` never runs.
`artifactName` is deliberately NOT `CamStack-*`. The release workflow
matches artifacts by glob, and two matrix legs sharing one glob is how the
v1.2.3 DMG got overwritten by the other architecture's build. This product
owns `CamStackViewer-*` and nothing else does.
`appId` differs too: the viewer and the hub app must be installable side by
side on one machine — the operator who runs a hub here is the same person
who wants to watch it from the sofa.

Enforced by `scripts/check-viewer-build-carries-no-server.ts`, which runs in CI.
It fails if `extraResources` is non-empty or missing, if `extends` reappears, if
`artifactName` starts with `CamStack-`, if `appId` matches the fat product's, or
if a `dist:viewer:*` script starts running `stage-deps`.

The rationale lives here rather than in the JSON because electron-builder
validates its config against a schema and rejects unknown keys — a `$comment`
field fails the build outright.

## The setup window follows the product

`extraMetadata.name` / `productName` here are not only branding: they are how
the running app knows which product it is. Electron derives `app.getName()` from
the packaged `package.json` that electron-builder writes them into, and
`resolveDesktopProduct` (`src/product/desktop-product.ts`) reads it exactly once,
in `main.ts`, before `app.whenReady`. That answer decides two things (D402):

- the setup window — this product shows the hub address and nothing else; the
  node product shows a hub/agent picker and no viewer option;
- whether `ignore-certificate-errors` may be appended at all. In this product it
  never is, whatever `<userData>/config.json` says.

So renaming either field here silently changes which UI ships and which
certificate posture the app boots with. Change them only together with
`VIEWER_APP_NAME` / `VIEWER_PRODUCT_NAME`.
