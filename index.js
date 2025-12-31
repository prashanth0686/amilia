'use strict';

const express = require('express');

// Node 18+ has global fetch. If your runtime is older, install node-fetch.
// const fetch = global.fetch || ((...args) => import('node-fetch').then(({default: f}) => f(...args)));

const app = express();
app.use(express.json({ limit: '1mb' }));

// ---------- Config ----------
const PORT = process.env.PORT || 8080;

// If set, /book requires: x-api-key: <API_KEY>
const API_KEY = process.env.API_KEY || '';

// Browserless
const BROWSERLESS_URL = process.env.BROWSERLESS_URL || ''; // e.g. https://chrome.browserless.io/function
const BROWSERLESS_TOKEN = process.env.BROWSERLESS_TOKEN || ''; // optional

const DEFAULT_PER_ATTEMPT_TIMEOUT_MS = parseInt(process.env.BROWSERLESS_PER_ATTEMPT_TIMEOUT_MS || '180000', 10); // 3 min
const DEFAULT_OVERALL_TIMEOUT_MS = parseInt(process.env.BROWSERLESS_OVERALL_TIMEOUT_MS || '540000', 10); // 9 min
const DEFAULT_MAX_ATTEMPTS = parseInt(process.env.BROWSERLESS_MAX_ATTEMPTS || '3', 10); // retries

// ---------- Utilities ----------
function nowIso() {
  return new Date().toISOString();
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function safeJsonParse(str) {
  try { return JSON.parse(str); } catch { return null; }
}

function normalizeBrowserlessUrl() {
  if (!BROWSERLESS_URL) return '';
  // If token is provided and URL doesn't already include it, append.
  if (BROWSERLESS_TOKEN && !BROWSERLESS_URL.includes('token=')) {
    const join = BROWSERLESS_URL.includes('?') ? '&' : '?';
    return `${BROWSERLESS_URL}${join}token=${encodeURIComponent(BROWSERLESS_TOKEN)}`;
  }
  return BROWSERLESS_URL;
}

function isRetryableStatus(code) {
  // Browserless timeouts / rate-limits / transient server errors
  return code === 408 || code === 429 || (code >= 500 && code <= 599);
}

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    return res;
  } finally {
    clearTimeout(id);
  }
}

async function fetchWithRetry({ url, options, maxAttempts, perAttemptTimeoutMs, overallTimeoutMs }) {
  const start = Date.now();
  let attempt = 0;
  let lastErr = null;

  while (attempt < maxAttempts && (Date.now() - start) < overallTimeoutMs) {
    attempt += 1;

    try {
      const remainingOverall = overallTimeoutMs - (Date.now() - start);
      const thisTimeout = Math.max(1000, Math.min(perAttemptTimeoutMs, remainingOverall));

      const res = await fetchWithTimeout(url, options, thisTimeout);

      if (res.ok) return { ok: true, res, attempt };

      // Read body for logging (best effort)
      const text = await res.text().catch(() => '');
      const parsed = safeJsonParse(text);

      if (isRetryableStatus(res.status)) {
        lastErr = { status: res.status, body: parsed || text || '(empty)' };
        // backoff: 1s, 2s, 4s...
        const backoff = Math.min(8000, 1000 * Math.pow(2, attempt - 1));
        console.log(`BROWSERLESS_RETRY ${JSON.stringify({ attempt, status: res.status, backoffMs: backoff, at: nowIso() })}`);
        await sleep(backoff);
        continue;
      }

      // Non-retryable
      return { ok: false, status: res.status, body: parsed || text, attempt };
    } catch (e) {
      // Abort or network error => retry (within limits)
      lastErr = { message: e?.message || String(e), name: e?.name || 'Error' };
      const backoff = Math.min(8000, 1000 * Math.pow(2, attempt - 1));
      console.log(`BROWSERLESS_RETRY ${JSON.stringify({ attempt, error: lastErr, backoffMs: backoff, at: nowIso() })}`);
      await sleep(backoff);
    }
  }

  return {
    ok: false,
    status: 408,
    body: { message: `fetchWithRetry failed after ${attempt} attempt(s)`, lastErr },
    attempt
  };
}

// ---------- Routes ----------

// Always-200 liveness
app.get('/', (_req, res) => {
  res.status(200).json({ ok: true, service: 'amilia-booker', at: nowIso() });
});

app.get('/health', (_req, res) => {
  res.status(200).json({ ok: true, status: 'healthy', at: nowIso() });
});

// Main endpoint called by Scheduler
app.post('/book', async (req, res) => {
  try {
    // Optional API key protection
    if (API_KEY) {
      const got = req.header('x-api-key') || '';
      if (got !== API_KEY) {
        // IMPORTANT: still return 200 so Scheduler doesn't mark job as failed
        console.log(`UNAUTHORIZED_BOOK_CALL ${JSON.stringify({ at: nowIso() })}`);
        return res.status(200).json({ ok: false, status: 'UNAUTHORIZED', error: 'Unauthorized (invalid x-api-key)' });
      }
    }

    const rule = {
      targetDay: req.body?.targetDay || 'Wednesday',
      eveningStart: req.body?.eveningStart || '17:00',
      eveningEnd: req.body?.eveningEnd || '21:00',
      timeZone: req.body?.timeZone || 'America/Toronto',
      activityUrl: req.body?.activityUrl || 'https://app.amilia.com/store/en/ville-de-quebec1/shop/activities/6112282?scrollToCalendar=true&view=month',
      dryRun: !!req.body?.dryRun,
      pollSeconds: Number(req.body?.pollSeconds ?? 540),
      pollIntervalMs: Number(req.body?.pollIntervalMs ?? 2500),
      playerName: req.body?.playerName || 'Hari Prashanth Vaidyula',
      addressFull: req.body?.addressFull || '383 rue des maraichers, quebec, qc, G1C 0K2'
    };

    console.log(`BOOK_START ${JSON.stringify({ rule })}`);

    // Call Browserless (your function/script lives there)
    const browserlessUrl = normalizeBrowserlessUrl();
    if (!browserlessUrl) {
      console.log(`BROWSERLESS_FINAL_FAIL ${JSON.stringify({ message: 'Missing BROWSERLESS_URL', status: 500 })}`);
      // Return 200 so Scheduler doesn't fail
      return res.status(200).json({ ok: false, status: 'CONFIG_ERROR', error: 'Missing BROWSERLESS_URL', rule });
    }

    const maxAttempts = Number(req.body?.maxAttempts ?? DEFAULT_MAX_ATTEMPTS);
    const perAttemptTimeoutMs = Number(req.body?.perAttemptTimeoutMs ?? DEFAULT_PER_ATTEMPT_TIMEOUT_MS);
    const overallTimeoutMs = Number(req.body?.overallTimeoutMs ?? DEFAULT_OVERALL_TIMEOUT_MS);

    const options = {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(rule)
    };

    const result = await fetchWithRetry({
      url: browserlessUrl,
      options,
      maxAttempts,
      perAttemptTimeoutMs,
      overallTimeoutMs
    });

    if (result.ok) {
      const text = await result.res.text().catch(() => '');
      const parsed = safeJsonParse(text);
      console.log(`BOOK_DONE ${JSON.stringify({ attempt: result.attempt, at: nowIso() })}`);

      // Still return 200 always
      return res.status(200).json({
        ok: true,
        status: 'BROWSERLESS_OK',
        rule,
        attempt: result.attempt,
        browserless: parsed || { raw: text }
      });
    }

    console.log(`BROWSERLESS_FINAL_FAIL ${JSON.stringify({ message: result.body?.message || 'Browserless failed', status: result.status })}`);

    return res.status(200).json({
      ok: false,
      status: 'BROWSERLESS_HTTP_ERROR',
      httpStatus: result.status,
      rule,
      retry: {
        attempts: maxAttempts,
        perAttemptTimeoutMs,
        overallTimeoutMs
      },
      browserless: result.body
    });
  } catch (e) {
    console.log(`BOOK_HANDLER_ERROR ${JSON.stringify({ message: e?.message || String(e), at: nowIso() })}`);
    // Always 200 so Scheduler never "fails"
    return res.status(200).json({ ok: false, status: 'HANDLER_ERROR', error: e?.message || String(e) });
  }
});

// Safety: unknown routes return 200 (prevents confusion with Cloud Scheduler checks)
app.all('*', (req, res) => {
  res.status(200).json({ ok: false, status: 'NOT_FOUND', path: req.path, method: req.method });
});

// Crash hygiene
process.on('unhandledRejection', (err) => console.log(`UNHANDLED_REJECTION ${JSON.stringify({ err: String(err), at: nowIso() })}`));
process.on('uncaughtException', (err) => console.log(`UNCAUGHT_EXCEPTION ${JSON.stringify({ err: String(err), at: nowIso() })}`));

app.listen(PORT, '0.0.0.0', () => {
  console.log(`SERVER_LISTENING ${JSON.stringify({ port: PORT, at: nowIso() })}`);
});
