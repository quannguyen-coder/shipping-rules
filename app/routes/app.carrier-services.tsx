import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { Form, useActionData, useLoaderData } from "react-router";
import { authenticate } from "../shopify.server";

type CarrierServiceItem = {
  id: string;
  name: string;
  active: boolean;
  callbackUrl: string | null;
};

type LoaderData = {
  carrierServices: CarrierServiceItem[];
  suggestedCallbackUrl: string;
};

async function listCarrierServices(request: Request): Promise<LoaderData> {
  const { admin } = await authenticate.admin(request);
  const suggestedCallbackUrl = `${new URL(request.url).origin}/carrier-service/rates`;

  const response = await admin.graphql(
    `#graphql
      query CarrierServicesList {
        carrierServices(first: 50) {
          nodes {
            id
            name
            active
            callbackUrl
          }
        }
      }`,
  );

  const json = (await response.json()) as {
    data?: { carrierServices?: { nodes?: CarrierServiceItem[] } };
  };

  return {
    carrierServices: json.data?.carrierServices?.nodes ?? [],
    suggestedCallbackUrl,
  };
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  return listCarrierServices(request);
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = String(formData.get("_intent") ?? "");
  const callbackUrl = String(formData.get("callbackUrl") ?? "").trim();
  const name = String(formData.get("name") ?? "Shipping Rules Carrier").trim();
  const id = String(formData.get("id") ?? "").trim();

  if (intent === "refresh") {
    return { ok: true };
  }

  if (!callbackUrl) {
    return { ok: false, error: "Callback URL is required." };
  }

  if (intent === "create") {
    const response = await admin.graphql(
      `#graphql
        mutation CarrierServiceCreate($input: DeliveryCarrierServiceCreateInput!) {
          carrierServiceCreate(input: $input) {
            carrierService {
              id
              name
              active
              callbackUrl
            }
            userErrors {
              field
              message
            }
          }
        }`,
      {
        variables: {
          input: {
            name,
            callbackUrl,
            supportsServiceDiscovery: true,
            active: true,
          },
        },
      },
    );

    const json = (await response.json()) as {
      data?: {
        carrierServiceCreate?: {
          userErrors?: { field?: string[]; message: string }[];
          carrierService?: CarrierServiceItem;
        };
      };
    };

    const userErrors = json.data?.carrierServiceCreate?.userErrors ?? [];
    if (userErrors.length > 0) {
      return { ok: false, error: userErrors.map((e) => e.message).join(", ") };
    }
    return {
      ok: true,
      message: "Carrier service created successfully.",
    };
  }

  if (intent === "update") {
    if (!id) {
      return { ok: false, error: "Please select a carrier service to update." };
    }

    const response = await admin.graphql(
      `#graphql
        mutation CarrierServiceUpdate($id: ID!, $input: DeliveryCarrierServiceUpdateInput!) {
          carrierServiceUpdate(id: $id, input: $input) {
            carrierService {
              id
              name
              active
              callbackUrl
            }
            userErrors {
              field
              message
            }
          }
        }`,
      {
        variables: {
          id,
          input: {
            callbackUrl,
            active: true,
          },
        },
      },
    );

    const json = (await response.json()) as {
      data?: {
        carrierServiceUpdate?: {
          userErrors?: { field?: string[]; message: string }[];
          carrierService?: CarrierServiceItem;
        };
      };
    };

    const userErrors = json.data?.carrierServiceUpdate?.userErrors ?? [];
    if (userErrors.length > 0) {
      return { ok: false, error: userErrors.map((e) => e.message).join(", ") };
    }
    return {
      ok: true,
      message: "Carrier service updated successfully.",
    };
  }

  return { ok: false, error: "Unknown action." };
};

export default function CarrierServicesPage() {
  const { carrierServices, suggestedCallbackUrl } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();

  return (
    <s-page heading="Carrier services">
      <s-section heading="Create or update callback URL">
        <s-paragraph>
          Register a carrier service and point callback URL to{" "}
          <code>/carrier-service/rates</code>.
        </s-paragraph>

        <Form method="post">
          <s-stack direction="block" gap="base">
            <s-text-field
              name="name"
              label="Carrier service name (for create)"
              defaultValue="Shipping Rules Carrier"
            />
            <s-text-field
              name="callbackUrl"
              label="Callback URL"
              defaultValue={suggestedCallbackUrl}
              required
            />
            <s-select name="id" label="Existing carrier service (for update)">
              <option value="">Select one...</option>
              {carrierServices.map((service) => (
                <option key={service.id} value={service.id}>
                  {service.name} ({service.id.slice(-8)})
                </option>
              ))}
            </s-select>
            <s-stack direction="inline" gap="base">
              <button type="submit" name="_intent" value="create">
                Create
              </button>
              <button type="submit" name="_intent" value="update">
                Update selected
              </button>
              <button type="submit" name="_intent" value="refresh">
                Refresh
              </button>
            </s-stack>
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

      <s-section heading={`Existing services (${carrierServices.length})`}>
        {carrierServices.length === 0 ? (
          <s-paragraph>No carrier service found yet.</s-paragraph>
        ) : (
          <s-box padding="base" borderWidth="base" borderRadius="base" background="subdued">
            <pre style={{ margin: 0 }}>
              <code>{JSON.stringify(carrierServices, null, 2)}</code>
            </pre>
          </s-box>
        )}
      </s-section>
    </s-page>
  );
}

