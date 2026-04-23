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
  var DEBUG = true;

  function debugLog() {
    if (!DEBUG) return;
    var args = Array.prototype.slice.call(arguments);
    args.unshift("[shipping-rules] manual-fee:");
    console.log.apply(console, args);
  }

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

  function parseRules(rawRules) {
    if (!Array.isArray(rawRules)) return [];
    return rawRules
      .map(function (r) {
        if (!r || typeof r !== "object") return null;
        var min = Number(r.weightMinGrams);
        var max = Number(r.weightMaxGrams);
        var priority = Number(r.priority || 0);
        if (!Number.isFinite(min) || !Number.isFinite(max) || !Number.isFinite(priority)) {
          return null;
        }
        return { weightMinGrams: min, weightMaxGrams: max, priority: priority };
      })
      .filter(function (r) {
        return r != null;
      });
  }

  function findMatchingRule(totalGrams, rules) {
    var matches = rules.filter(function (r) {
      return totalGrams >= r.weightMinGrams && totalGrams < r.weightMaxGrams;
    });
    if (matches.length === 0) return null;
    matches.sort(function (a, b) {
      return b.priority - a.priority;
    });
    return matches[0];
  }

  function hideFeeLineControls(feeVariantIdStr, feeLineKey, feeLineIndexOneBased) {
    if (typeof document === "undefined") return;
    if (!feeVariantIdStr) return;
    var marker = feeLineKey || feeVariantIdStr;
    var controlSelector =
      'input[name^="updates"], input[type="number"], button[name="minus"], button[name="plus"], button[name="remove"], [data-quantity-input], [data-quantity-selector], .quantity__button, .quantity__input, cart-remove-button, a[href*="/cart/change"], a[href*="line="]';

    var roots = document.querySelectorAll(
      ".cart-item, .cart__item, [data-cart-item], [data-cart-item-key], [data-line-item-key], tr, li, [id*='CartItem']",
    );
    roots.forEach(function (root) {
      if (!(root instanceof HTMLElement)) return;
      var html = root.outerHTML || "";
      var byMarker = html.indexOf(marker) !== -1 || html.indexOf(feeVariantIdStr) !== -1;
      var hasFeeSignal =
        root.querySelector('input[data-quantity-variant-id="' + feeVariantIdStr + '"]') ||
        root.querySelector('a[href*="variant=' + feeVariantIdStr + '"]') ||
        (feeLineKey && root.querySelector('[data-cart-item-key="' + feeLineKey + '"]'));
      if (!byMarker || !hasFeeSignal) return;
      var controls = root.querySelectorAll(controlSelector);
      controls.forEach(function (el) {
        if (!(el instanceof HTMLElement)) return;
        el.style.setProperty("display", "none", "important");
        el.setAttribute("aria-hidden", "true");
        if ("disabled" in el) el.disabled = true;
      });
    });

    // Dawn cart drawer/cart table: hide the full quantity cell for fee line.
    var feeQtyInputs = document.querySelectorAll(
      'input[data-quantity-variant-id="' + feeVariantIdStr + '"]',
    );
    feeQtyInputs.forEach(function (input) {
      if (!(input instanceof HTMLElement)) return;
      var row = input.closest("tr.cart-item");
      if (!(row instanceof HTMLElement)) return;
      var qtyCell = row.querySelector("td.cart-item__quantity");
      if (qtyCell instanceof HTMLElement) {
        qtyCell.style.setProperty("display", "none", "important");
        qtyCell.setAttribute("aria-hidden", "true");
      }
    });
  }

  async function shippingRulesManualSyncFeeLine() {
    try {
      debugLog("sync start");
      const config = await getJson(CONFIG_URL, { credentials: "same-origin" });
      const feeVariantIdStr = gidToVariantIdString(config?.feeVariantId);
      const rules = parseRules(config?.rules);
      debugLog("config loaded", {
        feeVariantId: config?.feeVariantId || null,
        feeVariantIdNumeric: feeVariantIdStr,
        rulesCount: Array.isArray(config?.rules) ? config.rules.length : 0,
      });
      if (!feeVariantIdStr) {
        debugLog("missing feeVariantId in config");
        return { ok: false, reason: "missing_fee_variant_id", detail: config };
      }

      const cart = await getJson(CART_URL, { credentials: "same-origin" });
      const items = Array.isArray(cart?.items) ? cart.items : [];

      const feeLine = items.find((item) => String(item.id) === feeVariantIdStr) || null;
      var feeLineIndex = feeLine ? items.findIndex((item) => item && item.key === feeLine.key) + 1 : 0;
      const qualifyingLines = items.filter((item) =>
        lineQualifiesForFee(item, feeVariantIdStr),
      );
      const totalGrams = qualifyingLines.reduce(function (sum, item) {
        return sum + Math.max(0, Number(item.grams) || 0) * Math.max(0, Number(item.quantity) || 0);
      }, 0);
      const matchedRule = findMatchingRule(totalGrams, rules);
      const shouldHaveFeeLine = qualifyingLines.length > 0 && !!matchedRule;
      if (feeLine) {
        hideFeeLineControls(feeVariantIdStr, feeLine.key || null, feeLineIndex);
      }
      debugLog("cart snapshot", {
        itemCount: items.length,
        feeLinePresent: !!feeLine,
        shouldHaveFeeLine: shouldHaveFeeLine,
        totalGrams: totalGrams,
        matchedRule: matchedRule,
        lineSummaries: items.map((item) => ({
          id: item?.id,
          key: item?.key,
          quantity: item?.quantity,
          grams: item?.grams,
          requires_shipping: item?.requires_shipping,
        })),
      });

      if (shouldHaveFeeLine && !feeLine) {
        var idForCart = variantIdForCartPayload(feeVariantIdStr);
        debugLog("adding fee line", { idForCart: idForCart });
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
          debugLog("add failed", { status: addRes.status, body: parsed || errText });
          return {
            ok: false,
            reason: "add_failed",
            httpStatus: addRes.status,
            body: parsed || errText,
          };
        }
        window.dispatchEvent(new CustomEvent("shipping-rules:fee-line-added"));
        debugLog("add success");
        return { ok: true, action: "added" };
      }

      if (!shouldHaveFeeLine && feeLine) {
        var changeId = feeLine.key || variantIdForCartPayload(feeVariantIdStr);
        debugLog("removing fee line", { id: changeId });
        await fetch(CHANGE_URL, {
          method: "POST",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            id: changeId,
            quantity: 0,
          }),
        });
        window.dispatchEvent(new CustomEvent("shipping-rules:fee-line-removed"));
        debugLog("remove success");
        return { ok: true, action: "removed" };
      }

      debugLog("no change needed");
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
    "[shipping-rules] manual-fee: loaded (debug ON). Run: await shippingRulesManualSyncFeeLine()",
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
