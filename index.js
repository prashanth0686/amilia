/**
 * Cloud Run entry (Express)
 * Endpoints:
 *   GET  /health   -> simple health JSON
 *   POST /warmup   -> login-only warmup, caches cookies in-memory
 *   POST /book     -> booking flow (placeholder here: you can plug your existing booking script)
 *
 * Design goals:
 *  - Always return HTTP 200 so Cloud Scheduler doesn't mark failures as failed.
 *  - Put real outcome in JSON: { ok, status, ... }
 *  - Single-instance friendly: concurrency should be 1 in Cloud Run.
 */

import express from "express";
import fetch from "node-fetch";

const app = express();
app.use(express.json({ limit: "1mb" }));

const PORT = process.env.PORT || 8080;

// ====== Required env ======
const API_KEY = process.env.API_KEY || "";
const AMILIA_EMAIL = process.env.AMILIA_EMAIL || "";
const AMILIA_PASSWORD = process.env.AMILIA_PASSWORD || "";

const BROWSERLESS_TOKEN = process.env.BROWSERLESS_TOKEN || "";
const BROWSERLESS_HTTP_BASE = process.env.BROWSERLESS_HTTP_BASE || "https://production-sfo.browserless.io";

// Tuning (you already set these)
const OVERALL_TIMEOUT_MS = parseInt(process.env.BROWSERLESS_OVERALL_TIMEOUT_MS || "540000", 10);
const PER_ATTEMPT_TIMEOUT_MS = parseInt(process.env.BROWSERLESS_PER_ATTEMPT_TIMEOUT_MS || "180000", 10);
const MAX_ATTEMPTS = parseInt(process.env.BROWSERLESS_MAX_ATTEMPTS || "3", 10);

// ====== In-memory cookie cache (works well with min instances = 1) ======
let cachedCookies = null; // array
let cachedCookiesAt = 0; // epoch ms

function now() {
  return Date.now();
}

function isAuthOk(req) {
  // Allow local/manual calls only if key matches
  const key = req.header("x-api-key");
  return API_KEY && key && key === API_KEY;
}

function ok200(res, payload) {
  // Always 200 to keep Scheduler green
  res.status(200).json(payload);
}

app.get("/health", (req, res) => {
  ok200(res, {
    ok: true,
    status: "OK",
    revision: process.env.K_REVISION,
    service: process.env.K_SERVICE,
    time: new Date().toISOString(),
    cookieCache: cachedCookies ? { ageSec: Math.floor((now() - cachedCookiesAt) / 1000) } : null
  });
});

/**
 * Calls Browserless /function
 * https://www.browserless.io/docs/function
 */
async function callBrowserlessFunction({ code, context, timeoutMs }) {
  const url = `${BROWSERLESS_HTTP_BASE.replace(/\/$/, "")}/function?token=${encodeURIComponent(BROWSERLESS_TOKEN)}`;

  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code, context }),
      signal: controller.signal
    });

    const text = await r.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* leave as text */ }

    return { httpStatus: r.status, body: json ?? text };
  } finally {
    clearTimeout(t);
  }
}

async function withRetry(fn, { attempts, perAttemptTimeoutMs }) {
  let lastErr = null;
  for (let i = 1; i <= attempts; i++) {
    try {
      return await fn(i);
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr;
}

/**
 * Warmup flow:
 * - Log into Amilia (lightweight)
 * - Return cookies
 * - Cache cookies in-memory
 */
app.post("/warmup", async (req, res) => {
  if (!isAuthOk(req)) {
    return ok200(res, { ok: false, status: "UNAUTHORIZED", error: "Unauthorized (invalid x-api-key)" });
  }
  if (!BROWSERLESS_TOKEN) {
    return ok200(res, { ok: false, status: "CONFIG_ERROR", error: "Missing BROWSERLESS_TOKEN" });
  }
  if (!AMILIA_EMAIL || !AMILIA_PASSWORD) {
    return ok200(res, { ok: false, status: "CONFIG_ERROR", error: "Missing AMILIA_EMAIL/AMILIA_PASSWORD" });
  }

  const started = now();
  console.log("WARMUP_START", JSON.stringify({ revision: process.env.K_REVISION }));

  // Browserless function code: logs in and returns cookies.
  // IMPORTANT: selectors may need adjusting if Amilia changes HTML.
  const code = `
module.exports = async ({ page, context }) => {
  const { email, password } = context;

  // 1) Go to site (adjust URL if needed)
  await page.goto("https://app.amilia.com", { waitUntil: "domcontentloaded", timeout: 60000 });

  // 2) Click login / sign in (best-effort)
  // These selectors are intentionally broad; update if Amilia DOM differs.
  const tryClick = async (sel) => {
    const el = await page.$(sel);
    if (el) { await el.click(); return true; }
    return false;
  };

  // Common patterns
  await tryClick('a[href*="login"]');
  await tryClick('button:has-text("Sign in")');
  await tryClick('button:has-text("Log in")');

  // 3) Fill email/password (best-effort)
  // Try common input types/names
  const emailSel = 'input[type="email"], input[name*="email"], input[id*="email"]';
  const passSel  = 'input[type="password"], input[name*="pass"], input[id*="pass"]';

  await page.waitForSelector(emailSel, { timeout: 30000 });
  await page.type(emailSel, email, { delay: 10 });

  await page.waitForSelector(passSel, { timeout: 30000 });
  await page.type(passSel, password, { delay: 10 });

  // Submit
  await tryClick('button[type="submit"]');
  await tryClick('button:has-text("Sign in")');
  await tryClick('button:has-text("Log in")');

  // Give time for login to complete
  await page.waitForTimeout(3000);

  const cookies = await page.cookies();
  return { ok: true, cookiesCount: cookies.length, cookies };
};
`;

  try {
    const result = await withRetry(
      async (attemptNo) => {
        const r = await callBrowserlessFunction({
          code,
          context: { email: AMILIA_EMAIL, password: AMILIA_PASSWORD },
          timeoutMs: PER_ATTEMPT_TIMEOUT_MS
        });

        if (r.httpStatus >= 200 && r.httpStatus < 300 && r.body && r.body.ok && Array.isArray(r.body.cookies)) {
          return r;
        }

        const err = new Error(`Browserless warmup failed (http ${r.httpStatus})`);
        err.details = r.body;
        throw err;
      },
      { attempts: MAX_ATTEMPTS, perAttemptTimeoutMs: PER_ATTEMPT_TIMEOUT_MS }
    );

    // Cache cookies
    cachedCookies = result.body.cookies;
    cachedCookiesAt = now();

    return ok200(res, {
      ok: true,
      status: "WARMUP_OK",
      tookMs: now() - started,
      cookieCache: { cookiesCount: cachedCookies.length }
    });
  } catch (e) {
    console.log("BROWSERLESS_FINAL_FAIL", JSON.stringify({ message: e.message, status: 408 }));
    return ok200(res, {
      ok: false,
      status: "BROWSERLESS_HTTP_ERROR",
      httpStatus: 408,
      error: e.message,
      tookMs: now() - started
    });
  }
});

/**
 * BOOK endpoint
 * NOTE: This is a scaffold. You can paste your existing booking logic where indicated.
 * It includes cachedCookies so you can reuse the warmup login.
 */
app.post("/book", async (req, res) => {
  if (!isAuthOk(req)) {
    return ok200(res, { ok: false, status: "UNAUTHORIZED", error: "Unauthorized (invalid x-api-key)" });
  }
  if (!BROWSERLESS_TOKEN) {
    return ok200(res, { ok: false, status: "CONFIG_ERROR", error: "Missing BROWSERLESS_TOKEN" });
  }

  const started = now();

  // Merge defaults + body overrides
  const rule = {
    targetDay: req.body?.targetDay ?? process.env.TARGET_DAY ?? "Wednesday",
    eveningStart: req.body?.eveningStart ?? process.env.EVENING_START ?? "17:00",
    eveningEnd: req.body?.eveningEnd ?? process.env.EVENING_END ?? "21:00",
    timeZone: req.body?.timeZone ?? process.env.LOCAL_TZ ?? "America/Toronto",
    activityUrl: req.body?.activityUrl ?? process.env.ACTIVITY_URL,
    dryRun: !!(req.body?.dryRun ?? false),
    pollSeconds: parseInt(req.body?.pollSeconds ?? process.env.POLL_SECONDS ?? "420", 10),
    pollIntervalMs: parseInt(req.body?.pollIntervalMs ?? process.env.POLL_INTERVAL_MS ?? "3000", 10),
    playerName: req.body?.playerName ?? process.env.PLAYER_NAME ?? "Hari Prashanth Vaidyula",
    addressFull: req.body?.addressFull ?? process.env.ADDRESS_FULL ?? "383 rue des maraichers, quebec, qc, G1C 0K2"
  };

  console.log("BOOK_START", JSON.stringify({ rule }));

  // If you want booking to reuse warmup cookies:
  const cookiesToUse =
    cachedCookies && (now() - cachedCookiesAt) < 2 * 60 * 60 * 1000
      ? cachedCookies
      : null;

  // >>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>
  // TODO: Replace this function code with your existing booking code.
  // This placeholder just proves Browserless runs and returns quickly.
  // >>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>
  const code = `
module.exports = async ({ page, context }) => {
  const { activityUrl, dryRun, cookies } = context;

  // Restore cookies if provided
  if (Array.isArray(cookies) && cookies.length) {
    for (const c of cookies) {
      try { await page.setCookie(c); } catch (e) {}
    }
  }

  if (activityUrl) {
    await page.goto(activityUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
  }

  // If dryRun, exit fast
  return {
    ok: true,
    dryRun: !!dryRun,
    note: "Replace this placeholder with real booking flow"
  };
};
`;

  try {
    const r = await callBrowserlessFunction({
      code,
      context: { ...rule, cookies: cookiesToUse },
      timeoutMs: Math.min(OVERALL_TIMEOUT_MS, 9 * 60 * 1000)
    });

    // Always return 200 to Scheduler; encode outcome in JSON
    if (r.httpStatus >= 200 && r.httpStatus < 300) {
      return ok200(res, {
        ok: true,
        status: "BROWSERLESS_OK",
        rule,
        result: r.body,
        tookMs: now() - started
      });
    }

    return ok200(res, {
      ok: false,
      status: "BROWSERLESS_HTTP_ERROR",
      httpStatus: r.httpStatus,
      rule,
      browserless: { raw: r.body },
      tookMs: now() - started
    });
  } catch (e) {
    console.log("BROWSERLESS_FINAL_FAIL", JSON.stringify({ message: e.message, status: 408 }));
    return ok200(res, {
      ok: false,
      status: "BROWSERLESS_HTTP_ERROR",
      httpStatus: 408,
      rule,
      error: e.message,
      tookMs: now() - started
    });
  }
});

app.listen(PORT, () => {
  console.log(`Listening on ${PORT}`);
});
