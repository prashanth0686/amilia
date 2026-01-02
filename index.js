import express from "express";
import puppeteer from "puppeteer-core";

const app = express();
app.use(express.json());

// ---------- Config ----------
const PORT = parseInt(process.env.PORT || "8080", 10);

const BROWSERLESS_HTTP_BASE =
  process.env.BROWSERLESS_HTTP_BASE || "https://production-sfo.browserless.io";
const BROWSERLESS_TOKEN = process.env.BROWSERLESS_TOKEN || "";

const OVERALL_TIMEOUT_MS = parseInt(process.env.BROWSERLESS_OVERALL_TIMEOUT_MS || "540000", 10);
const PER_ATTEMPT_TIMEOUT_MS = parseInt(process.env.BROWSERLESS_PER_ATTEMPT_TIMEOUT_MS || "180000", 10);
const MAX_ATTEMPTS = parseInt(process.env.BROWSERLESS_MAX_ATTEMPTS || "3", 10);

// Your automation inputs (already in env in Cloud Run)
const ACTIVITY_URL = process.env.ACTIVITY_URL || "";
const AMILIA_EMAIL = process.env.AMILIA_EMAIL || "";
const AMILIA_PASSWORD = process.env.AMILIA_PASSWORD || "";

// ---------- Helpers ----------
function sleep(ms) {
  return new Promise((res) => setTimeout(res, ms));
}

function browserWSEndpoint() {
  // Browserless usually supports ws endpoint derived from https base:
  // https://production-sfo.browserless.io  -> wss://production-sfo.browserless.io?token=XYZ
  const wsBase = BROWSERLESS_HTTP_BASE.replace(/^https:/, "wss:").replace(/^http:/, "ws:");
  const tokenQuery = BROWSERLESS_TOKEN ? `?token=${encodeURIComponent(BROWSERLESS_TOKEN)}` : "";
  return `${wsBase}${tokenQuery}`;
}

function nowIso() {
  return new Date().toISOString();
}

// Retry wrapper for “connect to browserless and do work”
async function withBrowserlessRetry(fn, label = "browserless-task") {
  const started = Date.now();
  let lastErr = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const elapsed = Date.now() - started;
    const remaining = OVERALL_TIMEOUT_MS - elapsed;

    if (remaining <= 0) {
      const msg = `${label}: overall timeout exceeded after ${attempt - 1} attempt(s)`;
      throw new Error(msg);
    }

    const attemptTimeout = Math.min(PER_ATTEMPT_TIMEOUT_MS, remaining);

    console.log(
      `${nowIso()} ${label}: attempt ${attempt}/${MAX_ATTEMPTS} (attemptTimeoutMs=${attemptTimeout}, remainingOverallMs=${remaining})`
    );

    try {
      // Race the attempt against attemptTimeout
      const result = await Promise.race([
        fn({ attempt, attemptTimeout }),
        (async () => {
          await sleep(attemptTimeout);
          throw new Error(`${label}: attempt timeout after ${attemptTimeout}ms`);
        })(),
      ]);

      return result; // success
    } catch (err) {
      lastErr = err;
      const msg = (err && err.message) ? err.message : String(err);

      // Backoff: 2s, 5s, 10s...
      const backoffMs = Math.min(10000, 2000 + (attempt - 1) * 3000);
      console.log(`${nowIso()} ${label}: FAILED attempt ${attempt}: ${msg}`);
      if (attempt < MAX_ATTEMPTS) {
        console.log(`${nowIso()} ${label}: retrying in ${backoffMs}ms...`);
        await sleep(backoffMs);
      }
    }
  }

  // If all attempts failed
  const finalMsg = (lastErr && lastErr.message) ? lastErr.message : String(lastErr);
  throw new Error(`BROWSERLESS_FINAL_FAIL {"message":"${label} failed after ${MAX_ATTEMPTS} attempt(s)","error":"${finalMsg}"}`);
}

async function connectBrowser({ attemptTimeout }) {
  const ws = browserWSEndpoint();
  if (!ws) throw new Error("Missing Browserless WS endpoint");

  console.log(`${nowIso()} browserless: connecting to ${ws.replace(/token=[^&]+/, "token=***")}`);

  const browser = await puppeteer.connect({
    browserWSEndpoint: ws,
    // puppeteer.connect has its own internal timeouts; we control via our attemptTimeout race too
  });

  // Optional: hard kill if it hangs later
  const killTimer = setTimeout(() => {
    try {
      browser.close();
    } catch {}
  }, attemptTimeout + 5000);

  return { browser, killTimer };
}

// Put your REAL booking automation inside here.
async function runBookingFlow(page) {
  // --- Minimal “real” baseline steps so you can confirm Browserless works ---
  // If you already have selectors/steps, replace everything below with your logic.

  if (!ACTIVITY_URL) throw new Error("Missing ACTIVITY_URL env var");

  await page.goto(ACTIVITY_URL, { waitUntil: "domcontentloaded" });

  // If you need login, implement it here.
  // NOTE: I can’t guess the exact selectors for Amilia login. You must plug in your working selectors.
  // Example skeleton:
  //
  // await page.click('text=Log in');
  // await page.waitForSelector('input[type="email"]', { timeout: 30000 });
  // await page.type('input[type="email"]', AMILIA_EMAIL);
  // await page.type('input[type="password"]', AMILIA_PASSWORD);
  // await page.click('button[type="submit"]');
  // await page.waitForNavigation({ waitUntil: 'networkidle2' });

  // Quick “proof” return:
  const title = await page.title();
  return { ok: true, title };
}

// ---------- Routes ----------
app.get("/", (req, res) => res.status(200).send("amilia-booker up"));
app.get("/health", (req, res) => res.status(200).json({ ok: true, ts: nowIso() }));

// Warmup: just connect + open a page + close (helps reduce cold flakiness)
app.get("/warmup", async (req, res) => {
  try {
    const result = await withBrowserlessRetry(async ({ attemptTimeout }) => {
      const { browser, killTimer } = await connectBrowser({ attemptTimeout });
      try {
        const page = await browser.newPage();
        await page.close();
        return { ok: true };
      } finally {
        clearTimeout(killTimer);
        await browser.close();
      }
    }, "warmup");

    res.status(200).json(result);
  } catch (err) {
    res.status(500).json({ ok: false, error: err?.message || String(err) });
  }
});

// Book: this is what Scheduler should call
app.get("/book", async (req, res) => {
  try {
    const result = await withBrowserlessRetry(async ({ attemptTimeout }) => {
      const { browser, killTimer } = await connectBrowser({ attemptTimeout });

      try {
        const page = await browser.newPage();
        page.setDefaultTimeout(60000);
        page.setDefaultNavigationTimeout(60000);

        const bookingResult = await runBookingFlow(page);
        return bookingResult;
      } finally {
        clearTimeout(killTimer);
        await browser.close();
      }
    }, "book");

    res.status(200).json(result);
  } catch (err) {
    res.status(500).json({ ok: false, error: err?.message || String(err) });
  }
});

// ---------- Start ----------
app.listen(PORT, "0.0.0.0", () => {
  console.log(`${nowIso()} listening on port ${PORT}`);
});
