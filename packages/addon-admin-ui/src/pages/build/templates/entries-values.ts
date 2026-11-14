/**
 * An `entries` input holds automation elements verbatim. The two pickers each
 * draw one kind of element; this reads the stored list back into that kind and
 * leaves out what the picker cannot draw (it is judged by the engine, not here).
 */
import {
  type AutomationCommandStep,
  AutomationCommandStepSchema,
  AutomationWhenSchema,
  type DeviceFiredLeaf,
  type TemplateInputValue,
} from "@camstack/types";

function recordsOf(value: TemplateInputValue | undefined): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

/** The device-fired leaves of a trigger list, each with its id. */
export function firedLeavesOf(
  value: TemplateInputValue | undefined,
): readonly DeviceFiredLeaf[] {
  return recordsOf(value).flatMap((entry): readonly DeviceFiredLeaf[] => {
    const parsed = AutomationWhenSchema.safeParse(entry);
    return parsed.success && parsed.data.kind === "device-fired"
      ? [parsed.data]
      : [];
  });
}

/** The command steps of a step list. */
export function commandStepsOf(
  value: TemplateInputValue | undefined,
): readonly AutomationCommandStep[] {
  return recordsOf(value).flatMap((entry): readonly AutomationCommandStep[] => {
    const parsed = AutomationCommandStepSchema.safeParse(entry);
    return parsed.success ? [parsed.data] : [];
  });
}

/** The list as the value of an entries input; an empty list is no value. */
export function entriesValueOf(
  entries: readonly Readonly<Record<string, unknown>>[],
): TemplateInputValue | undefined {
  return entries.length === 0
    ? undefined
    : entries.map((entry) => ({ ...entry }));
}
