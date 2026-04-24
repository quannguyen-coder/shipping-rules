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
  var CONFIG_TTL_MS = 15000;
  var CART_TTL_MS = 1200;
  var SECTION_IDS = [
    "cart-drawer",
    "cart-icon-bubble",
    "main-cart-items",
    "main-cart-footer",
    "cart-live-region-text",
  ];
  var DEBUG =
    typeof window !== "undefined" &&
    (window.SHIPPING_RULES_DEBUG === true ||
      (window.location &&
        typeof window.location.search === "string" &&
        /(?:\\?|&)shipping_rules_debug=1(?:&|$)/.test(window.location.search)));

  function debugLog() {
    if (!DEBUG) return;
    var args = Array.prototype.slice.call(arguments);
    args.unshift("[shipping-rules] auto-fee:");
    console.log.apply(console, args);
  }

  /**
   * Variant id for Cart API: digits from ProductVariant GID, or already-numeric string.
   * Prefer Number() in JSON when safe so /cart/add.js matches storefront expectations.
   */
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
      /* fall through */
    }
    return idStr;
  }

  async function getJson(url, init) {
    const response = await fetch(url, init);
    if (!response.ok) throw new Error(\`Request failed: \${url} \${response.status}\`);
    return response.json();
  }

  var cachedConfig = null;
  var cachedConfigFetchedAt = 0;
  var configInFlight = null;
  var cachedCart = null;
  var cachedCartFetchedAt = 0;
  var cartInFlight = null;

  async function getPublishedConfig(force) {
    var now = Date.now();
    var isFresh = cachedConfig && now - cachedConfigFetchedAt < CONFIG_TTL_MS;
    if (!force && isFresh) return cachedConfig;
    if (configInFlight) return configInFlight;
    configInFlight = getJson(CONFIG_URL, { credentials: "same-origin" })
      .then(function (cfg) {
        cachedConfig = cfg;
        cachedConfigFetchedAt = Date.now();
        return cfg;
      })
      .finally(function () {
        configInFlight = null;
      });
    return configInFlight;
  }

  function captureCartSnapshot(maybeCart) {
    if (!maybeCart || typeof maybeCart !== "object") return false;
    if (!Array.isArray(maybeCart.items)) return false;
    cachedCart = maybeCart;
    cachedCartFetchedAt = Date.now();
    return true;
  }

  async function getCartSnapshot(force) {
    var now = Date.now();
    var isFresh = cachedCart && now - cachedCartFetchedAt < CART_TTL_MS;
    if (!force && isFresh) return cachedCart;
    if (cartInFlight) return cartInFlight;
    cartInFlight = getJson(CART_URL, { credentials: "same-origin" })
      .then(function (cart) {
        captureCartSnapshot(cart);
        return cart;
      })
      .finally(function () {
        cartInFlight = null;
      });
    return cartInFlight;
  }

  function getCartFingerprint(maybeCart) {
    if (!maybeCart || typeof maybeCart !== "object") return null;
    var items = Array.isArray(maybeCart.items) ? maybeCart.items : null;
    if (!items) return null;
    var normalizedItems = items
      .map(function (item) {
        if (!item || typeof item !== "object") return null;
        var key = item.key != null ? String(item.key) : "";
        var id = item.id != null ? String(item.id) : "";
        var qty = Number(item.quantity) || 0;
        return key + "|" + id + "|" + qty;
      })
      .filter(function (row) {
        return row != null;
      })
      .sort();
    return JSON.stringify({
      item_count: Number(maybeCart.item_count) || 0,
      total_price: Number(maybeCart.total_price) || 0,
      items: normalizedItems,
    });
  }

  async function refreshCartUiIfChanged(beforeFingerprint, maybeAfterCart, reason) {
    var nextFingerprint = getCartFingerprint(maybeAfterCart);
    var changed = false;
    if (beforeFingerprint && nextFingerprint) {
      changed = beforeFingerprint !== nextFingerprint;
    } else {
      try {
        var latestCart = await getCartSnapshot(true);
        nextFingerprint = getCartFingerprint(latestCart);
        if (latestCart) captureCartSnapshot(latestCart);
        changed = !!beforeFingerprint && !!nextFingerprint && beforeFingerprint !== nextFingerprint;
      } catch (err) {
        debugLog("cart change verification failed", { reason: reason, err: err });
      }
    }
    if (changed) {
      debugLog("cart changed, refresh UI", { reason: reason });
      refreshCartUi();
    } else {
      debugLog("skip UI refresh, cart unchanged", { reason: reason });
    }
  }

  var addCooldownUntil = 0;
  var debounceTimer = null;

  function scheduleSyncFeeLine(delayMs) {
    var d = typeof delayMs === "number" ? delayMs : 150;
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(function () {
      debounceTimer = null;
      syncFeeLine();
    }, d);
  }

  function flushSyncFeeLine() {
    clearTimeout(debounceTimer);
    debounceTimer = null;
    return syncFeeLine();
  }

  function bumpAddCooldown(ms) {
    var until = Date.now() + ms;
    if (until > addCooldownUntil) addCooldownUntil = until;
  }

  async function refreshCartUi() {
    var replacedCount = 0;
    // Let themes react immediately while section HTML is fetching.
    window.dispatchEvent(new CustomEvent("cart:refresh"));
    window.dispatchEvent(new CustomEvent("cart:updated"));
    window.dispatchEvent(new CustomEvent("shipping-rules:cart-refreshed"));
    try {
      var params = new URLSearchParams();
      params.set("sections", SECTION_IDS.join(","));
      params.set("sections_url", window.location.pathname + window.location.search);
      const sectionsRes = await fetch(ROOT + "?" + params.toString(), {
        credentials: "same-origin",
      });
      if (!sectionsRes.ok) throw new Error("sections reload failed: " + sectionsRes.status);
      const sections = await sectionsRes.json();
      if (!sections || typeof sections !== "object") return;

      Object.keys(sections).forEach(function (sectionId) {
        var html = sections[sectionId];
        if (typeof html !== "string") return;
        var candidates = [];
        var byId = document.getElementById("shopify-section-" + sectionId);
        if (byId) candidates.push(byId);
        document
          .querySelectorAll('[id^="shopify-section-' + sectionId + '"], [data-section-id="' + sectionId + '"]')
          .forEach(function (el) {
            if (el instanceof HTMLElement && candidates.indexOf(el) === -1) candidates.push(el);
          });
        if (candidates.length === 0) return;

        var doc = new DOMParser().parseFromString(html, "text/html");
        var parsedRoot = doc.getElementById("shopify-section-" + sectionId);
        candidates.forEach(function (liveRoot) {
          if (!(liveRoot instanceof HTMLElement)) return;
          if (parsedRoot && liveRoot.parentNode) {
            liveRoot.parentNode.replaceChild(parsedRoot.cloneNode(true), liveRoot);
          } else {
            liveRoot.innerHTML = html;
          }
          replacedCount += 1;
        });
      });
    } catch (err) {
      debugLog("refreshCartUi fallback via events", err);
    } finally {
      if (replacedCount === 0) {
        debugLog("no section replaced, hard reload");
        window.location.reload();
      }
    }
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
        return {
          weightMinGrams: min,
          weightMaxGrams: max,
          priority: priority,
          feeAmount:
            typeof r.feeAmount === "string" || r.feeAmount === null ? r.feeAmount : null,
          feePercent:
            typeof r.feePercent === "string" || r.feePercent === null ? r.feePercent : null,
        };
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

  function parseRuleNumber(v) {
    if (v == null || v === "") return null;
    var n = Number(v);
    return Number.isFinite(n) ? n : null;
  }

  function lineSubtotalFromCartItem(item) {
    if (!item) return 0;
    var cents = Number(item.final_line_price);
    if (!Number.isFinite(cents)) cents = Number(item.line_price);
    if (!Number.isFinite(cents)) return 0;
    return cents / 100;
  }

  function calculatedFeeTotal(matchedRule, qualifyingLines) {
    if (!matchedRule) return 0;
    var amount = parseRuleNumber(matchedRule.feeAmount);
    if (amount != null) return Math.max(0, amount);
    var pct = parseRuleNumber(matchedRule.feePercent);
    if (pct != null && pct > 0) {
      var subtotal = qualifyingLines.reduce(function (sum, item) {
        return sum + lineSubtotalFromCartItem(item);
      }, 0);
      return (subtotal * pct) / 100;
    }
    return 0;
  }

  function hideFeeLineControls(feeVariantIdStr, feeLineKey, feeLineIndexOneBased) {
    if (typeof document === "undefined") return;
    if (!feeVariantIdStr) return;
    var controlSelector =
      'input[name^="updates"], input[type="number"], button[name="minus"], button[name="plus"], button[name="remove"], [data-quantity-input], [data-quantity-selector], .quantity__button, .quantity__input, cart-remove-button, a[href*="/cart/change"], a[href*="line="]';
    var rowSelector = ".cart-item, .cart__item, tr[role='row'], [data-cart-item-key], [data-line-item-key], li";
    var feeRows = [];
    function addRowFromNode(node) {
      if (!(node instanceof HTMLElement)) return;
      var row = node.closest(rowSelector);
      if (!(row instanceof HTMLElement)) return;
      if (feeRows.indexOf(row) === -1) feeRows.push(row);
    }

    document
      .querySelectorAll('input[data-quantity-variant-id="' + feeVariantIdStr + '"]')
      .forEach(addRowFromNode);
    document
      .querySelectorAll('a[href*="variant=' + feeVariantIdStr + '"]')
      .forEach(addRowFromNode);
    if (feeLineKey) {
      document
        .querySelectorAll('[data-cart-item-key="' + feeLineKey + '"], [data-line-item-key="' + feeLineKey + '"]')
        .forEach(addRowFromNode);
    }

    feeRows.forEach(function (row) {
      var controls = row.querySelectorAll(controlSelector);
      controls.forEach(function (el) {
        if (!(el instanceof HTMLElement)) return;
        el.style.setProperty("display", "none", "important");
        el.setAttribute("aria-hidden", "true");
        if ("disabled" in el) el.disabled = true;
      });
    });

    // Dawn cart drawer/cart table: hide the full quantity cell for fee line.
    var feeQtyInputs = document.querySelectorAll('input[data-quantity-variant-id="' + feeVariantIdStr + '"]');
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

  var syncInProgress = false;
  var syncRerunRequested = false;
  var syncCurrentPromise = Promise.resolve();
  var lastFastSyncAt = 0;
  var skipNextCartUiRefresh = false;

  function maybeFastSync(reason) {
    var now = Date.now();
    if (now - lastFastSyncAt < 120) return;
    lastFastSyncAt = now;
    debugLog("fast sync trigger", { reason: reason });
    scheduleSyncFeeLine(0);
    setTimeout(function () {
      scheduleSyncFeeLine(60);
    }, 60);
  }

  function maybeFastSyncWithoutUiRefresh(reason) {
    skipNextCartUiRefresh = true;
    maybeFastSync(reason);
  }

  function isCartMutationUrl(urlLike) {
    if (!urlLike) return false;
    try {
      var u = new URL(String(urlLike), window.location.origin);
      var p = (u.pathname || "").toLowerCase();
      return (
        p.endsWith("/cart/add.js") ||
        p.endsWith("/cart/change.js") ||
        p.endsWith("/cart/update.js") ||
        p.endsWith("/cart/clear.js")
      );
    } catch (_) {
      return false;
    }
  }

  function classifyCartMutation(urlLike) {
    if (!urlLike) return null;
    try {
      var u = new URL(String(urlLike), window.location.origin);
      var p = (u.pathname || "").toLowerCase();
      if (p.endsWith("/cart/add.js")) return "add";
      if (p.endsWith("/cart/change.js")) return "change";
      if (p.endsWith("/cart/update.js")) return "update";
      if (p.endsWith("/cart/clear.js")) return "clear";
      return null;
    } catch (_) {
      return null;
    }
  }

  function dispatchCartMutationEvents(kind, payload, meta) {
    var lineItem = meta && meta.lineItem ? meta.lineItem : null;
    var detail = {
      kind: kind || "unknown",
      lineItem: lineItem,
      cart: payload || null,
      source: meta || null,
    };
    var events = ["cart:changed"];
    if (kind === "add") events.push("cart:added");
    if (kind === "change" || kind === "update") events.push("cart:quantityChanged");
    if (kind === "clear") events.push("cart:removed");
    events.forEach(function (name) {
      document.dispatchEvent(new CustomEvent(name, { detail: detail }));
    });
  }

  function normalizeLineItem(raw) {
    if (!raw || typeof raw !== "object") return null;
    var id = raw.id != null ? String(raw.id) : null;
    var quantity = Number(raw.quantity);
    if (!Number.isFinite(quantity) || quantity <= 0) quantity = 1;
    var key = raw.key != null ? String(raw.key) : null;
    if (!id && !key) return null;
    return {
      id: id,
      quantity: quantity,
      key: key,
    };
  }

  function extractLineItemFromBody(body) {
    if (!body) return null;
    try {
      if (typeof body === "string") {
        var parsed = JSON.parse(body);
        if (parsed && Array.isArray(parsed.items) && parsed.items.length > 0) {
          return normalizeLineItem(parsed.items[0]);
        }
        if (parsed && typeof parsed === "object") return normalizeLineItem(parsed);
      }
      if (typeof URLSearchParams !== "undefined" && body instanceof URLSearchParams) {
        return normalizeLineItem({
          id: body.get("id"),
          quantity: body.get("quantity"),
        });
      }
      if (typeof FormData !== "undefined" && body instanceof FormData) {
        return normalizeLineItem({
          id: body.get("id"),
          quantity: body.get("quantity"),
        });
      }
    } catch (_) {
      return null;
    }
    return null;
  }

  function installCartMutationHooks() {
    // Hook fetch for immediate post-mutation sync.
    if (typeof window.fetch === "function") {
      var originalFetch = window.fetch.bind(window);
      window.fetch = function (input, init) {
        var url = typeof input === "string" ? input : input && input.url;
        var shouldWatch = isCartMutationUrl(url);
        var mutationKind = classifyCartMutation(url);
        var requestLineItem = extractLineItemFromBody(init && init.body);
        return originalFetch(input, init).then(function (res) {
          if (shouldWatch && res && res.ok) {
            try {
              res
                .clone()
                .json()
                .then(function (payload) {
                  captureCartSnapshot(payload);
                  dispatchCartMutationEvents(mutationKind, payload, {
                    transport: "fetch",
                    url: url || null,
                    lineItem: requestLineItem,
                  });
                })
                .catch(function () {
                  /* mutation may not return full cart shape */
                  dispatchCartMutationEvents(mutationKind, null, {
                    transport: "fetch",
                    url: url || null,
                    lineItem: requestLineItem,
                  });
                });
            } catch (_) {
              /* ignore clone/parse errors */
              dispatchCartMutationEvents(mutationKind, null, {
                transport: "fetch",
                url: url || null,
                lineItem: requestLineItem,
              });
            }
            // cart changed; mark stale so next sync refetches if no snapshot captured.
            cachedCartFetchedAt = 0;
            // Do not force refresh config on every mutation.
            // Rules/config are already cached with TTL; forcing here causes noisy,
            // low-value requests to app-proxy endpoint.
            maybeFastSyncWithoutUiRefresh("fetch:" + url);
          }
          return res;
        });
      };
    }

    // Hook XHR for themes that still use XMLHttpRequest.
    var XHR = window.XMLHttpRequest;
    if (!XHR || !XHR.prototype) return;
    var origOpen = XHR.prototype.open;
    var origSend = XHR.prototype.send;
    XHR.prototype.open = function (method, url) {
      this.__shippingRulesCartWatch = isCartMutationUrl(url);
      this.__shippingRulesCartMutationKind = classifyCartMutation(url);
      this.__shippingRulesCartUrl = url || null;
      return origOpen.apply(this, arguments);
    };
    XHR.prototype.send = function () {
      this.__shippingRulesCartLineItem = extractLineItemFromBody(arguments[0]);
      if (this.__shippingRulesCartWatch) {
        this.addEventListener("loadend", function () {
          if (this.status >= 200 && this.status < 300) {
            var payload = null;
            try {
              payload = this.responseText ? JSON.parse(this.responseText) : null;
              captureCartSnapshot(payload);
            } catch (_) {
              payload = null;
            }
            dispatchCartMutationEvents(this.__shippingRulesCartMutationKind, payload, {
              transport: "xhr",
              url: this.__shippingRulesCartUrl || null,
              lineItem: this.__shippingRulesCartLineItem || null,
            });
            cachedCartFetchedAt = 0;
            // Same as fetch hook: keep config refresh on TTL, not per mutation.
            maybeFastSyncWithoutUiRefresh("xhr");
          }
        });
      }
      return origSend.apply(this, arguments);
    };
  }

  async function runSyncOnce() {
    var allowCartUiRefresh = !skipNextCartUiRefresh;
    skipNextCartUiRefresh = false;
    try {
      const config = await getPublishedConfig(false);
      const feeVariantIdStr = gidToVariantIdString(config?.feeVariantId);
      debugLog("config loaded", {
        feeVariantId: config?.feeVariantId || null,
        feeVariantIdNumeric: feeVariantIdStr,
        rulesCount: Array.isArray(config?.rules) ? config.rules.length : 0,
      });
      if (!feeVariantIdStr) {
        console.warn("[shipping-rules] auto-fee: missing feeVariantId in app proxy config");
        return;
      }

      const cart = await getCartSnapshot(false);
      const items = Array.isArray(cart?.items) ? cart.items : [];
      const rules = parseRules(config?.rules);

      const feeLine = items.find((item) => String(item.id) === feeVariantIdStr) || null;
      var feeLineIndex = feeLine ? items.findIndex((item) => item && item.key === feeLine.key) + 1 : 0;
      const qualifyingLines = items.filter((item) =>
        lineQualifiesForFee(item, feeVariantIdStr),
      );
      const totalGrams = qualifyingLines.reduce(function (sum, item) {
        return sum + Math.max(0, Number(item.grams) || 0) * Math.max(0, Number(item.quantity) || 0);
      }, 0);
      const matchedRule = findMatchingRule(totalGrams, rules);
      const feeTotal = calculatedFeeTotal(matchedRule, qualifyingLines);
      const shouldHaveFeeLine = qualifyingLines.length > 0 && feeTotal > 0;
      if (feeLine) {
        hideFeeLineControls(feeVariantIdStr, feeLine.key || null, feeLineIndex);
      }
      debugLog("sync snapshot", {
        itemCount: items.length,
        feeLinePresent: !!feeLine,
        shouldHaveFeeLine: shouldHaveFeeLine,
        totalGrams: totalGrams,
        matchedRule: matchedRule,
        feeTotal: feeTotal,
        cooldownRemainingMs: Math.max(0, addCooldownUntil - Date.now()),
      });

      if (shouldHaveFeeLine && !feeLine) {
        if (Date.now() < addCooldownUntil) {
          debugLog("skip add during cooldown", {
            cooldownUntil: addCooldownUntil,
          });
          return;
        }
        var idForCart = variantIdForCartPayload(feeVariantIdStr);
        debugLog("adding fee line", { idForCart: idForCart });
        var beforeAddFingerprint = getCartFingerprint(cart);
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
          var waitSec = 120;
          try {
            var errJson = JSON.parse(errText);
            console.warn("[shipping-rules] auto-fee: cart/add.js failed", addRes.status, errJson);
            if (errJson && errJson.status === "too_many_requests") waitSec = 300;
          } catch (_) {
            console.warn("[shipping-rules] auto-fee: cart/add.js failed", addRes.status, errText);
          }
          if (addRes.status === 429) waitSec = 300;
          bumpAddCooldown(waitSec * 1000);
          debugLog("add failed", {
            status: addRes.status,
            cooldownSeconds: waitSec,
          });
          return;
        }
        addCooldownUntil = 0;
        debugLog("add success");
        var addPayload = null;
        try {
          addPayload = await addRes.clone().json();
          captureCartSnapshot(addPayload);
        } catch (_) {
          /* ignore payload parse errors, verify via cart fetch fallback */
        }
        window.dispatchEvent(new CustomEvent("shipping-rules:fee-line-added"));
        cachedCartFetchedAt = 0;
        if (allowCartUiRefresh) {
          await refreshCartUiIfChanged(beforeAddFingerprint, addPayload, "add-fee-line");
        } else {
          debugLog("skip UI refresh for hook-triggered sync", { reason: "add-fee-line" });
        }
        return;
      }

      if (!shouldHaveFeeLine && feeLine) {
        debugLog("removing fee line", { id: feeVariantIdStr });
        var changeId = feeLine.key || variantIdForCartPayload(feeVariantIdStr);
        var beforeRemoveFingerprint = getCartFingerprint(cart);
        const removeRes = await fetch(CHANGE_URL, {
          method: "POST",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            id: changeId,
            quantity: 0,
          }),
        });
        if (!removeRes.ok) {
          var removeErrText = await removeRes.text();
          console.warn(
            "[shipping-rules] auto-fee: cart/change.js failed",
            removeRes.status,
            removeErrText,
          );
          return;
        }
        debugLog("remove success");
        var removePayload = null;
        try {
          removePayload = await removeRes.clone().json();
          captureCartSnapshot(removePayload);
        } catch (_) {
          /* ignore payload parse errors, verify via cart fetch fallback */
        }
        window.dispatchEvent(new CustomEvent("shipping-rules:fee-line-removed"));
        cachedCartFetchedAt = 0;
        if (allowCartUiRefresh) {
          await refreshCartUiIfChanged(beforeRemoveFingerprint, removePayload, "remove-fee-line");
        } else {
          debugLog("skip UI refresh for hook-triggered sync", { reason: "remove-fee-line" });
        }
      } else {
        debugLog("no change needed");
      }
    } catch (err) {
      console.warn("[shipping-rules] auto-fee sync error", err);
    }
  }

  function syncFeeLine() {
    if (syncInProgress) {
      syncRerunRequested = true;
      return syncCurrentPromise;
    }
    syncInProgress = true;
    syncCurrentPromise = (async function () {
      try {
        do {
          syncRerunRequested = false;
          await runSyncOnce();
        } while (syncRerunRequested);
      } finally {
        syncInProgress = false;
      }
    })();
    return syncCurrentPromise;
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
      flushSyncFeeLine().finally(function () {
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
      flushSyncFeeLine().finally(function () {
        window.location.assign(dest);
      });
    },
    true,
  );

  scheduleSyncFeeLine(250);
  window.addEventListener("pageshow", function () {
    scheduleSyncFeeLine(400);
  });
  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "visible") scheduleSyncFeeLine(600);
  });
  document.addEventListener("shopify:section:load", function () {
    scheduleSyncFeeLine(80);
  });
  document.addEventListener("cart:updated", function () {
    scheduleSyncFeeLine(80);
  });
  document.addEventListener("ajaxProduct:added", function () {
    scheduleSyncFeeLine(60);
  });
  // React faster to quantity interactions in cart/drawer, before theme custom events fire.
  document.addEventListener("click", function (e) {
    var t = e.target;
    if (!(t instanceof Element)) return;
    var qtyBtn = t.closest(".quantity__button, button[name='plus'], button[name='minus']");
    if (!qtyBtn) return;
    maybeFastSync("qty-button");
  });
  document.addEventListener("change", function (e) {
    var t = e.target;
    if (!(t instanceof HTMLInputElement)) return;
    var isQtyInput =
      t.matches('input[name^="updates"]') ||
      t.matches("input.quantity__input") ||
      t.matches('input[data-quantity-variant-id]');
    if (!isQtyInput) return;
    maybeFastSync("qty-input");
  });
  installCartMutationHooks();
  // Preload config early so first cart change responds faster.
  getPublishedConfig(false).catch(function (err) {
    debugLog("config preload failed", err);
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
      scheduleSyncFeeLine(0);
    }, 60000);
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
