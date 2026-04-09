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
  if (request.method.toUpperCase() !== "POST") {
    return Response.json({ error: "method_not_allowed" }, { status: 405 });
  }

  let payload: ShopifyCarrierRequest;
  try {
    payload = (await request.json()) as ShopifyCarrierRequest;
  } catch {
    return Response.json({ error: "invalid_json" }, { status: 400 });
  }

  const shop =
    request.headers.get("x-shopify-shop-domain") ??
    new URL(request.url).searchParams.get("shop");

  if (!shop) {
    // Keep checkout resilient; when we cannot identify the shop, return no rates.
    return Response.json({ rates: [] });
  }

  const lines = (payload.rate?.items ?? []).map((item) => ({
    grams: Number(item.grams ?? 0),
    quantity: Number(item.quantity ?? 0),
  }));
  const totalGrams = totalCartGrams(lines);

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
    return Response.json({ rates: [] });
  }

  const matchedRule = pickMatchingRule(totalGrams, rules);

  let baseRates: CarrierRate[] = [];
  try {
    baseRates = await fetchBaseRates(payload);
  } catch (err) {
    console.error("[carrier-service.rates] fetch base rates failed", err);
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

  return Response.json({ rates } satisfies CarrierResponse);
};

