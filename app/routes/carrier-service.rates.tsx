import type { ActionFunctionArgs } from "react-router";
import prisma from "../db.server";
import {
  computeSurchargeAmount,
  pickMatchingRule,
  totalCartGrams,
  type SurchargeRuleInput,
} from "../lib/calculate-shipping-surcharge";

type CarrierRate = {
  service_name: string;
  service_code: string;
  total_price: string;
  currency: string;
  description?: string;
};

type CarrierResponse = {
  rates: CarrierRate[];
};

type ShopifyCarrierRequest = {
  rate?: {
    items?: Array<{ grams?: number; quantity?: number }>;
    rates?: CarrierRate[];
  };
};

function logCarrierEvent(
  event: string,
  details: Record<string, unknown>,
): void {
  console.log(
    JSON.stringify({
      source: "carrier-service.rates",
      event,
      ...details,
    }),
  );
}

function toSubunits(amountMajor: number): string {
  const cents = Math.round(amountMajor * 100);
  return String(Math.max(cents, 0));
}

function fromSubunits(totalPrice: string): number | null {
  const n = Number(totalPrice);
  if (!Number.isFinite(n)) return null;
  return n / 100;
}

async function fetchBaseRates(
  payload: ShopifyCarrierRequest,
): Promise<CarrierRate[]> {
  const upstreamUrl = process.env.CARRIER_BASE_RATES_URL;

  // Local testing fallback: let developers pass rates directly in payload.
  if (!upstreamUrl) {
    return payload.rate?.rates ?? [];
  }

  const response = await fetch(upstreamUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    throw new Error(`Carrier upstream failed: ${response.status}`);
  }

  const json = (await response.json()) as CarrierResponse;
  return Array.isArray(json?.rates) ? json.rates : [];
}

export const action = async ({ request }: ActionFunctionArgs) => {
  const requestId = crypto.randomUUID();

  if (request.method.toUpperCase() !== "POST") {
    logCarrierEvent("method_not_allowed", {
      requestId,
      method: request.method,
    });
    return Response.json({ error: "method_not_allowed" }, { status: 405 });
  }

  let payload: ShopifyCarrierRequest;
  try {
    payload = (await request.json()) as ShopifyCarrierRequest;
  } catch {
    logCarrierEvent("invalid_json", { requestId });
    return Response.json({ error: "invalid_json" }, { status: 400 });
  }

  const shop =
    request.headers.get("x-shopify-shop-domain") ??
    new URL(request.url).searchParams.get("shop");

  if (!shop) {
    // Keep checkout resilient; when we cannot identify the shop, return no rates.
    logCarrierEvent("missing_shop", { requestId });
    return Response.json({ rates: [] });
  }

  const lines = (payload.rate?.items ?? []).map((item) => ({
    grams: Number(item.grams ?? 0),
    quantity: Number(item.quantity ?? 0),
  }));
  const totalGrams = totalCartGrams(lines);
  logCarrierEvent("request_received", {
    requestId,
    shop,
    itemCount: lines.length,
    totalGrams,
  });

  let rules: SurchargeRuleInput[] = [];
  try {
    const dbRules = await prisma.shippingRule.findMany({
      where: { shop, enabled: true, published: true },
      orderBy: [{ weightMinGrams: "asc" }, { priority: "desc" }],
      select: {
        weightMinGrams: true,
        weightMaxGrams: true,
        feeAmount: true,
        feePercent: true,
        priority: true,
      },
    });
    rules = dbRules.map((r) => ({
      weightMinGrams: r.weightMinGrams,
      weightMaxGrams: r.weightMaxGrams,
      feeAmount: r.feeAmount?.toString() ?? null,
      feePercent: r.feePercent?.toString() ?? null,
      priority: r.priority,
    }));
  } catch (err) {
    console.error("[carrier-service.rates] load rules failed", err);
    logCarrierEvent("load_rules_failed", {
      requestId,
      shop,
      error: err instanceof Error ? err.message : String(err),
    });
    return Response.json({ rates: [] });
  }

  const matchedRule = pickMatchingRule(totalGrams, rules);
  logCarrierEvent("rule_matched", {
    requestId,
    shop,
    totalGrams,
    matchedRule:
      matchedRule == null
        ? null
        : {
            weightMinGrams: matchedRule.weightMinGrams,
            weightMaxGrams: matchedRule.weightMaxGrams,
            feeAmount: matchedRule.feeAmount,
            feePercent: matchedRule.feePercent,
            priority: matchedRule.priority,
          },
  });

  let baseRates: CarrierRate[] = [];
  try {
    baseRates = await fetchBaseRates(payload);
  } catch (err) {
    console.error("[carrier-service.rates] fetch base rates failed", err);
    logCarrierEvent("fetch_base_rates_failed", {
      requestId,
      shop,
      error: err instanceof Error ? err.message : String(err),
    });
    return Response.json({ rates: [] });
  }

  const rates = baseRates.map((rate) => {
    const baseMajor = fromSubunits(rate.total_price);
    const surcharge = computeSurchargeAmount(matchedRule, baseMajor);
    if (baseMajor == null || surcharge == null) {
      return rate;
    }
    return {
      ...rate,
      total_price: toSubunits(baseMajor + surcharge.amount),
    };
  });

  logCarrierEvent("response_ready", {
    requestId,
    shop,
    inputRateCount: baseRates.length,
    outputRateCount: rates.length,
    rates: rates.map((rate, idx) => {
      const base = baseRates[idx];
      const beforeMajor = base ? fromSubunits(base.total_price) : null;
      const afterMajor = fromSubunits(rate.total_price);
      return {
        serviceCode: rate.service_code,
        currency: rate.currency,
        beforeMajor,
        afterMajor,
      };
    }),
  });

  return Response.json({ rates } satisfies CarrierResponse);
};

