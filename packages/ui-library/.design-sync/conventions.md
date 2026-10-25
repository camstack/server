# CamStack UI Library — how to build with it

CamStack is a surveillance/camera platform. Its components are real, compiled React
components on `window.CamstackUI.*` (loaded from `_ds_bundle.js`). Build screens by
composing them; style your own layout glue with the Tailwind v4 utilities below.

## Dark-first — wrap every screen
The design system is **dark-first**. Its color tokens default to the dark palette, so put
the `dark` class on a root element and paint the canvas with the DS background, or
everything renders on browser-default white:

```tsx
<div className="dark bg-background text-foreground min-h-screen p-6">
  {/* your screen */}
</div>
```

No theme provider is required — the tokens live in the shipped stylesheet and resolve from
the `dark` class. (A `.light` variant exists; add `light` instead of `dark` to opt in.)

## Styling idiom — Tailwind v4 utilities with CamStack tokens
Components are styled internally; for YOUR layout, use Tailwind utility classes. Use the
**semantic token utilities** (not raw colors) so it stays on-brand:

| Purpose | Classes |
|---|---|
| Surfaces | `bg-background` (app canvas), `bg-background-elevated`, `bg-surface`, `bg-surface-hover` |
| Text | `text-foreground`, `text-foreground-muted`, `text-foreground-subtle`, `text-foreground-disabled` |
| Brand / accent | `bg-primary` / `text-primary` (CamStack orange), `text-primary-foreground` |
| Borders | `border-border`, `border-border-subtle` |
| Status | `text-success` / `bg-success`, `text-warning`, `text-danger`, `text-info` (+ `bg-*`) |
| Provider accents | `text-provider-onvif`, `text-provider-hikvision`, `text-provider-reolink`, `text-provider-ha`, `text-provider-rtsp` |
| Radius | `rounded-sm` (4px), `rounded-md` (6px), `rounded-lg` (8px), `rounded-xl` (12px) |

Standard Tailwind layout utilities (flex, grid, gap-*, p-*, w-*, etc.) all work.

## Key components (full API in each component's `.d.ts` + `.prompt.md`)
- `Button` — `variant: primary | secondary | ghost | danger | outline`, `size: sm | md | lg`
- `IconButton` — `icon={LucideIcon}`, same variants/sizes; `Card`, `CollapsibleCard`
- `Input` (`state: default | error`), `Checkbox`, `Switch`, `Select`, `Label`, `FormField`
- `Badge`, `StatusBadge`, `ProviderBadge`, `BatteryBadge`, `SemanticBadge`
- `Dialog` (+ `DialogContent/Header/Footer/Title/Description/Trigger`) — controlled via `open`
- `Tabs` (+ `TabsList/TabsTrigger/TabsContent`), `Popover`, `Tooltip`
- `DataTable` (`columns: DataColumn<T>[]`, `rows`), `KeyValueList`, `StatCard`, `EmptyState`, `ErrorBox`
- `DeviceCard`, `DeviceGrid`, `AppShell`, `Sidebar`/`SidebarItem`, `PageHeader`, `Breadcrumb`

Domain device controls (`*HeroCard`, `*Panel`, `*InlineControl`) exist on the bundle and are
importable, but they read live device state from a tRPC/device-proxy layer — drive them with
real data, not static props.

## Where the truth lives
Read these before styling: the compiled stylesheet `styles.css` (and its `@import`ed
`_ds_bundle.css`) for the exact token/utility set, and each component's `<Name>.d.ts`
(prop contract) + `<Name>.prompt.md` (usage) in its component folder.

## Idiomatic snippet
```tsx
const { Button, Card, StatusBadge } = window.CamstackUI

function CameraTile() {
  return (
    <div className="dark bg-background text-foreground p-6">
      <Card className="max-w-sm">
        <div className="flex items-center justify-between gap-2">
          <span className="font-medium text-foreground">Front Door</span>
          <StatusBadge status="online" />
        </div>
        <p className="text-foreground-muted text-sm mt-1">ONVIF · 2560×1920</p>
        <div className="flex gap-2 mt-4">
          <Button variant="primary" size="sm">View live</Button>
          <Button variant="outline" size="sm">Settings</Button>
        </div>
      </Card>
    </div>
  )
}
```
