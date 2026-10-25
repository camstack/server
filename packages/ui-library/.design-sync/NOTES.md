# design-sync notes — @camstack/ui-library

Repo-specific gotchas for syncing this DS to Claude Design. Read before any re-sync.

## ⚠️ .design-sync/ is gitignored + gets wiped
`.gitignore` line 6 blanket-ignores `.design-sync/` (added by the repo's distribution
work). A `git clean -x` during this run DELETED the untracked durable files
(config.json, NOTES.md, overrides/, tailwind-input.css, build-theme-css.sh) mid-session;
they were recreated from session history. The 78 previews survived but are at risk.
**To persist the durable set you must `git add -f` past the ignore (or drop the blanket
ignore).** A live backup of previews+grades is at `/tmp/ds-sync-backup`.

## Source shape & build
- Shape: **package** (no Storybook). Entry: `dist/index.js` (ESM). Build: `vite build`.
- `--node-modules` = monorepo root `camstack-server/node_modules` (react is hoisted there).
- 188 components from the `.d.ts` barrel.

## Forks (`.design-sync/overrides/bundle.mjs`, declared in cfg.libOverrides)
1. **minify: true** — unminified IIFE is 5.4 MB (>5 MB upload limit); minified = 2.4 MB.
   Contract-safe (export names + IIFE wrapper survive; `@ds-bundle` header added after).
2. **Dropped the `scheduler` stub** — DS pulls react-konva→react-reconciler which
   legitimately bundles its own scheduler; the stock throw-stub killed the whole IIFE
   (all 188 `[SCHEDULER_MISSING]`). react-dom is externalized to window.ReactDOM.
The fork repoints its `common.mjs` import to `../../.ds-sync/lib/common.mjs` and needs
`.design-sync/node_modules -> ../.ds-sync/node_modules` (gitignored symlink, recreate per clone).

## CSS — Tailwind v4, MUST pre-compile (re-sync step!)
- DS styles via Tailwind v4 utilities compiled by the host; package ships only the
  `@theme` tokens (`src/tailwind/camstack-theme.css`).
- **Before every `package-build.mjs`**, run `bash .design-sync/build-theme-css.sh` →
  `.design-sync/.cache/compiled.css` (utilities + preflight + tokens, scanning `../src` +
  `./previews`). `cfg.cssEntry` points at it. Uses `@tailwindcss/cli@4.3.1` in `.ds-sync`.
- `tailwind-input.css` safelists the standard sizing/spacing/grid scale via `@source inline`.
  **Arbitrary `[..]` values can't be safelisted** — previews must use the standard scale or
  inline `style={{ width: N }}`.

## Dark-first FRAME convention (ALL authored previews)
CamStack is dark-first; the Claude Design card chrome is light. Every preview wraps each
story in a dark frame:
```tsx
const Frame = ({ children }: { children: ReactNode }) => (
  <div className="dark bg-background text-foreground p-5 rounded-lg">{children}</div>
)
```
The `dark` class resolves the token cascade to the dark palette; bg-background gives the canvas.

## Authoring learnings
- **Trust the emitted `.d.ts`** for the API, but it can be WRONG/incomplete: `FormField.d.ts`
  came out with ConfigFormField's props (fixed via `cfg.dtsPropsFor.FormField`); many composite
  `.d.ts` omit referenced types — cross-check `src/composites/<kebab>.tsx`.
- Native `<dialog>`/showModal overlays (Dialog) AND absolute-positioned overlays (Popover,
  Tooltip, BottomSheet, MobileDrawer, FloatingPanel) capture fine when rendered OPEN — no
  cardMode/viewport override needed.
- Tooltip has no controlled open: force visible via `className="opacity-100"` on TooltipContent.
- Atoms live in `src/composites/device-controls/atoms.tsx`; SemanticBadge in `version-badge.tsx`.

## DECISION: device/stream tail is deliberately floor-carded (user choice)
~75 device-control HeroCards/Panels/InlineControls + live-stream composites render from a
live reactive device-proxy + tRPC layer (`useDeviceProxy(trpc, deviceId)` → `createDeviceProxy`
+ `useDeviceStateSlice` capability subscriptions). The tests mock this via `vi.mock`, which
can't run in a browser preview. A faithful static mock is high-effort + risks misleading
renders (worse than an honest floor card). They ship fully functional as floor cards.
To author later: build a mock `trpc` (`UseDeviceProxyTrpc`: `deviceManager.getBindings.query`
→ `DeviceBinding`) + a `createDeviceProxy`-compatible binding with mocked `state.<cap>` slices;
see `src/hooks/use-device-proxy.ts` + `src/composites/device-controls/__tests__/*`.
Context providers (SystemProvider, ThemeProvider, *Provider) are also floor-carded
(non-visual wrappers) and documented in the conventions header.

## Escalated (floor-carded) this run
Dropdown family (Dropdown/DropdownTrigger/DropdownContent/DropdownItem — portals to body,
no controllable open), SensorValueAtom, DummyInline, DeviceItem, DeviceList, PopoverRowAction,
DeviceActivityPanel — all device-proxy/tRPC or portal-overlay bound. Plus the device/stream tail.

## Known render warns
- Floor-card blanks (unauthored, expected): the device/stream tail + the escalations above.

## Re-sync risks
- **`.design-sync/` deletion** (see top) — back up before any git clean; persist with `git add -f`.
- **CSS staleness**: recompile `build-theme-css.sh` before the converter or previews are unstyled.
- **AudioLevelWaveform** authored with a `LevelFeeder` wrapper (ring-buffer fill) but was not
  re-captured/graded before the config wipe — verify it on the next full build.
- Fork drift if upstream `lib/bundle.mjs` changes — re-apply the 2 edits.
