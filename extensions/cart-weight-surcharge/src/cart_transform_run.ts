import type {
  CartTransformRunInput,
  CartTransformRunResult,
  LineUpdateOperation,
  WeightUnit,
} from "../generated/api";

const NO_CHANGES: CartTransformRunResult = {
  operations: [],
};
// TEMP DEBUG SWITCH: set true to force a visible line update.
const DEBUG_HARD_MODE = true;

export function cartTransformRun(input: CartTransformRunInput): CartTransformRunResult {
  const config = parseConfig(input);
  if (!config || !config.feeVariantId || config.rules.length === 0) {
    return NO_CHANGES;
  }
  const feeVariantNumeric = variantIdNumericFromGid(config.feeVariantId);

  let feeLine:
    | {
        id: string;
        quantity: number;
      }
    | null = null;

  const weightedLines: { grams: number; quantity: number }[] = [];
  let merchandiseSubtotal = 0;

  for (const line of input.cart.lines) {
    const merchandise = line.merchandise;
    if (merchandise.__typename !== "ProductVariant") continue;

    const lineVariantNumeric = variantIdNumericFromGid(merchandise.id);
    if (
      merchandise.id === config.feeVariantId ||
      (feeVariantNumeric != null &&
        lineVariantNumeric != null &&
        lineVariantNumeric === feeVariantNumeric)
    ) {
      feeLine = { id: line.id, quantity: line.quantity };
      continue;
    }

    const unitPrice = parseDecimal(line.cost?.amountPerQuantity?.amount);
    if (unitPrice != null && unitPrice >= 0) {
      merchandiseSubtotal += unitPrice * line.quantity;
    }

    const grams = toGrams(merchandise.weight, merchandise.weightUnit);
    if (grams <= 0) continue;
    weightedLines.push({ grams, quantity: line.quantity });
  }

  // Separate fee line must already exist in the cart. If not present, keep no-op.
  if (!feeLine || feeLine.quantity <= 0) {
    return NO_CHANGES;
  }
  if (DEBUG_HARD_MODE) {
    return buildFeeUpdateResult(feeLine.id, 9.99, "SR DEBUG");
  }

  const totalGrams = weightedLines.reduce(
    (sum, line) => sum + line.grams * line.quantity,
    0,
  );

  const matchedRule = findMatchingRule(totalGrams, config.rules);
  if (!matchedRule) {
    return buildFeeUpdateResult(feeLine.id, 0);
  }

  // Flat fee: currency units per fee line (split across quantity).
  const flatAmount = parseNumber(matchedRule.feeAmount);
  if (flatAmount != null && flatAmount >= 0) {
    const perUnitAmount = flatAmount / feeLine.quantity;
    return buildFeeUpdateResult(feeLine.id, roundCurrency(perUnitAmount));
  }

  // Percent: applied to merchandise subtotal (excludes fee line). Cart Transform has no access
  // to selected shipping rate; this matches "surcharge scales with order value" for heavy tiers.
  const pct = parseNumber(matchedRule.feePercent);
  if (pct != null && pct >= 0 && merchandiseSubtotal > 0) {
    const totalFee = (merchandiseSubtotal * pct) / 100;
    const perUnitAmount = totalFee / feeLine.quantity;
    return buildFeeUpdateResult(feeLine.id, roundCurrency(perUnitAmount));
  }

  return buildFeeUpdateResult(feeLine.id, 0);
}

type RulesConfig = {
  rules: Array<{
    weightMinGrams: number;
    weightMaxGrams: number;
    feeAmount: string | null;
    feePercent: string | null;
    priority: number;
  }>;
  feeVariantId?: string;
};

function parseConfig(input: CartTransformRunInput): RulesConfig | null {
  let raw = input.shop.metafield?.jsonValue as unknown;
  if (typeof raw === "string") {
    try {
      raw = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (!raw || typeof raw !== "object") return null;
  const maybe = raw as {
    rules?: unknown;
    feeVariantId?: unknown;
  };
  if (!Array.isArray(maybe.rules)) return null;

  const rules = maybe.rules
    .map((r) => {
      if (!r || typeof r !== "object") return null;
      const o = r as Record<string, unknown>;
      const weightMinGrams = Number(o.weightMinGrams);
      const weightMaxGrams = Number(o.weightMaxGrams);
      const priority = Number(o.priority ?? 0);
      if (
        !Number.isFinite(weightMinGrams) ||
        !Number.isFinite(weightMaxGrams) ||
        !Number.isFinite(priority)
      ) {
        return null;
      }
      return {
        weightMinGrams,
        weightMaxGrams,
        priority,
        feeAmount:
          typeof o.feeAmount === "string" || o.feeAmount === null
            ? (o.feeAmount as string | null)
            : null,
        feePercent:
          typeof o.feePercent === "string" || o.feePercent === null
            ? (o.feePercent as string | null)
            : null,
      };
    })
    .filter((r): r is NonNullable<typeof r> => r != null);

  return {
    rules,
    feeVariantId:
      typeof maybe.feeVariantId === "string" ? maybe.feeVariantId : undefined,
  };
}

function parseNumber(v: string | null): number | null {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function parseDecimal(v: unknown): number | null {
  if (v == null) return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function roundCurrency(amount: number): number {
  return Math.round(amount * 100) / 100;
}

function decimalString(amount: number): string {
  return roundCurrency(amount).toFixed(2);
}

function variantIdNumericFromGid(id: string | null | undefined): string | null {
  if (!id) return null;
  if (/^[0-9]+$/.test(id)) return id;
  const raw = id.split("/").pop();
  if (!raw) return null;
  const cleaned = raw.split("?")[0];
  return /^[0-9]+$/.test(cleaned) ? cleaned : null;
}

function buildFeeUpdateResult(
  cartLineId: string,
  amountPerUnit: number,
  title = "Shipping surcharge",
): CartTransformRunResult {
  const decimalAmount = decimalString(amountPerUnit);
  const lineUpdate: LineUpdateOperation = {
    cartLineId,
    title,
    price: {
      adjustment: {
        fixedPricePerUnit: {
          // Runtime expects a Decimal-compatible value.
          amount: decimalAmount as unknown as number,
        },
      },
    },
  };

  return {
    operations: [{ lineUpdate }],
  };
}

function findMatchingRule(
  totalGrams: number,
  rules: RulesConfig["rules"],
) {
  const matches = rules.filter(
    (r) => totalGrams >= r.weightMinGrams && totalGrams < r.weightMaxGrams,
  );
  if (matches.length === 0) return null;
  matches.sort((a, b) => b.priority - a.priority);
  return matches[0];
}

function toGrams(
  weight: number | null | undefined,
  unit: WeightUnit,
): number {
  if (weight == null || !Number.isFinite(weight) || weight <= 0) return 0;
  switch (unit) {
    case "GRAMS":
      return weight;
    case "KILOGRAMS":
      return weight * 1000;
    case "POUNDS":
      return weight * 453.59237;
    case "OUNCES":
      return weight * 28.349523125;
    default:
      return 0;
  }
}