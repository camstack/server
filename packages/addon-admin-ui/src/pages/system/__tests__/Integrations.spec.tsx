// @vitest-environment jsdom
/**
 * Connectivity — a SectionedPage with ONE instances table per kind
 * (Exporters / Email / Brokers / Calendars). No kind draws a pill row of addons beside it: a
 * provider without records is a fixed row of the table itself.
 */
import { render, screen, within } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";

vi.mock("../../../components/instances/InstancesTable", () => ({
  InstancesTable: ({
    functionCap,
    install,
  }: {
    functionCap: string;
    install?: { capability: string };
  }) => (
    <div
      data-testid="provider-instances"
      data-cap={functionCap}
      data-install={install?.capability ?? ""}
    />
  ),
}));

vi.mock("../../../lib/nav-items", () => ({
  navChromeForPath: () => null,
}));

import { IntegrationsPage } from "../Integrations";

function Where() {
  const loc = useLocation();
  return <div data-testid="where">{`${loc.pathname}${loc.search}`}</div>;
}

function renderAt(url: string) {
  return render(
    <MemoryRouter initialEntries={[url]}>
      <IntegrationsPage />
      <Where />
    </MemoryRouter>,
  );
}

describe("Connectivity SectionedPage", () => {
  it("renders four kind sections", () => {
    renderAt("/system/integrations");
    expect(
      screen.getByRole("heading", { level: 1, name: "Connectivity" }),
    ).toBeTruthy();
    const tabs = screen.getByRole("tablist", { name: "Connectivity sections" });
    for (const label of ["Exporters", "Email", "Brokers", "Calendars"]) {
      expect(within(tabs).getByRole("tab", { name: label })).toBeTruthy();
    }
  });

  it.each([
    ["exporters", "device-export"],
    ["email", "smtp-provider"],
    ["brokers", "broker"],
    ["calendars", "calendar-source"],
  ])(
    "%s is one instances table of %s, with the add-provider link and no addon pill row",
    (tab, cap) => {
      renderAt(`/system/integrations?tab=${tab}`);
      const table = screen.getByTestId("provider-instances");
      expect(table.dataset.cap).toBe(cap);
      expect(table.dataset.install).toBe(cap);
      expect(
        screen.queryByRole("navigation", { name: /integrations/i }),
      ).toBeNull();
    },
  );

  it("remaps legacy ?tab=device-export to exporters", async () => {
    renderAt("/system/integrations?tab=device-export");
    // replace effect runs after paint
    await vi.waitFor(() => {
      expect(screen.getByTestId("where").textContent).toContain(
        "tab=exporters",
      );
    });
  });
});
