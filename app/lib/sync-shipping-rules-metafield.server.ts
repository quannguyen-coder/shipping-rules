import prisma from "../db.server";

type AdminClient = {
  graphql: (
    query: string,
    options?: { variables?: Record<string, unknown> },
  ) => Promise<Response>;
};

const METAFIELD_NAMESPACE = "$app";
const METAFIELD_KEY = "shipping_rules_config";

export async function syncShippingRulesMetafield(
  admin: AdminClient,
  shopDomain: string,
  options?: {
    feeVariantId?: string | null;
  },
): Promise<void> {
  const rules = await prisma.shippingRule.findMany({
    where: { shop: shopDomain, enabled: true, published: true },
    orderBy: [{ weightMinGrams: "asc" }, { priority: "desc" }],
    select: {
      weightMinGrams: true,
      weightMaxGrams: true,
      feeAmount: true,
      feePercent: true,
      priority: true,
    },
  });

  const shopRes = await admin.graphql(
    `#graphql
      query ShopIdForRulesMetafield {
        shop {
          id
          metafield(namespace: "$app", key: "shipping_rules_config") {
            jsonValue
          }
        }
      }`,
  );
  const shopJson = (await shopRes.json()) as {
    data?: {
      shop?: {
        id?: string;
        metafield?: { jsonValue?: unknown } | null;
      };
    };
    errors?: unknown;
  };
  const ownerId = shopJson.data?.shop?.id;
  if (!ownerId) {
    throw new Error("Failed to resolve shop owner id for metafield sync.");
  }

  const existingConfig =
    (shopJson.data?.shop?.metafield?.jsonValue as Record<string, unknown> | null) ??
    {};

  const nextConfig: Record<string, unknown> = {
    ...existingConfig,
    rules: rules.map((r) => ({
      weightMinGrams: r.weightMinGrams,
      weightMaxGrams: r.weightMaxGrams,
      feeAmount: r.feeAmount?.toString() ?? null,
      feePercent: r.feePercent?.toString() ?? null,
      priority: r.priority,
    })),
  };

  if (options?.feeVariantId !== undefined) {
    if (options.feeVariantId === null || options.feeVariantId.trim() === "") {
      delete nextConfig.feeVariantId;
    } else {
      nextConfig.feeVariantId = options.feeVariantId.trim();
    }
  }

  const value = JSON.stringify(nextConfig);

  const setRes = await admin.graphql(
    `#graphql
      mutation SyncShippingRulesMetafield($metafields: [MetafieldsSetInput!]!) {
        metafieldsSet(metafields: $metafields) {
          metafields {
            namespace
            key
          }
          userErrors {
            field
            message
            code
          }
        }
      }`,
    {
      variables: {
        metafields: [
          {
            ownerId,
            namespace: METAFIELD_NAMESPACE,
            key: METAFIELD_KEY,
            type: "json",
            value,
          },
        ],
      },
    },
  );
  const setJson = (await setRes.json()) as {
    data?: {
      metafieldsSet?: {
        userErrors?: { message: string }[];
      };
    };
    errors?: { message: string }[];
  };

  const topErrors = setJson.errors ?? [];
  if (topErrors.length > 0) {
    throw new Error(
      `metafieldsSet failed: ${topErrors.map((e) => e.message).join(", ")}`,
    );
  }

  const userErrors = setJson.data?.metafieldsSet?.userErrors ?? [];
  if (userErrors.length > 0) {
    throw new Error(
      `metafieldsSet user errors: ${userErrors
        .map((e) => e.message)
        .join(", ")}`,
    );
  }
}

