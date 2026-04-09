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

