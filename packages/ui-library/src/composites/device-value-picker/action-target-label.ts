/**
 * The name of an action target, through the shared device resolvers: the
 * devices by their compact label, a domain as "all <type> in <room>".
 */
import { type ActionTarget, DeviceType } from "@camstack/types";
import { useUiText } from "../../contexts/ui-text";
import { nounSpecFor } from "../device-name/device-name-nouns";
import { useDeviceNameIndex } from "../device-name/device-fleet";
import { useDeviceLabelsByIds } from "../device-name/use-device-label";

const NO_IDS: readonly number[] = [];

/** The type's plural-neutral short noun in the active locale ("Light"). */
export function useDeviceTypeNoun(): (type: string) => string {
  const t = useUiText();
  return (type) => {
    const spec = nounSpecFor(null, type);
    return t(spec.key, spec.shortEn);
  };
}

export function useActionTargetLabel(target: ActionTarget): string {
  const t = useUiText();
  const noun = useDeviceTypeNoun();
  const names = useDeviceLabelsByIds(
    target.kind === "devices" ? target.ids : NO_IDS,
    "compact",
  );
  if (target.kind === "devices") return names.join(", ");
  if (target.kind === "var") return target.name;
  const what =
    target.deviceType === undefined
      ? t("uiLibrary.deviceActionPicker.allDevices", "all devices")
      : t("uiLibrary.deviceActionPicker.allOfType", "all {{type}}", {
          type: noun(target.deviceType).toLowerCase(),
        });
  return target.roomId === undefined
    ? what
    : t("uiLibrary.deviceActionPicker.inRoom", "{{what}} in {{room}}", {
        what,
        room: target.roomId,
      });
}

export interface DomainChoices {
  readonly types: readonly {
    readonly value: DeviceType;
    readonly label: string;
  }[];
  readonly rooms: readonly string[];
}

/** The types and rooms the fleet holds, for the "By room/type" form. Empty until the fleet answered. */
export function useDomainChoices(): DomainChoices {
  const index = useDeviceNameIndex();
  const noun = useDeviceTypeNoun();
  if (index === null) return { types: [], rooms: [] };
  const types = new Set<DeviceType>();
  const rooms = new Map<string, string>();
  for (const device of index.byId.values()) {
    const type = Object.values(DeviceType).find(
      (known) => known === device.type,
    );
    if (type !== undefined) types.add(type);
    const room = device.location?.trim();
    if (room !== undefined && room.length > 0 && !rooms.has(room.toLowerCase()))
      rooms.set(room.toLowerCase(), room);
  }
  return {
    types: [...types]
      .map((value) => ({ value, label: noun(value) }))
      .sort((a, b) => a.label.localeCompare(b.label)),
    rooms: [...rooms.values()].sort((a, b) => a.localeCompare(b)),
  };
}
