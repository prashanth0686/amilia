'use strict';

const express = require('express');

const app = express();
app.use(express.json({ limit: '1mb' }));

// --- Basic routes ---
app.get('/', (req, res) => {
  res.status(200).send('OK');
});

app.get('/health', (req, res) => {
  res.status(200).json({ ok: true });
});

// IMPORTANT: keep /book route defined
app.post('/book', async (req, res) => {
  try {
    // Always respond JSON (Scheduler expects reachable HTTP)
    // You can keep dryRun functionality here.
    const body = req.body || {};
    const dryRun = body.dryRun === true;

    // Minimal response so Scheduler doesn't fail.
    // If you want booking to actually run, call runBooking(body) before responding.
    // If you want "fast ack + async work", you should move booking to Cloud Tasks/PubSub.
    if (dryRun) {
      return res.status(200).json({
        ok: true,
        status: 'DRY_RUN_OK',
        received: body,
      });
    }

    // Run booking inside the request (simple + reliable)
    // Put your current automation logic here:
    const result = await runBooking(body);

    return res.status(200).json({
      ok: true,
      status: 'BOOK_ATTEMPTED',
      result,
    });
  } catch (err) {
    // Still return 200 so Scheduler never shows a hard failure
    console.error('BOOK_HANDLER_ERROR', err?.stack || err);
    return res.status(200).json({
      ok: false,
      status: 'BOOK_HANDLER_ERROR',
      error: String(err?.message || err),
    });
  }
});

// --- Booking logic stub ---
// Replace contents with your current logic (Browserless/Amilia steps).
async function runBooking(input) {
  // IMPORTANT: Do not do heavy work at top-level import time.
  // Put it inside this function.
  return {
    message: 'Replace runBooking() with your existing booking code.',
    input,
  };
}

// --- Hard safety: never crash silently ---
process.on('unhandledRejection', (reason) => {
  console.error('UNHANDLED_REJECTION', reason);
});
process.on('uncaughtException', (err) => {
  console.error('UNCAUGHT_EXCEPTION', err);
});

// --- Cloud Run listen ---
const PORT = Number(process.env.PORT) || 8080;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Listening on ${PORT}`);
});
