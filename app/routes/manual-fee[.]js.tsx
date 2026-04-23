import type { LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";

/**
 * App proxy URL on the storefront:
 *   GET /apps/shipping-rules/manual-fee.js
 *
 * Loads no timers or listeners. Exposes:
 *   await window.shippingRulesManualSyncFeeLine()
 * for one-off testing (e.g. DevTools console) while auto-fee.js is removed from the theme.
 */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.public.appProxy(request);

  const script = `
(() => {
  var ROOT =
    (typeof window !== "undefined" &&
      window.Shopify &&
      window.Shopify.routes &&
      window.Shopify.routes.root) ||
    "/";
  if (typeof ROOT !== "string") ROOT = "/";
  if (ROOT.charAt(ROOT.length - 1) !== "/") ROOT = ROOT + "/";

  var CONFIG_URL = ROOT + "apps/shipping-rules/published-shipping-rules";
  var CART_URL = ROOT + "cart.js";
  var ADD_URL = ROOT + "cart/add.js";
  var CHANGE_URL = ROOT + "cart/change.js";

  function gidToVariantIdString(gid) {
    if (!gid || typeof gid !== "string") return null;
    if (/^[0-9]+$/.test(gid)) return gid;
    if (gid.indexOf("ProductVariant") === -1) return null;
    var raw = gid.split("/").pop();
    if (!raw || !/^[0-9]+$/.test(raw)) return null;
    return raw;
  }

  function variantIdForCartPayload(idStr) {
    if (!idStr) return null;
    try {
      var bi = BigInt(idStr);
      var max = BigInt(Number.MAX_SAFE_INTEGER);
      if (bi >= 0n && bi <= max) return Number(idStr);
    } catch (e) {
    }
    return idStr;
  }

  async function getJson(url, init) {
    const response = await fetch(url, init);
    if (!response.ok) throw new Error("Request failed: " + url + " " + response.status);
    return response.json();
  }

  function lineQualifiesForFee(item, feeVariantIdStr) {
    if (!item || Number(item.quantity) <= 0) return false;
    if (String(item.id) === feeVariantIdStr) return false;
    if (item.requires_shipping === true) return true;
    const grams = Number(item.grams);
    if (Number.isFinite(grams) && grams > 0) return true;
    return false;
  }

  async function shippingRulesManualSyncFeeLine() {
    try {
      const config = await getJson(CONFIG_URL, { credentials: "same-origin" });
      const feeVariantIdStr = gidToVariantIdString(config?.feeVariantId);
      if (!feeVariantIdStr) {
        return { ok: false, reason: "missing_fee_variant_id", detail: config };
      }

      const cart = await getJson(CART_URL, { credentials: "same-origin" });
      const items = Array.isArray(cart?.items) ? cart.items : [];

      const feeLine = items.find((item) => String(item.id) === feeVariantIdStr) || null;
      const shouldHaveFeeLine = items.some((item) =>
        lineQualifiesForFee(item, feeVariantIdStr),
      );

      if (shouldHaveFeeLine && !feeLine) {
        var idForCart = variantIdForCartPayload(feeVariantIdStr);
        const addRes = await fetch(ADD_URL, {
          method: "POST",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            items: [{ id: idForCart, quantity: 1 }],
          }),
        });
        if (!addRes.ok) {
          var errText = await addRes.text();
          var parsed = null;
          try {
            parsed = JSON.parse(errText);
          } catch (_) {
          }
          console.warn("[shipping-rules] manual-fee: cart/add.js failed", addRes.status, parsed || errText);
          return {
            ok: false,
            reason: "add_failed",
            httpStatus: addRes.status,
            body: parsed || errText,
          };
        }
        window.dispatchEvent(new CustomEvent("shipping-rules:fee-line-added"));
        return { ok: true, action: "added" };
      }

      if (!shouldHaveFeeLine && feeLine) {
        await fetch(CHANGE_URL, {
          method: "POST",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            id: variantIdForCartPayload(feeVariantIdStr),
            quantity: 0,
          }),
        });
        window.dispatchEvent(new CustomEvent("shipping-rules:fee-line-removed"));
        return { ok: true, action: "removed" };
      }

      return {
        ok: true,
        action: "noop",
        shouldHaveFeeLine: shouldHaveFeeLine,
        hadFeeLine: !!feeLine,
      };
    } catch (err) {
      console.warn("[shipping-rules] manual-fee sync error", err);
      return { ok: false, reason: "exception", error: String(err && err.message ? err.message : err) };
    }
  }

  window.shippingRulesManualSyncFeeLine = shippingRulesManualSyncFeeLine;
  console.info(
    "[shipping-rules] manual-fee: loaded. Run: await shippingRulesManualSyncFeeLine()",
  );
})();
`.trim();

  return new Response(script, {
    headers: {
      "Content-Type": "application/javascript; charset=utf-8",
      "Cache-Control": "private, max-age=60",
    },
  });
};
