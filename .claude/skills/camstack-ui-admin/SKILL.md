---
name: camstack-ui-admin
description: CamStack admin UI, ui-library and addon pages (Module Federation remotes — Model Studio, Benchmark, OSD manager, Training — and widgets). Use with camstack-ui when adding or changing an admin page, a /system tab, a table, a dialog, a settings form, a secret field, an integration page, an addon page or a ui-library component; or when an addon page renders with missing styles. Covers AdminPage, AdminTabs, IntegrationHub, DataTable, Dialog, the secret field, pickers and the @source / D747 addon-page CSS rule.
---

# CamStack UI — admin UI, ui-library, addon pages

Load the umbrella first: `camstack-ui` (`.claude/skills/camstack-ui/SKILL.md`)
owns the workflow, the token map and the done-gate. This skill is the web
half. The rules behind each line are in `docs/ui/admin-patterns.md` and
`docs/ui/conventions.md`; read the section before you use the pattern.

## Where your file lives decides what you may import

| File under | May import | Notes |
| --- | --- | --- |
| `packages/addon-admin-ui/src/` | `@camstack/ui-library` + admin-ui-local components | `AdminPage`, `AdminTabs`, `StableTabPanel`, `components/integration-hub/` are LOCAL |
| `packages/ui-library/src/` | its own tree only | export new things from `src/primitives/index.ts` / `src/composites/index.ts`; `npm run ui:catalogue` |
| an addon page (`packages/addon-<x>/src/page.tsx` …) | `@camstack/ui-library` only | a Module Federation remote; React, tRPC, react-query and the library are SHARED with the host |

**Addon pages (Module Federation).** Declared in the package's
`package.json` → `camstack.addons[].pages[]` (`id`, `label`, `icon`, `path`,
`remoteName`, `bundle`); built by `vite.page.config.ts` with
`@module-federation/vite`, exposing `./page`; loaded by
`packages/addon-admin-ui/src/layouts/AddonPageLoader.tsx`, which renders the
default export with `AddonPageProps` (`trpc`, `theme.isDark`, `navigate`).
Reference: `packages/addon-model-studio/vite.page.config.ts`. Develop it
standalone with `mountAddonPage`.

**An addon page ships no CSS (D747).** The host never loads the page's
`dist/*.css`; its classes exist only if the admin-ui Tailwind build scans the
package. `packages/addon-admin-ui/src/index.css` carries a generated `@source`
line per page package — a NEW page package needs
`npx tsx scripts/check-addon-page-css.ts --write`. No `@theme` / `@utility` /
`@custom-variant` in a page's CSS. Symptom when forgotten: the page looks
right on its own dev server and broken in the hub.

## The patterns (verify props with `npm run ui:show -- <Name>`)

- **Page frame:** `AdminPage` (`icon`, `title`, `subtitle`, `actions`, `nav`);
  an addon page uses the library's `PageHeader`. Gutter is `p-2 sm:p-4` — never
  stack another unconditional `p-4` inside (padding compounds on a phone).
- **Tabs:** `AdminTabs` (`tabs: AdminTab[]` with `id`, `label`, `icon`,
  `content`, `ownedParams`; `?tab=` in the URL). One `?tab=` strip per page —
  a page that owns `?tab=` is never nested inside another. Inside a card or
  dialog: `Tabs` / `TabsList` / `TabsTrigger` / `TabsContent`.
- **Integrations of one kind:** `IntegrationHub` (`groups`, `isLoading`,
  `emptyTitle`, `emptyDescription`) with `AddonIntegrationBody` per entry. The
  header pills are the context switcher; selection in `?integration=`, links
  only through `lib/integration-hub-url.ts`. Smallest example:
  `pages/system/Authentication.tsx`; over non-addon kinds:
  `pages/system/Access.tsx` (Identity → Tokens & sessions).
- **Sections and settings:** `SectionCard` + `SettingRow`; a schema-driven
  form is `ConfigFormBuilder` / `AddonGlobalSettingsForm`, never hand-built.
- **Managed lists:** `DataTable` (`columns: DataColumn[]`, `rows`, `rowKey`,
  `maxBodyHeight={TABLE_SCROLL_MAX_H}`,
  `emptyMessage`; per column `sortValue` returning the RAW value or
  `notSortableReason`; `defaultSort`, or controlled `sort` + `onSortChange`;
  `pageSize` (+ `page` / `onPageChange`); `selection` for bulk actions).
  Filters: `useDataTableFilter` + `DataTableFilterBar` outside the table
  (`facetValue` or `facetGroups`). Reference consumer:
  `components/access/CredentialTable.tsx`. Devices: `DeviceList`
  (`mode="generic"` for expandable rows). Never a `div` stack, never a raw
  `<table>`.
- **Dialogs:** `Dialog` + `DialogContent` (`width`,
  `placement="sheet-on-mobile"`, `scroll="body"` when tall) + `DialogHeader` /
  `DialogBody` / `DialogFooter`. Questions: `useConfirm`, `usePrompt`,
  `useAlert`, `ConfirmActionButton`. Never `fixed inset-0` overlays, never
  `window.confirm`.
- **Secrets:** `PasswordInput`; keychain settings are `SecretFieldControl`
  (a schema `secret` field renders it), revealed only via
  `SecretRevealProvider` → audited `keychain-admin.reveal`.
- **Pickers:** `NodePicker` / `NodeSelectField` for nodes; the one smart
  device picker `DeviceSelectField` / `DeviceMultiSelectField` (D636).
- **Status and feedback:** `StatusBadge`, `Badge`, `EmptyState`, `ErrorBox`,
  `Skeleton`; presence via `useCapabilityPresence` (pending ≠ absent).
- **Buttons and menus:** `Button`, `IconButton` (+ `aria-label`), `KebabMenu`,
  `Dropdown` family, `Select`.
- **Charts:** inline SVG, no charting dependency, no dual axis, gaps break the
  line, x axis is wall time.
- **Hub URLs:** `hubPath('/api/…')`, never a root-absolute literal
  (`docs/architecture/ui.md` → "The admin UI under a path prefix").

## Strings (addon pages and widgets)

No English literal in an addon `.tsx`: strings live in
`packages/addon-<x>/src/i18n/{en,it}.json` and are read with the `useT()` /
`Trans` / `translate` that `createAddonI18n(ns, { en, it })` returns
(`@camstack/ui-library`). The language is `<html lang>`, set by the admin. Plural
keys are `key_one` / `key_other`; a sentence with inline elements is one `Trans`
message, never concatenated fragments. Schema `label:` / `description:` and
server error messages are out of scope. Add a key with
`npm run i18n:set -- <dotted.key> "<en>" "<it>"` (`i18n:get`, `i18n:keys`;
`--pkg <dir>`, default admin-ui; `--force` to replace) — do not open the
catalog JSON. Details: `docs/architecture/ui.md` →
"An addon page's strings"; guard: `scripts/__tests__/addon-i18n-parity.spec.ts`.

## Styling

Tokens as utilities only (see the umbrella's map): `bg-surface`,
`text-foreground-muted`, `border-border`, `text-danger`, `bg-success/10`.
Breakpoint-bound concessions (`sticky`, `truncate`, fixed label widths) carry
their breakpoint (D43, `packages/ui-library/src/lib/responsive.ts`).
`overflow-x-clip`, not `overflow-x-hidden`. A viewport-anchored overlay
spells its offset with `env(safe-area-inset-*)`.

## Verify

- `npm run ui:check -- <touched files>` — 0 new findings.
- Specs: `npx vitest run packages/addon-admin-ui/src/<path>` (jsdom) or the
  package's `npm test`; typecheck the package (`npm run typecheck -w
  <package>` or `npm run typecheck`).
- A new page package: `npx tsx scripts/check-addon-page-css.ts`.
- Screenshots per the umbrella's done-gate against `npm run dev:admin` (or the
  addon's own page dev server for layout only — its CSS is not the host's).
