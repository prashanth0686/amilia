/**
 * index.js — Cloud Run (Express) endpoint for Cloud Scheduler
 *
 * Goals:
 * 1) Cloud Scheduler NEVER fails due to your app logic: always return HTTP 200 with JSON.
 * 2) dryRun is FAST (skips Browserless entirely).
 * 3) Browserless timeouts (408), rate limits (429), and 5xx are retryable.
 * 4) Optional “warmup/login before 8am” flow using Firestore session storage.
 *
 * Required ENV (already in your screenshots):
 * - API_KEY                      (your internal x-api-key)
 * - BROWSERLESS_TOKEN
 * - BROWSERLESS_HTTP_BASE        (e.g. https://production-sfo.browserless.io)
 * - AMILIA_EMAIL
 * - AMILIA_PASSWORD
 * - LOCAL_TZ                     (e.g. America/Toronto)
 * - ACTIVITY_URL                 (full activity URL you want)
 *
 * Recommended ENV:
 * - BROWSERLESS_OVERALL_TIMEOUT_MS=540000
 * - BROWSERLESS_PER_ATTEMPT_TIMEOUT_MS=180000   (3 min recommended)
 * - BROWSERLESS_MAX_ATTEMPTS=3
 * - SESSION_STORE=firestore
 * - FIRESTORE_SESSION_DOC=amilia/session        (collection/doc)
 *
 * NOTE:
 * - This file DOES NOT contain your actual booking selectors (site can change).
 * - It gives you a stable framework + where to plug the booking steps.
 */

"use strict";

const express = require("express");

const app = express();
app.use(express.json({ limit: "1mb" }));

/** ---------- Config helpers ---------- */
const PORT = process.env.PORT || 8080;

function envInt(name, def) {
  const v = process.env[name];
  if (v === undefined || v === "") return def;
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}

const CONFIG = {
  apiKey: process.env.API_KEY || "",
  browserless: {
    token: process.env.BROWSERLESS_TOKEN || "",
    httpBase: process.env.BROWSERLESS_HTTP_BASE || "https://production-sfo.browserless.io",
    overallTimeoutMs: envInt("BROWSERLESS_OVERALL_TIMEOUT_MS", 540000),
    perAttemptTimeoutMs: envInt("BROWSERLESS_PER_ATTEMPT_TIMEOUT_MS", 180000),
    maxAttempts: envInt("BROWSERLESS_MAX_ATTEMPTS", 3),
  },
  amilia: {
    email: process.env.AMILIA_EMAIL || "",
    password: process.env.AMILIA_PASSWORD || "",
  },
  defaults: {
    localTz: process.env.LOCAL_TZ || "America/Toronto",
    activityUrl: process.env.ACTIVITY_URL || "",
    targetDay: process.env.TARGET_DAY || "Wednesday",
    eveningStart: process.env.EVENING_START || "13:00",
    eveningEnd: process.env.EVENING_END || "20:00",
  },
  sessionStore: process.env.SESSION_STORE || "memory", // "firestore" recommended
  firestoreDoc: process.env.FIRESTORE_SESSION_DOC || "amilia/session",
};

/** ---------- Optional Firestore session storage ---------- */
let firestore = null;
async function getFirestore() {
  if (CONFIG.sessionStore !== "firestore") return null;
  if (firestore) return firestore;
  // Lazy-load to avoid crashing if you didn't install it.
  const { Firestore } = require("@google-cloud/firestore");
  firestore = new Firestore();
  return firestore;
}

async function saveSession(sessionObj) {
  if (CONFIG.sessionStore !== "firestore") {
    inMemorySession = sessionObj;
    return { store: "memory" };
  }
  const fs = await getFirestore();
  const [col, doc] = CONFIG.firestoreDoc.split("/");
  await fs.collection(col).doc(doc).set(
    {
      updatedAt: new Date().toISOString(),
      session: sessionObj,
    },
    { merge: true }
  );
  return { store: "firestore", doc: CONFIG.firestoreDoc };
}

async function loadSession() {
  if (CONFIG.sessionStore !== "firestore") return inMemorySession || null;
  const fs = await getFirestore();
  const [col, doc] = CONFIG.firestoreDoc.split("/");
  const snap = await fs.collection(col).doc(doc).get();
  if (!snap.exists) return null;
  const data = snap.data();
  return data?.session || null;
}

let inMemorySession = null; // fallback only

/** ---------- Auth middleware (x-api-key) ---------- */
function requireApiKey(req, res, next) {
  // Allow health checks without key:
  if (req.path === "/" || req.path === "/health") return next();

  const key = req.header("x-api-key") || req.header("X-Api-Key") || "";
  if (!CONFIG.apiKey) {
    // If you forgot to set API_KEY, fail safely but still return 200 (Scheduler should not fail).
    return res.status(200).json({
      ok: false,
      status: "MISCONFIGURED",
      error: "API_KEY env is not set",
    });
  }
  if (key !== CONFIG.apiKey) {
    return res.status(200).json({
      ok: false,
      status: "UNAUTHORIZED",
      error: "Unauthorized (invalid x-api-key)",
    });
  }
  next();
}
app.use(requireApiKey);

/** ---------- Stable response wrapper ----------
 * Always return HTTP 200 to Scheduler, even if booking fails.
 */
function ok200(res, payload) {
  return res.status(200).json(payload);
}

function normalizeRule(body) {
  const rule = {
    targetDay: body?.targetDay ?? CONFIG.defaults.targetDay,
    eveningStart: body?.eveningStart ?? CONFIG.defaults.eveningStart,
    eveningEnd: body?.eveningEnd ?? CONFIG.defaults.eveningEnd,
    timeZone: body?.timeZone ?? CONFIG.defaults.localTz,
    activityUrl: body?.activityUrl ?? CONFIG.defaults.activityUrl,
    dryRun: Boolean(body?.dryRun ?? false),
    pollSeconds: envInt("POLL_SECONDS", body?.pollSeconds ?? 420),
    pollIntervalMs: envInt("POLL_INTERVAL_MS", body?.pollIntervalMs ?? 3000),

    // Your extra steps:
    playerName: body?.playerName ?? "Hari Prashanth Vaidyula",
    addressFull: body?.addressFull ?? "383 rue des maraichers, quebec, qc, G1C 0K2",
  };

  // Basic sanity:
  if (!rule.activityUrl) {
    rule._warning = "ACTIVITY_URL not set (or activityUrl not provided in request)";
  }
  return rule;
}

/** ---------- Retryable HTTP helper ----------
 * Retries on 408/429/5xx and network errors.
 */
async function sleep(ms) {
  await new Promise((r) => setTimeout(r, ms));
}

function shouldRetryStatus(status) {
  if (!status) return true; // network/unknown
  if (status === 408) return true;
  if (status === 429) return true;
  if (status >= 500 && status <= 599) return true;
  return false;
}

/** ---------- Browserless call ----------
 * We use Browserless /function endpoint so we can run Node code server-side.
 * IMPORTANT: You must keep your function code small and deterministic.
 *
 * If you already had a working Browserless integration before, you can replace
 * browserlessFunctionSource() with your existing one.
 */
function browserlessUrl() {
  // Browserless function endpoint:
  // https://<host>/function?token=<TOKEN>
  const base = CONFIG.browserless.httpBase.replace(/\/+$/, "");
  return `${base}/function?token=${encodeURIComponent(CONFIG.browserless.token)}`;
}

function browserlessFunctionSource() {
  // This runs inside Browserless. You can (and should) replace selectors here
  // with your known-working logic. This is a stub framework.
  //
  // It returns JSON string; Browserless will return that as the response body.
  //
  // Key idea:
  // - Use the session (cookies/localStorage) if provided
  // - If not, login and then return session so Cloud Run can store it (warmup)
  // - During booking run, reuse session to avoid slow login at 8am
  return `
module.exports = async ({ page, context, request }) => {
  const input = (request && request.body) || {};
  const mode = input.mode || "book"; // "warmup" or "book"
  const rule = input.rule || {};
  const session = input.session || null;

  const AMILIA_EMAIL = input.amiliaEmail;
  const AMILIA_PASSWORD = input.amiliaPassword;

  // Helper: apply cookies
  async function applySession(sess) {
    if (!sess) return;
    try {
      if (Array.isArray(sess.cookies)) {
        await context.addCookies(sess.cookies);
      }
    } catch (e) {}
  }

  // Helper: extract cookies
  async function extractSession() {
    try {
      const cookies = await context.cookies();
      return { cookies };
    } catch (e) {
      return null;
    }
  }

  // ---- Apply existing session (if any) ----
  await applySession(session);

  // ---- Go to site ----
  const url = rule.activityUrl;
  if (!url) {
    return JSON.stringify({ ok:false, status:"NO_ACTIVITY_URL" });
  }

  // Faster defaults
  await page.setViewport({ width: 1280, height: 800 });
  page.setDefaultTimeout(45000);
  page.setDefaultNavigationTimeout(45000);

  // ---- Login flow (stub) ----
  // You MUST update these selectors based on the actual Amilia login UI.
  async function ensureLoggedIn() {
    // Navigate:
    await page.goto(url, { waitUntil: "domcontentloaded" });

    // Heuristic: if login button exists, login; otherwise assume logged in.
    const loginButton = await page.$('a[href*="login"], button:has-text("Login"), button:has-text("Sign in")');
    if (!loginButton) return { didLogin:false };

    // Click login:
    await loginButton.click().catch(()=>{});
    await page.waitForTimeout(1000);

    // Fill credentials (replace selectors):
    const emailSel = 'input[type="email"], input[name="email"]';
    const passSel = 'input[type="password"], input[name="password"]';

    await page.waitForSelector(emailSel, { timeout: 15000 });
    await page.fill(emailSel, AMILIA_EMAIL);
    await page.fill(passSel, AMILIA_PASSWORD);

    // Submit:
    const submit = await page.$('button[type="submit"], button:has-text("Sign in"), button:has-text("Login")');
    if (submit) await submit.click();

    // Wait a bit for redirect/session:
    await page.waitForTimeout(4000);

    return { didLogin:true };
  }

  // If we’re warmup, login + return session
  if (mode === "warmup") {
    const loginRes = await ensureLoggedIn();
    const newSession = await extractSession();
    return JSON.stringify({ ok:true, status:"WARMUP_OK", loginRes, session:newSession });
  }

  // Booking run: make sure logged in too (in case cookies expired)
  const loginRes = await ensureLoggedIn();

  // ---- Booking steps (stub placeholders) ----
  // You asked:
  // 1) Click register exactly when open (8am)
  // 2) Select player checkbox: "Hari Prashanth Vaidyula"
  // 3) Address search: "383 rue des maraichers, quebec, qc, G1C 0K2" and pick suggestion
  //
  // Replace the selectors below with the real ones from the page.
  const playerName = rule.playerName || "";
  const addressFull = rule.addressFull || "";

  // TODO: implement real detection for "registrations open"
  // For now just return success stub to show flow.
  const finalSession = await extractSession();

  return JSON.stringify({
    ok: true,
    status: "BROWSERLESS_OK",
    note: "Stub booking flow ran. Replace selectors in browserlessFunctionSource() to actually book.",
    loginRes,
    playerName,
    addressFull,
    session: finalSession
  });
};
`.trim();
}

async function callBrowserless({ mode, rule, session }) {
  const url = browserlessUrl();
  const source = browserlessFunctionSource();

  const payload = {
    code: source,
    context: { stealth: true },
    // Browserless gives request.body to function as `request.body`
    // (function runner passes the JSON body you send as request.body).
    // We'll put our runtime inputs under request.body:
    // NOTE: Some Browserless deployments accept `payload` as request.body directly.
    // If your Browserless expects a different format, adapt here.
    // We use a common pattern: send inputs as top-level keys too.
    mode,
    rule,
    session,
    amiliaEmail: CONFIG.amilia.email,
    amiliaPassword: CONFIG.amilia.password,
  };

  // Node 18+ has global fetch on Cloud Run.
  const resp = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      // Browserless "function" expects { code, context, ... } as body
      // and then passes the whole body into request.body in many setups.
      // To be safe, we include everything here.
      ...payload,
      // Also duplicate as requestBody-style field that some templates use:
      data: payload,
    }),
    signal: AbortSignal.timeout(CONFIG.browserless.perAttemptTimeoutMs),
  });

  const text = await resp.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch (e) {
    json = { raw: text };
  }
  return { httpStatus: resp.status, body: json };
}

async function browserlessWithRetry({ mode, rule, session }) {
  const started = Date.now();
  const attempts = Math.max(1, CONFIG.browserless.maxAttempts);

  let last = null;
  for (let i = 1; i <= attempts; i++) {
    const elapsed = Date.now() - started;
    if (elapsed >= CONFIG.browserless.overallTimeoutMs) {
      return {
        ok: false,
        status: "BROWSERLESS_OVERALL_TIMEOUT",
        retry: { attempts: i - 1, maxAttempts: attempts, elapsedMs: elapsed },
        last,
      };
    }

    try {
      const out = await callBrowserless({ mode, rule, session });
      last = out;

      if (out.httpStatus >= 200 && out.httpStatus < 300) {
        // Browserless responded 2xx. Decide if this is "success" logically:
        if (out.body?.ok === false && out.body?.status) {
          // Logical failure inside 2xx response -> still "ok" for Scheduler, but booking failed.
          // Whether to retry depends on inner status.
          const inner = String(out.body.status || "");
          const retryableInner = inner.includes("TIMEOUT") || inner.includes("429") || inner.includes("5XX");
          if (retryableInner && i < attempts) {
            await sleep(Math.min(2000 * i, 8000));
            continue;
          }
        }
        return {
          ok: true,
          status: "BROWSERLESS_OK",
          httpStatus: out.httpStatus,
          body: out.body,
          retry: { attempts: i, maxAttempts: attempts, elapsedMs: Date.now() - started },
        };
      }

      // Non-2xx:
      if (shouldRetryStatus(out.httpStatus) && i < attempts) {
        await sleep(Math.min(2000 * i, 8000));
        continue;
      }

      return {
        ok: false,
        status: "BROWSERLESS_HTTP_ERROR",
        httpStatus: out.httpStatus,
        body: out.body,
        retry: { attempts: i, maxAttempts: attempts, elapsedMs: Date.now() - started },
      };
    } catch (err) {
      const msg = err?.name || err?.message || String(err);
      last = { error: msg };

      // AbortSignal.timeout throws TimeoutError in many environments; treat retryable:
      const retryable = true;
      if (retryable && i < attempts) {
        await sleep(Math.min(2000 * i, 8000));
        continue;
      }

      return {
        ok: false,
        status: "BROWSERLESS_EXCEPTION",
        error: msg,
        retry: { attempts: i, maxAttempts: attempts, elapsedMs: Date.now() - started },
      };
    }
  }

  return {
    ok: false,
    status: "BROWSERLESS_FINAL_FAIL",
    last,
  };
}

/** ---------- Routes ---------- */
app.get("/", (req, res) => ok200(res, { ok: true, status: "OK", service: "amilia-booker" }));
app.get("/health", (req, res) => ok200(res, { ok: true, status: "HEALTHY" }));

/**
 * POST /book
 * Scheduler should call this.
 * Always returns HTTP 200 JSON.
 */
app.post("/book", async (req, res) => {
  const rule = normalizeRule(req.body || {});
  console.log("BOOK_START", JSON.stringify({ rule }));

  // DRY RUN MUST BE FAST:
  if (rule.dryRun) {
    return ok200(res, {
      ok: true,
      status: "DRY_RUN_OK",
      rule,
      note: "Dry run: skipping Browserless + booking.",
    });
  }

  // Load session if available (warmup saved it)
  const session = await loadSession();

  const out = await browserlessWithRetry({ mode: "book", rule, session });

  // If Browserless returned an updated session, store it (keeps cookies fresh)
  const returnedSession = out?.body?.session;
  if (returnedSession) {
    await saveSession(returnedSession);
  }

  // IMPORTANT: Always HTTP 200 for Scheduler stability:
  return ok200(res, {
    ok: out.ok,
    status: out.status,
    rule,
    browserless: {
      httpStatus: out.httpStatus,
      body: out.body,
    },
    retry: out.retry,
  });
});

/**
 * POST /warmup
 * Run at 7:55am to login + store session.
 * Always returns HTTP 200 JSON.
 */
app.post("/warmup", async (req, res) => {
  const rule = normalizeRule(req.body || {});
  console.log("WARMUP_START", JSON.stringify({ rule }));

  // Warmup should not do full booking; it logs in and stores session.
  const existing = await loadSession();
  const out = await browserlessWithRetry({ mode: "warmup", rule, session: existing });

  const returnedSession = out?.body?.session;
  let saved = null;
  if (returnedSession) {
    saved = await saveSession(returnedSession);
  }

  return ok200(res, {
    ok: out.ok,
    status: out.status,
    rule,
    saved,
    browserless: {
      httpStatus: out.httpStatus,
      body: out.body,
    },
    retry: out.retry,
  });
});

/** ---------- Start server ---------- */
app.listen(PORT, () => {
  console.log(`Listening on port ${PORT}`);
});
