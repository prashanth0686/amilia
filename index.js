/**
 * index.js — Cloud Run entrypoint for amilia-booker
 *
 * ✅ Includes REQUIRED health endpoint: GET /health -> 200 "ok"
 * ✅ Uses PORT from Cloud Run (default 8080)
 * ✅ Protects /book with x-api-key (or Authorization: Bearer <API_KEY>)
 * ✅ Implements retry + timeouts for Browserless calls
 *
 * Note: The Browserless “booking” part is written as a safe, generic wrapper.
 * You can drop your real puppeteer/function payload into `runBrowserlessJob()`.
 */

"use strict";

const express = require("express");

const app = express();
app.use(express.json({ limit: "1mb" }));

// -------------------------
// Config (env)
// -------------------------
const PORT = parseInt(process.env.PORT || "8080", 10);

const API_KEY = process.env.API_KEY || ""; // required to call /book
const BROWSERLESS_HTTP_BASE = process.env.BROWSERLESS_HTTP_BASE || "https://production-sfo.browserless.io";
const BROWSERLESS_TOKEN = process.env.BROWSERLESS_TOKEN || "";

const TARGET_DAY = process.env.TARGET_DAY || "Wednesday";
const EVENING_START = process.env.EVENING_START || "17:00";
const EVENING_END = process.env.EVENING_END || "21:00";
const LOCAL_TZ = process.env.LOCAL_TZ || "America/Toronto";
const ACTIVITY_URL = process.env.ACTIVITY_URL || "";

const PLAYER_NAME = process.env.PLAYER_NAME || "";
const ADDRESS_FULL = process.env.ADDRESS_FULL || "";

const BROWSERLESS_OVERALL_TIMEOUT_MS = parseInt(process.env.BROWSERLESS_OVERALL_TIMEOUT_MS || "540000", 10);
const BROWSERLESS_PER_ATTEMPT_TIMEOUT_MS = parseInt(process.env.BROWSERLESS_PER_ATTEMPT_TIMEOUT_MS || "180000", 10);
const BROWSERLESS_MAX_ATTEMPTS = parseInt(process.env.BROWSERLESS_MAX_ATTEMPTS || "3", 10);

// Optional app-level run timeout guard (Cloud Run request timeout is configured separately)
const BOOK_HANDLER_TIMEOUT_MS = Math.min(BROWSERLESS_OVERALL_TIMEOUT_MS + 30000, 870000); // keep below 900s

// -------------------------
// Helpers
// -------------------------
function nowIso() {
  return new Date().toISOString();
}

function logJson(tag, obj) {
  // Cloud Run logs pick this up neatly
  console.log(`${tag} ${JSON.stringify(obj)}`);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function withTimeout(promise, ms, timeoutMessage = "Request timed out") {
  let t;
  const timeout = new Promise((_, reject) => {
    t = setTimeout(() => reject(Object.assign(new Error(timeoutMessage), { code: "ETIMEDOUT" })), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(t));
}

// Accept either header: x-api-key: <key> OR Authorization: Bearer <key>
function requireApiKey(req, res, next) {
  if (!API_KEY) {
    return res.status(500).json({ ok: false, error: "Server misconfigured: API_KEY not set" });
  }

  const headerKey = req.header("x-api-key");
  const auth = req.header("authorization") || "";
  const bearer = auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : "";

  const provided = headerKey || bearer;

  if (!provided || provided !== API_KEY) {
    return res.status(401).json({ ok: false, status: "UNAUTHORIZED", error: "Unauthorized (invalid api key)" });
  }
  next();
}

function normalizeRule(input = {}) {
  return {
    targetDay: input.targetDay || TARGET_DAY,
    eveningStart: input.eveningStart || EVENING_START,
    eveningEnd: input.eveningEnd || EVENING_END,
    timeZone: input.timeZone || LOCAL_TZ,
    activityUrl: input.activityUrl || ACTIVITY_URL,
    dryRun: typeof input.dryRun === "boolean" ? input.dryRun : true,
    pollSeconds: typeof input.pollSeconds === "number" ? input.pollSeconds : 60,
    pollIntervalMs: typeof input.pollIntervalMs === "number" ? input.pollIntervalMs : 3000,
    playerName: input.playerName || PLAYER_NAME,
    addressFull: input.addressFull || ADDRESS_FULL,
    // Optional override knobs per request (fallback to env)
    retry: input.retry || {
      attempts: BROWSERLESS_MAX_ATTEMPTS,
      perAttemptTimeoutMs: BROWSERLESS_PER_ATTEMPT_TIMEOUT_MS,
      overallTimeoutMs: BROWSERLESS_OVERALL_TIMEOUT_MS,
      backoffMs: 1500
    }
  };
}

function browserlessUrl(path) {
  const base = BROWSERLESS_HTTP_BASE.replace(/\/+$/, "");
  const p = path.startsWith("/") ? path : `/${path}`;
  // browserless expects ?token=...
  const token = encodeURIComponent(BROWSERLESS_TOKEN || "");
  return `${base}${p}?token=${token}`;
}

/**
 * Browserless wrapper.
 * This uses Browserless `/function` which runs a puppeteer script remotely.
 * Replace `code` with your actual script (or keep your own integration).
 */
async function runBrowserlessJob(rule) {
  if (!BROWSERLESS_TOKEN) {
    return {
      ok: false,
      status: "BROWSERLESS_CONFIG_ERROR",
      httpStatus: 500,
      error: "BROWSERLESS_TOKEN not set"
    };
  }
  if (!rule.activityUrl) {
    return {
      ok: false,
      status: "VALIDATION_ERROR",
      httpStatus: 400,
      error: "ACTIVITY_URL not set (env) and activityUrl not provided"
    };
  }

  // Minimal function example: just opens the URL and returns the page title.
  // Replace this code with your real booking flow.
  const code = `
    module.exports = async ({ page, context }) => {
      await page.goto(context.activityUrl, { waitUntil: "domcontentloaded", timeout: 120000 });
      const title = await page.title();
      return { title, activityUrl: context.activityUrl, dryRun: context.dryRun };
    };
  `;

  const payload = {
    code,
    context: {
      activityUrl: rule.activityUrl,
      dryRun: rule.dryRun,
      targetDay: rule.targetDay,
      eveningStart: rule.eveningStart,
      eveningEnd: rule.eveningEnd,
      timeZone: rule.timeZone,
      playerName: rule.playerName,
      addressFull: rule.addressFull
    }
  };

  const url = browserlessUrl("/function");
  const resp = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload)
  });

  const text = await resp.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    // leave as null
  }

  if (!resp.ok) {
    return {
      ok: false,
      status: "BROWSERLESS_HTTP_ERROR",
      httpStatus: resp.status,
      browserless: { raw: text, json }
    };
  }

  return {
    ok: true,
    status: "BROWSERLESS_OK",
    httpStatus: resp.status,
    result: json ?? { raw: text }
  };
}

/**
 * Retry helper with per-attempt timeout + overall timeout.
 */
async function fetchWithRetryOverall(fn, { attempts, perAttemptTimeoutMs, overallTimeoutMs, backoffMs }) {
  const started = Date.now();
  let lastErr = null;

  for (let i = 1; i <= attempts; i++) {
    const elapsed = Date.now() - started;
    const remaining = overallTimeoutMs - elapsed;

    if (remaining <= 0) {
      const e = new Error("Overall timeout exceeded");
      e.httpStatus = 408;
      e.status = 408;
      throw e;
    }

    const attemptTimeout = Math.min(perAttemptTimeoutMs, remaining);

    try {
      return await withTimeout(fn(), attemptTimeout, "Per-attempt timeout");
    } catch (err) {
      lastErr = err;

      // Small backoff, but don't waste remaining time
      const backoff = Math.min(backoffMs || 1500, Math.max(0, overallTimeoutMs - (Date.now() - started) - 50));
      if (i < attempts && backoff > 0) {
        await sleep(backoff);
      }
    }
  }

  throw lastErr || new Error("fetchWithRetry failed");
}

// -------------------------
// REQUIRED: health endpoints
// -------------------------
app.get("/health", (req, res) => {
  res.status(200).send("ok");
});

// Optional (nice for humans)
app.get("/", (req, res) => {
  res.status(200).send("amilia-booker alive");
});

// -------------------------
// Main booking endpoint
// -------------------------
app.post("/book", requireApiKey, async (req, res) => {
  const rule = normalizeRule(req.body || {});
  logJson("BOOK_START", { at: nowIso(), rule: { ...rule, retry: undefined } });

  // Guard entire handler time
  try {
    const result = await withTimeout(
      (async () => {
        // If dryRun: we still call Browserless by default, because it validates connectivity.
        // If you want dryRun to skip Browserless completely, return here instead.
        // return { ok: true, status: "DRY_RUN", rule };

        const retryCfg = rule.retry || {
          attempts: BROWSERLESS_MAX_ATTEMPTS,
          perAttemptTimeoutMs: BROWSERLESS_PER_ATTEMPT_TIMEOUT_MS,
          overallTimeoutMs: BROWSERLESS_OVERALL_TIMEOUT_MS,
          backoffMs: 1500
        };

        const browserlessResponse = await fetchWithRetryOverall(
          () => runBrowserlessJob(rule),
          retryCfg
        );

        return {
          ok: browserlessResponse.ok === true,
          status: browserlessResponse.ok ? "OK" : browserlessResponse.status,
          httpStatus: browserlessResponse.httpStatus,
          rule,
          browserless: browserlessResponse
        };
      })(),
      BOOK_HANDLER_TIMEOUT_MS,
      "Book handler timed out"
    );

    // Always 200 for app-level result; caller can inspect ok/status/httpStatus.
    // If you prefer non-200 on failure, change below.
    res.status(200).json(result);

    if (!result.ok) {
      logJson("BROWSERLESS_FINAL_FAIL", {
        message: "fetchWithRetry failed after attempt(s)",
        status: result.httpStatus || 500
      });
    } else {
      logJson("BOOK_DONE", { at: nowIso(), ok: true });
    }
  } catch (err) {
    const status = err?.httpStatus || err?.status || (err?.code === "ETIMEDOUT" ? 408 : 500);
    logJson("BROWSERLESS_FINAL_FAIL", { message: err?.message || "Unknown error", status });

    res.status(200).json({
      ok: false,
      status: "BROWSERLESS_FINAL_FAIL",
      httpStatus: status,
      error: err?.message || String(err),
      rule
    });
  }
});

// -------------------------
// Start server
// -------------------------
app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
