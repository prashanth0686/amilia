'use strict';

const express = require('express');
const crypto = require('crypto');

const app = express();
app.use(express.json({ limit: '1mb' }));

/**
 * ENV
 */
const API_KEY = process.env.API_KEY || '';
const AMILIA_EMAIL = process.env.AMILIA_EMAIL || '';
const AMILIA_PASSWORD = process.env.AMILIA_PASSWORD || '';

const BROWSERLESS_TOKEN = process.env.BROWSERLESS_TOKEN || '';
const BROWSERLESS_HTTP_BASE = (process.env.BROWSERLESS_HTTP_BASE || '').replace(/\/+$/, ''); // no trailing slash

// Defaults tuned for Browserless "60s function cap" reality.
// Keep each Browserless call under ~55s, and do polling in Cloud Run instead.
const DEFAULTS = {
  TARGET_DAY: process.env.TARGET_DAY || 'Sunday',
  EVENING_START: process.env.EVENING_START || '13:00',
  EVENING_END: process.env.EVENING_END || '20:00',
  LOCAL_TZ: process.env.LOCAL_TZ || 'America/Toronto',
  ACTIVITY_URL: process.env.ACTIVITY_URL || '',
  PLAYER_NAME: process.env.PLAYER_NAME || 'Hari Prashanth Vaidyula',
  ADDRESS_FULL: process.env.ADDRESS_FULL || '383 rue des maraichers, quebec, qc, G1C 0K2',

  // Cloud Run polling (seconds)
  POLL_SECONDS: parseInt(process.env.POLL_SECONDS || '420', 10),
  POLL_INTERVAL_MS: parseInt(process.env.POLL_INTERVAL_MS || '3000', 10),

  // Browserless call behavior
  // IMPORTANT: keep per-call under 55s unless you know your Browserless plan supports longer.
  BROWSERLESS_CALL_TIMEOUT_MS: parseInt(process.env.BROWSERLESS_CALL_TIMEOUT_MS || '55000', 10),
  BROWSERLESS_MAX_ATTEMPTS: parseInt(process.env.BROWSERLESS_MAX_ATTEMPTS || '3', 10),
  BROWSERLESS_RETRY_DELAY_MS: parseInt(process.env.BROWSERLESS_RETRY_DELAY_MS || '1500', 10),
};

function nowIso() {
  return new Date().toISOString();
}

function reqId() {
  return crypto.randomBytes(6).toString('hex');
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function pick(obj, key, fallback) {
  return obj && obj[key] !== undefined && obj[key] !== null ? obj[key] : fallback;
}

function requireApiKey(req, res) {
  // Your Cloud Run may already be IAM-protected. This is an extra guard.
  if (!API_KEY) return true; // allow if not set
  const got = (req.header('x-api-key') || '').trim();
  if (got && got === API_KEY) return true;
  res.status(200).json({ ok: false, status: 'UNAUTHORIZED', error: 'Unauthorized (invalid x-api-key)' });
  return false;
}

function validateEnvOrThrow() {
  const missing = [];
  if (!BROWSERLESS_HTTP_BASE) missing.push('BROWSERLESS_HTTP_BASE');
  if (!BROWSERLESS_TOKEN) missing.push('BROWSERLESS_TOKEN');
  if (!AMILIA_EMAIL) missing.push('AMILIA_EMAIL');
  if (!AMILIA_PASSWORD) missing.push('AMILIA_PASSWORD');
  if (missing.length) {
    const err = new Error(`Missing env: ${missing.join(', ')}`);
    err.code = 'MISSING_ENV';
    throw err;
  }
}

function buildRule(body = {}) {
  return {
    targetDay: pick(body, 'targetDay', DEFAULTS.TARGET_DAY),
    eveningStart: pick(body, 'eveningStart', DEFAULTS.EVENING_START),
    eveningEnd: pick(body, 'eveningEnd', DEFAULTS.EVENING_END),
    timeZone: pick(body, 'timeZone', DEFAULTS.LOCAL_TZ),
    activityUrl: pick(body, 'activityUrl', DEFAULTS.ACTIVITY_URL),
    playerName: pick(body, 'playerName', DEFAULTS.PLAYER_NAME),
    addressFull: pick(body, 'addressFull', DEFAULTS.ADDRESS_FULL),

    dryRun: Boolean(pick(body, 'dryRun', false)),
    pollSeconds: parseInt(pick(body, 'pollSeconds', DEFAULTS.POLL_SECONDS), 10),
    pollIntervalMs: parseInt(pick(body, 'pollIntervalMs', DEFAULTS.POLL_INTERVAL_MS), 10),
  };
}

// Browserless /function runner with retries (actual polling happens in Cloud Run)
async function callBrowserlessFunction({ code, context, timeoutMs }) {
  validateEnvOrThrow();

  // Browserless function endpoint
  const url = `${BROWSERLESS_HTTP_BASE}/function?token=${encodeURIComponent(BROWSERLESS_TOKEN)}`;

  const payload = {
    code,
    context,
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    const text = await resp.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      json = { raw: text };
    }

    if (!resp.ok) {
      const err = new Error(`Browserless HTTP ${resp.status}`);
      err.httpStatus = resp.status;
      err.payload = json;
      throw err;
    }

    return { ok: true, data: json };
  } finally {
    clearTimeout(timer);
  }
}

async function callBrowserlessWithRetry({ code, context, timeoutMs, maxAttempts }) {
  const attempts = Math.max(1, maxAttempts || DEFAULTS.BROWSERLESS_MAX_ATTEMPTS);
  let lastErr;

  for (let i = 1; i <= attempts; i++) {
    try {
      return await callBrowserlessFunction({ code, context, timeoutMs });
    } catch (e) {
      lastErr = e;
      // If we got an explicit Browserless 408, wait and retry (but keep total time small)
      await sleep(DEFAULTS.BROWSERLESS_RETRY_DELAY_MS);
    }
  }

  const status = lastErr?.httpStatus || 408;
  return {
    ok: false,
    status,
    error: lastErr?.message || 'Browserless timeout',
    details: lastErr?.payload || null,
  };
}

/**
 * Browserless function code
 * - Warmup intent: login + quick check (<55s)
 * - Book intent: quick "is Register available?" attempt, do minimal steps, return state
 *
 * NOTE: Selectors may need tweaking based on Amilia DOM.
 */
const BROWSERLESS_FN = `
module.exports = async ({ page, context }) => {
  const {
    intent,
    email,
    password,
    activityUrl,
    playerName,
    addressFull,
    dryRun,
    targetDay,
    eveningStart,
    eveningEnd,
    timeBudgetMs,
  } = context;

  const startedAt = Date.now();
  const deadline = startedAt + timeBudgetMs;

  const step = async (name, fn) => {
    const t = Date.now();
    if (t > deadline) throw new Error('Time budget exceeded');
    try {
      const out = await fn();
      return { name, ok: true, ms: Date.now() - t, out };
    } catch (e) {
      return { name, ok: false, ms: Date.now() - t, error: e.message || String(e) };
    }
  };

  const steps = [];
  const result = { intent, dryRun, steps };

  // Conservative defaults for page timing
  page.setDefaultTimeout(15000);
  page.setDefaultNavigationTimeout(20000);

  // --- WARMUP: login only, fast
  if (intent === 'warmup') {
    steps.push(await step('goto_login', async () => {
      await page.goto('https://app.amilia.com/', { waitUntil: 'domcontentloaded' });
      return true;
    }));

    // Try to click Sign in / Log in if present; otherwise this is still a "warm" success.
    steps.push(await step('try_open_login', async () => {
      const signIn = await page.$('a[href*="login"], a[href*="sign-in"], button:has-text("Sign in"), button:has-text("Log in")');
      if (signIn) await signIn.click();
      return true;
    }));

    steps.push(await step('try_fill_login', async () => {
      // These selectors often differ; we try a few common patterns:
      const emailSel = 'input[type="email"], input[name*="email" i], input[id*="email" i]';
      const passSel = 'input[type="password"], input[name*="pass" i], input[id*="pass" i]';
      const emailEl = await page.$(emailSel);
      const passEl = await page.$(passSel);

      if (!emailEl || !passEl) return { skipped: true };

      await emailEl.click({ clickCount: 3 });
      await emailEl.type(email, { delay: 10 });
      await passEl.click({ clickCount: 3 });
      await passEl.type(password, { delay: 10 });

      // Try submit
      const btn = await page.$('button[type="submit"], button:has-text("Sign in"), button:has-text("Log in")');
      if (btn) await btn.click();
      return { attempted: true };
    }));

    steps.push(await step('done', async () => ({ warm: true })));
    result.status = 'WARMUP_OK';
    return result;
  }

  // --- BOOK: quick try, return "not_open" if register not available
  steps.push(await step('goto_activity', async () => {
    if (!activityUrl) throw new Error('Missing activityUrl');
    await page.goto(activityUrl, { waitUntil: 'domcontentloaded' });
    return true;
  }));

  steps.push(await step('find_register', async () => {
    // Try multiple patterns; adjust if needed
    const candidates = [
      'button:has-text("Register")',
      'a:has-text("Register")',
      'button:has-text("Inscription")',
      'a:has-text("Inscription")',
    ];

    for (const sel of candidates) {
      const el = await page.$(sel);
      if (el) {
        const disabled = await page.evaluate((b) => b.disabled === true, el).catch(() => false);
        return { found: sel, disabled };
      }
    }
    return { found: null };
  }));

  // If register isn’t present/available, return fast so Cloud Run can poll.
  const regStep = steps.find(s => s.name === 'find_register');
  const regFound = regStep && regStep.ok && regStep.out && regStep.out.found;
  const regDisabled = regStep && regStep.ok && regStep.out && regStep.out.disabled;

  if (!regFound || regDisabled) {
    result.status = 'NOT_OPEN_YET';
    return result;
  }

  steps.push(await step('click_register', async () => {
    await page.click(regFound);
    return true;
  }));

  // Player selection step (checkbox)
  steps.push(await step('select_player', async () => {
    // This is highly DOM-dependent. We use label text fallback.
    const labelXpath = \`//label[contains(., "\${playerName}")]\`;
    const [label] = await page.$x(labelXpath);
    if (label) {
      await label.click();
      return { selected: true };
    }
    // fallback: checkbox near text
    const [cb] = await page.$x(\`//span[contains(., "\${playerName}")]/preceding::input[@type="checkbox"][1]\`);
    if (cb) { await cb.click(); return { selected: true }; }
    return { selected: false };
  }));

  // Proceed/Next
  steps.push(await step('click_next', async () => {
    const btn = await page.$('button:has-text("Next"), button:has-text("Proceed"), button:has-text("Continue"), button:has-text("Suivant"), button:has-text("Continuer")');
    if (btn) { await btn.click(); return true; }
    return false;
  }));

  // Address entry
  steps.push(await step('fill_address', async () => {
    const input = await page.$('input[placeholder*="address" i], input[name*="address" i], input[id*="address" i]');
    if (!input) return { filled: false };

    await input.click({ clickCount: 3 });
    await input.type(addressFull, { delay: 10 });

    // Wait a bit for suggestions dropdown and select first match
    await page.waitForTimeout(800);
    const option = await page.$('li[role="option"], div[role="option"]');
    if (option) { await option.click(); return { filled: true, picked: true }; }
    return { filled: true, picked: false };
  }));

  // Final submit (if not dryRun)
  steps.push(await step('final_submit', async () => {
    if (dryRun) return { skipped: true };
    const btn = await page.$('button:has-text("Confirm"), button:has-text("Submit"), button:has-text("Register"), button:has-text("Confirmer"), button:has-text("Soumettre")');
    if (btn) { await btn.click(); return { submitted: true }; }
    return { submitted: false };
  }));

  result.status = dryRun ? 'DRYRUN_DONE' : 'BOOK_ATTEMPT_DONE';
  return result;
};
`;

/**
 * Routes
 */

// Health check (useful for you + monitoring)
app.get('/health', (req, res) => {
  res.status(200).json({
    ok: true,
    status: 'OK',
    time: nowIso(),
    service: 'amilia-booker',
  });
});

// Alias root -> avoid "Cannot POST /"
app.post('/', (req, res) => {
  req.url = '/book';
  return app._router.handle(req, res);
});

// Job A: Warmup (fast, should not hit 408)
app.post('/warmup', async (req, res) => {
  if (!requireApiKey(req, res)) return;

  const id = reqId();
  const rule = buildRule(req.body || {});
  console.log('WARMUP_START', JSON.stringify({ id, rule }));

  try {
    const out = await callBrowserlessWithRetry({
      code: BROWSERLESS_FN,
      context: {
        intent: 'warmup',
        email: AMILIA_EMAIL,
        password: AMILIA_PASSWORD,
        activityUrl: rule.activityUrl,
        playerName: rule.playerName,
        addressFull: rule.addressFull,
        dryRun: true,
        targetDay: rule.targetDay,
        eveningStart: rule.eveningStart,
        eveningEnd: rule.eveningEnd,
        timeBudgetMs: Math.min(DEFAULTS.BROWSERLESS_CALL_TIMEOUT_MS, 55000),
      },
      timeoutMs: Math.min(DEFAULTS.BROWSERLESS_CALL_TIMEOUT_MS, 55000),
      maxAttempts: DEFAULTS.BROWSERLESS_MAX_ATTEMPTS,
    });

    if (!out.ok) {
      console.log('BROWSERLESS_FINAL_FAIL', JSON.stringify({ id, message: out.error, status: out.status }));
      return res.status(200).json({ ok: false, status: 'BROWSERLESS_HTTP_ERROR', httpStatus: out.status, rule, browserless: out.details || { raw: out.error } });
    }

    return res.status(200).json({ ok: true, status: 'WARMUP_OK', rule, browserless: out.data });
  } catch (e) {
    console.log('WARMUP_EXCEPTION', JSON.stringify({ id, error: e.message || String(e) }));
    return res.status(200).json({ ok: false, status: 'EXCEPTION', error: e.message || String(e), rule });
  }
});

// Job B: Booking (polling happens in Cloud Run, each Browserless call stays <55s)
app.post('/book', async (req, res) => {
  if (!requireApiKey(req, res)) return;

  const id = reqId();
  const rule = buildRule(req.body || {});
  console.log('BOOK_START', JSON.stringify({ id, rule }));

  try {
    const deadline = Date.now() + Math.max(5, rule.pollSeconds) * 1000;
    const interval = Math.max(500, rule.pollIntervalMs);

    while (Date.now() < deadline) {
      const out = await callBrowserlessWithRetry({
        code: BROWSERLESS_FN,
        context: {
          intent: 'book',
          email: AMILIA_EMAIL,
          password: AMILIA_PASSWORD,
          activityUrl: rule.activityUrl,
          playerName: rule.playerName,
          addressFull: rule.addressFull,
          dryRun: rule.dryRun,
          targetDay: rule.targetDay,
          eveningStart: rule.eveningStart,
          eveningEnd: rule.eveningEnd,
          timeBudgetMs: Math.min(DEFAULTS.BROWSERLESS_CALL_TIMEOUT_MS, 55000),
        },
        timeoutMs: Math.min(DEFAULTS.BROWSERLESS_CALL_TIMEOUT_MS, 55000),
        maxAttempts: DEFAULTS.BROWSERLESS_MAX_ATTEMPTS,
      });

      if (!out.ok) {
        console.log('BROWSERLESS_FINAL_FAIL', JSON.stringify({ id, message: out.error, status: out.status }));
        // Keep 200 so Scheduler never fails, but report the error in JSON.
        return res.status(200).json({
          ok: false,
          status: 'BROWSERLESS_HTTP_ERROR',
          httpStatus: out.status,
          rule,
          browserless: out.details || { raw: out.error },
          retry: { attempts: DEFAULTS.BROWSERLESS_MAX_ATTEMPTS, callTimeoutMs: Math.min(DEFAULTS.BROWSERLESS_CALL_TIMEOUT_MS, 55000) },
        });
      }

      const data = out.data;
      const status = data && data.status;

      // If not open, wait and poll again
      if (status === 'NOT_OPEN_YET') {
        await sleep(interval);
        continue;
      }

      // Anything else: we attempted something — return the payload
      return res.status(200).json({ ok: true, status: 'BROWSERLESS_OK', rule, browserless: data });
    }

    return res.status(200).json({
      ok: false,
      status: 'POLL_TIMEOUT',
      rule,
      message: `No booking opportunity within ${rule.pollSeconds}s`,
    });
  } catch (e) {
    console.log('BOOK_EXCEPTION', JSON.stringify({ id, error: e.message || String(e) }));
    return res.status(200).json({ ok: false, status: 'EXCEPTION', error: e.message || String(e), rule });
  }
});

const port = parseInt(process.env.PORT || '8080', 10);
app.listen(port, '0.0.0.0', () => {
  console.log(`Listening on ${port}`);
});
