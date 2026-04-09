/**
 * Pure fee logic — safe to run in admin, carrier callback, or browser bundle.
 * Intervals are half-open [weightMinGrams, weightMaxGrams) in grams.
 */

export type SurchargeRuleInput = {
  weightMinGrams: number;
  weightMaxGrams: number;
  feeAmount: string | null;
  feePercent: string | null;
  priority: number;
};

export function pickMatchingRule(
  totalGrams: number,
  rules: SurchargeRuleInput[],
): SurchargeRuleInput | null {
  const matches = rules.filter(
    (r) =>
      totalGrams >= r.weightMinGrams && totalGrams < r.weightMaxGrams,
  );
  if (matches.length === 0) return null;
  matches.sort((a, b) => b.priority - a.priority);
  return matches[0]!;
}

export type SurchargeResult =
  | { kind: "flat"; amount: number }
  | { kind: "percent"; amount: number }
  | null;

/**
 * @param baseShippingAmount — major currency units (e.g. USD). Required when the matched rule uses feePercent.
 */
export function computeSurchargeAmount(
  rule: SurchargeRuleInput | null,
  baseShippingAmount: number | null,
): SurchargeResult {
  if (!rule) return null;

  const hasAmount =
    rule.feeAmount != null &&
    rule.feeAmount !== "" &&
    !Number.isNaN(Number(rule.feeAmount));
  const hasPercent =
    rule.feePercent != null &&
    rule.feePercent !== "" &&
    !Number.isNaN(Number(rule.feePercent));

  if (hasAmount && !hasPercent) {
    const n = Number(rule.feeAmount);
    if (!Number.isFinite(n) || n < 0) return null;
    return { kind: "flat", amount: n };
  }

  if (hasPercent && !hasAmount) {
    if (baseShippingAmount == null || !Number.isFinite(baseShippingAmount)) {
      return null;
    }
    const p = Number(rule.feePercent);
    if (!Number.isFinite(p) || p < 0) return null;
    return { kind: "percent", amount: (baseShippingAmount * p) / 100 };
  }

  return null;
}

export function totalCartGrams(
  lines: { grams: number; quantity: number }[],
): number {
  let sum = 0;
  for (const line of lines) {
    const g = line.grams;
    const q = line.quantity;
    if (!Number.isFinite(g) || g < 0 || !Number.isFinite(q) || q < 0) {
      continue;
    }
    sum += g * q;
  }
  return sum;
}
