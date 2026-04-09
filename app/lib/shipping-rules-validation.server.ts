import type { ShippingRule } from "@prisma/client";

/** Half-open intervals [min, max) in grams. */
export function halfOpenRangesOverlap(
  minA: number,
  maxA: number,
  minB: number,
  maxB: number,
): boolean {
  return minA < maxB && minB < maxA;
}

export function overlapsExistingRules(
  minG: number,
  maxG: number,
  rules: Pick<ShippingRule, "id" | "weightMinGrams" | "weightMaxGrams">[],
  excludeId: string | null,
): boolean {
  for (const r of rules) {
    if (excludeId && r.id === excludeId) continue;
    if (
      halfOpenRangesOverlap(minG, maxG, r.weightMinGrams, r.weightMaxGrams)
    ) {
      return true;
    }
  }
  return false;
}

export type RuleJson = {
  id: string;
  shop: string;
  weightMinGrams: number;
  weightMaxGrams: number;
  feeAmount: string | null;
  feePercent: string | null;
  priority: number;
  enabled: boolean;
  published: boolean;
  createdAt: string;
  updatedAt: string;
};

export function toRuleJson(rule: ShippingRule): RuleJson {
  return {
    id: rule.id,
    shop: rule.shop,
    weightMinGrams: rule.weightMinGrams,
    weightMaxGrams: rule.weightMaxGrams,
    feeAmount: rule.feeAmount?.toString() ?? null,
    feePercent: rule.feePercent?.toString() ?? null,
    priority: rule.priority,
    enabled: rule.enabled,
    published: rule.published,
    createdAt: rule.createdAt.toISOString(),
    updatedAt: rule.updatedAt.toISOString(),
  };
}
