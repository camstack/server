/**
 * An automation made from the shipped "Buttons → devices" template
 * (`/build?tab=automations&block=blk-buttons`): one button, two actions. The
 * button is a child of a wall switch, and two integration instances share a
 * name, so the device picker's selected value and its Integration facet can be
 * shot too. Invented data.
 */
import { generateAutomationBlock } from "../../../../packages/types/src/automation/codegen.ts";
import type { TemplateTimeWindowValue } from "../../../../packages/types/src/automation/template-link.ts";
import { instantiateAutomationTemplate } from "../../../../packages/types/src/template/automation-template.ts";
import { BUILTIN_AUTOMATION_TEMPLATES } from "../../../../packages/types/src/template/builtin-automation-templates.ts";
import { defineFixtures } from "./_define";
import { NOW } from "./_time";
import templates from "./templates";

const TEMPLATE_ID = "builtin:buttons-to-devices";
const BUTTONS = BUILTIN_AUTOMATION_TEMPLATES.find(
  (template) => template.id === TEMPLATE_ID,
);
if (BUTTONS === undefined)
  throw new Error(`${TEMPLATE_ID} is not a built-in template`);

interface Row {
  readonly id: number;
  readonly name: string;
  readonly type: string;
  readonly parentDeviceId: number | null;
  readonly integrationId: string;
  readonly location: string;
  readonly caps: readonly string[];
}

const ROWS: readonly Row[] = [
  {
    id: 300,
    name: "Pulsante luce bagno piano terra",
    type: "container",
    parentDeviceId: null,
    integrationId: "int-ha",
    location: "Bagno",
    caps: [],
  },
  {
    id: 301,
    name: "Buttons",
    type: "event-emitter",
    parentDeviceId: 300,
    integrationId: "int-ha",
    location: "Bagno",
    caps: ["event-emitter"],
  },
  {
    id: 302,
    name: "Luce bagno camerette",
    type: "switch",
    parentDeviceId: null,
    integrationId: "int-casa-hm",
    location: "Bagno",
    caps: ["switch"],
  },
  {
    id: 303,
    name: "Luce corridoio",
    type: "switch",
    parentDeviceId: null,
    integrationId: "int-casa-hue",
    location: "Corridoio",
    caps: ["switch"],
  },
];

const INTEGRATIONS = [
  {
    id: "int-ha",
    addonId: "provider-homeassistant",
    name: "Home Assistant Produzione",
  },
  { id: "int-casa-hm", addonId: "provider-homematic", name: "Casa" },
  { id: "int-casa-hue", addonId: "provider-hue", name: "Casa" },
];
const ADDONS = [
  { id: "provider-homeassistant", name: "Home Assistant" },
  { id: "provider-homematic", name: "Homematic" },
  { id: "provider-hue", name: "Philips Hue" },
];

const integrationOf = (id: string) => INTEGRATIONS.find((i) => i.id === id);

const fleetDevice = (row: Row) => ({
  id: row.id,
  stableId: `fixture.${String(row.id)}`,
  addonId: integrationOf(row.integrationId)?.addonId ?? "",
  type: row.type,
  name: row.name,
  location: row.location,
  disabled: false,
  parentDeviceId: row.parentDeviceId,
  role: null,
  online: true,
  probed: true,
  features: [],
  isCamera: false,
  config: {},
  secretConfigPaths: [],
  metadata: {},
  integrationId: row.integrationId,
});

const searchItem = (row: Row) => ({
  id: row.id,
  name: row.name,
  type: row.type,
  location: row.location,
  integrationId: row.integrationId,
  integrationLabel: integrationOf(row.integrationId)?.name ?? null,
  online: true,
  disabled: false,
  compatible: true,
  values: [],
});

const PICKABLE = ROWS.filter((row) => row.type !== "container");

function searchAnswer(input: {
  ids?: readonly number[];
  text?: string;
  requires?: { caps?: readonly string[] };
  filters?: { integrationIds?: readonly string[] };
}) {
  const ids = input.ids;
  const text = (input.text ?? "").toLowerCase();
  const caps = input.requires?.caps ?? [];
  const wanted = input.filters?.integrationIds ?? [];
  const pool =
    ids !== undefined
      ? ROWS.filter((row) => ids.includes(row.id))
      : PICKABLE.filter(
          (row) =>
            row.name.toLowerCase().includes(text) &&
            (caps.length === 0 || caps.some((cap) => row.caps.includes(cap))),
        );
  const items = pool.filter(
    (row) => wanted.length === 0 || wanted.includes(row.integrationId),
  );
  return {
    items: items.map(searchItem),
    nextCursor: null,
    total: items.length,
    compatibleTotal: items.length,
    fleetTotal: ROWS.length,
    hiddenIncompatible: 0,
    facets: {
      locations: [],
      integrations: INTEGRATIONS.map((i) => ({
        id: i.id,
        label: i.name,
        count: pool.filter((row) => row.integrationId === i.id).length,
      })),
      types: [],
    },
    suggested: [],
    missingIds:
      ids === undefined
        ? []
        : ids.filter((id) => !ROWS.some((row) => row.id === id)),
  };
}

const bindingsOf = (deviceId: number) => ({
  deviceId,
  entries: (ROWS.find((row) => row.id === deviceId)?.caps ?? []).map(
    (capName) => ({
      capName,
      kind: "native",
      providerAddonId: "provider-homeassistant",
      providerNodeId: "hub",
      nativeAddonId: "provider-homeassistant",
    }),
  ),
});

const NAME = "Pulsante bagno";
/** The window the "with a window" variant of this fixture fills in: weeknights. */
const NIGHT_WEEKDAYS: TemplateTimeWindowValue = {
  between: {
    from: { kind: "clock", hh: 22, mm: 0 },
    to: { kind: "clock", hh: 6, mm: 0 },
  },
  days: ["mon", "tue", "wed", "thu", "fri"],
};

function instanceOf(window: TemplateTimeWindowValue | undefined) {
  const made = instantiateAutomationTemplate(TEMPLATE_ID, BUTTONS.payload, {
    ...(window === undefined ? {} : { active: window }),
    buttons: [
      {
        when: [
          {
            kind: "device-fired",
            id: "ev-short",
            deviceId: 301,
            sourceIds: ["1"],
            eventIds: ["press_short"],
          },
        ],
        do: [
          {
            kind: "command",
            target: { kind: "devices", ids: [302] },
            actionId: "switch.toggle",
          },
          {
            kind: "command",
            target: { kind: "devices", ids: [303] },
            actionId: "switch.toggle",
          },
        ],
      },
    ],
  });
  if (!made.ok) {
    throw new Error(
      `fixture instance: ${made.problems.map((p) => p.detail).join("; ")}`,
    );
  }
  return {
    id: "blk-buttons",
    name: NAME,
    code: generateAutomationBlock({ name: NAME, recipe: made.recipe }),
    enabled: true,
    placement: "hub",
    createdAt: NOW - 86_400_000,
    updatedAt: NOW - 3_600_000,
    createdBy: "admin",
    status: "running",
    lastChangedAt: NOW - 3_600_000,
  };
}

const BUTTON_SOURCES = [
  { id: "1", label: "Tasto 1" },
  { id: "2", label: "Tasto 2" },
];
const VOCABULARY = BUTTON_SOURCES.flatMap((source) => [
  { id: "press_short", source, label: "Short press", kind: "press" },
  { id: "press_long", source, label: "Long press", kind: "long-press" },
]);

export function buttonsFixtures(
  area: string,
  description: string,
  window?: TemplateTimeWindowValue,
) {
  return defineFixtures({
    area,
    description,
    handlers: {
      ...templates.handlers,
      "coreBlocks.list": { blocks: [instanceOf(window)] },
      "deviceManager.listAll": ROWS.map(fleetDevice),
      "deviceManager.getDevice": (input: { deviceId?: number }) => {
        const row = ROWS.find((r) => r.id === input.deviceId);
        return row === undefined ? null : fleetDevice(row);
      },
      "deviceManager.search": searchAnswer,
      "deviceManager.getBindings": (input: { deviceId?: number }) =>
        bindingsOf(input.deviceId ?? 0),
      "deviceManager.getBindingsBatch": (input: {
        deviceIds?: readonly number[];
      }) => (input.deviceIds ?? []).map(bindingsOf),
      "deviceState.getCapSlice": (input: {
        deviceId?: number;
        capName?: string;
      }) =>
        input.deviceId === 301 && input.capName === "event-emitter"
          ? {
              eventTypes: ["press_short", "press_long"],
              vocabulary: VOCABULARY,
              lastEvent: null,
              eventCountSinceStart: 0,
            }
          : null,
      "integrations.list": INTEGRATIONS.map((i) => ({
        ...i,
        enabled: true,
        info: {},
        createdAt: 0,
        updatedAt: 0,
        processState: "running",
      })),
      "addons.list": ADDONS.map((a) => ({
        manifest: {
          id: a.id,
          name: a.name,
          packageName: a.id,
          packageVersion: "1",
        },
        source: "npm",
      })),
    },
  });
}

export default buttonsFixtures(
  "template-buttons",
  "An automation made from the Buttons → devices template: one button, two actions",
);
