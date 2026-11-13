// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ItemFormDialog } from "../item-form-dialog";

beforeEach(() => {
  HTMLDialogElement.prototype.showModal ??= function showModal(
    this: HTMLDialogElement,
  ) {
    this.open = true;
  };
  HTMLDialogElement.prototype.close ??= function close(
    this: HTMLDialogElement,
  ) {
    this.open = false;
  };
});
afterEach(cleanup);

function dialogClass(fill: boolean): string {
  render(
    <ItemFormDialog open onClose={() => {}} title="T" fill={fill} testId="dlg">
      <p>body</p>
    </ItemFormDialog>,
  );
  return screen.getByTestId("dlg").className;
}

describe("ItemFormDialog fill", () => {
  it("gives a fill dialog a definite desktop height so only the columns scroll", () => {
    expect(dialogClass(true)).toContain("md:h-[min(48rem,calc(100dvh-4rem))]");
  });
  it("leaves a plain dialog to grow to its content", () => {
    expect(dialogClass(false)).toContain("md:h-auto");
  });
});
