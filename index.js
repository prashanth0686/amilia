'use strict';

const express = require('express');

// If you're using Node 18+ (Cloud Run default), global fetch exists.
// If your runtime is older, uncomment the next line:
// const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));

const app = express();
app.use(express.json({ limit: '1mb' }));

/**
 * Helpers
 */
function envStr(name, def = '') {
  const v = process.env[name];
  return (v === undefined || v === null || String(v).trim() === '') ? def : String(v);
}

function envInt(name, def) {
  const raw = process.env[name];
  const v = parseInt(String(raw ?? ''), 10);
  return Number.isFinite(v) && v > 0 ? v : def;
}

function nowIso() {
  return new Date().toISOString();
}

function mask(s) {
  if (!s) return '';
  const str = String(s);
  if (str.length <= 6) return '***';
  return str.slice(0, 3) + '***' + str.slice(-3);
}

/**
 * Config: defaults from env, request body can override when Scheduler sends payload.
 */
function buildRuleFromEnvAndBody(body = {}) {
  const rule = {
    // booking window / calendar
    targetDay: body.targetDay ?? envStr('TARGET_DAY', 'Wednesday'),
    eveningStart: body.eveningStart ?? envStr('EVENING_START', '17:00'),
    eveningEnd: body.eveningEnd ?? envStr('EVENING_END', '21:00'),
    timeZone: body.timeZone ?? envStr('LOCAL_TZ', 'America/Toronto'),
    activityUrl: body.activityUrl ?? envStr('ACTIVITY_URL', ''),

    // behavior
    dryRun: body.dryRun ?? false,
    pollSeconds: Number.isFinite(Number(body.pollSeconds))
      ? Number(body.pollSeconds)
      : envInt('POLL_SECONDS', 420),
    pollIntervalMs: Number.isFinite(Number(body.pollIntervalMs))
      ? Number(body.pollIntervalMs)
      : envInt('POLL_INTERVAL_MS', 3000),

    // booking form details you mentioned
    playerName: body.playerName ?? envStr('PLAYER_NAME', 'Hari Prashanth Vaidyula'),
    addressFull:
      body.addressFull ??
      envStr('ADDRESS_FULL', '383 rue des maraichers, quebec, qc, G1C 0K2'),
  };

  return rule;
}

function buildRetryConfig() {
  // NOTE: defaults matter. You currently set per-attempt=180000, overall=540000, attempts=3
  const retry = {
    maxAttempts: envInt('BROWSERLESS_MAX_ATTEMPTS', 3),
    perAttemptTimeoutMs: envInt('BROWSERLESS_PER_ATTEMPT_TIMEOUT_MS', 180000),
    overallTimeoutMs: envInt('BROWSERLESS_OVERALL_TIMEOUT_MS', 540000),
  };

  return retry;
}

/**
 * Auth: simple x-api-key check.
 * If you use Cloud Scheduler with OIDC/IAM instead, you can remove this.
 */
function requireApiKey(req, res) {
  const expected = envStr('API_KEY', '');
  if (!expected) return true; // if not set, allow (not recommended)
  const got = req.header('x-api-key');
  if (!got || got !== expected) {
    res.status(200).json({
      ok: false,
      status: 'UNAUTHORIZED',
      error: 'Unauthorized (invalid x-api-key)',
    });
    return false;
  }
  return true;
}

/**
 * Browserless call
 * You said you're using Browserless HTTP base: https://production-sfo.browserless.io
 *
 * This implementation uses Browserless "function" endpoint (server-side puppeteer).
 * You MUST ensure your Browserless plan supports it.
 *
 * If you are currently using a different Browserless endpoint in your code,
 * swap this function to match your current approach.
 */
async function callBrowserlessFunction({ script, timeoutMs }) {
  const base = envStr('BROWSERLESS_HTTP_BASE', 'https://production-sfo.browserless.io').replace(/\/+$/, '');
  const token = envStr('BROWSERLESS_TOKEN', '');
  if (!token) {
    return {
      ok: false,
      httpStatus: 500,
      body: { error: 'Missing BROWSERLESS_TOKEN' },
      raw: 'Missing BROWSERLESS_TOKEN',
    };
  }

  // Browserless "function" endpoint:
  // POST {base}/function?token=XYZ
  const url = `${base}/function?token=${encodeURIComponent(token)}`;

  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: script }),
      signal: controller.signal,
    });

    const text = await r.text();
    let parsed = null;
    try { parsed = JSON.parse(text); } catch (_) {}

    return {
      ok: r.ok,
      httpStatus: r.status,
      body: parsed ?? { raw: text },
      raw: text,
    };
  } catch (e) {
    return {
      ok: false,
      httpStatus: 408, // treat abort/timeouts as 408
      body: { error: e?.name || 'Error', message: e?.message || String(e) },
      raw: String(e),
    };
  } finally {
    clearTimeout(t);
  }
}

/**
 * Retry wrapper
 */
async function fetchWithRetry({ runOnce, retry }) {
  const start = Date.now();
  const attempts = [];

  for (let attempt = 1; attempt <= retry.maxAttempts; attempt++) {
    const elapsed = Date.now() - start;
    const remainingOverall = retry.overallTimeoutMs - elapsed;
    const attemptTimeout = Math.min(retry.perAttemptTimeoutMs, Math.max(1, remainingOverall));

    if (remainingOverall <= 0) {
      const msg = `Overall timeout exceeded before attempt ${attempt}`;
      return {
        ok: false,
        status: 'BROWSERLESS_TIMEOUT',
        httpStatus: 408,
        attempts,
        message: msg,
      };
    }

    const t0 = Date.now();
    const result = await runOnce({ attempt, timeoutMs: attemptTimeout });
    const t1 = Date.now();

    attempts.push({
      attempt,
      attemptTimeoutMs: attemptTimeout,
      durationMs: t1 - t0,
      ok: result.ok,
      httpStatus: result.httpStatus,
    });

    if (result.ok) {
      return {
        ok: true,
        status: 'BROWSERLESS_OK',
        httpStatus: 200,
        attempts,
        result,
      };
    }

    // retry only on transient errors
    const retryable = [408, 429, 500, 502, 503, 504].includes(result.httpStatus);
    console.log('BROWSERLESS_ERR', JSON.stringify({
      attempt,
      perAttemptTimeoutMs: attemptTimeout,
      retryable,
      httpStatus: result.httpStatus,
      body: result.body,
    }));

    if (!retryable || attempt === retry.maxAttempts) {
      return {
        ok: false,
        status: 'BROWSERLESS_HTTP_ERROR',
        httpStatus: result.httpStatus || 500,
        attempts,
        result,
        message: `fetchWithRetry failed after ${attempt} attempt(s)`,
      };
    }

    // simple backoff (2s, 4s, 8s ...)
    const backoff = Math.min(8000, 1000 * Math.pow(2, attempt));
    await new Promise(r => setTimeout(r, backoff));
  }

  return {
    ok: false,
    status: 'BROWSERLESS_HTTP_ERROR',
    httpStatus: 500,
    attempts,
    message: 'fetchWithRetry failed unexpectedly',
  };
}

/**
 * Build the puppeteer script that runs inside Browserless.
 * This is where you implement:
 * - login
 * - wait for registrations open at 8am
 * - click register
 * - select player checkbox "Hari Prashanth Vaidyula"
 * - proceed
 * - enter address and select suggestion
 *
 * NOTE: selectors are site-specific and you already have them in your working automation.
 * Replace TODO selectors with your confirmed ones.
 */
function buildBrowserlessScript(rule) {
  // IMPORTANT: keep it minimal to reduce timeouts.
  // Use request interception, disable images/fonts, reduce load.
  // This script returns JSON which Browserless will echo back.
  const email = envStr('AMILIA_EMAIL', '');
  const password = envStr('AMILIA_PASSWORD', '');

  return `
module.exports = async ({ page, context }) => {
  const result = { step: 'start', ok: false };

  // speed up: block heavy assets
  await page.setRequestInterception(true);
  page.on('request', (req) => {
    const type = req.resourceType();
    if (['image','font','media'].includes(type)) return req.abort();
    return req.continue();
  });

  const rule = ${JSON.stringify(rule)};
  const EMAIL = ${JSON.stringify(email)};
  const PASSWORD = ${JSON.stringify(password)};

  // Small helper
  const wait = (ms) => new Promise(r => setTimeout(r, ms));

  try {
    if (!rule.activityUrl) {
      return { ok:false, error:'Missing activityUrl' };
    }

    result.step = 'goto_activity';
    await page.goto(rule.activityUrl, { waitUntil: 'domcontentloaded' });

    // TODO: ensure logged in BEFORE 8am
    // If you have a direct login URL, you can go there first.
    result.step = 'login';
    // Example placeholders:
    // await page.click('button:has-text("Sign in")');
    // await page.type('input[name="email"]', EMAIL, { delay: 20 });
    // await page.type('input[name="password"]', PASSWORD, { delay: 20 });
    // await page.click('button[type="submit"]');
    // await page.waitForNavigation({ waitUntil: 'domcontentloaded' });

    // TODO: navigate to the right day/time window and detect when "Register" becomes available.
    result.step = 'poll_for_register';
    // Minimal dummy polling so the script returns quickly during dryRun
    if (rule.dryRun) {
      return { ok:true, dryRun:true, message:'Dry run completed', rule };
    }

    // TODO: replace with real condition check.
    // Example:
    // const registerBtn = await page.$('button:has-text("Register")');
    // if (!registerBtn) throw new Error('Register button not found');

    // TODO: click Register at the right time
    result.step = 'click_register';
    // await page.click('button:has-text("Register")');

    // TODO: select player checkbox
    result.step = 'select_player';
    // await page.click('label:has-text("Hari Prashanth Vaidyula") input[type="checkbox"]');

    // TODO: proceed/next button
    result.step = 'proceed';
    // await page.click('button:has-text("Next")');

    // TODO: enter address, select suggestion
    result.step = 'address';
    // await page.type('input[placeholder="Search address"]', rule.addressFull, { delay: 15 });
    // await page.waitForSelector('.suggestion-item');
    // await page.click('.suggestion-item:has-text("383 rue des maraichers")');

    result.step = 'done';
    result.ok = true;
    return { ok:true, rule, message:'Automation steps completed (placeholders must be filled with real selectors).' };
  } catch (e) {
    return { ok:false, step: result.step, error: e.message || String(e), rule };
  }
};
`.trim();
}

/**
 * Health endpoints
 */
app.get('/', (_req, res) => res.status(200).send('ok'));
app.get('/healthz', (_req, res) => res.status(200).json({ ok: true, ts: nowIso() }));

/**
 * Main Scheduler target:
 * POST /book
 */
app.post('/book', async (req, res) => {
  // Always return 200 so Scheduler never marks it failed
  // (Your app will report ok:false in JSON if automation fails)
  try {
    if (!requireApiKey(req, res)) return;

    const rule = buildRuleFromEnvAndBody(req.body || {});
    const retry = buildRetryConfig();

    console.log('BOOK_START', JSON.stringify({ rule }));
    console.log('RETRY_CONFIG', JSON.stringify({
      raw: {
        BROWSERLESS_MAX_ATTEMPTS: process.env.BROWSERLESS_MAX_ATTEMPTS,
        BROWSERLESS_PER_ATTEMPT_TIMEOUT_MS: process.env.BROWSERLESS_PER_ATTEMPT_TIMEOUT_MS,
        BROWSERLESS_OVERALL_TIMEOUT_MS: process.env.BROWSERLESS_OVERALL_TIMEOUT_MS,
      },
      parsed: retry
    }));

    const script = buildBrowserlessScript(rule);

    const outcome = await fetchWithRetry({
      retry,
      runOnce: async ({ attempt, timeoutMs }) => {
        const result = await callBrowserlessFunction({
          script,
          timeoutMs
        });
        // attach for debugging
        result.attempt = attempt;
        return result;
      }
    });

    if (outcome.ok) {
      return res.status(200).json({
        ok: true,
        status: outcome.status,
        rule,
        retry: {
          attempts: outcome.attempts?.length || 0,
          maxAttempts: retry.maxAttempts,
          perAttemptTimeoutMs: retry.perAttemptTimeoutMs,
          overallTimeoutMs: retry.overallTimeoutMs,
        },
        browserless: {
          httpStatus: outcome.result?.httpStatus,
          body: outcome.result?.body,
        }
      });
    }

    console.log('BROWSERLESS_FINAL_FAIL', JSON.stringify({
      message: outcome.message,
      status: outcome.httpStatus,
      attempts: outcome.attempts,
    }));

    return res.status(200).json({
      ok: false,
      status: outcome.status,
      httpStatus: outcome.httpStatus,
      rule,
      retry: {
        attempts: outcome.attempts?.length || 0,
        maxAttempts: retry.maxAttempts,
        perAttemptTimeoutMs: retry.perAttemptTimeoutMs,
        overallTimeoutMs: retry.overallTimeoutMs,
      },
      browserless: {
        httpStatus: outcome.result?.httpStatus,
        body: outcome.result?.body,
        raw: outcome.result?.raw,
      },
      error: outcome.message,
    });
  } catch (err) {
    console.log('SERVER_ERR', JSON.stringify({
      name: err?.name,
      message: err?.message,
      stack: err?.stack,
    }));
    return res.status(200).json({
      ok: false,
      status: 'SERVER_ERROR',
      error: err?.message || String(err),
    });
  }
});

/**
 * Start server (Cloud Run uses PORT)
 */
const PORT = parseInt(process.env.PORT || '8080', 10);
app.listen(PORT, () => {
  console.log(`listening on ${PORT} at ${nowIso()}`);
  console.log('ENV', JSON.stringify({
    TARGET_DAY: envStr('TARGET_DAY', ''),
    EVENING_START: envStr('EVENING_START', ''),
    EVENING_END: envStr('EVENING_END', ''),
    LOCAL_TZ: envStr('LOCAL_TZ', ''),
    ACTIVITY_URL: envStr('ACTIVITY_URL', ''),
    PLAYER_NAME: envStr('PLAYER_NAME', ''),
    ADDRESS_FULL: envStr('ADDRESS_FULL', ''),
    BROWSERLESS_HTTP_BASE: envStr('BROWSERLESS_HTTP_BASE', ''),
    BROWSERLESS_TOKEN: mask(envStr('BROWSERLESS_TOKEN', '')),
    API_KEY: mask(envStr('API_KEY', '')),
  }));
});
