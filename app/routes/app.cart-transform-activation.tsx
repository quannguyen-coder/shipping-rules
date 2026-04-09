import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { Form, useActionData, useLoaderData } from "react-router";
import { authenticate } from "../shopify.server";

type CartTransformNode = {
  id: string;
  functionId: string;
  blockOnFailure: boolean;
};

type ShopifyFunctionNode = {
  id: string;
  title: string;
  apiType: string;
};

type LoaderData = {
  transforms: CartTransformNode[];
  functions: ShopifyFunctionNode[];
};

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin } = await authenticate.admin(request);

  const transformsRes = await admin.graphql(
    `#graphql
      query CartTransformsList {
        cartTransforms(first: 20) {
          nodes {
            id
            functionId
            blockOnFailure
          }
        }
      }`,
  );
  const transformsJson = (await transformsRes.json()) as {
    data?: {
      cartTransforms?: {
        nodes?: CartTransformNode[];
      };
    };
  };

  let functions: ShopifyFunctionNode[] = [];
  try {
    const functionsRes = await admin.graphql(
      `#graphql
        query ShopifyFunctionsList {
          shopifyFunctions(first: 100) {
            nodes {
              id
              title
              apiType
            }
          }
        }`,
    );
    const functionsJson = (await functionsRes.json()) as {
      data?: {
        shopifyFunctions?: {
          nodes?: ShopifyFunctionNode[];
        };
      };
    };
    functions = (functionsJson.data?.shopifyFunctions?.nodes ?? []).filter(
      (node) => node.apiType === "cart_transform",
    );
  } catch {
    // Fallback: some shops/api versions may not expose shopifyFunctions query.
    functions = [];
  }

  return {
    transforms: transformsJson.data?.cartTransforms?.nodes ?? [],
    functions,
  } satisfies LoaderData;
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = String(formData.get("_intent") ?? "");

  if (intent === "activate") {
    const functionId = String(formData.get("functionId") ?? "").trim();
    if (!functionId) {
      return { ok: false, error: "Function ID is required." };
    }

    const response = await admin.graphql(
      `#graphql
        mutation ActivateCartTransform($functionId: String!) {
          cartTransformCreate(functionId: $functionId, blockOnFailure: false) {
            cartTransform {
              id
              functionId
              blockOnFailure
            }
            userErrors {
              field
              message
            }
          }
        }`,
      { variables: { functionId } },
    );
    const json = (await response.json()) as {
      data?: {
        cartTransformCreate?: {
          userErrors?: { message: string }[];
        };
      };
      errors?: { message: string }[];
    };

    const errors = [
      ...(json.errors?.map((e) => e.message) ?? []),
      ...(json.data?.cartTransformCreate?.userErrors?.map((e) => e.message) ?? []),
    ];
    if (errors.length > 0) {
      return { ok: false, error: errors.join(", ") };
    }
    return { ok: true, message: "Cart Transform activated." };
  }

  if (intent === "deactivate") {
    const id = String(formData.get("transformId") ?? "").trim();
    if (!id) {
      return { ok: false, error: "Transform ID is required." };
    }

    const response = await admin.graphql(
      `#graphql
        mutation DeactivateCartTransform($id: ID!) {
          cartTransformDelete(id: $id) {
            deletedId
            userErrors {
              field
              message
            }
          }
        }`,
      { variables: { id } },
    );
    const json = (await response.json()) as {
      data?: {
        cartTransformDelete?: {
          userErrors?: { message: string }[];
        };
      };
      errors?: { message: string }[];
    };

    const errors = [
      ...(json.errors?.map((e) => e.message) ?? []),
      ...(json.data?.cartTransformDelete?.userErrors?.map((e) => e.message) ?? []),
    ];
    if (errors.length > 0) {
      return { ok: false, error: errors.join(", ") };
    }
    return { ok: true, message: "Cart Transform deactivated." };
  }

  return { ok: false, error: "Unknown action." };
};

export default function CartTransformActivationPage() {
  const { transforms, functions } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();

  return (
    <s-page heading="Cart Transform activation">
      <s-section heading="Activate">
        <s-paragraph>
          Paste Function ID for your <code>cart-weight-surcharge</code> extension, then activate.
        </s-paragraph>
        <Form method="post">
          <s-stack direction="block" gap="base">
            <s-select name="functionId" label="Function ID (detected cart_transform functions)">
              <option value="">Select function id...</option>
              {functions.map((fn) => (
                <option key={fn.id} value={fn.id}>
                  {fn.title} ({fn.id})
                </option>
              ))}
            </s-select>
            <s-text-field
              name="functionId"
              label="Or paste Function ID manually"
              placeholder="gid://shopify/ShopifyFunction/..."
            />
            <s-button type="submit" name="_intent" value="activate" variant="primary">
              Activate
            </s-button>
          </s-stack>
        </Form>
      </s-section>

      <s-section heading={`Active transforms (${transforms.length})`}>
        {transforms.length === 0 ? (
          <s-paragraph>No active cart transforms.</s-paragraph>
        ) : (
          <s-stack direction="block" gap="base">
            {transforms.map((t) => (
              <s-box key={t.id} padding="base" borderWidth="base" borderRadius="base" background="subdued">
                <s-stack direction="block" gap="base">
                  <s-text type="strong">{t.id}</s-text>
                  <s-text>Function: {t.functionId}</s-text>
                  <s-text>blockOnFailure: {String(t.blockOnFailure)}</s-text>
                  <Form method="post">
                    <input type="hidden" name="_intent" value="deactivate" />
                    <input type="hidden" name="transformId" value={t.id} />
                    <s-button type="submit" tone="critical" variant="tertiary">
                      Deactivate
                    </s-button>
                  </Form>
                </s-stack>
              </s-box>
            ))}
          </s-stack>
        )}
      </s-section>

      {actionData && "error" in actionData && actionData.error ? (
        <s-section>
          <s-text tone="critical">{actionData.error}</s-text>
        </s-section>
      ) : null}
      {actionData && "message" in actionData && actionData.message ? (
        <s-section>
          <s-text tone="success">{actionData.message}</s-text>
        </s-section>
      ) : null}
    </s-page>
  );
}

