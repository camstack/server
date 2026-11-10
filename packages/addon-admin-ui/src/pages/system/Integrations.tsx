/**
 * Connectivity — external systems this hub talks to, one kind at a time
 * (Exporters / Email / Brokers / Calendars) under the OSD `SectionedPage` shell.
 *
 * Every kind is declared data (`KINDS`) and rendered as ONE `InstancesTable` over its function
 * cap: the provider pills, Add, the on switch and the actions are the shared component's. A
 * provider that keeps no records is a fixed row of that table with its own switch and Settings
 * dialog, so no kind draws a second list of its providers.
 *
 * URL: `?tab=<exporters|email|brokers|calendars>` selects the kind section.
 */
import {
  Calendar,
  Mail,
  Plug,
  Radio,
  Share2,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useMemo, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { useSearchParams } from "react-router-dom";
import type { DataColumn } from "@camstack/ui-library";

import { AdminSectionedPage } from "../../components/AdminSectionedPage";
import { type ConnectivitySectionId } from "../../lib/integration-hub-url";
import { navChromeForPath } from "../../lib/nav-items";
import { InstancesTable } from "../../components/instances/InstancesTable";
import type {
  InstanceRow,
  PanelRow,
} from "../../components/instances/instances-model";
import {
  ExportSetupLead,
  exportedDevicesColumn,
} from "../../components/integrations/exported-devices";
import {
  wasteFetchAllAction,
  wasteFetchNowAction,
} from "../../components/integrations/waste-fetch-now";
import type { TFunction } from "i18next";

interface KindDescriptor {
  readonly sectionId: ConnectivitySectionId;
  readonly labelKey: string;
  readonly icon: LucideIcon;
  readonly installLabelKey: string;
  readonly emptyTitleKey: string;
  readonly emptyDescriptionKey: string;
  /** The one list of the kind: a row per record, a fixed row per provider without records. */
  readonly instances: InstancesDescriptor;
}

interface InstancesDescriptor {
  readonly functionCap: string;
  readonly subtitleKey: string;
  readonly subtitleDefault: string;
  readonly addLabelKey: string;
  readonly addLabelDefault: string;
  /** Columns the kind adds to the shared table (after On). */
  readonly extraColumns?: (t: TFunction) => readonly DataColumn<PanelRow>[];
  /** A block at the top of an instance's edit dialog. */
  readonly lead?: (row: InstanceRow) => ReactElement;
  /** Controls the kind adds to an instance row's action cell, before Edit. */
  readonly rowActions?: (row: InstanceRow) => ReactElement | null;
  /** Controls the kind adds to the page header beside Add. */
  readonly pageActions?: (rows: readonly InstanceRow[]) => ReactElement | null;
}

/**
 * Pre-SectionedPage Connectivity used `?tab=<ProviderKind>` as a group link.
 * Map those (and a few aliases) onto the new section ids.
 */
const LEGACY_TAB_TO_SECTION: Readonly<Record<string, ConnectivitySectionId>> = {
  "device-export": "exporters",
  exporters: "exporters",
  email: "email",
  broker: "brokers",
  brokers: "brokers",
  "message-brokers": "brokers",
  calendar: "calendars",
  calendars: "calendars",
  "calendar-source": "calendars",
};

const KINDS: readonly KindDescriptor[] = [
  {
    sectionId: "exporters",
    labelKey: "system.connectivity.exporters",
    icon: Share2,
    installLabelKey: "system.connectivity.exportersInstall",
    emptyTitleKey: "system.connectivity.exportersEmptyTitle",
    emptyDescriptionKey: "system.connectivity.exportersEmptyDescription",
    instances: {
      functionCap: "device-export",
      subtitleKey: "system.connectivity.exportersSubtitle",
      subtitleDefault:
        "The ecosystems and hubs this hub publishes its devices to.",
      addLabelKey: "system.connectivity.exportersAdd",
      addLabelDefault: "Add export",
      extraColumns: (t) => [exportedDevicesColumn(t)],
      lead: (row) => (
        <ExportSetupLead addonId={row.addonId} instanceId={row.id} />
      ),
    },
  },
  {
    sectionId: "email",
    labelKey: "system.connectivity.email",
    icon: Mail,
    installLabelKey: "system.connectivity.emailInstall",
    emptyTitleKey: "system.connectivity.emailEmptyTitle",
    emptyDescriptionKey: "system.connectivity.emailEmptyDescription",
    instances: {
      functionCap: "smtp-provider",
      subtitleKey: "system.connectivity.emailSubtitle",
      subtitleDefault:
        "The SMTP relays that notification targets send mail through.",
      addLabelKey: "system.connectivity.emailAdd",
      addLabelDefault: "Add relay",
    },
  },
  {
    sectionId: "brokers",
    labelKey: "system.connectivity.brokers",
    icon: Radio,
    installLabelKey: "system.connectivity.brokersInstall",
    emptyTitleKey: "system.connectivity.brokersEmptyTitle",
    emptyDescriptionKey: "system.connectivity.brokersEmptyDescription",
    instances: {
      functionCap: "broker",
      subtitleKey: "system.connectivity.brokersSubtitle",
      subtitleDefault:
        "The accounts and connections this hub reaches its devices through.",
      addLabelKey: "system.connectivity.brokersAdd",
      addLabelDefault: "Add connection",
    },
  },
  {
    sectionId: "calendars",
    labelKey: "system.connectivity.calendars",
    icon: Calendar,
    installLabelKey: "system.connectivity.calendarsInstall",
    emptyTitleKey: "system.connectivity.calendarsEmptyTitle",
    emptyDescriptionKey: "system.connectivity.calendarsEmptyDescription",
    instances: {
      functionCap: "calendar-source",
      subtitleKey: "system.connectivity.calendarsSubtitle",
      subtitleDefault: "The calendars this hub reads events from.",
      addLabelKey: "system.connectivity.calendarsAdd",
      addLabelDefault: "Add calendar",
      rowActions: wasteFetchNowAction,
      pageActions: wasteFetchAllAction,
    },
  },
];

export function IntegrationsPage(): ReactElement {
  const { t } = useTranslation();
  const [searchParams, setSearchParams] = useSearchParams();
  const chrome = navChromeForPath("/system/integrations", {
    t,
    isAdmin: true,
  }) ?? {
    icon: Plug,
    title: t("admin.system.integrations.connectivity", "Connectivity"),
  };

  // Pre-SectionedPage Connectivity used `?tab=<ProviderKind>` as a group link.
  useEffect(() => {
    const raw = searchParams.get("tab");
    if (raw === null) return;
    const mapped = LEGACY_TAB_TO_SECTION[raw];
    if (mapped === undefined || mapped === raw) return;
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.set("tab", mapped);
        return next;
      },
      { replace: true },
    );
  }, [searchParams, setSearchParams]);

  const sections = useMemo(
    () =>
      KINDS.map((descriptor) => {
        const spec = descriptor.instances;
        return {
          id: descriptor.sectionId,
          label: t(descriptor.labelKey),
          content: (
            <InstancesTable
              functionCap={spec.functionCap}
              icon={descriptor.icon}
              title={t(descriptor.labelKey)}
              subtitle={t(spec.subtitleKey, spec.subtitleDefault)}
              emptyTitle={t(descriptor.emptyTitleKey)}
              emptyDescription={t(descriptor.emptyDescriptionKey)}
              addLabel={t(spec.addLabelKey, spec.addLabelDefault)}
              install={{
                capability: spec.functionCap,
                label: t(descriptor.installLabelKey),
              }}
              {...(spec.extraColumns !== undefined
                ? { extraColumns: spec.extraColumns(t) }
                : {})}
              {...(spec.lead !== undefined ? { lead: spec.lead } : {})}
              {...(spec.rowActions !== undefined
                ? { rowActions: spec.rowActions }
                : {})}
              {...(spec.pageActions !== undefined
                ? { pageActions: spec.pageActions }
                : {})}
            />
          ),
        };
      }),
    [t],
  );

  return (
    <AdminSectionedPage
      icon={chrome.icon}
      title={chrome.title}
      subtitle={t(
        "admin.system.integrations.externalSystemsThisHubTalks",
        "External systems this hub talks to — exporters, email, brokers and calendar sources.",
      )}
      defaultSection="exporters"
      sectionsLabel="Connectivity sections"
      sections={sections}
    />
  );
}
