import express from "express";

// Node 18+ has fetch built-in
const app = express();
app.use(express.json({ limit: "2mb" }));

const PORT = process.env.PORT || 8080;

/** -----------------------------
 *  Basic health + auth
 *  ----------------------------- */
app.get("/", (_req, res) => res.status(200).json({ status: "ok" }));

function requireApiKey(req, res) {
  const apiKey = req.headers["x-api-key"];
  if (!process.env.API_KEY) {
    res.status(500).json({ ok: false, error: "Missing API_KEY in env" });
    return false;
  }
  if (!apiKey || apiKey !== process.env.API_KEY) {
    res.status(401).json({ ok: false, error: "Unauthorized (invalid x-api-key)" });
    return false;
  }
  return true;
}

/** -----------------------------
 *  Config helpers
 *  ----------------------------- */
function envInt(name, fallback) {
  const v = process.env[name];
  if (v === undefined || v === null || v === "") return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function envStr(name, fallback = "") {
  const v = process.env[name];
  return v === undefined || v === null || v === "" ? fallback : v;
}

function nowIso() {
  return new Date().toISOString();
}

/** -----------------------------
 *  Timeout + retry wrapper
 *  ----------------------------- */
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function isRetryableHttpStatus(status) {
  if (!status) return true; // network errors etc.
  if (status === 408) return true;
  if (status === 429) return true;
  if (status >= 500 && status <= 599) return true;
  return false;
}

async function fetchWithRetry(url, options, retryCfg) {
  const maxAttempts = Math.max(1, Number(retryCfg.maxAttempts || 1));
  const perAttemptTimeoutMs = Math.max(1000, Number(retryCfg.perAttemptTimeoutMs || 30000));
  const overallTimeoutMs = Math.max(perAttemptTimeoutMs, Number(retryCfg.overallTimeoutMs || perAttemptTimeoutMs));

  const started = Date.now();
  let lastErr = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const elapsed = Date.now() - started;
    const remainingOverall = overallTimeoutMs - elapsed;
    if (remainingOverall <= 0) {
      const err = new Error(`Overall timeout exceeded (${overallTimeoutMs}ms)`);
      err.name = "OverallTimeoutError";
      lastErr = err;
      break;
    }

    // Abort slightly AFTER perAttemptTimeout so we don’t cut off too early
    const attemptBudget = Math.min(perAttemptTimeoutMs, remainingOverall);
    const controller = new AbortController();
    const abortTimer = setTimeout(() => controller.abort(), attemptBudget + 250);

    try {
      const resp = await fetch(url, { ...options, signal: controller.signal });
      clearTimeout(abortTimer);

      if (!resp.ok) {
        const status = resp.status;
        const text = await safeReadText(resp);

        const err = new Error(`HTTP ${status}: ${text?.slice(0, 500) || ""}`.trim());
        err.name = "HttpError";
        err.status = status;
        err.body = text;

        if (isRetryableHttpStatus(status) && attempt < maxAttempts) {
          console.log("BROWSERLESS_ERR", JSON.stringify({
            attempt,
            perAttemptTimeoutMs,
            overallTimeoutMs,
            maxAttempts,
            retryable: true,
            status,
            name: err.name,
            message: err.message
          }));
          // backoff: 1.5s, 3s, 6s...
          const backoff = Math.min(1500 * Math.pow(2, attempt - 1), 10000);
          await sleep(backoff);
          lastErr = err;
          continue;
        }

        lastErr = err;
        return { ok: false, status: "BROWSERLESS_HTTP_ERROR", httpStatus: status, raw: text, attempt };
      }

      const text = await safeReadText(resp);
      return { ok: true, status: "BROWSERLESS_OK", httpStatus: resp.status, raw: text, attempt };
    } catch (e) {
      clearTimeout(abortTimer);

      const name = e?.name || "Error";
      const message = e?.message || String(e);

      const retryable =
        name === "AbortError" ||
        name === "TimeoutError" ||
        name === "FetchError" ||
        /aborted/i.test(message) ||
        /timeout/i.test(message);

      if (retryable && attempt < maxAttempts) {
        console.log("BROWSERLESS_ERR", JSON.stringify({
          attempt,
          perAttemptTimeoutMs,
          overallTimeoutMs,
          maxAttempts,
          retryable: true,
          name,
          message
        }));
        const backoff = Math.min(1500 * Math.pow(2, attempt - 1), 10000);
        await sleep(backoff);
        lastErr = e;
        continue;
      }

      lastErr = e;
      return { ok: false, status: "BROWSERLESS_FETCH_ERROR", httpStatus: 0, raw: message, attempt };
    }
  }

  // If we exit loop without returning, we failed overall
  const finalStatus = lastErr?.status || (lastErr?.name === "AbortError" ? 408 : 500);
  console.log("BROWSERLESS_FINAL_FAIL", JSON.stringify({
    message: `fetchWithRetry failed after ${retryCfg.maxAttempts || 1} attempt(s)`,
    status: finalStatus
  }));
  return { ok: false, status: "BROWSERLESS_FINAL_FAIL", httpStatus: finalStatus, raw: lastErr?.message || String(lastErr) };
}

async function safeReadText(resp) {
  try {
    return await resp.text();
  } catch {
    return "";
  }
}

/** -----------------------------
 *  Booking rule builder
 *  ----------------------------- */
function buildRule(reqBody = {}) {
  const rule = {
    targetDay: reqBody.targetDay ?? envStr("TARGET_DAY", "Wednesday"),
    eveningStart: reqBody.eveningStart ?? envStr("EVENING_START", "13:00"),
    eveningEnd: reqBody.eveningEnd ?? envStr("EVENING_END", "20:00"),
    timeZone: reqBody.timeZone ?? envStr("LOCAL_TZ", "America/Toronto"),
    activityUrl: reqBody.activityUrl ?? envStr("ACTIVITY_URL", ""),
    dryRun: reqBody.dryRun ?? false,
    pollSeconds: reqBody.pollSeconds ?? 420,
    pollIntervalMs: reqBody.pollIntervalMs ?? 3000,
    playerName: reqBody.playerName ?? envStr("PLAYER_NAME", ""),
    addressFull: reqBody.addressFull ?? envStr("ADDRESS_FULL", "")
  };

  // Retry config (can be overridden by body if needed)
  const retry = {
    maxAttempts: reqBody.maxAttempts ?? envInt("BROWSERLESS_MAX_ATTEMPTS", 3),
    perAttemptTimeoutMs: reqBody.perAttemptTimeoutMs ?? envInt("BROWSERLESS_PER_ATTEMPT_TIMEOUT_MS", 90000),
    overallTimeoutMs: reqBody.overallTimeoutMs ?? envInt("BROWSERLESS_OVERALL_TIMEOUT_MS", 540000)
  };

  return { rule, retry };
}

/** -----------------------------
 *  Browserless call
 *  NOTE: This uses Browserless "function" endpoint with Puppeteer.
 *  You MUST adjust selectors via env vars if defaults don’t match.
 *  ----------------------------- */
function buildSelectors() {
  return {
    loginEmail: envStr("SEL_LOGIN_EMAIL", 'input[type="email"], input[name="email"], #email'),
    loginPassword: envStr("SEL_LOGIN_PASSWORD", 'input[type="password"], input[name="password"], #password'),
    loginSubmit: envStr("SEL_LOGIN_SUBMIT", 'button[type="submit"], button[name="login"]'),

    registerButton: envStr("SEL_REGISTER_BUTTON", 'button:has-text("Register"), a:has-text("Register")'),

    // Player selection step
    playerContainer: envStr("SEL_PLAYER_CHECKBOX_CONTAINER", "body"), // you can scope if needed
    playerNext: envStr("SEL_PLAYER_NEXT_BUTTON", 'button:has-text("Next"), button:has-text("Proceed"), button[type="submit"]'),

    // Address step
    addressInput: envStr("SEL_ADDRESS_INPUT", 'input[type="search"], input[placeholder*="Address"], input[name*="address"]'),
    addressSuggestionList: envStr("SEL_ADDRESS_SUGGESTION_LIST", '[role="listbox"], ul[role="listbox"], .pac-container'),
    addressNext: envStr("SEL_ADDRESS_NEXT_BUTTON", 'button:has-text("Next"), button:has-text("Proceed"), button[type="submit"]')
  };
}

function buildBrowserlessFunctionPayload({ rule }) {
  const selectors = buildSelectors();

  // Browserless "function" code runs in their environment.
  // It must be a string. Keep it concise and log milestones.
  const code = `
    const puppeteer = require('puppeteer');
    module.exports = async ({ page, context }) => {
      const {
        amiliaEmail, amiliaPassword,
        activityUrl, pollSeconds, pollIntervalMs,
        playerName, addressFull,
        selectors, dryRun
      } = context;

      const log = (msg, obj) => console.log(msg, obj ? JSON.stringify(obj) : "");

      // 1) Go to site / activity
      log("NAVIGATE_START", { activityUrl });
      await page.goto(activityUrl, { waitUntil: 'networkidle2', timeout: 120000 });
      log("NAVIGATE_OK");

      // 2) Login (if needed)
      // Heuristic: if login fields exist, fill them.
      const emailSel = selectors.loginEmail;
      const passSel = selectors.loginPassword;

      const emailExists = await page.$(emailSel);
      const passExists = await page.$(passSel);

      if (emailExists && passExists) {
        log("LOGIN_START");
        await page.click(emailSel, { clickCount: 3 });
        await page.type(emailSel, amiliaEmail, { delay: 10 });
        await page.click(passSel, { clickCount: 3 });
        await page.type(passSel, amiliaPassword, { delay: 10 });

        const submitSel = selectors.loginSubmit;
        const submitBtn = await page.$(submitSel);
        if (submitBtn) {
          await Promise.all([
            page.click(submitSel),
            page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 120000 }).catch(() => null)
          ]);
        }
        log("LOGIN_OK");
      } else {
        log("LOGIN_SKIP", { reason: "login fields not found" });
      }

      // 3) Poll for Register opening
      const deadline = Date.now() + (pollSeconds * 1000);
      log("POLL_START", { pollSeconds, pollIntervalMs });

      let registerFound = false;
      while (Date.now() < deadline) {
        const registerBtn = await page.$(selectors.registerButton);
        if (registerBtn) {
          registerFound = true;
          break;
        }
        await page.waitForTimeout(pollIntervalMs);
        await page.reload({ waitUntil: 'networkidle2' }).catch(() => null);
      }

      if (!registerFound) {
        log("REGISTER_NOT_FOUND");
        return { ok: false, step: "POLL_REGISTER", message: "Register button not found within poll window" };
      }

      log("REGISTER_FOUND");
      if (dryRun) {
        log("DRY_RUN_STOP");
        return { ok: true, step: "DRY_RUN", message: "Register found (dryRun true)" };
      }

      // Click Register
      await page.click(selectors.registerButton).catch(() => null);
      await page.waitForTimeout(1500);

      // 4) Player selection (select checkbox by visible text match)
      log("PLAYER_STEP_START", { playerName });

      // Find label containing playerName; click its associated checkbox
      const clickedPlayer = await page.evaluate(({ playerName }) => {
        const textMatch = (el) => (el?.innerText || "").toLowerCase().includes(playerName.toLowerCase());
        const labels = Array.from(document.querySelectorAll('label, div, span, p'));
        for (const el of labels) {
          if (textMatch(el)) {
            // Try click near it
            el.click();
            return true;
          }
        }
        return false;
      }, { playerName });

      log("PLAYER_SELECTED", { clickedPlayer });

      // Click Next/Proceed
      await page.click(selectors.playerNext).catch(() => null);
      await page.waitForTimeout(1500);

      // 5) Address step
      log("ADDRESS_STEP_START", { addressFull });

      // Type address
      const addrSel = selectors.addressInput;
      await page.waitForSelector(addrSel, { timeout: 30000 });
      await page.click(addrSel, { clickCount: 3 });
      await page.type(addrSel, addressFull, { delay: 10 });

      // Wait suggestions and choose first matching suggestion
      await page.waitForTimeout(1200);

      // Try pick first suggestion item
      const picked = await page.keyboard.press('ArrowDown').then(() => page.keyboard.press('Enter')).then(() => true).catch(() => false);
      log("ADDRESS_PICKED", { picked });

      // Next/Proceed
      await page.click(selectors.addressNext).catch(() => null);
      await page.waitForTimeout(1500);

      log("FLOW_DONE");
      return { ok: true, step: "DONE", message: "Flow completed (final confirmation step may still be required depending on site)" };
    };
  `;

  return {
    code,
    context: {
      amiliaEmail: envStr("AMILIA_EMAIL", ""),
      amiliaPassword: envStr("AMILIA_PASSWORD", ""),
      activityUrl: rule.activityUrl,
      pollSeconds: rule.pollSeconds,
      pollIntervalMs: rule.pollIntervalMs,
      playerName: rule.playerName,
      addressFull: rule.addressFull,
      selectors,
      dryRun: rule.dryRun
    }
  };
}

async function callBrowserless({ rule, retry }) {
  const base = envStr("BROWSERLESS_HTTP_BASE", "");
  const token = envStr("BROWSERLESS_TOKEN", "");
  if (!base || !token) {
    return { ok: false, status: "CONFIG_ERROR", httpStatus: 500, raw: "Missing BROWSERLESS_HTTP_BASE or BROWSERLESS_TOKEN" };
  }
  if (!rule.activityUrl) {
    return { ok: false, status: "CONFIG_ERROR", httpStatus: 400, raw: "Missing activityUrl (set ACTIVITY_URL or send in request)" };
  }

  const url = `${base.replace(/\\/$/, "")}/function?token=${encodeURIComponent(token)}`;
  const payload = buildBrowserlessFunctionPayload({ rule });

  // Some Browserless tiers/timeouts are enforced server-side; still, we keep our own aborts + retries.
  return await fetchWithRetry(
    url,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    },
    retry
  );
}

/** -----------------------------
 *  Routes
 *  ----------------------------- */
app.post("/warmup", async (req, res) => {
  if (!requireApiKey(req, res)) return;

  const { rule, retry } = buildRule({ ...req.body, dryRun: true, pollSeconds: 15, pollIntervalMs: 2000 });

  console.log("WARMUP_START", JSON.stringify({ at: nowIso(), rule, retry }));
  const result = await callBrowserless({ rule, retry });

  // ALWAYS 200 for scheduler safety
  res.status(200).json({
    ok: result.ok,
    status: result.status,
    httpStatus: result.httpStatus,
    at: nowIso(),
    rule,
    retry,
    browserless: { raw: result.raw?.slice?.(0, 2000) ?? result.raw }
  });
});

app.post("/book", async (req, res) => {
  if (!requireApiKey(req, res)) return;

  const { rule, retry } = buildRule(req.body);

  console.log("BOOK_START", JSON.stringify({ rule }));

  const result = await callBrowserless({ rule, retry });

  // ALWAYS 200 so Cloud Scheduler never marks it failed
  res.status(200).json({
    ok: result.ok,
    status: result.status,
    httpStatus: result.httpStatus,
    at: nowIso(),
    rule,
    retry,
    browserless: { raw: result.raw?.slice?.(0, 4000) ?? result.raw }
  });
});

/** -----------------------------
 *  Start server
 *  ----------------------------- */
app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
