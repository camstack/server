---
id: D747
title: Every addon page package is scanned by the admin-ui Tailwind build
status: accepted
date: 2026-10-07
supersedes:
applies-to:
  - packages/addon-admin-ui/src/index.css
  - scripts/check-addon-page-css.ts
---

## Context

An addon page is a Module Federation remote. `AddonPageLoader` loads its
JavaScript and nothing else, so the CSS the page builds for itself
(`dist/<pkg>.css`) is never requested. Each class the page uses must
therefore already be in the admin-ui stylesheet. Tailwind writes a class into
that stylesheet only if it finds the class in a file it scans, and
`index.css` scanned ui-library and three widget trees but no page package. On
Model Studio → Installed, the classes `gap-x-8`, `pl-1` and `bg-zinc-*`
produced no rule, and the Size label drew over the format pills. A check
against the built stylesheet found 20+ classes used by page packages that had
no rule (`sm:ml-auto`, `sm:w-auto`, `bg-zinc-950`, `divide-x`, `list-inside`,
…). The build, the typecheck and the page's own dev server were all green,
because that dev server loads the page's own CSS.

Loading the remote's CSS from `AddonPageLoader` was rejected. It is a second
full Tailwind build (preflight, theme tokens, and Model Studio's
`color-scheme: dark`) applied on top of the host's, and it would fight the
light theme.

## Decision

`packages/addon-admin-ui/src/index.css` has a generated block with one
`@source` for each package whose `camstack.addons[].pages` is non-empty. The
packages are found from every `packages/*/package.json`, never from a hand
list. `tsx scripts/check-addon-page-css.ts --write` rewrites the block. A page
package's CSS must not declare `@theme`, `@utility` or `@custom-variant`: the
classes those define exist only in the page's own build. Shared tokens belong
in ui-library's theme.

## Consequences

- A new page package needs `--write` before CI passes.
- The host stylesheet grows by the classes the page packages use. The growth
  measured at the time was about 3 KB.
- A class the theme cannot produce at all (`bg-surface-raised` in
  osd-manager) is still invisible to this guard. Only a check against the
  built stylesheet would see it.

## Enforcement

`scripts/check-addon-page-css.ts` is in the CI guard list.
`scripts/__tests__/check-addon-page-css.spec.ts` covers a missing block, a
page package that is not scanned, a stale entry, and the repo's own
stylesheet.
