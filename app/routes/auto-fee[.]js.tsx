import type { LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";

/**
 * App proxy URL on the storefront:
 *   GET /apps/shipping-rules/auto-fee.js
 *
 * File name uses `[.]` so @react-router/fs-routes maps to `/auto-fee.js` (a flat
 * `auto-fee.js.tsx` would incorrectly become `/auto-fee/js`).
 */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.public.appProxy(request);

  const script = `
(() => {
  const CONFIG_URL = "/apps/shipping-rules/published-shipping-rules";
  const CART_URL = "/cart.js";
  const ADD_URL = "/cart/add.js";
  const CHANGE_URL = "/cart/change.js";

  /**
   * Numeric id from ProductVariant GID, kept as string so large Snowflake ids are not
   * rounded by JavaScript Number (which breaks /cart/add.js with "Cannot find variant").
   */
  function gidToVariantIdString(gid) {
    if (!gid || typeof gid !== "string") return null;
    const raw = gid.split("/").pop();
    if (!raw || !/^[0-9]+$/.test(raw)) return null;
    return raw;
  }

  async function getJson(url, init) {
    const response = await fetch(url, init);
    if (!response.ok) throw new Error(\`Request failed: \${url} \${response.status}\`);
    return response.json();
  }

  /** Cart line counts toward surcharge context (matches storefront weight rules intent). */
  function lineQualifiesForFee(item, feeVariantIdStr) {
    if (!item || Number(item.quantity) <= 0) return false;
    if (String(item.id) === feeVariantIdStr) return false;
    if (item.requires_shipping === true) return true;
    const grams = Number(item.grams);
    if (Number.isFinite(grams) && grams > 0) return true;
    return false;
  }

  let syncQueue = Promise.resolve();

  async function runSyncOnce() {
    try {
      const config = await getJson(CONFIG_URL, { credentials: "same-origin" });
      const feeVariantIdStr = gidToVariantIdString(config?.feeVariantId);
      if (!feeVariantIdStr) {
        console.warn("[shipping-rules] auto-fee: missing feeVariantId in app proxy config");
        return;
      }

      const cart = await getJson(CART_URL, { credentials: "same-origin" });
      const items = Array.isArray(cart?.items) ? cart.items : [];

      const feeLine = items.find((item) => String(item.id) === feeVariantIdStr) || null;
      const shouldHaveFeeLine = items.some((item) =>
        lineQualifiesForFee(item, feeVariantIdStr),
      );

      if (shouldHaveFeeLine && !feeLine) {
        const addRes = await fetch(ADD_URL, {
          method: "POST",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            items: [{ id: feeVariantIdStr, quantity: 1 }],
          }),
        });
        if (!addRes.ok) {
          var errText = await addRes.text();
          try {
            var errJson = JSON.parse(errText);
            console.warn("[shipping-rules] auto-fee: cart/add.js failed", addRes.status, errJson);
          } catch (_) {
            console.warn("[shipping-rules] auto-fee: cart/add.js failed", addRes.status, errText);
          }
          return;
        }
        window.dispatchEvent(new CustomEvent("shipping-rules:fee-line-added"));
        return;
      }

      if (!shouldHaveFeeLine && feeLine) {
        await fetch(CHANGE_URL, {
          method: "POST",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            id: feeVariantIdStr,
            quantity: 0,
          }),
        });
        window.dispatchEvent(new CustomEvent("shipping-rules:fee-line-removed"));
      }
    } catch (err) {
      console.warn("[shipping-rules] auto-fee sync error", err);
    }
  }

  function syncFeeLine() {
    syncQueue = syncQueue.then(runSyncOnce, runSyncOnce);
    return syncQueue;
  }

  let bypassCheckoutSubmitGuard = false;

  document.addEventListener(
    "submit",
    function (e) {
      if (bypassCheckoutSubmitGuard) return;
      const form = e.target;
      if (!(form instanceof HTMLFormElement)) return;
      const action = (form.getAttribute("action") || "").toLowerCase();
      if (!action.includes("/cart")) return;
      const sub = e.submitter;
      if (!(sub instanceof HTMLElement)) return;
      const submitName = sub.getAttribute("name") || "";
      if (submitName !== "checkout" && submitName !== "goto" && submitName !== "goto_pp") return;
      e.preventDefault();
      e.stopPropagation();
      syncFeeLine().finally(function () {
        bypassCheckoutSubmitGuard = true;
        try {
          if (typeof form.requestSubmit === "function") {
            form.requestSubmit(sub);
          } else {
            form.submit();
          }
        } finally {
          bypassCheckoutSubmitGuard = false;
        }
      });
    },
    true,
  );

  document.addEventListener(
    "click",
    function (e) {
      const t = e.target;
      if (!(t instanceof Element)) return;
      const a = t.closest("a[href]");
      if (!(a instanceof HTMLAnchorElement)) return;
      if (a.target === "_blank" || a.hasAttribute("download")) return;
      const href = (a.getAttribute("href") || "").toLowerCase();
      if (!href.includes("/checkout") && !href.includes("/checkouts/")) return;
      e.preventDefault();
      e.stopPropagation();
      const dest = a.href;
      syncFeeLine().finally(function () {
        window.location.assign(dest);
      });
    },
    true,
  );

  syncFeeLine();
  window.addEventListener("pageshow", function () {
    syncFeeLine();
  });
  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "visible") syncFeeLine();
  });
  document.addEventListener("shopify:section:load", function () {
    syncFeeLine();
  });
  document.addEventListener("cart:updated", function () {
    syncFeeLine();
  });
  document.addEventListener("ajaxProduct:added", function () {
    syncFeeLine();
  });

  /** Hosted checkout does not run this script—fee line must exist in /cart.js first. */
  function isCartPath() {
    try {
      var p = window.location.pathname || "";
      return p === "/cart" || p.endsWith("/cart");
    } catch (e) {
      return false;
    }
  }

  if (isCartPath()) {
    var feeCartPoll = window.setInterval(function () {
      syncFeeLine();
    }, 3000);
    window.addEventListener("pagehide", function () {
      window.clearInterval(feeCartPoll);
    });
  }
})();
`.trim();

  return new Response(script, {
    headers: {
      "Content-Type": "application/javascript; charset=utf-8",
      "Cache-Control": "private, max-age=60",
    },
  });
};
