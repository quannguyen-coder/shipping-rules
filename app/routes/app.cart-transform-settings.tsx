import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { Form, useActionData, useLoaderData } from "react-router";
import { authenticate } from "../shopify.server";
import { syncShippingRulesMetafield } from "../lib/sync-shipping-rules-metafield.server";

type LoaderData = {
  currentFeeVariantId: string;
};

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin } = await authenticate.admin(request);

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
  } satisfies LoaderData;
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const formData = await request.formData();
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
  const { currentFeeVariantId } = useLoaderData<typeof loader>();
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
          Add the theme script so the fee variant is present when checkout runs the
          transform:{" "}
          <s-text type="strong">
            /apps/shipping-rules/auto-fee.js
          </s-text>{" "}
          (see App proxy). Publish rules and set a dedicated fee product variant
          priced at $0 in Admin.
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

        <Form method="post">
          <s-stack direction="block" gap="base">
            <s-text-field
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
      </s-section>
    </s-page>
  );
}

