import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import { Form, redirect, useActionData, useLoaderData } from "react-router";
import { Prisma } from "@prisma/client";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import {
  overlapsExistingRules,
  toRuleJson,
  type RuleJson,
} from "../lib/shipping-rules-validation.server";
import { syncShippingRulesMetafield } from "../lib/sync-shipping-rules-metafield.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const url = new URL(request.url);
  const editId = url.searchParams.get("edit");

  const rules = await prisma.shippingRule.findMany({
    where: { shop: session.shop },
    orderBy: [{ weightMinGrams: "asc" }, { priority: "desc" }],
  });

  const editingRaw =
    editId && rules.some((r) => r.id === editId)
      ? rules.find((r) => r.id === editId)!
      : null;

  return {
    rules: rules.map(toRuleJson),
    editing: editingRaw ? toRuleJson(editingRaw) : null,
  };
};

type ActionErrors = Record<string, string>;

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session, admin } = await authenticate.admin(request);
  const shop = session.shop;
  const formData = await request.formData();
  const intent = String(formData.get("_intent") ?? "");

  const allRules = await prisma.shippingRule.findMany({
    where: { shop },
    select: { id: true, weightMinGrams: true, weightMaxGrams: true },
  });

  if (intent === "delete") {
    const id = String(formData.get("id") ?? "");
    if (!id) {
      return { errors: { form: "Missing rule id." } satisfies ActionErrors };
    }
    const existing = await prisma.shippingRule.findFirst({
      where: { id, shop },
    });
    if (!existing) {
      return { errors: { form: "Rule not found." } satisfies ActionErrors };
    }
    await prisma.shippingRule.delete({ where: { id } });
    try {
      await syncShippingRulesMetafield(admin, shop);
    } catch (err) {
      return {
        errors: {
          form: `Rule deleted, but metafield sync failed: ${err instanceof Error ? err.message : String(err)}`,
        },
      };
    }
    return redirect("/app/shipping-rules");
  }

  if (intent !== "create" && intent !== "update") {
    return { errors: { form: "Unknown action." } satisfies ActionErrors };
  }

  const id = intent === "update" ? String(formData.get("id") ?? "") : "";
  if (intent === "update" && !id) {
    return { errors: { form: "Missing rule id for update." } satisfies ActionErrors };
  }

  const weightMinGrams = Number(formData.get("weightMinGrams"));
  const weightMaxGrams = Number(formData.get("weightMaxGrams"));
  const priority = Number(formData.get("priority") ?? "0");
  const feeAmountRaw = String(formData.get("feeAmount") ?? "").trim();
  const feePercentRaw = String(formData.get("feePercent") ?? "").trim();
  const enabled = formData.get("enabled") === "true";
  const published = formData.get("published") === "true";

  const errors: ActionErrors = {};

  if (!Number.isInteger(weightMinGrams) || weightMinGrams < 0) {
    errors.weightMinGrams = "Min weight must be a non-negative integer (grams).";
  }
  if (!Number.isInteger(weightMaxGrams) || weightMaxGrams < 0) {
    errors.weightMaxGrams = "Max weight must be a non-negative integer (grams).";
  }
  if (
    !errors.weightMinGrams &&
    !errors.weightMaxGrams &&
    weightMinGrams >= weightMaxGrams
  ) {
    errors.weightMaxGrams =
      "Max weight must be greater than min weight (upper bound is exclusive).";
  }

  const hasAmount = feeAmountRaw.length > 0;
  const hasPercent = feePercentRaw.length > 0;
  if (hasAmount === hasPercent) {
    errors.fee = "Set exactly one of flat fee or percent (not both, not neither).";
  }

  let feeAmount: Prisma.Decimal | null = null;
  let feePercent: Prisma.Decimal | null = null;

  if (hasAmount && !hasPercent) {
    try {
      const d = new Prisma.Decimal(feeAmountRaw);
      if (!d.isFinite() || d.isNegative()) {
        errors.feeAmount = "Flat fee must be a number ≥ 0.";
      } else {
        feeAmount = d;
      }
    } catch {
      errors.feeAmount = "Invalid flat fee.";
    }
  }

  if (hasPercent && !hasAmount) {
    try {
      const d = new Prisma.Decimal(feePercentRaw);
      if (!d.isFinite() || d.isNegative() || d.gt(100)) {
        errors.feePercent = "Percent must be between 0 and 100.";
      } else {
        feePercent = d;
      }
    } catch {
      errors.feePercent = "Invalid percent.";
    }
  }

  if (!Number.isFinite(priority) || !Number.isInteger(priority)) {
    errors.priority = "Priority must be an integer.";
  }

  if (Object.keys(errors).length > 0) {
    return { errors };
  }

  if (
    overlapsExistingRules(
      weightMinGrams,
      weightMaxGrams,
      allRules,
      intent === "update" ? id : null,
    )
  ) {
    return {
      errors: {
        form: "This weight range overlaps another rule. Use non-overlapping [min, max) ranges.",
      },
    };
  }

  const data = {
    shop,
    weightMinGrams,
    weightMaxGrams,
    feeAmount,
    feePercent,
    priority,
    enabled,
    published,
  };

  if (intent === "create") {
    await prisma.shippingRule.create({ data });
    try {
      await syncShippingRulesMetafield(admin, shop);
    } catch (err) {
      return {
        errors: {
          form: `Rule created, but metafield sync failed: ${err instanceof Error ? err.message : String(err)}`,
        },
      };
    }
    return redirect("/app/shipping-rules");
  }

  const existing = await prisma.shippingRule.findFirst({ where: { id, shop } });
  if (!existing) {
    return { errors: { form: "Rule not found." } };
  }

  await prisma.shippingRule.update({
    where: { id },
    data,
  });
  try {
    await syncShippingRulesMetafield(admin, shop);
  } catch (err) {
    return {
      errors: {
        form: `Rule updated, but metafield sync failed: ${err instanceof Error ? err.message : String(err)}`,
      },
    };
  }
  return redirect("/app/shipping-rules");
};

export default function ShippingRulesPage() {
  const { rules, editing } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const errors = actionData && "errors" in actionData ? actionData.errors : undefined;

  return (
    <s-page heading="Weight surcharge rules">
      <s-link slot="primary-action" href="/app/shipping-rules">
        {editing ? "Cancel edit" : "List"}
      </s-link>

      <s-section
        heading={editing ? `Edit rule (${editing.id.slice(0, 8)}…)` : "Add rule"}
      >
        <s-paragraph>
          Ranges use grams and are half-open:{" "}
          <s-text type="strong">[min, max)</s-text> — max is not included. Example:
          0–5000 covers 0 g up to but not including 5000 g.
        </s-paragraph>

        <Form method="post">
          <input
            type="hidden"
            name="_intent"
            value={editing ? "update" : "create"}
          />
          {editing ? <input type="hidden" name="id" value={editing.id} /> : null}

          <s-stack direction="block" gap="base">
            <s-stack direction="inline" gap="base">
              <s-text-field
                name="weightMinGrams"
                label="Min weight (g)"
                defaultValue={
                  editing != null ? String(editing.weightMinGrams) : ""
                }
                error={errors?.weightMinGrams}
                required
              />
              <s-text-field
                name="weightMaxGrams"
                label="Max weight (g), exclusive"
                defaultValue={
                  editing != null ? String(editing.weightMaxGrams) : ""
                }
                error={errors?.weightMaxGrams}
                required
              />
            </s-stack>

            <s-stack direction="inline" gap="base">
              <s-text-field
                name="feeAmount"
                label="Flat fee (shop currency)"
                placeholder="e.g. 2.00"
                defaultValue={editing?.feeAmount ?? ""}
                error={errors?.feeAmount ?? errors?.fee}
              />
              <s-text-field
                name="feePercent"
                label="Percent of base shipping (%)"
                placeholder="e.g. 10"
                defaultValue={editing?.feePercent ?? ""}
                error={errors?.feePercent ?? errors?.fee}
              />
            </s-stack>

            <s-text-field
              name="priority"
              label="Priority (integer; for future tie-breaking)"
              defaultValue={
                editing != null ? String(editing.priority) : "0"
              }
              error={errors?.priority}
            />

            <s-stack direction="inline" gap="base">
              <label style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
                <input
                  type="checkbox"
                  name="enabled"
                  value="true"
                  defaultChecked={editing?.enabled ?? true}
                />
                Enabled
              </label>
              <label style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
                <input
                  type="checkbox"
                  name="published"
                  value="true"
                  defaultChecked={editing?.published ?? false}
                />
                Published (exposed to storefront read path later)
              </label>
            </s-stack>

            {errors?.form ? (
              <s-paragraph>
                <s-text tone="critical">{errors.form}</s-text>
              </s-paragraph>
            ) : null}

            <s-button type="submit" variant="primary">
              {editing ? "Save changes" : "Create rule"}
            </s-button>
          </s-stack>
        </Form>
      </s-section>

      <s-section heading={`Rules (${rules.length})`}>
        {rules.length === 0 ? (
          <s-paragraph>No rules yet.</s-paragraph>
        ) : (
          <s-stack direction="block" gap="base">
            {rules.map((r) => (
              <RuleRow key={r.id} rule={r} />
            ))}
          </s-stack>
        )}
      </s-section>
    </s-page>
  );
}

function RuleRow({ rule }: { rule: RuleJson }) {
  const feeLabel =
    rule.feeAmount != null
      ? `Flat ${rule.feeAmount}`
      : rule.feePercent != null
        ? `${rule.feePercent}%`
        : "—";

  return (
    <s-box
      padding="base"
      borderWidth="base"
      borderRadius="base"
      background="subdued"
    >
      <s-stack direction="block" gap="base">
        <s-text type="strong">
          [{rule.weightMinGrams} g, {rule.weightMaxGrams} g) · {feeLabel} · priority{" "}
          {rule.priority}
        </s-text>
        <s-text>
          {rule.enabled ? "On" : "Off"} · {rule.published ? "Published" : "Draft"}
        </s-text>
        <s-stack direction="inline" gap="base">
          <s-link href={`/app/shipping-rules?edit=${rule.id}`}>Edit</s-link>
          <Form method="post">
            <input type="hidden" name="_intent" value="delete" />
            <input type="hidden" name="id" value={rule.id} />
            <s-button type="submit" variant="tertiary" tone="critical">
              Delete
            </s-button>
          </Form>
        </s-stack>
      </s-stack>
    </s-box>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
