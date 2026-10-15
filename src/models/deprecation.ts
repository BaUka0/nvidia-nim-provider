import { MODEL_LIST } from "./catalog";

const DAY_MS = 24 * 60 * 60 * 1000;
const ISO_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

/** `warningText` key for the retirement countdown in the model picker. */
export const DEPRECATION_WARNING_KEY = "deprecation";

/** Midnight UTC of a `YYYY-MM-DD` date, or undefined for anything else. */
export function parseDeprecationDate(date: string): number | undefined {
  const match = ISO_DATE_PATTERN.exec(date);
  if (!match) {
    return undefined;
  }
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const time = Date.UTC(year, month - 1, day);
  const parsed = new Date(time);
  // Date.UTC rolls 2026-02-30 over to March; reject it instead.
  if (parsed.getUTCMonth() !== month - 1 || parsed.getUTCDate() !== day) {
    return undefined;
  }
  return time;
}

function startOfUtcDay(now: Date): number {
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
}

/** Whole UTC days from today to the retirement date; negative once it has passed. */
export function daysUntilDeprecation(date: string, now: Date): number | undefined {
  const retiresAt = parseDeprecationDate(date);
  if (retiresAt === undefined) {
    return undefined;
  }
  return Math.round((retiresAt - startOfUtcDay(now)) / DAY_MS);
}

function formatUtcDate(time: number): string {
  return new Date(time).toLocaleDateString("en-US", {
    timeZone: "UTC",
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

/**
 * Countdown shown as a warning banner in the model picker card and hover.
 * Returns undefined for a model without a valid `deprecationDate`.
 */
export function formatDeprecationWarning(date: string | undefined, now: Date): string | undefined {
  if (date === undefined) {
    return undefined;
  }
  const retiresAt = parseDeprecationDate(date);
  const days = daysUntilDeprecation(date, now);
  if (retiresAt === undefined || days === undefined) {
    return undefined;
  }
  const label = formatUtcDate(retiresAt);
  if (days < 0) {
    return `NVIDIA retired this model on ${label}. Requests to it may fail; switch to another model.`;
  }
  if (days === 0) {
    return `NVIDIA retires this model today, ${label}. Switch to another model.`;
  }
  const when = days === 1 ? "tomorrow" : `in ${days} days`;
  return `NVIDIA retires this model on ${label}, ${when}. Switch to another model before then.`;
}

/**
 * Picker name with a short countdown, e.g. `GLM 5.3 (retires in 15 days)`.
 * The name is the only picker field Copilot harness sessions keep: the agent
 * host rebuilds BYOK model metadata and drops `warningText`.
 */
export function formatDeprecatedModelName(
  displayName: string,
  date: string | undefined,
  now: Date,
): string {
  const days = date === undefined ? undefined : daysUntilDeprecation(date, now);
  if (days === undefined) {
    return displayName;
  }
  const countdown =
    days < 0
      ? "retired"
      : days === 0
        ? "retires today"
        : days === 1
          ? "retires tomorrow"
          : `retires in ${days} days`;
  return `${displayName} (${countdown})`;
}

/** True when any curated model has a retirement date, so the countdown needs a daily refresh. */
export function hasScheduledDeprecations(): boolean {
  return Object.values(MODEL_LIST).some((entry) => entry.deprecationDate !== undefined);
}

export function msUntilNextUtcMidnight(now: Date): number {
  return startOfUtcDay(now) + DAY_MS - now.getTime();
}

/**
 * Calls `onMidnight` at every midnight UTC so the picker countdown moves to
 * the next day. Schedules nothing when no curated model has a retirement date.
 */
export function scheduleDeprecationCountdownRefresh(
  onMidnight: () => void,
  clock: () => Date = () => new Date(),
): { dispose(): void } {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const schedule = () => {
    timer = setTimeout(() => {
      onMidnight();
      schedule();
    }, msUntilNextUtcMidnight(clock()));
    // A pending countdown refresh must not keep the extension host or a test worker alive.
    timer.unref?.();
  };
  if (hasScheduledDeprecations()) {
    schedule();
  }
  return {
    dispose: () => {
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
    },
  };
}
