import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { Form, useActionData, useLoaderData } from "react-router";
import { authenticate } from "../shopify.server";
import { syncShippingRulesMetafield } from "../lib/sync-shipping-rules-metafield.server";

type LoaderData = {
  currentFeeVariantId: string;
  shop: string;
};

function firstVariantIdFromProduct(product: {
  variants?: {
    edges?: Array<{ node?: { id?: string } | null } | null> | null;
    nodes?: Array<{ id?: string } | null> | null;
  } | null;
}): string | null {
  const nodes = product.variants?.nodes;
  if (Array.isArray(nodes) && nodes[0]?.id) return nodes[0].id;
  const edges = product.variants?.edges;
  const edge = Array.isArray(edges) ? edges[0] : null;
  return edge?.node?.id ?? null;
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);

  const response = await admin.graphql(
    `#graphql
      query CartTransformSettings {
        shop {
          metafield(namespace: "$app", key: "shipping_rules_config") {
            jsonValue
          }
        }
      }`,
  );

  const json = (await response.json()) as {
    data?: {
      shop?: {
        metafield?: {
          jsonValue?: unknown;
        } | null;
      };
    };
  };

  const config =
    (json.data?.shop?.metafield?.jsonValue as Record<string, unknown> | null) ??
    {};

  return {
    currentFeeVariantId:
      typeof config.feeVariantId === "string" ? config.feeVariantId : "",
    shop: session.shop,
  } satisfies LoaderData;
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = String(formData.get("_intent") ?? "save");

  if (intent === "create_fee_product") {
    try {
      const createRes = await admin.graphql(
        `#graphql
          mutation CreateShippingRulesFeeProduct($product: ProductCreateInput!) {
            productCreate(product: $product) {
              product {
                id
                title
                handle
                variants(first: 1) {
                  nodes {
                    id
                  }
                  edges {
                    node {
                      id
                    }
                  }
                }
              }
              userErrors {
                field
                message
              }
            }
          }`,
        {
          variables: {
            product: {
              title: "Shipping Rules — surcharge fee line",
              descriptionHtml:
                "<p>Internal product used as a cart line for weight-based shipping surcharges (Cart Transform). Do not delete while the app is active. Price is set by the app at checkout.</p>",
              vendor: "Shipping Rules",
              productType: "App shipping fee",
              status: "ACTIVE",
              tags: ["shipping-rules-fee", "shipping-rules-app"],
            },
          },
        },
      );
      const createJson = (await createRes.json()) as {
        data?: {
          productCreate?: {
            product?: {
              id: string;
              title: string;
              handle: string;
              variants?: {
                nodes?: Array<{ id: string } | null> | null;
                edges?: Array<{ node?: { id: string } | null } | null> | null;
              } | null;
            } | null;
            userErrors?: Array<{ field?: string[]; message: string }>;
          };
        };
        errors?: { message: string }[];
      };

      const topErr = createJson.errors?.map((e) => e.message).join(", ");
      if (topErr) {
        return { ok: false as const, error: topErr };
      }

      const userErrors = createJson.data?.productCreate?.userErrors ?? [];
      if (userErrors.length > 0) {
        return {
          ok: false as const,
          error: userErrors.map((e) => e.message).join(", "),
        };
      }

      const product = createJson.data?.productCreate?.product;
      if (!product?.id) {
        return { ok: false as const, error: "productCreate returned no product." };
      }

      const variantId = firstVariantIdFromProduct(product);
      if (!variantId) {
        return {
          ok: false as const,
          error: "Could not read default variant id from created product.",
        };
      }

      const updateRes = await admin.graphql(
        `#graphql
          mutation SetFeeVariantPrice($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
            productVariantsBulkUpdate(productId: $productId, variants: $variants) {
              productVariants {
                id
                price
              }
              userErrors {
                field
                message
              }
            }
          }`,
        {
          variables: {
            productId: product.id,
            variants: [
              {
                id: variantId,
                price: "0.00",
              },
            ],
          },
        },
      );
      const updateJson = (await updateRes.json()) as {
        data?: {
          productVariantsBulkUpdate?: {
            userErrors?: Array<{ message: string }>;
          };
        };
        errors?: { message: string }[];
      };

      const updateTop = updateJson.errors?.map((e) => e.message).join(", ");
      if (updateTop) {
        return { ok: false as const, error: updateTop };
      }
      const updateUserErrors =
        updateJson.data?.productVariantsBulkUpdate?.userErrors ?? [];
      if (updateUserErrors.length > 0) {
        return {
          ok: false as const,
          error: updateUserErrors.map((e) => e.message).join(", "),
        };
      }

      await syncShippingRulesMetafield(admin, session.shop, {
        feeVariantId: variantId,
      });

      const productNumericId = product.id.split("/").pop();
      const productUrl =
        productNumericId != null
          ? `https://${session.shop}/admin/products/${productNumericId}`
          : null;

      return {
        ok: true as const,
        message:
          "Fee product created, variant price set to 0, and fee variant saved for Cart Transform.",
        feeVariantId: variantId,
        productUrl,
      };
    } catch (err) {
      return {
        ok: false as const,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  const feeVariantId = String(formData.get("feeVariantId") ?? "").trim();

  if (feeVariantId && !feeVariantId.startsWith("gid://shopify/ProductVariant/")) {
    return {
      ok: false,
      error:
        "feeVariantId must be a ProductVariant GID, for example gid://shopify/ProductVariant/1234567890.",
    };
  }

  try {
    await syncShippingRulesMetafield(admin, session.shop, {
      feeVariantId: feeVariantId || null,
    });
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }

  return {
    ok: true,
    message: "Cart Transform settings saved.",
  };
};

export default function CartTransformSettingsPage() {
  const { currentFeeVariantId, shop } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();

  return (
    <s-page heading="Cart Transform settings">
      <s-section heading="Plus checkout (Cart Transform)">
        <s-paragraph>
          Rules and <s-text type="strong">fee variant</s-text> are stored on the shop
          metafield <s-text type="strong">$app.shipping_rules_config</s-text> (JSON).
          The Cart Transform function reads that metafield and adjusts the fee line
          price. After you change rules in Shipping rules or save settings here, the
          metafield updates on save.
        </s-paragraph>
        <s-paragraph>
          <s-text type="strong">Flat fee</s-text> rules set the fee line to that amount
          (split per unit if quantity is greater than 1).{" "}
          <s-text type="strong">Percent</s-text>{" "}
          rules apply to merchandise subtotal (all variant lines except the fee
          line), not to the shipping rate Shopify shows—Cart Transform has no access
          to the selected shipping method.
        </s-paragraph>
        <s-paragraph>
          Cart Transform cannot add the fee line by itself—the fee variant must
          already be in the cart. Load the app-proxy script on the storefront (for
          example at the end of <s-text type="strong">theme.liquid</s-text>): a script
          tag with <s-text type="strong">src="/apps/shipping-rules/auto-fee.js"</s-text>{" "}
          and <s-text type="strong">defer</s-text>. The hosted checkout page does{" "}
          <s-text type="strong">not</s-text> load <s-text type="strong">theme.liquid</s-text>
          , so you will not see this script on checkout—that is normal. What matters is
          that <s-text type="strong">/cart.js</s-text> lists the fee variant before you
          leave the storefront. On the <s-text type="strong">/cart</s-text> page the
          script also polls every few seconds so accelerated checkout buttons still see
          an updated cart. Catalog variants should have shipping enabled or a positive
          weight so the fee line is added.
        </s-paragraph>
        <s-paragraph>
          Activate the transform under{" "}
          <s-link href="/app/cart-transform-activation">Cart Transform activation</s-link>
          .
        </s-paragraph>
      </s-section>

      <s-section heading="Separate fee line configuration">
        <s-paragraph>
          Enter the product variant GID used as the fee line. Cart Transform will
          only update this existing line in cart.
        </s-paragraph>

        <s-stack direction="block" gap="base">
          <Form method="post">
            <s-stack direction="block" gap="base">
              <s-text-field
                key={currentFeeVariantId || "empty"}
                name="feeVariantId"
                label="Fee variant ID (gid://shopify/ProductVariant/...)"
                defaultValue={currentFeeVariantId}
                placeholder="gid://shopify/ProductVariant/1234567890"
              />
              <s-button type="submit" variant="primary">
                Save
              </s-button>
            </s-stack>
          </Form>

          <Form method="post">
            <input type="hidden" name="_intent" value="create_fee_product" />
            <s-paragraph>
              Creates a dedicated product in{" "}
              <s-text type="strong">{shop}</s-text> via Admin GraphQL (
              <s-text type="strong">productCreate</s-text>, then{" "}
              <s-text type="strong">productVariantsBulkUpdate</s-text> to{" "}
              <s-text type="strong">0.00</s-text>), then saves its variant GID
              here and syncs the shop metafield.
            </s-paragraph>
            <s-button type="submit" variant="secondary">
              Create fee product
            </s-button>
          </Form>
        </s-stack>

        {actionData && "error" in actionData && actionData.error ? (
          <s-paragraph>
            <s-text tone="critical">{actionData.error}</s-text>
          </s-paragraph>
        ) : null}
        {actionData && "message" in actionData && actionData.message ? (
          <s-paragraph>
            <s-text tone="success">{actionData.message}</s-text>
          </s-paragraph>
        ) : null}
        {actionData &&
        "feeVariantId" in actionData &&
        actionData.feeVariantId &&
        typeof actionData.feeVariantId === "string" ? (
          <s-paragraph>
            <s-text type="strong">Variant GID:</s-text>{" "}
            <s-text>{actionData.feeVariantId}</s-text>
          </s-paragraph>
        ) : null}
        {actionData &&
        "productUrl" in actionData &&
        actionData.productUrl &&
        typeof actionData.productUrl === "string" ? (
          <s-paragraph>
            <s-link href={actionData.productUrl} target="_blank">
              Open product in Admin
            </s-link>
          </s-paragraph>
        ) : null}
      </s-section>
    </s-page>
  );
}

