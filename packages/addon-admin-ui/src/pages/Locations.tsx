/**
 * Locations — physical rooms/areas of the site, and which devices sit in them.
 *
 * Storage disks live on Data → Storage. This page is the operator registry
 * (`deviceManager.listLocations` / `addLocation` / `removeLocation`) plus
 * per-device assignment (`setLocation`).
 *
 * Shell is `AdminSectionedPage` with three sections (Identity pattern):
 *   - Locations — a searchable room selector (`RoomSelect`) picks a room or
 *     Unassigned; the device table for that selection follows.
 *   - Camera links — the same selector; the room's cameras with the devices
 *     each one is linked to (read-only, edited on the camera's Customize page).
 *   - Zones — site zones CRUD; Add lives in the page header.
 *
 * Each device table filters ON ITS OWN (`useDataTableFilter`). Rows are
 * top-level because `setLocation` cascades to EVERY descendant server-side.
 * See `docs/design/2026-09-01-locations-page-design.md`.
 */

import { type IconKey, locationIconKey } from '@camstack/types'
import {
  type PickerItem,
  useDeviceExtensionSetSlot,
  useDeviceManagerAddLocation,
  useDeviceManagerListAll,
  useDeviceManagerListLocationDescriptions,
  useDeviceManagerListSiteZones,
  useDeviceManagerListLocationIcons,
  useDeviceManagerListLocations,
  useDeviceManagerRemoveLocation,
  useDeviceManagerRenameLocation,
  useDeviceManagerSetLocation,
  useDeviceManagerRemoveSiteZone,
  useDeviceManagerRenameSiteZone,
  useDeviceManagerSetLocationDescription,
  useDeviceManagerSetLocationZone,
  useDeviceManagerSetSiteZone,
  useDeviceManagerSetLocationIcon,
  useConfirm,
} from '@camstack/ui-library'
import { useQueryClient } from '@tanstack/react-query'
import { MapPin } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useSearchParams } from 'react-router-dom'
import { AdminSectionedPage } from '../components/AdminSectionedPage'
import { CameraLinksSection } from './locations/CameraLinksSection'
import { LocationCard } from './locations/LocationCard'
import { pickLocationDescription } from './locations/LocationDescriptionField'
import { zoneKeyOfLocation } from './locations/LocationZoneField'
import { SiteZonesPanel } from './locations/SiteZonesPanel'
import { pickLocationIcon } from './locations/LocationIconPicker'
import { NewLocationButton } from './locations/NewLocationButton'
import { NewZoneButton } from './locations/NewZoneButton'
import { QuickAddDevicesDialog } from './locations/QuickAddDevicesDialog'
import { RoomSelect } from './locations/RoomSelect'
import { UnassignedTable } from './locations/UnassignedTable'
import { linkedDevicesSlotWrite, planRoomLinkRebuild } from './locations/rebuild-room-links'
import {
  devicesAtLocation,
  groupDevicesBySite,
  topLevelUnassigned,
  type SiteDevice,
} from './locations/site-locations'

/** URL value for the Unassigned devices pill (`?room=`). */
export const LOCATIONS_UNASSIGNED_ROOM = '__unassigned__'

export function LocationsPage() {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const confirm = useConfirm()
  const { data: labels, isLoading: locLoading } = useDeviceManagerListLocations()
  // Assignments only — a room with no icon is ABSENT here, not `map-pin`. The
  // fallback is the renderer's (`useLocationIconComponent`), so "chose the pin"
  // and "chose nothing" stay two different things for the picker.
  const { data: iconAssignments } = useDeviceManagerListLocationIcons()
  const { data: descriptionAssignments } = useDeviceManagerListLocationDescriptions()
  const { data: siteZones } = useDeviceManagerListSiteZones()
  const { data: raw, isLoading: devicesLoading } = useDeviceManagerListAll({ projection: 'slim' })

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: [['deviceManager', 'listLocations']] })
    void queryClient.invalidateQueries({ queryKey: [['deviceManager', 'listAll']] })
    // A rename or a delete MOVES the icon server-side, so this list is stale
    // after either. Invalidating it here rather than only after `setLocationIcon`
    // is what stops the tab strip showing the old room's glyph on the new name.
    void queryClient.invalidateQueries({ queryKey: [['deviceManager', 'listLocationIcons']] })
    // Everything else this page RENDERS from the server. Both of these were
    // added to the page without being added here, and the operator found it
    // immediately: "quando creo una zona la admin ui non si aggiorna
    // automaticamente" [when I create a zone the admin UI does not refresh by itself] — and the same for a rename, an icon, an assignment.
    // The page mutated the server and kept drawing the answer it had cached
    // BEFORE the mutation, which reads as "the button did nothing".
    //
    // The mutation and the refresh are two places, and adding a feature only
    // touches the first. `locations-invalidates-everything.spec.ts` is what
    // makes the second fail instead of going quiet.
    void queryClient.invalidateQueries({
      queryKey: [['deviceManager', 'listLocationDescriptions']],
    })
    void queryClient.invalidateQueries({ queryKey: [['deviceManager', 'listSiteZones']] })
  }

  const addLocation = useDeviceManagerAddLocation({ onSuccess: invalidate })
  const removeLocation = useDeviceManagerRemoveLocation({ onSuccess: invalidate })
  const setLocation = useDeviceManagerSetLocation({ onSuccess: invalidate })
  const renameLocation = useDeviceManagerRenameLocation({ onSuccess: invalidate })
  const setLocationIcon = useDeviceManagerSetLocationIcon({ onSuccess: invalidate })
  const setLocationDescription = useDeviceManagerSetLocationDescription({ onSuccess: invalidate })
  const setSiteZone = useDeviceManagerSetSiteZone({ onSuccess: invalidate })
  const removeSiteZone = useDeviceManagerRemoveSiteZone({ onSuccess: invalidate })
  const renameSiteZone = useDeviceManagerRenameSiteZone({ onSuccess: invalidate })
  const setLocationZone = useDeviceManagerSetLocationZone({ onSuccess: invalidate })
  const setLinkedDevices = useDeviceExtensionSetSlot()

  const devices = useMemo<SiteDevice[]>(
    () =>
      (raw ?? []).map((d) => ({
        id: d.id,
        name: d.name,
        location: d.location ?? null,
        type: String(d.type),
        isCamera: d.isCamera,
        parentDeviceId: d.parentDeviceId,
        online: d.online,
        role: d.role ?? null,
        stableId: d.stableId,
        primaryChildEntityId: d.primaryChildEntityId ?? null,
      })),
    [raw],
  )

  const registered = labels ?? []
  const groups = useMemo(() => groupDevicesBySite(devices, registered), [devices, registered])

  /**
   * ONE room at a time, chosen from a tab strip that scrolls horizontally, and
   * the choice lives in the URL.
   *
   * The grid of cards showed every room at once, which reads well with four
   * rooms and stops reading at twenty: the card an operator came for is below
   * the fold and the page scrolls vertically past rooms they did not ask about.
   * A tab strip keeps the room names on one line and spends the vertical space
   * on the room actually selected.
   *
   * In the URL rather than in component state because the operator's next move
   * from here is usually INTO a device and back — and with the selection held in
   * state, "back" dropped them on the first room every time. The query param
   * also makes a room linkable.
   *
   * The selection is REPAIRED, never cleared: a room that no longer exists (a
   * rename, a delete, a stale bookmark) falls back to the first rather than
   * rendering nothing, which is a state this page has no useful drawing for.
   */
  const [params, setParams] = useSearchParams()
  const tabParam = params.get('tab')
  const sectionTab = tabParam === 'zones' || tabParam === 'camera-links' ? tabParam : 'locations'
  const requested = params.get('room')
  const unassignedRows = useMemo(
    () => topLevelUnassigned(devices, registered),
    [devices, registered],
  )
  const showUnassigned = requested === LOCATIONS_UNASSIGNED_ROOM
  const activeName = showUnassigned
    ? null
    : requested !== null && groups.some((g) => g.name === requested)
      ? requested
      : (groups[0]?.name ?? null)
  const active = activeName !== null ? (groups.find((g) => g.name === activeName) ?? null) : null
  const selectedRoomValue = showUnassigned
    ? LOCATIONS_UNASSIGNED_ROOM
    : (activeName ?? LOCATIONS_UNASSIGNED_ROOM)
  // Camera links has no Unassigned entry: a camera with no room has no room's links to show.
  const linksRoom = activeName ?? groups[0]?.name ?? null
  const roomChoices = useMemo(
    () => groups.map((g) => ({ name: g.name, count: g.members.length })),
    [groups],
  )

  const selectRoom = (name: string): void => {
    // `replace` — hopping between rooms is browsing, not navigation, and each
    // hop pushing a history entry would make Back walk the tab strip instead of
    // leaving the page.
    setParams(
      (prev) => {
        const copy = new URLSearchParams(prev)
        copy.set('room', name)
        return copy
      },
      { replace: true },
    )
  }
  const loading = locLoading || devicesLoading
  const busy =
    setLocation.isPending ||
    removeLocation.isPending ||
    addLocation.isPending ||
    setLocationIcon.isPending

  const onAdd = async (name: string) => {
    await addLocation.mutateAsync({ name })
  }

  // ONE call. This was `addLocation(to)` → N × `setLocation(device, to)` →
  // `removeLocation(from)`, run from the browser with nothing binding the three
  // together: a closed tab halfway left the fleet split across two rooms, one
  // of which the operator believed was gone. The server does it under its own
  // locks now (D331).
  //
  // The old guard also refused a rename that differed only in case, so the
  // capitalisation of a room could never be corrected. `renameLocation` treats
  // that as the real edit it is.
  const onRename = async (from: string, to: string) => {
    const name = to.trim()
    if (name.length === 0 || name === from) return
    await renameLocation.mutateAsync({ from, to: name })
  }

  /**
   * Rebuild every camera in one room from what the room CONTAINS — the
   * operator's own ask, after two of camera 104's stored picks turned out to
   * point at devices a provider had recreated with new ids. The list stores
   * numeric ids; a resync orphans them and nothing says so.
   *
   * It OVERWRITES, which the operator asked for and which costs nothing today
   * (measured 2026-09-24: not one of 17 cameras links another room's device on
   * purpose). The confirmation still names the cameras and the counts, because
   * "overwrite" is not a number anybody can picture.
   */
  const onRebuildLinks = async (room: string) => {
    const plan = planRoomLinkRebuild(room, devices)
    if (plan.entries.length === 0) {
      await confirm({
        title: t('locations.rebuildLinkedDevices', 'Rebuild linked devices'),
        message: t('locations.noCameraIsAssignedTo', 'No camera is assigned to “{{room}}”.', {
          room,
        }),
        confirmLabel: 'OK',
      })
      return
    }
    const lines = plan.entries
      .map((e) => t('locations.rebuildEntry', { name: e.name, count: e.ids.length }))
      .join('\n')
    const ok = await confirm({
      title: t('locations.rebuildLinkedDevices', 'Rebuild linked devices'),
      message: t(
        'locations.replaceTheLinkedDeviceList',
        'Replace the linked-device list of every camera in “{{room}}” with what the room contains? {{lines}} Anything linked by hand that is not in this room is lost.',
        { room, lines },
      ),
      confirmLabel: t('locations.rebuild', 'Rebuild'),
      variant: 'danger',
    })
    if (!ok) return
    // Through the `linked-devices` slot (D655). One refused camera must not
    // stop the others, and must not pass in silence: each refusal is named.
    const refused: string[] = []
    for (const entry of plan.entries) {
      try {
        await setLinkedDevices.mutateAsync(linkedDevicesSlotWrite(entry))
      } catch (err: unknown) {
        refused.push(`• ${entry.name}: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
    invalidate()
    if (refused.length > 0) {
      await confirm({
        title: t('locations.rebuildLinkedDevices', 'Rebuild linked devices'),
        message: t('locations.notRebuilt', 'Not rebuilt: {{value1}}', {
          value1: refused.join('\n'),
        }),
        confirmLabel: 'OK',
      })
    }
  }

  const onDelete = async (name: string, deviceCount: number) => {
    const extra = deviceCount > 0 ? ` ${String(deviceCount)} device(s) will become unassigned.` : ''
    const ok = await confirm({
      title: t('locations.deleteLocation', 'Delete location'),
      message: t('locations.deleteTheLocation', 'Delete the location “{{name}}”?{{extra}}', {
        name,
        extra,
      }),
      confirmLabel: t('common.delete', 'Delete'),
      variant: 'danger',
    })
    if (!ok) return
    await removeLocation.mutateAsync({ name, cascade: true })
  }

  const onDeleteZone = async (name: string) => {
    const ok = await confirm({
      title: t('locations.deleteZone', 'Delete zone'),
      message: t(
        'locations.deleteTheZoneTheRooms',
        'Delete the zone “{{name}}”? The rooms in it are kept.',
        { name },
      ),
      confirmLabel: t('common.delete', 'Delete'),
      variant: 'danger',
    })
    if (!ok) return
    await removeSiteZone.mutateAsync({ name })
  }

  const onPickIcon = async (location: string, icon: IconKey | null) => {
    await setLocationIcon.mutateAsync({ location, icon })
  }

  const onSaveDescription = async (location: string, description: string | null) => {
    await setLocationDescription.mutateAsync({ location, description })
  }

  const zones = siteZones ?? []

  const onChangeZone = async (location: string, zone: string | null) => {
    await setLocationZone.mutateAsync({ location, zone })
  }

  const onAssign = (deviceIds: readonly number[], location: string) => {
    for (const deviceId of deviceIds) setLocation.mutate({ deviceId, location })
  }

  // Quick multi-add of devices to the selected room. Rows are top-level because
  // `setLocation` cascades to every descendant server-side.
  const [addingToRoom, setAddingToRoom] = useState<string | null>(null)
  const addItems = useMemo(
    (): readonly PickerItem<number>[] =>
      devices
        .filter((d) => d.parentDeviceId === null)
        .map((d) => ({ id: d.id, name: d.name, type: d.type, location: d.location })),
    [devices],
  )

  const roomSelect = (
    <RoomSelect
      rooms={roomChoices}
      {...(sectionTab === 'locations' ? { unassignedCount: unassignedRows.length } : {})}
      value={sectionTab === 'locations' ? selectedRoomValue : (linksRoom ?? '')}
      unassignedValue={LOCATIONS_UNASSIGNED_ROOM}
      onChange={selectRoom}
    />
  )

  const locationsBody = (
    <div className="flex flex-col gap-3" data-testid="locations-section">
      {loading && (
        <p className="text-xs text-foreground-subtle">
          {t('locations.loadingLocationsAndDevices', 'Loading locations and devices…')}
        </p>
      )}

      {roomSelect}

      {showUnassigned || active === null ? (
        <UnassignedTable
          rows={unassignedRows}
          fleet={devices}
          locations={registered}
          busy={busy}
          emptyMessage={
            loading
              ? t('common.loading', 'Loading…')
              : t('locations.everyTopLevelDeviceHas', 'Every top-level device has a room.')
          }
          onAssign={onAssign}
        />
      ) : (
        <LocationCard
          key={active.name}
          name={active.name}
          members={active.members}
          devices={devices}
          busy={busy}
          icon={pickLocationIcon(iconAssignments, locationIconKey(active.name))}
          onPickIcon={(icon) => onPickIcon(active.name, icon)}
          description={pickLocationDescription(
            descriptionAssignments,
            locationIconKey(active.name),
          )}
          onSaveDescription={(description) => onSaveDescription(active.name, description)}
          zones={zones}
          zoneKey={zoneKeyOfLocation(zones, locationIconKey(active.name))}
          onChangeZone={(zone) => onChangeZone(active.name, zone)}
          onRename={(to) => onRename(active.name, to)}
          onDelete={() => onDelete(active.name, devicesAtLocation(devices, active.name).length)}
          onRebuildLinks={() => onRebuildLinks(active.name)}
          onAddDevices={() => setAddingToRoom(active.name)}
        />
      )}

      {registered.length === 0 && !loading && (
        <p className="text-xs text-foreground-subtle">
          {t(
            'locations.noLocationsYetAddFrontDoor',
            'No locations yet. Add Front door, Hall, Kitchen…',
          )}
        </p>
      )}
      <QuickAddDevicesDialog
        open={addingToRoom !== null}
        title={t('locations.room.addDialogTitle', { room: addingToRoom ?? '' })}
        items={addItems}
        listState={devicesLoading ? 'pending' : 'answered'}
        lockedIds={
          addingToRoom === null
            ? []
            : (groups.find((g) => g.name === addingToRoom)?.members ?? []).map((m) => m.id)
        }
        lockedNote={t('locations.room.alreadyHere')}
        suggestions={{
          heading: t('locations.room.suggestedUnassigned'),
          ids: unassignedRows.map((d) => d.id),
        }}
        busy={setLocation.isPending}
        onConfirm={(ids) => {
          if (addingToRoom !== null) onAssign(ids, addingToRoom)
          setAddingToRoom(null)
        }}
        onClose={() => setAddingToRoom(null)}
      />
    </div>
  )

  const linksBody = (
    <div className="flex flex-col gap-3" data-testid="camera-links-tab">
      {roomSelect}
      <CameraLinksSection
        room={linksRoom}
        cameras={
          linksRoom === null ? [] : devicesAtLocation(devices, linksRoom).filter((d) => d.isCamera)
        }
        fleet={devices}
      />
    </div>
  )

  return (
    <AdminSectionedPage
      icon={MapPin}
      title={t('locations.locations', 'Locations')}
      subtitle={t(
        'locations.roomsAndAreasOfThe',
        'Rooms and areas of the site. Assign any device here — storage disks are under Data → Storage.',
      )}
      defaultSection="locations"
      sectionsLabel="Locations sections"
      actions={
        sectionTab === 'zones' ? (
          <NewZoneButton
            busy={setSiteZone.isPending}
            onCreate={(name) => setSiteZone.mutateAsync({ name })}
          />
        ) : (
          <NewLocationButton busy={addLocation.isPending} onCreate={onAdd} />
        )
      }
      sections={[
        {
          id: 'locations',
          label: t('locations.locations', 'Locations'),
          content: locationsBody,
        },
        {
          id: 'camera-links',
          label: t('locations.cameraLinks', 'Camera links'),
          content: linksBody,
        },
        {
          id: 'zones',
          label: t('locations.zones', 'Zones'),
          content: (
            <SiteZonesPanel
              zones={zones}
              busy={busy}
              onRename={(from, to) => renameSiteZone.mutateAsync({ from, to })}
              onDelete={onDeleteZone}
              onPickIcon={(name, icon) => setSiteZone.mutateAsync({ name, icon })}
            />
          ),
        },
      ]}
    />
  )
}
