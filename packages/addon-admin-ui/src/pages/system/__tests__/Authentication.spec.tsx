/**
 * Identity → Authentication is ONE instances table over `login-method` plus the sign-in policy
 * card: no addon pill row, no second list of the same providers, no hand-written provider hints.
 */
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (_key: string, fallback?: string) => fallback ?? _key,
  }),
  Trans: () => <span data-testid="totp-note" />,
}));
vi.mock("@camstack/ui-library", () => ({
  SECTION_BODY: "",
  SectionCard: ({ children }: { children: React.ReactNode }) => (
    <section>{children}</section>
  ),
}));
vi.mock("../../../components/instances/InstancesTable", () => ({
  InstancesTable: ({
    functionCap,
    install,
  }: {
    functionCap: string;
    install?: { capability: string };
  }) => (
    <div
      data-testid="instances"
      data-cap={functionCap}
      data-install={install?.capability ?? ""}
    />
  ),
}));
vi.mock("../../../components/system/BootstrapSettingsForm", () => ({
  BootstrapSettingsForm: ({
    sectionIds,
  }: {
    sectionIds?: readonly string[];
  }) => (
    <div data-testid="bootstrap-form" data-sections={sectionIds?.join(",")} />
  ),
}));

import { AuthenticationPage } from "../Authentication";

afterEach(cleanup);

describe("AuthenticationPage", () => {
  it("is one login-method table with the add-provider link, then the sign-in policy", () => {
    render(
      <MemoryRouter>
        <AuthenticationPage />
      </MemoryRouter>,
    );
    const table = screen.getByTestId("instances");
    expect(table.dataset.cap).toBe("login-method");
    expect(table.dataset.install).toBe("login-method");
    expect(screen.getByTestId("bootstrap-form").dataset.sections).toBe(
      "system-config-auth",
    );
    expect(screen.getByTestId("totp-note")).toBeTruthy();
    expect(screen.queryByRole("navigation")).toBeNull();
  });
});
