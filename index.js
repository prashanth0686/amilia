'use strict';

const express = require('express');
const puppeteer = require('puppeteer-core');

const app = express();
app.use(express.json());

/**
 * -----------------------------
 * Env parsing (NO silent defaults)
 * -----------------------------
 */
function intEnv(name, def) {
  const raw = process.env[name];
  if (raw === undefined || raw === null || raw === '') return def;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : def;
}

function strEnv(name, def = '') {
  const v = process.env[name];
  return (v === undefined || v === null) ? def : String(v);
}

const PORT = intEnv('PORT', 8080);

// Browserless
const BROWSERLESS_TOKEN = strEnv('BROWSERLESS_TOKEN');
const BROWSERLESS_HTTP_BASE = strEnv('BROWSERLESS_HTTP_BASE', 'https://production-sfo.browserless.io');

// Retries + timeouts
const MAX_ATTEMPTS = intEnv('BROWSERLESS_MAX_ATTEMPTS', 3);
const PER_ATTEMPT_TIMEOUT_MS = intEnv('BROWSERLESS_PER_ATTEMPT_TIMEOUT_MS', 180000);
const OVERALL_TIMEOUT_MS = intEnv('BROWSERLESS_OVERALL_TIMEOUT_MS', 540000);

// Optional: your booking inputs (kept for compatibility)
const TARGET_DAY = strEnv('TARGET_DAY', 'Wednesday');
const EVENING_START = strEnv('EVENING_START', '17:00');
const EVENING_END = strEnv('EVENING_END', '21:00');
const LOCAL_TZ = strEnv('LOCAL_TZ', 'America/Toronto');
const ACTIVITY_URL = strEnv('ACTIVITY_URL');

// Credentials (already in your YAML)
const AMILIA_EMAIL = strEnv('AMILIA_EMAIL');
const AMILIA_PASSWORD = strEnv('AMILIA_PASSWORD');

console.log('BOOT_CONFIG', {
  PORT,
  BROWSERLESS_HTTP_BASE,
  tokenPresent: Boolean(BROWSERLESS_TOKEN),
  MAX_ATTEMPTS,
  PER_ATTEMPT_TIMEOUT_MS,
  OVERALL_TIMEOUT_MS,
  TARGET_DAY,
  EVENING_START,
  EVENING_END,
  LOCAL_TZ,
  activityUrlPresent: Boolean(ACTIVITY_URL),
  amiliaEmailPresent: Boolean(AMILIA_EMAIL),
  amiliaPasswordPresent: Boolean(AMILIA_PASSWORD),
});

/**
 * -----------------------------
 * Utilities
 * -----------------------------
 */
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function nowIso() {
  return new Date().toISOString();
}

// Build Browserless websocket endpoint.
// Browserless commonly supports: wss://<host>?token=<token>
function browserlessWSEndpoint() {
  if (!BROWSERLESS_TOKEN) {
    throw new Error('Missing BROWSERLESS_TOKEN env var');
  }
  const base = BROWSERLESS_HTTP_BASE.replace(/^http/, 'ws').replace(/\/+$/, '');
  return `${base}?token=${encodeURIComponent(BROWSERLESS_TOKEN)}`;
}

async function withTimeout(promise, timeoutMs, label) {
  let t;
  const timeout = new Promise((_, reject) => {
    t = setTimeout(() => reject(new Error(`TIMEOUT(${label}) after ${timeoutMs}ms`)), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(t);
  }
}

async function runWithRetry(fn, { attempts, backoffMs = 1000, label = 'op' }) {
  let lastErr;
  for (let i = 1; i <= attempts; i++) {
    try {
      return await fn(i);
    } catch (e) {
      lastErr = e;
      console.log('RETRY_FAIL', { label, attempt: i, attempts, message: e?.message });
      if (i < attempts) await sleep(backoffMs * i);
    }
  }
  throw lastErr;
}

/**
 * -----------------------------
 * Browser session helpers
 * -----------------------------
 */
async function connectBrowserless() {
  const ws = browserlessWSEndpoint();
  console.log('BROWSERLESS_CONNECT', { ws: ws.replace(BROWSERLESS_TOKEN, '***') });

  // puppeteer.connect can hang if endpoint is slow; wrap it
  return await withTimeout(
    puppeteer.connect({
      browserWSEndpoint: ws,
      // You can add `ignoreHTTPSErrors: true` if needed:
      // ignoreHTTPSErrors: true
    }),
    PER_ATTEMPT_TIMEOUT_MS,
    'puppeteer.connect'
  );
}

/**
 * -----------------------------
 * Core job: booking flow skeleton (safe + observable)
 * -----------------------------
 *
 * This is intentionally implemented as:
 * - Connect to browserless
 * - Navigate to ACTIVITY_URL (if provided)
 * - Return timing + a screenshot step marker
 *
 * You can extend the TODO section with real Amilia DOM steps.
 */
async function doBookingJob({ mode = 'book' } = {}) {
  const startedAt = Date.now();
  const t0 = Date.now();
  const marks = [];
  const mark = (name, extra = {}) => {
    marks.push({ name, ms: Date.now() - t0, ...extra });
    console.log('STEP', { name, ms: Date.now() - t0, ...extra });
  };

  const result = {
    ok: false,
    mode,
    startedAt: nowIso(),
    config: {
      MAX_ATTEMPTS,
      PER_ATTEMPT_TIMEOUT_MS,
      OVERALL_TIMEOUT_MS,
      TARGET_DAY,
      EVENING_START,
      EVENING_END,
      LOCAL_TZ,
      ACTIVITY_URL: ACTIVITY_URL ? 'set' : 'missing',
    },
    marks,
  };

  // Hard overall guard so this never runs forever
  return await withTimeout(
    (async () => {
      await runWithRetry(async (attemptNo) => {
        mark('attempt_start', { attemptNo });

        let browser;
        try {
          browser = await connectBrowserless();
          mark('browser_connected');

          const page = await browser.newPage();
          page.setDefaultTimeout(PER_ATTEMPT_TIMEOUT_MS);
          page.setDefaultNavigationTimeout(PER_ATTEMPT_TIMEOUT_MS);

          // Lightweight warmup path: just open a blank page or activity URL
          if (!ACTIVITY_URL) {
            await page.goto('about:blank');
            mark('goto_about_blank_ok');
          } else {
            // Avoid "networkidle" which can stall on modern apps; use domcontentloaded.
            await page.goto(ACTIVITY_URL, { waitUntil: 'domcontentloaded' });
            mark('activity_page_loaded', { url: ACTIVITY_URL });

            // TODO: Implement actual Amilia flow here.
            // You’ll want explicit waits like:
            // await page.waitForSelector('input[type="email"]', { timeout: 60000 });
            // await page.type('input[type="email"]', AMILIA_EMAIL);
            // ...
            // mark('logged_in');
            //
            // Then navigate to calendar, select slot, click book, confirm.
            // Always add mark() between steps so logs show where it fails.
          }

          // If we got here, connectivity is healthy.
          result.ok = true;
          result.finishedAt = nowIso();
          result.totalMs = Date.now() - startedAt;

          return;
        } catch (e) {
          // Map to 408-style output so it’s obvious in logs
          mark('attempt_error', { attemptNo, message: e?.message });
          throw e;
        } finally {
          try {
            if (browser) {
              await browser.close();
              mark('browser_closed');
            }
          } catch (_) {
            // ignore
          }
        }
      }, { attempts: MAX_ATTEMPTS, backoffMs: 1500, label: `doBookingJob(${mode})` });

      return result;
    })(),
    OVERALL_TIMEOUT_MS,
    `OVERALL_${mode}`
  );
}

/**
 * -----------------------------
 * Routes
 * -----------------------------
 */

// Health MUST exist for your curl check
app.get('/health', (req, res) => {
  res.status(200).json({
    ok: true,
    service: 'amilia-booker',
    time: nowIso(),
    port: PORT,
  });
});

// Optional: quick connectivity test to Browserless
app.get('/warmup', async (req, res) => {
  try {
    const out = await doBookingJob({ mode: 'warmup' });
    res.status(out.ok ? 200 : 500).json(out);
  } catch (e) {
    res.status(500).json({
      ok: false,
      mode: 'warmup',
      error: e?.message || String(e),
      time: nowIso(),
    });
  }
});

// Scheduler should hit this
app.get('/book', async (req, res) => {
  try {
    const out = await doBookingJob({ mode: 'book' });
    res.status(out.ok ? 200 : 500).json(out);
  } catch (e) {
    res.status(500).json({
      ok: false,
      mode: 'book',
      error: e?.message || String(e),
      time: nowIso(),
    });
  }
});

// Root (so hitting service URL doesn’t return 404)
app.get('/', (req, res) => {
  res.status(200).json({
    ok: true,
    message: 'Service is running. Use /health, /warmup, /book',
    time: nowIso(),
  });
});

// Make 404s JSON (helps debugging)
app.use((req, res) => {
  res.status(404).json({ ok: false, error: `Not found: ${req.method} ${req.path}` });
});

// Start server
app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
