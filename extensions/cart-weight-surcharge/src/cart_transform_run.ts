import type {
  CartTransformRunInput,
  CartTransformRunResult,
  LineUpdateOperation,
  WeightUnit,
} from "../generated/api";

const NO_CHANGES: CartTransformRunResult = {
  operations: [],
};

export function cartTransformRun(input: CartTransformRunInput): CartTransformRunResult {
  const config = parseConfig(input);
  if (!config || !config.feeVariantId || config.rules.length === 0) {
    return NO_CHANGES;
  }

  let feeLine:
    | {
        id: string;
        quantity: number;
      }
    | null = null;

  const weightedLines: { grams: number; quantity: number }[] = [];

  for (const line of input.cart.lines) {
    const merchandise = line.merchandise;
    if (merchandise.__typename !== "ProductVariant") continue;

    if (merchandise.id === config.feeVariantId) {
      feeLine = { id: line.id, quantity: line.quantity };
      continue;
    }

    const grams = toGrams(merchandise.weight, merchandise.weightUnit);
    if (grams <= 0) continue;
    weightedLines.push({ grams, quantity: line.quantity });
  }

  // Separate fee line must already exist in the cart. If not present, keep no-op.
  if (!feeLine || feeLine.quantity <= 0) {
    return NO_CHANGES;
  }

  const totalGrams = weightedLines.reduce(
    (sum, line) => sum + line.grams * line.quantity,
    0,
  );

  const matchedRule = findMatchingRule(totalGrams, config.rules);
  if (!matchedRule) {
    return buildFeeUpdateResult(feeLine.id, 0);
  }

  // For percentage rules, Cart Transform doesn't know shipping base rate.
  // We currently apply only flat fee in this function path.
  const flatAmount = parseNumber(matchedRule.feeAmount);
  if (flatAmount == null || flatAmount < 0) {
    return buildFeeUpdateResult(feeLine.id, 0);
  }

  const perUnitAmount = flatAmount / feeLine.quantity;
  return buildFeeUpdateResult(feeLine.id, roundCurrency(perUnitAmount));
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
  const raw = input.cart.metafield?.jsonValue as unknown;
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

function roundCurrency(amount: number): number {
  return Math.round(amount * 100) / 100;
}

function buildFeeUpdateResult(
  cartLineId: string,
  amountPerUnit: number,
): CartTransformRunResult {
  const lineUpdate: LineUpdateOperation = {
    cartLineId,
    title: "Shipping surcharge",
    price: {
      adjustment: {
        fixedPricePerUnit: {
          amount: amountPerUnit,
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