import type { LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";

/**
 * App proxy script endpoint:
 *   /apps/shipping-rules/auto-fee.js
 *
 * Include this script in theme to auto add/remove the fee variant line in cart.
 */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.public.appProxy(request);

  const script = `
(() => {
  const CONFIG_URL = "/apps/shipping-rules/published-shipping-rules";
  const CART_URL = "/cart.js";
  const ADD_URL = "/cart/add.js";
  const CHANGE_URL = "/cart/change.js";
  const FLAG = "__shippingRulesFeeSyncInProgress";

  function toVariantNumericId(gid) {
    if (!gid || typeof gid !== "string") return null;
    const raw = gid.split("/").pop();
    const id = Number(raw);
    return Number.isFinite(id) ? id : null;
  }

  async function getJson(url, init) {
    const response = await fetch(url, init);
    if (!response.ok) throw new Error(\`Request failed: \${url} \${response.status}\`);
    return response.json();
  }

  async function syncFeeLine() {
    if (window[FLAG]) return;
    window[FLAG] = true;
    try {
      const config = await getJson(CONFIG_URL, { credentials: "same-origin" });
      const feeVariantNumericId = toVariantNumericId(config?.feeVariantId);
      if (!feeVariantNumericId) return;

      const cart = await getJson(CART_URL, { credentials: "same-origin" });
      const items = Array.isArray(cart?.items) ? cart.items : [];

      const feeLine = items.find((item) => Number(item.id) === feeVariantNumericId) || null;
      const hasShippableNonFeeItem = items.some((item) => {
        if (Number(item.id) === feeVariantNumericId) return false;
        return item && item.requires_shipping === true && Number(item.quantity) > 0;
      });

      if (hasShippableNonFeeItem && !feeLine) {
        await fetch(ADD_URL, {
          method: "POST",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            items: [{ id: feeVariantNumericId, quantity: 1 }],
          }),
        });
        window.dispatchEvent(new CustomEvent("shipping-rules:fee-line-added"));
        return;
      }

      if (!hasShippableNonFeeItem && feeLine) {
        await fetch(CHANGE_URL, {
          method: "POST",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            id: feeVariantNumericId,
            quantity: 0,
          }),
        });
        window.dispatchEvent(new CustomEvent("shipping-rules:fee-line-removed"));
      }
    } catch (err) {
      console.warn("[shipping-rules] auto-fee sync error", err);
    } finally {
      window[FLAG] = false;
    }
  }

  // Initial run + common cart update hooks.
  syncFeeLine();
  window.addEventListener("pageshow", syncFeeLine);
  document.addEventListener("cart:updated", syncFeeLine);
  document.addEventListener("ajaxProduct:added", syncFeeLine);
})();
`.trim();

  return new Response(script, {
    headers: {
      "Content-Type": "application/javascript; charset=utf-8",
      "Cache-Control": "private, max-age=60",
    },
  });
};

