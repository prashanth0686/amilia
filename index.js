'use strict';

const express = require('express');

const app = express();

// ---------- middleware ----------
app.use(express.json({ limit: '1mb' }));

// Basic request logging (helps Cloud Run logs)
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    console.log(
      JSON.stringify({
        severity: 'INFO',
        msg: 'request',
        method: req.method,
        path: req.path,
        status: res.statusCode,
        durationMs: Date.now() - start,
      })
    );
  });
  next();
});

// ---------- helpers ----------
function getHeader(req, name) {
  // Express lowercases header keys
  return req.headers[String(name).toLowerCase()];
}

function requireApiKey(req) {
  const expected = process.env.API_KEY;
  if (!expected) {
    // Misconfiguration - fail closed
    return { ok: false, status: 500, message: 'API_KEY env var not set' };
  }

  const provided =
    getHeader(req, 'x-api-key') ||
    getHeader(req, 'x-api_key') ||
    getHeader(req, 'authorization'); // optional fallback

  if (!provided) return { ok: false, status: 401, message: 'Missing API key' };

  // If user sends "Bearer <key>"
  const token = String(provided).startsWith('Bearer ')
    ? String(provided).slice('Bearer '.length)
    : String(provided);

  if (token !== expected) return { ok: false, status: 403, message: 'Invalid API key' };

  return { ok: true };
}

function buildRuleFromRequest(body = {}) {
  // Prefer request body, fallback to env vars (so scheduler can just call /book with {})
  return {
    targetDay: body.targetDay ?? process.env.TARGET_DAY ?? 'Wednesday',
    eveningStart: body.eveningStart ?? process.env.EVENING_START ?? '17:00',
    eveningEnd: body.eveningEnd ?? process.env.EVENING_END ?? '21:00',
    timeZone: body.timeZone ?? process.env.LOCAL_TZ ?? 'America/Toronto',
    activityUrl: body.activityUrl ?? process.env.ACTIVITY_URL,
    dryRun: body.dryRun ?? false,

    // Optional tuning
    browserlessHttpBase: body.browserlessHttpBase ?? process.env.BROWSERLESS_HTTP_BASE,
    browserlessToken: body.browserlessToken ?? process.env.BROWSERLESS_TOKEN,

    // Browserless timeout controls (strings in env → convert to int when using)
    overallTimeoutMs: Number(body.overallTimeoutMs ?? process.env.BROWSERLESS_OVERALL_TIMEOUT_MS ?? 540000),
    perAttemptTimeoutMs: Number(body.perAttemptTimeoutMs ?? process.env.BROWSERLESS_PER_ATTEMPT_TIMEOUT_MS ?? 180000),
    maxAttempts: Number(body.maxAttempts ?? process.env.BROWSERLESS_MAX_ATTEMPTS ?? 3),

    // Amilia account
    amiliaEmail: body.amiliaEmail ?? process.env.AMILIA_EMAIL,
    amiliaPassword: body.amiliaPassword ?? process.env.AMILIA_PASSWORD,

    // Session config (if you use it)
    sessionStore: body.sessionStore ?? process.env.SESSION_STORE ?? 'firestore',
    firestoreSessionDoc: body.firestoreSessionDoc ?? process.env.FIRESTORE_SESSION_DOC ?? 'amilia/session',

    // Optional user info
    playerName: body.playerName ?? process.env.PLAYER_NAME,
    addressFull: body.addressFull ?? process.env.ADDRESS_FULL,
  };
}

// ---------- routes ----------

// Root: quick “is the service alive?”
app.get('/', (req, res) => {
  res.status(200).send('OK');
});

// Health: your curl should return 200 now
app.get('/health', (req, res) => {
  res.status(200).json({ ok: true, status: 'healthy' });
});

// Scheduler endpoint
app.post('/book', async (req, res) => {
  const auth = requireApiKey(req);
  if (!auth.ok) {
    return res.status(auth.status).json({ ok: false, error: auth.message });
  }

  const rule = buildRuleFromRequest(req.body);

  // Basic validation so failures are obvious
  if (!rule.activityUrl) {
    return res.status(400).json({ ok: false, error: 'Missing activityUrl (ACTIVITY_URL env var or request body)' });
  }
  if (!rule.browserlessHttpBase || !rule.browserlessToken) {
    return res.status(400).json({
      ok: false,
      error: 'Missing Browserless config (BROWSERLESS_HTTP_BASE / BROWSERLESS_TOKEN)',
    });
  }
  if (!rule.amiliaEmail || !rule.amiliaPassword) {
    return res.status(400).json({
      ok: false,
      error: 'Missing Amilia credentials (AMILIA_EMAIL / AMILIA_PASSWORD)',
    });
  }

  console.log(
    JSON.stringify({
      severity: 'INFO',
      msg: 'BOOK_START',
      rule: {
        targetDay: rule.targetDay,
        eveningStart: rule.eveningStart,
        eveningEnd: rule.eveningEnd,
        timeZone: rule.timeZone,
        dryRun: rule.dryRun,
        activityUrl: rule.activityUrl,
        maxAttempts: rule.maxAttempts,
        perAttemptTimeoutMs: rule.perAttemptTimeoutMs,
        overallTimeoutMs: rule.overallTimeoutMs,
      },
    })
  );

  try {
    const result = await runBooking(rule);

    console.log(JSON.stringify({ severity: 'INFO', msg: 'BOOK_DONE', resultSummary: result?.summary ?? null }));

    return res.status(200).json({
      ok: true,
      result,
    });
  } catch (err) {
    const status = err?.httpStatus || err?.status || 500;

    console.error(
      JSON.stringify({
        severity: 'ERROR',
        msg: 'BOOK_FAIL',
        error: err?.message ?? String(err),
        stack: err?.stack ?? null,
        httpStatus: status,
      })
    );

    return res.status(200).json({
      ok: false,
      status: err?.status ?? 'UNKNOWN_ERROR',
      httpStatus: status,
      message: err?.message ?? 'Booking failed',
    });
  }
});

// ---------- booking implementation ----------
// Replace ONLY the body of this function with your existing booking logic.
// Keep the function signature and thrown errors consistent.
async function runBooking(rule) {
  // ✅ If you already have code that calls Browserless/Puppeteer and books on Amilia,
  // paste it here.

  // Example placeholder behavior:
  if (rule.dryRun) {
    return {
      summary: 'dryRun: no booking attempted',
      rule,
    };
  }

  // If you want “fail fast” until real code is pasted in:
  const e = new Error('Booking logic not implemented in this template. Paste your existing booking code into runBooking(rule).');
  e.status = 'NOT_IMPLEMENTED';
  e.httpStatus = 500;
  throw e;
}

// ---------- start server ----------
const PORT = Number(process.env.PORT || 8080);
app.listen(PORT, '0.0.0.0', () => {
  console.log(JSON.stringify({ severity: 'INFO', msg: 'server_started', port: PORT }));
});
