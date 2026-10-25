/**
 * Children section rendered in the Overview tab of the DeviceDetail
 * page. Lists every persisted child of a device — both:
 *
 *   - Accessories (`role` present — siren / floodlight / PIR / …)
 *     auto-spawned by the provider when the firmware advertises the
 *     capability. Operators can't release/adopt them; they live and
 *     die with the parent.
 *   - Hub-adopted children (`role` absent — cameras under an NVR/Hub).
 *     The `<DiscoveryPanel>` also surfaces them under "Already
 *     adopted" with adoption controls, but operators want a clean
 *     navigation list here too — DiscoveryPanel is wired around the
 *     "discover/adopt/release" lifecycle, not navigation.
 *
 * Rendered through the global `<DeviceItem>` composite in `minimal`
 * variant — the panel sits in a narrow column so parent badges and
 * snapshot popovers are stripped. Inline switch toggle stays on so
 * operators can flip a sub-switch (siren / floodlight) without
 * drilling into the child page.
 *
 * The data source is `deviceManager.getChildren` which only returns
 * persisted devices — discovered-but-not-yet-adopted candidates live
 * in `deviceDiscovery.listDiscovered` and never leak into this list.
 *
 * `childLayout`: a CONTAINER parent may declare a `childLayout` that
 * assigns specific accessory children to named accordion SECTIONS. When
 * present, listed children render inside collapsible
 * `<ChildSectionAccordion>` sections (open by default) and the rest keep
 * the plain role-based list below. When absent (the default for every
 * device today), behavior is byte-for-byte the previous flat list.
 */

import {
  ChildSectionAccordion,
  childListName,
  DeviceItem,
  type DeviceItemDevice,
  groupChildrenByLayout,
  useDeviceManagerGetDevice,
  useSystem,
} from '@camstack/ui-library'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'
import { useDeviceChildren } from '../../hooks/useDevice'

interface ChildrenListProps {
  readonly parentDeviceId: number
}

export function ChildrenList({ parentDeviceId }: ChildrenListProps) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const system = useSystem()
  const { data, isLoading, isError } = useDeviceChildren(parentDeviceId)
  // The parent row carries `stableId` (for childKey matching) + the
  // optional `childLayout` directive. Enabled only for a finite id.
  const { data: parent } = useDeviceManagerGetDevice(
    { deviceId: parentDeviceId },
    { enabled: Number.isFinite(parentDeviceId) },
  )

  if (isLoading) {
    return (
      <div className="rounded-lg border border-border bg-surface p-3">
        <p className="text-[10px] text-foreground-subtle">
          {t('common.loading', { defaultValue: 'Loading…' })}
        </p>
      </div>
    )
  }

  if (isError) {
    return (
      <div className="rounded-lg border border-border bg-surface p-3">
        <p className="text-[10px] text-warning">
          {t('integrations.childrenLoadError', { defaultValue: 'Failed to load children' })}
        </p>
      </div>
    )
  }

  // Hide children an operator marked hidden via the per-device `display.hidden`
  // override. Distinct from the HA `accessories` cap `hiddenChildIds` mechanism
  // (container-scoped, provider-persisted) — this is the device-level flag.
  const children = (data ?? []).filter((c) => c.display?.hidden !== true)
  if (children.length === 0) return null

  const grouped = groupChildrenByLayout(parent?.stableId ?? '', children, parent?.childLayout)
  const ungrouped = grouped.ungrouped

  const navigateToChild = (id: number) => navigate(`/devices/${String(id)}`)

  // Container view only: trim the redundant parent-name prefix from the child's
  // DISPLAY name (the underlying entity name stays full — exports / Alexa / the
  // child's own detail page show it verbatim). Providers name children
  // `"<Container> <Label>"` (or `"<Container> — <Label>"`) so the entity reads
  // cleanly standalone; under the container that prefix is noise. Shared with
  // the devices list-table via `childListName` (respects `display.label`).
  const parentName = parent?.name ?? ''

  const renderChildItem = (childId: number, child: DeviceItemDevice) => (
    <DeviceItem
      key={childId}
      trpc={system.trpcClient}
      device={{ ...child, name: childListName(child, parentName) }}
      variant="minimal"
      onNavigate={navigateToChild}
    />
  )

  // Adapt the ungrouped section header to the kind of children present:
  //   - any `role`-tagged → "Accessories" (mostly siren/floodlight/PIR)
  //   - all role-absent   → "Adopted devices" (hub-adopted cameras)
  //   - mixed             → "Children"
  const hasAccessory = ungrouped.some((c) => Boolean(c.role))
  const hasAdopted = ungrouped.some((c) => !c.role)
  const ungroupedHeaderLabel =
    hasAccessory && !hasAdopted
      ? t('device.accessories', { defaultValue: 'Accessories' })
      : !hasAccessory && hasAdopted
        ? t('device.adoptedDevices', { defaultValue: 'Adopted devices' })
        : t('device.children', { defaultValue: 'Children' })

  const ungroupedBox =
    ungrouped.length > 0 ? (
      <div className="rounded-lg border border-border bg-surface p-3">
        <div className="text-[10px] font-semibold uppercase tracking-wide text-foreground-subtle mb-1.5">
          {ungroupedHeaderLabel}
        </div>
        <div className="space-y-1">{ungrouped.map((c) => renderChildItem(c.id, c))}</div>
      </div>
    ) : null

  // Synthetic trailing "Disabled" section — every child whose CamStack-side
  // `disabled` flag is set, pulled out of its normal placement. Collapsed by
  // default + muted (de-emphasized, matching the `!enabled` → `opacity-60`
  // idiom used elsewhere in the device-item composites). Localized title.
  const disabledBox =
    grouped.disabledSection !== undefined ? (
      <ChildSectionAccordion
        key={grouped.disabledSection.title}
        title={t('device.disabledSection', { defaultValue: 'Disabled' })}
        count={grouped.disabledSection.children.length}
        defaultOpen={false}
      >
        <div className="opacity-60 space-y-1">
          {grouped.disabledSection.children.map((c) => renderChildItem(c.id, c))}
        </div>
      </ChildSectionAccordion>
    ) : null

  // No layout declared (the default for every device today) ⇒ render the
  // plain bordered box exactly as before, plus the disabled section last.
  // When neither is present this returns null (no children to show).
  if (grouped.sections.length === 0) {
    if (disabledBox === null) return ungroupedBox
    return (
      <div className="space-y-2">
        {ungroupedBox}
        {disabledBox}
      </div>
    )
  }

  // ADOPTED DEVICES LEAD; accessories keep their place.
  //
  // The sections are how the device's AUTHOR arranged the device's own parts,
  // so a box of leftover accessories must not jump them. Adopted devices are a
  // different thing entirely: separate devices the operator put under this one,
  // and the reason they opened the page. On a container with several accessory
  // sections they were pushed below all of them.
  //
  // The mixed case ("Children") counts as accessories: a box that contains part
  // of the device is part of the device.
  const adoptedLeads = hasAdopted && !hasAccessory

  return (
    <div className="space-y-2">
      {adoptedLeads ? ungroupedBox : null}
      {grouped.sections.map((section) => (
        <ChildSectionAccordion
          key={section.title}
          title={section.title}
          count={section.children.length}
          defaultOpen={section.defaultOpen}
        >
          {section.children.map((c) => renderChildItem(c.id, c))}
        </ChildSectionAccordion>
      ))}
      {adoptedLeads ? null : ungroupedBox}
      {disabledBox}
    </div>
  )
}
