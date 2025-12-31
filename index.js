'use strict';

const express = require('express');

const app = express();

// Cloud Run expects you to listen on process.env.PORT
const PORT = process.env.PORT || 8080;

// Parse JSON bodies
app.use(express.json({ limit: '1mb' }));

/**
 * Simple helper: consistent JSON responses
 */
function ok(res, payload = {}) {
  return res.status(200).json({ ok: true, ...payload });
}
function failBut200(res, payload = {}) {
  // IMPORTANT: still return 200 so Scheduler never marks it as failed
  return res.status(200).json({ ok: false, ...payload });
}

/**
 * Health endpoint (NO AUTH) — used for warmup job
 * Must always return 200 quickly.
 */
app.get('/health', (req, res) => {
  return ok(res, {
    status: 'HEALTHY',
    ts: new Date().toISOString(),
  });
});

/**
 * Root endpoint (NO AUTH) — helps Cloud Run "Test" button too.
 */
app.get('/', (req, res) => {
  return ok(res, { status: 'OK', hint: 'POST /book to run booking. GET /health for warmup.' });
});

/**
 * API key guard for protected routes
 */
function requireApiKey(req, res, next) {
  const expected = process.env.API_KEY;
  if (!expected) {
    // If you forgot to set it, fail safely (but still 200 so scheduler isn't "failed")
    return failBut200(res, { status: 'MISCONFIG', error: 'Missing API_KEY env var' });
  }

  // Support both header styles
  const provided =
    req.get('x-api-key') ||
    (req.get('authorization') || '').replace(/^Bearer\s+/i, '').trim();

  if (provided !== expected) {
    return failBut200(res, { status: 'UNAUTHORIZED', error: 'Unauthorized (invalid x-api-key)' });
  }
  next();
}

/**
 * Booking endpoint (AUTH REQUIRED)
 * Cloud Scheduler should POST here at 8:00.
 */
app.post('/book', requireApiKey, async (req, res) => {
  // Keep defaults consistent with what you've been using
  const rule = {
    targetDay: req.body?.targetDay ?? 'Wednesday',
    eveningStart: req.body?.eveningStart ?? '17:00',
    eveningEnd: req.body?.eveningEnd ?? '21:00',
    timeZone: req.body?.timeZone ?? 'America/Toronto',
    activityUrl:
      req.body?.activityUrl ??
      'https://app.amilia.com/store/en/ville-de-quebec1/shop/activities/6112282?scrollToCalendar=true&view=month',

    // booking flow details you specified
    playerName: req.body?.playerName ?? 'Hari Prashanth Vaidyula',
    addressFull: req.body?.addressFull ?? '383 rue des maraichers, quebec, qc, G1C 0K2',

    // run behavior knobs
    dryRun: !!req.body?.dryRun,
    pollSeconds: Number(req.body?.pollSeconds ?? 420),
    pollIntervalMs: Number(req.body?.pollIntervalMs ?? 3000),
  };

  console.log('BOOK_START', JSON.stringify({ rule }));

  try {
    // ---- IMPORTANT ----
    // Put your existing booking logic here.
    // This should throw on real failures so we can return ok:false (but still HTTP 200)
    const result = await doBooking(rule);

    // Always 200 so scheduler doesn't "fail"
    return ok(res, { status: 'BOOKING_DONE', rule, result });
  } catch (err) {
    console.error('BOOK_FAIL', err?.stack || err);
    return failBut200(res, {
      status: 'BOOKING_ERROR',
      rule,
      error: String(err?.message || err),
    });
  }
});

/**
 * Replace this with your existing logic that calls Browserless etc.
 * Must either return a result object or throw an Error.
 */
async function doBooking(rule) {
  // Example placeholder:
  // - Call Browserless
  // - Poll for availability
  // - Click register at 8am
  // - Select player checkbox: "Hari Prashanth Vaidyula"
  // - Proceed
  // - Address input: "383 rue des maraichers, quebec, qc, G1C 0K2" and pick suggestion
  //
  // Use your working implementation here.
  return { note: 'Replace doBooking(rule) with your current implementation.' };
}

app.listen(PORT, () => {
  console.log(`Listening on ${PORT}`);
});
