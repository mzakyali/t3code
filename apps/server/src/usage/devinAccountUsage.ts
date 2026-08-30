// @effect-diagnostics globalDate:off -- API date values are normalized to calendar-day labels.
/**
 * Pure parsing helpers for Devin's organization consumption endpoint.
 *
 * The API reports account billing units (ACUs), not model tokens. Keeping the
 * parser separate from the HTTP effect makes it safe to test and keeps raw API
 * responses out of the usage contract.
 *
 * @module devinAccountUsage
 */
import { UsageDay, type UsageAccountConsumptionDay } from "@t3tools/contracts";

export interface ParsedDevinAccountConsumption {
  readonly totalAcus: number;
  readonly days: readonly UsageAccountConsumptionDay[];
}

const DATE_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;

function finiteNonNegative(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

/** Devin currently returns Unix seconds, but tolerate milliseconds and ISO dates. */
function parseDay(value: unknown): UsageDay | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (DATE_ONLY_PATTERN.test(trimmed)) return UsageDay.make(trimmed);
    const parsed = Date.parse(trimmed);
    if (!Number.isFinite(parsed)) return null;
    return UsageDay.make(new Date(parsed).toISOString().slice(0, 10));
  }
  const numeric = finiteNonNegative(value);
  if (numeric === null) return null;
  const milliseconds = numeric < 100_000_000_000 ? numeric * 1_000 : numeric;
  const date = new Date(milliseconds);
  if (!Number.isFinite(date.getTime())) return null;
  return UsageDay.make(date.toISOString().slice(0, 10));
}

function parseProducts(value: unknown): Readonly<Record<string, number>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  const products: Record<string, number> = {};
  for (const [name, raw] of Object.entries(value as Record<string, unknown>)) {
    const amount = finiteNonNegative(raw);
    if (amount !== null && name.trim().length > 0) products[name] = amount;
  }
  return products;
}

/**
 * Parse the documented `{ total_acus, consumption_by_date }` response.
 * Invalid rows are ignored; a response with no usable rows is rejected so a
 * transient proxy/error body cannot look like a legitimate zero-usage result.
 */
export function parseDevinAccountConsumptionPayload(
  document: unknown,
): ParsedDevinAccountConsumption | null {
  if (typeof document !== "object" || document === null || Array.isArray(document)) return null;
  const record = document as Record<string, unknown>;
  const rawDays = record.consumption_by_date;
  if (!Array.isArray(rawDays)) return null;

  const days: UsageAccountConsumptionDay[] = [];
  for (const rawDay of rawDays) {
    if (typeof rawDay !== "object" || rawDay === null || Array.isArray(rawDay)) continue;
    const entry = rawDay as Record<string, unknown>;
    const day = parseDay(entry.date ?? entry.day);
    const acus = finiteNonNegative(entry.acus);
    if (day === null || acus === null) continue;
    days.push({
      day,
      acus,
      byProduct: parseProducts(entry.acus_by_product ?? entry.byProduct),
    });
  }

  const totalFromResponse = finiteNonNegative(record.total_acus ?? record.totalAcus);
  if (days.length === 0 && totalFromResponse === null) return null;
  return {
    totalAcus: totalFromResponse ?? days.reduce((total, day) => total + day.acus, 0),
    days,
  };
}
