import { InvalidShopError } from "@shopify/shopify-api";
import type { LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

/**
 * App proxy URL on the storefront (after you enable proxy in Partner Dashboard / toml):
 *   GET /apps/shipping-rules/published-shipping-rules
 * Shopify forwards to this route with a valid signature and `shop` query param.
 *
 * If you see 500: `[app_proxy].url` in shopify.app.toml must match your live app URL
 * (same tunnel as `application_url` when running `shopify app dev`). Push config after changing it.
 */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  try {
    await authenticate.public.appProxy(request);
  } catch (err) {
    if (err instanceof Response) {
      throw err;
    }
    console.error("[published-shipping-rules] appProxy auth failed", err);
    if (err instanceof InvalidShopError) {
      return Response.json(
        { error: "invalid_shop", message: err.message },
        { status: 400 },
      );
    }
    const message = err instanceof Error ? err.message : String(err);
    return Response.json({ error: "proxy_auth_failed", message }, { status: 500 });
  }

  const shop = new URL(request.url).searchParams.get("shop");
  if (!shop) {
    return Response.json({ error: "missing_shop" }, { status: 400 });
  }

  let rules;
  try {
    const { admin } = await authenticate.public.appProxy(request);

    let feeVariantId: string | null = null;
    if (admin) {
      const shopMetaRes = await admin.graphql(
        `#graphql
          query PublishedRulesConfig {
            shop {
              metafield(namespace: "$app", key: "shipping_rules_config") {
                jsonValue
              }
            }
          }`,
      );
      const shopMetaJson = (await shopMetaRes.json()) as {
        data?: {
          shop?: {
            metafield?: {
              jsonValue?: unknown;
            } | null;
          };
        };
      };
      const cfg =
        (shopMetaJson.data?.shop?.metafield?.jsonValue as
          | Record<string, unknown>
          | null) ?? {};
      feeVariantId =
        typeof cfg.feeVariantId === "string" ? cfg.feeVariantId : null;
    }

    rules = await prisma.shippingRule.findMany({
      where: { shop, published: true, enabled: true },
      orderBy: [{ weightMinGrams: "asc" }, { priority: "desc" }],
      select: {
        weightMinGrams: true,
        weightMaxGrams: true,
        feeAmount: true,
        feePercent: true,
        priority: true,
      },
    });

    const body = rules.map((r) => ({
      weightMinGrams: r.weightMinGrams,
      weightMaxGrams: r.weightMaxGrams,
      feeAmount: r.feeAmount?.toString() ?? null,
      feePercent: r.feePercent?.toString() ?? null,
      priority: r.priority,
    }));

    return Response.json(
      {
        feeVariantId,
        rules: body,
      },
      {
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "private, max-age=60",
        },
      },
    );
  } catch (err) {
    console.error("[published-shipping-rules] prisma", err);
    const message = err instanceof Error ? err.message : String(err);
    return Response.json({ error: "database", message }, { status: 500 });
  }
};

