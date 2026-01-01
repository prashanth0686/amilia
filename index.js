'use strict';

const express = require('express');

const app = express();
app.use(express.json({ limit: '1mb' }));

// --- Health endpoints (important for validation / monitoring) ---
app.get('/', (req, res) => {
  res.status(200).send('OK');
});

app.get('/health', (req, res) => {
  res.status(200).json({ ok: true });
});

// --- Your booking endpoint (keep/merge your real logic here) ---
app.post('/book', async (req, res) => {
  try {
    // IMPORTANT: keep your existing logic here.
    // Example: validate payload
    const { targetDay, eveningStart, eveningEnd, timeZone, dryRun } = req.body || {};

    if (!targetDay || !eveningStart || !eveningEnd || !timeZone) {
      return res.status(400).json({ ok: false, error: 'Missing required fields' });
    }

    // TODO: call your existing browserless/booking code here
    // const result = await runBookingFlow({...})
    // return res.status(200).json(result)

    return res.status(200).json({
      ok: true,
      message: 'Book endpoint reachable (wire in booking logic here)',
      received: { targetDay, eveningStart, eveningEnd, timeZone, dryRun: !!dryRun },
    });
  } catch (err) {
    console.error('BOOK_ERROR', err);
    return res.status(500).json({ ok: false, error: 'Internal error' });
  }
});

// --- MUST listen on Cloud Run provided port ---
const PORT = parseInt(process.env.PORT || '8080', 10);
app.listen(PORT, () => {
  console.log(`Listening on port ${PORT}`);
});

// Good practice: log crashes so Cloud Run logs show why startup failed
process.on('unhandledRejection', (err) => console.error('UNHANDLED_REJECTION', err));
process.on('uncaughtException', (err) => console.error('UNCAUGHT_EXCEPTION', err));
