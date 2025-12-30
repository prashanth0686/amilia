/**
 * amilia-booker / index.js
 *
 * Key goals:
 *  - Cloud Scheduler must NEVER fail due to app errors → always respond 200 with JSON.
 *  - Provide fast warmup endpoints: GET / and GET /health (no Browserless usage).
 *  - POST /book triggers Browserless automation (or dryRun) and returns 200 with status.
 *
 * Environment variables expected (Cloud Run):
 *  API_KEY
 *  AMILIA_EMAIL
 *  AMILIA_PASSWORD
 *  BROWSERLESS_TOKEN
 *  BROWSERLESS_HTTP_BASE               (ex: https://production-sfo.browserless.io)
 *  ACTIVITY_URL
 *  TARGET_DAY                          (ex: Wednesday)
 *  EVENING_START                        (ex: 13:00)
 *  EVENING_END                          (ex: 20:00)
 *  LOCAL_TZ                            (ex: America/Toronto)
 *  BROWSERLESS_OVERALL_TIMEOUT_MS      (ex: 540000)
 *  BROWSERLESS_PER_ATTEMPT_TIMEOUT_MS  (ex: 180000)
 *  BROWSERLESS_MAX_ATTEMPTS            (ex: 3)
 *
 * Optional per-request override (POST body):
 *  dryRun, targetDay, eveningStart, eveningEnd, timeZone, activityUrl,
 *  pollSeconds, pollIntervalMs, playerName, addressFull
 */

"use strict";

const express = require("express");
const crypto = require("crypto");

// Node 18+ has fetch globally on Cloud Run.
// If you're on Node 16, uncomment below:
// const fetch = (...args) => import("node-fetch").then(({ default: f }) => f(...args));

const app = express();

// Scheduler / Browserless requests are JSON
app.use(express.json({ limit: "1mb" }));

/** ---------- Utilities ---------- **/

function nowIso() {
  return new Date().toISOString();
}

function toInt(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function safeJson(res, obj) {
  // Always 200 for scheduler stability
  res.status(200).type("application/json").send(JSON.stringify(obj));
}

function getApiKeyFromReq(req) {
  // support x-api-key OR ?key=
  return (
    req.get("x-api-key") ||
    req.get("X-API-KEY") ||
    req.query.key ||
    req.query.apiKey ||
    ""
  );
}

function isAuthorized(req) {
  const expected = process.env.API_KEY || "";
  if (!expected) return true; // if no API_KEY configured, don't block (useful for debugging)
  const got = getApiKeyFromReq(req);
  return got && got === expected;
}

function getRuleFromEnvAndBody(body = {}) {
  const rule = {
    targetDay: body.targetDay || process.env.TARGET_DAY || "Wednesday",
    eveningStart: body.eveningStart || process.env.EVENING_START || "13:00",
    eveningEnd: body.eveningEnd || process.env.EVENING_END || "20:00",
    timeZone: body.timeZone || process.env.LOCAL_TZ || "America/Toronto",
    activityUrl: body.activityUrl || process.env.ACTIVITY_URL || "",
    dryRun: body.dryRun === true || body.dryRun === "true" ? true : false,

    // polling for “registrations open” / time window behavior
    pollSeconds: toInt(body.pollSeconds, 420), // default 7 minutes
    pollIntervalMs: toInt(body.pollIntervalMs, 3000),

    // additional booking steps user asked to include
    playerName: body.playerName || "Hari Prashanth Vaidyula",
    addressFull:
      body.addressFull || "383 rue des maraichers, quebec, qc, G1C 0K2",
  };

  return rule;
}

function browserlessConfigFromEnv(body = {}) {
  const overallTimeoutMs = toInt(
    body.overallTimeoutMs,
    toInt(process.env.BROWSERLESS_OVERALL_TIMEOUT_MS, 540000)
  );
  const perAttemptTimeoutMs = toInt(
    body.perAttemptTimeoutMs,
    toInt(process.env.BROWSERLESS_PER_ATTEMPT_TIMEOUT_MS, 180000)
  );
  const maxAttempts = toInt(
    body.maxAttempts,
    toInt(process.env.BROWSERLESS_MAX_ATTEMPTS, 3)
  );

  return { overallTimeoutMs, perAttemptTimeoutMs, maxAttempts };
}

function mask(str) {
  if (!str) return "";
  if (str.length <= 6) return "***";
  return str.slice(0, 2) + "***" + str.slice(-2);
}

/** ---------- Warmup / health endpoints (NO Browserless) ---------- **/

app.get("/", (req, res) => {
  res.status(200).send("OK");
});

app.get("/health", (req, res) => {
  safeJson(res, {
    ok: true,
    status: "healthy",
    time: nowIso(),
    service: "amilia-booker",
  });
});

/** ---------- Browserless call with retry ---------- **/

async function fetchWithTimeout(url, opts, timeoutMs) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(url, { ...opts, signal: controller.signal });
    return resp;
  } finally {
    clearTimeout(t);
  }
}

async function fetchWithRetry({ url, options, perAttemptTimeoutMs, maxAttempts }) {
  let lastErr = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const resp = await fetchWithTimeout(url, options, perAttemptTimeoutMs);

      // Browserless may return non-2xx on some errors; still capture body
      const text = await resp.text().catch(() => "");
      return { ok: resp.ok, status: resp.status, text, attempt };
    } catch (err) {
      lastErr = err;
      // small backoff
      await sleep(Math.min(1500 * attempt, 5000));
    }
  }

  const e = new Error(`fetchWithRetry failed after ${maxAttempts} attempt(s)`);
  e.cause = lastErr;
  throw e;
}

/** ---------- Browserless automation payload (Function API) ---------- **/

function buildBrowserlessFunctionCode() {
  /**
   * NOTE:
   * This Browserless “function” runs inside their environment with Puppeteer available.
   * You MUST adjust selectors below if Amilia UI differs.
   *
   * We keep it defensive:
   *  - login early
   *  - keep polling until registration open / time available
   *  - select player checkbox by visible label (playerName)
   *  - fill address and pick from dropdown
   */
  return `
module.exports = async ({ page, context }) => {
  const {
    activityUrl,
    email,
    password,
    targetDay,
    eveningStart,
    eveningEnd,
    timeZone,
    pollSeconds,
    pollIntervalMs,
    playerName,
    addressFull,
    dryRun
  } = context;

  const log = (...args) => console.log("[BL]", ...args);

  // Basic hardening
  page.setDefaultTimeout(45000);
  page.setDefaultNavigationTimeout(60000);

  const start = Date.now();
  const deadline = start + (pollSeconds * 1000);

  const goto = async (url) => {
    await page.goto(url, { waitUntil: "domcontentloaded" });
  };

  // --- Step 1: Go to activity page (forces auth flow if not logged in) ---
  log("Going to activityUrl:", activityUrl);
  await goto(activityUrl);
  await page.waitForTimeout(1500);

  // --- Step 2: Login if login form appears ---
  // These selectors are common; you may need to tweak depending on Amilia.
  const tryLogin = async () => {
    // Heuristics: find email/password inputs
    const emailSel = 'input[type="email"], input[name="email"], input#email';
    const passSel = 'input[type="password"], input[name="password"], input#password';

    const emailEl = await page.$(emailSel);
    const passEl = await page.$(passSel);

    if (!emailEl || !passEl) {
      return false;
    }

    log("Login form detected, attempting login...");
    await page.click(emailSel, { clickCount: 3 }).catch(() => {});
    await page.type(emailSel, email, { delay: 10 });

    await page.click(passSel, { clickCount: 3 }).catch(() => {});
    await page.type(passSel, password, { delay: 10 });

    // Submit button heuristics
    const btnSel = 'button[type="submit"], button:has-text("Sign in"), button:has-text("Log in"), button:has-text("Connexion")';
    const btn = await page.$(btnSel);
    if (btn) {
      await Promise.allSettled([
        page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 60000 }),
        btn.click()
      ]);
    } else {
      // fallback: press Enter
      await page.keyboard.press("Enter").catch(() => {});
      await page.waitForTimeout(2000);
    }

    log("Login attempt finished");
    return true;
  };

  await tryLogin().catch((e) => log("Login error (ignored):", String(e)));

  // --- Step 3: Poll until registration open / calendar selectable ---
  // We keep polling until we see something that looks like an enabled "Register" button.
  const isRegisterOpen = async () => {
    // try a few common register selectors/texts
    const candidates = [
      'button:has-text("Register")',
      'button:has-text("Register now")',
      'button:has-text("Inscription")',
      'button:has-text("S\\'inscrire")'
    ];
    for (const sel of candidates) {
      const el = await page.$(sel);
      if (el) {
        const disabled = await el.evaluate((b) => b.disabled || b.getAttribute("aria-disabled") === "true").catch(() => true);
        if (!disabled) return { open: true, selector: sel };
      }
    }
    return { open: false, selector: null };
  };

  while (Date.now() < deadline) {
    const r = await isRegisterOpen();
    if (r.open) {
      log("Registration looks open. selector:", r.selector);
      if (dryRun) {
        return { ok: true, status: "DRYRUN_REGISTER_OPEN", selector: r.selector };
      }
      await page.click(r.selector);
      await page.waitForTimeout(1500);
      break;
    }

    // Refresh/poke the UI
    await page.waitForTimeout(pollIntervalMs);
    // Light refresh every ~15s
    if ((Date.now() - start) % 15000 < pollIntervalMs) {
      await page.reload({ waitUntil: "domcontentloaded" }).catch(() => {});
    }
  }

  if (Date.now() >= deadline) {
    return { ok: false, status: "REGISTER_NOT_OPEN_IN_TIME" };
  }

  // --- Step 4: Select player checkbox (label match) ---
  // Looks for the player name text and clicks nearby checkbox.
  const selectPlayerByName = async (name) => {
    // Try label text search
    const xpath = \`//*[contains(normalize-space(), "\${name}")]\`;
    const nodes = await page.$x(xpath);
    if (!nodes.length) return false;

    for (const n of nodes) {
      // walk up and find input checkbox
      const checkbox = await n.$('input[type="checkbox"]').catch(() => null);
      if (checkbox) {
        const checked = await checkbox.evaluate((c) => c.checked).catch(() => false);
        if (!checked) await checkbox.click().catch(() => {});
        return true;
      }
      // try nearest preceding checkbox
      const cb2 = await page.evaluateHandle((el) => {
        const root = el.closest("label, div, li, tr") || el.parentElement;
        if (!root) return null;
        return root.querySelector('input[type="checkbox"]');
      }, n).catch(() => null);

      if (cb2) {
        const asEl = cb2.asElement();
        if (asEl) {
          const checked = await asEl.evaluate((c) => c.checked).catch(() => false);
          if (!checked) await asEl.click().catch(() => {});
          return true;
        }
      }
    }
    return false;
  };

  const playerOk = await selectPlayerByName(playerName);
  log("Player selection:", playerOk);

  // Proceed/Next button
  const clickNext = async () => {
    const nextSel = 'button:has-text("Next"), button:has-text("Continue"), button:has-text("Proceed"), button:has-text("Suivant"), button:has-text("Continuer")';
    const btn = await page.$(nextSel);
    if (btn) {
      await btn.click();
      await page.waitForTimeout(1200);
      return true;
    }
    return false;
  };

  await clickNext().catch(() => {});

  // --- Step 5: Address input + choose suggestion ---
  const fillAddress = async (address) => {
    // Common address/autocomplete selectors
    const addrSel = 'input[autocomplete="street-address"], input[name*="address" i], input[id*="address" i], input[placeholder*="address" i]';
    const addrEl = await page.$(addrSel);
    if (!addrEl) return false;

    await page.click(addrSel, { clickCount: 3 }).catch(() => {});
    await page.type(addrSel, address, { delay: 10 });
    await page.waitForTimeout(1200);

    // try to pick first dropdown option
    const optionSel = '[role="option"], li[role="option"], .pac-item, ul li';
    const opt = await page.$(optionSel);
    if (opt) {
      await opt.click().catch(() => {});
      await page.waitForTimeout(800);
      return true;
    }

    // fallback: ArrowDown + Enter
    await page.keyboard.press("ArrowDown").catch(() => {});
    await page.keyboard.press("Enter").catch(() => {});
    await page.waitForTimeout(800);
    return true;
  };

  const addrOk = await fillAddress(addressFull);
  log("Address fill:", addrOk);

  // Next again
  await clickNext().catch(() => {});

  // --- Final: Try to locate final submit/confirm ---
  const trySubmit = async () => {
    const submitSel = 'button:has-text("Confirm"), button:has-text("Submit"), button:has-text("Pay"), button:has-text("Complete"), button[type="submit"], button:has-text("Confirmer")';
    const btn = await page.$(submitSel);
    if (!btn) return false;

    if (dryRun) {
      return "DRYRUN_READY_TO_SUBMIT";
    }
    await btn.click().catch(() => {});
    await page.waitForTimeout(2000);
    return "SUBMIT_CLICKED";
  };

  const submitResult = await trySubmit().catch(() => "SUBMIT_FAILED");

  return {
    ok: true,
    status: "FLOW_DONE",
    playerOk,
    addrOk,
    submitResult
  };
};`;
}

/** ---------- POST /book (Scheduler calls this) ---------- **/

app.post("/book", async (req, res) => {
  const reqId = crypto.randomUUID();
  const startedAt = Date.now();

  // Auth gate (return 200 but with status UNAUTHORIZED so Scheduler doesn't 5xx)
  if (!isAuthorized(req)) {
    return safeJson(res, {
      ok: false,
      status: "UNAUTHORIZED",
      error: "Unauthorized (invalid x-api-key)",
      reqId,
      time: nowIso(),
    });
  }

  const rule = getRuleFromEnvAndBody(req.body || {});
  const retry = browserlessConfigFromEnv(req.body || {});

  console.log(
    "BOOK_START",
    JSON.stringify({
      reqId,
      rule,
      retry: { ...retry },
      env: {
        BROWSERLESS_HTTP_BASE: process.env.BROWSERLESS_HTTP_BASE,
        BROWSERLESS_TOKEN: mask(process.env.BROWSERLESS_TOKEN),
        ACTIVITY_URL: process.env.ACTIVITY_URL,
      },
    })
  );

  // If dryRun, you can optionally skip Browserless entirely
  // but leaving Browserless enabled helps validate selectors.
  const browserlessBase = process.env.BROWSERLESS_HTTP_BASE || "";
  const token = process.env.BROWSERLESS_TOKEN || "";
  const email = process.env.AMILIA_EMAIL || "";
  const password = process.env.AMILIA_PASSWORD || "";

  if (!browserlessBase || !token) {
    return safeJson(res, {
      ok: false,
      status: "MISSING_BROWSERLESS_CONFIG",
      reqId,
      rule,
      error: "BROWSERLESS_HTTP_BASE or BROWSERLESS_TOKEN not set",
    });
  }

  if (!rule.activityUrl) {
    return safeJson(res, {
      ok: false,
      status: "MISSING_ACTIVITY_URL",
      reqId,
      rule,
      error: "ACTIVITY_URL not set and not provided in body",
    });
  }

  // Browserless Function API endpoint:
  // Many Browserless deployments accept /function?token=...
  const url = `${browserlessBase.replace(/\/+$/, "")}/function?token=${encodeURIComponent(
    token
  )}`;

  const functionCode = buildBrowserlessFunctionCode();

  const payload = {
    code: functionCode,
    context: {
      activityUrl: rule.activityUrl,
      email,
      password,
      targetDay: rule.targetDay,
      eveningStart: rule.eveningStart,
      eveningEnd: rule.eveningEnd,
      timeZone: rule.timeZone,
      pollSeconds: rule.pollSeconds,
      pollIntervalMs: rule.pollIntervalMs,
      playerName: rule.playerName,
      addressFull: rule.addressFull,
      dryRun: rule.dryRun,
    },
  };

  try {
    const bl = await fetchWithRetry({
      url,
      options: {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      },
      perAttemptTimeoutMs: retry.perAttemptTimeoutMs,
      maxAttempts: retry.maxAttempts,
    });

    // Try parse JSON from browserless, but keep raw text too
    let parsed = null;
    try {
      parsed = JSON.parse(bl.text);
    } catch (_) {}

    const elapsedMs = Date.now() - startedAt;

    // Browserless often returns 408 when it times out.
    if (!bl.ok) {
      console.log(
        "BROWSERLESS_FINAL_FAIL",
        JSON.stringify({ message: `fetchWithRetry failed after ${bl.attempt} attempt(s)`, status: bl.status })
      );
    }

    return safeJson(res, {
      ok: bl.ok,
      status: bl.ok ? "BROWSERLESS_OK" : "BROWSERLESS_HTTP_ERROR",
      httpStatus: bl.status,
      reqId,
      rule,
      retry: {
        attempts: bl.attempt,
        perAttemptTimeoutMs: retry.perAttemptTimeoutMs,
        overallTimeoutMs: retry.overallTimeoutMs,
        maxAttempts: retry.maxAttempts,
      },
      browserless: {
        parsed,
        raw: bl.text?.slice(0, 2000) || "", // limit size
      },
      timing: { elapsedMs },
    });
  } catch (err) {
    const elapsedMs = Date.now() - startedAt;
    console.log(
      "BROWSERLESS_FINAL_FAIL",
      JSON.stringify({
        message: err?.message || "Unknown error",
        status: 408, // treat as timeout-like for logging consistency
      })
    );

    // Still 200 so Scheduler won't mark job failed due to 5xx
    return safeJson(res, {
      ok: false,
      status: "BROWSERLESS_EXCEPTION",
      reqId,
      rule,
      error: err?.message || String(err),
      timing: { elapsedMs },
    });
  }
});

/** ---------- Fallback for unknown routes ---------- **/
app.use((req, res) => {
  safeJson(res, {
    ok: false,
    status: "NOT_FOUND",
    path: req.path,
    method: req.method,
    time: nowIso(),
  });
});

/** ---------- Start server ---------- **/
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`amilia-booker listening on ${PORT}`);
});
