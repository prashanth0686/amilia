import express from "express";

const app = express();
app.use(express.json({ limit: "2mb" }));

const PORT = process.env.PORT || 8080;

// --------------------
// Health check
// --------------------
app.get("/", (req, res) => {
  res.json({ status: "ok" });
});

function requireApiKey(req, res) {
  const apiKey = req.headers["x-api-key"];
  if (!apiKey || apiKey !== process.env.API_KEY) {
    res.status(401).json({ error: "Unauthorized (invalid x-api-key)" });
    return false;
  }
  return true;
}

const VALID_DAYS = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

function isValidHHMM(v) {
  return /^([01]?\d|2[0-3]):[0-5]\d$/.test(v || "");
}

function normalizeBaseUrl(u) {
  return String(u || "").replace(/\/$/, "");
}

// Accept Activities OR Programs Calendar
function isValidCalendarUrl(u) {
  if (typeof u !== "string") return false;
  return u.includes("/shop/activities/") || u.includes("/shop/programs/calendar/");
}

// --------------------
// Robust fetch with retries + per-attempt timeout
// --------------------
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchWithRetry(url, options, cfg) {
  const {
    maxAttempts = 3,
    perAttemptTimeoutMs = 120000,
    overallTimeoutMs = 540000,
    backoffBaseMs = 1000,
  } = cfg;

  const overallStart = Date.now();
  let lastErr = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const elapsed = Date.now() - overallStart;
    const remainingOverall = overallTimeoutMs - elapsed;

    if (remainingOverall <= 0) {
      const err = new Error(`Overall timeout exceeded (${overallTimeoutMs}ms)`);
      err.name = "OverallTimeout";
      throw err;
    }

    const attemptTimeout = Math.min(perAttemptTimeoutMs, remainingOverall);

    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), attemptTimeout);

    try {
      const resp = await fetch(url, {
        ...options,
        signal: controller.signal,
      });
      clearTimeout(t);

      // Treat 429/5xx as retryable from Browserless side
      if (resp.status === 429 || resp.status >= 500) {
        const text = await resp.text().catch(() => "");
        const err = new Error(`Retryable HTTP ${resp.status}`);
        err.name = "RetryableHttpError";
        err.httpStatus = resp.status;
        err.bodyText = text;
        throw err;
      }

      return resp;
    } catch (err) {
      clearTimeout(t);

      const retryable =
        err?.name === "AbortError" ||
        err?.name === "RetryableHttpError" ||
        err?.name === "TypeError"; // network-ish

      lastErr = err;

      console.log(
        "BROWSERLESS_ERR",
        JSON.stringify({
          attempt,
          perAttemptTimeoutMs: attemptTimeout,
          retryable,
          name: err?.name,
          message: err?.message,
          httpStatus: err?.httpStatus,
        })
      );

      if (!retryable || attempt === maxAttempts) break;

      // backoff: 1s, 2s, 4s...
      const backoff = backoffBaseMs * Math.pow(2, attempt - 1);
      await sleep(backoff);
    }
  }

  const finalMsg =
    lastErr?.name === "RetryableHttpError"
      ? `fetchWithRetry failed after ${cfg.maxAttempts} attempt(s): HTTP ${lastErr.httpStatus}`
      : `fetchWithRetry failed after ${cfg.maxAttempts} attempt(s): ${lastErr?.message || lastErr}`;

  const finalError = new Error(finalMsg);
  finalError.name = "FetchWithRetryFailed";
  finalError.cause = lastErr;
  throw finalError;
}

// --------------------
// Main booking endpoint
// --------------------
app.post("/book", async (req, res) => {
  if (!requireApiKey(req, res)) return;

  const {
    BROWSERLESS_HTTP_BASE,
    BROWSERLESS_TOKEN,
    AMILIA_EMAIL,
    AMILIA_PASSWORD,
  } = process.env;

  if (!BROWSERLESS_HTTP_BASE || !BROWSERLESS_TOKEN) {
    return res.status(500).json({
      error: "Browserless HTTP not configured",
      missing: {
        BROWSERLESS_HTTP_BASE: !BROWSERLESS_HTTP_BASE,
        BROWSERLESS_TOKEN: !BROWSERLESS_TOKEN,
      },
    });
  }

  if (!AMILIA_EMAIL || !AMILIA_PASSWORD) {
    return res.status(500).json({
      error: "Amilia credentials not configured",
      missing: {
        AMILIA_EMAIL: !AMILIA_EMAIL,
        AMILIA_PASSWORD: !AMILIA_PASSWORD,
      },
    });
  }

  // === DEFAULTS (Cloud Run env vars) ===
  const DEFAULT_TARGET_DAY = process.env.TARGET_DAY || "Saturday";
  const DEFAULT_EVENING_START = process.env.EVENING_START || "13:00";
  const DEFAULT_EVENING_END = process.env.EVENING_END || "20:00";
  const DEFAULT_TIMEZONE = process.env.LOCAL_TZ || "America/Toronto";
  const DEFAULT_ACTIVITY_URL =
    process.env.ACTIVITY_URL ||
    "https://app.amilia.com/store/en/ville-de-quebec1/shop/programs/calendar/126867?view=basicWeek&scrollToCalendar=true";
  const DEFAULT_DRY_RUN =
    (process.env.DRY_RUN || "true").toLowerCase() === "true";

  const DEFAULT_POLL_SECONDS = Number(process.env.POLL_SECONDS || "240");
  const DEFAULT_POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS || "3000");

  // Browserless fetch retry config from env (the ones you added)
  const DEFAULT_BW_OVERALL_MS = Number(process.env.BROWSERLESS_OVERALL_TIMEOUT_MS || "540000");
  const DEFAULT_BW_PER_ATTEMPT_MS = Number(process.env.BROWSERLESS_PER_ATTEMPT_TIMEOUT_MS || "120000");
  const DEFAULT_BW_ATTEMPTS = Number(process.env.BROWSERLESS_MAX_ATTEMPTS || "3");

  // === OVERRIDES (request body) ===
  const body = req.body || {};

  const rule = {
    targetDay: body.targetDay ?? DEFAULT_TARGET_DAY,
    eveningStart: body.eveningStart ?? DEFAULT_EVENING_START,
    eveningEnd: body.eveningEnd ?? DEFAULT_EVENING_END,
    timeZone: body.timeZone ?? DEFAULT_TIMEZONE,
    activityUrl: body.activityUrl ?? DEFAULT_ACTIVITY_URL,
    dryRun: typeof body.dryRun === "boolean" ? body.dryRun : DEFAULT_DRY_RUN,
    pollSeconds: Number.isFinite(Number(body.pollSeconds))
      ? Number(body.pollSeconds)
      : DEFAULT_POLL_SECONDS,
    pollIntervalMs: Number.isFinite(Number(body.pollIntervalMs))
      ? Number(body.pollIntervalMs)
      : DEFAULT_POLL_INTERVAL_MS,
  };

  console.log("BOOK_START", JSON.stringify({ rule }));

  // === VALIDATION ===
  if (!VALID_DAYS.includes(rule.targetDay)) {
    return res.status(400).json({
      error: "Invalid targetDay",
      provided: rule.targetDay,
      allowed: VALID_DAYS,
      rule,
    });
  }

  if (!isValidHHMM(rule.eveningStart) || !isValidHHMM(rule.eveningEnd)) {
    return res.status(400).json({
      error: "Invalid eveningStart/eveningEnd (expected HH:MM)",
      provided: { eveningStart: rule.eveningStart, eveningEnd: rule.eveningEnd },
      examples: ["13:00", "18:30", "21:00"],
      rule,
    });
  }

  if (!isValidCalendarUrl(rule.activityUrl)) {
    return res.status(400).json({
      error: "Invalid activityUrl (must include /shop/activities/ OR /shop/programs/calendar/)",
      provided: rule.activityUrl,
      rule,
    });
  }

  const functionUrl = `${normalizeBaseUrl(BROWSERLESS_HTTP_BASE)}/function?token=${encodeURIComponent(
    BROWSERLESS_TOKEN
  )}`;

  // Browserless “Function API” script (your existing logic can stay here)
  // IMPORTANT: keep this pure & defensive. Any thrown error becomes retryable upstream.
  const code = `
export default async function ({ page, context }) {
  const {
    EMAIL,
    PASSWORD,
    EVENING_START,
    EVENING_END,
    ACTIVITY_URL,
    DRY_RUN,
    POLL_SECONDS,
    POLL_INTERVAL_MS
  } = context;

  page.setDefaultTimeout(30000);
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  // 1) Login
  await page.goto("https://app.amilia.com/en/login", {
    waitUntil: "domcontentloaded",
    timeout: 60000
  });

  const emailSel = 'input[type="email"], input[name*="email" i]';
  const passSel  = 'input[type="password"], input[name*="password" i]';

  await page.waitForSelector(emailSel, { timeout: 20000 });
  await page.click(emailSel);
  await page.keyboard.type(EMAIL, { delay: 10 });

  await page.waitForSelector(passSel, { timeout: 20000 });
  await page.click(passSel);
  await page.keyboard.type(PASSWORD, { delay: 10 });

  const submitSel = 'button[type="submit"], input[type="submit"]';
  const submit = await page.$(submitSel);
  if (submit) {
    await submit.click();
  } else {
    await page.focus(passSel);
    await page.keyboard.press("Enter");
  }

  await page.waitForFunction(() => !location.href.includes("/login"), { timeout: 60000 }).catch(() => {});

  // 2) Go to calendar
  await page.goto(ACTIVITY_URL, { waitUntil: "networkidle2", timeout: 60000 });
  await sleep(1200);

  const maxAttempts = Math.max(1, Math.floor((Number(POLL_SECONDS) * 1000) / Number(POLL_INTERVAL_MS)));
  let attempts = 0;

  const getState = async () => {
    return await page.evaluate(() => {
      const normalize = (s) => String(s || "").replace(/\\s+/g, " ").trim();
      const bodyText = normalize(document.body?.innerText || "");
      const url = location.href;

      const hasQuickReg = /[?&]quickRegisterId=\\d+/.test(url);
      const hasCartCue =
        /\\/cart\\b/i.test(url) ||
        /\\/checkout\\b/i.test(url) ||
        /my cart/i.test(bodyText) ||
        /cart summary/i.test(bodyText) ||
        /order summary/i.test(bodyText);

      const cannotRegister = /cannot register/i.test(bodyText);
      const notOpenedYet = /registration has not yet been opened/i.test(bodyText);

      return { url, success: Boolean(hasQuickReg || hasCartCue), cannotRegister, notOpenedYet };
    });
  };

  const pickAndClickCalendarRegister = async () => {
    return await page.evaluate(() => {
      const isVisible = (el) => {
        if (!el) return false;
        const r = el.getBoundingClientRect();
        if (!r || r.width === 0 || r.height === 0) return false;
        const style = window.getComputedStyle(el);
        if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") return false;
        return true;
      };

      const eventContainers = Array.from(document.querySelectorAll(
        ".fc-event, .fc-day-grid-event, .fc-time-grid-event, .activity-segment, [id^='event-title-']"
      ));

      for (const container of eventContainers) {
        const btn =
          container.querySelector("button.register, a.register, button[title='Register'], a[title='Register']");
        if (btn && isVisible(btn)) {
          btn.click();
          return { clicked: true };
        }
      }
      return { clicked: false, reason: "NO_REGISTER_FOUND" };
    });
  };

  let lastClick = null;
  let state = await getState();
  if (state.success) {
    return { data: { ok: true, outcome: "ALREADY_SUCCESS", state }, type: "application/json" };
  }

  while (attempts < maxAttempts) {
    attempts += 1;
    state = await getState();
    if (state.success) break;

    if (state.cannotRegister || state.notOpenedYet) {
      await sleep(Number(POLL_INTERVAL_MS));
      continue;
    }

    if (DRY_RUN) {
      await sleep(Number(POLL_INTERVAL_MS));
      continue;
    }

    lastClick = await pickAndClickCalendarRegister();
    await sleep(1200);

    state = await getState();
    if (state.success) break;

    await sleep(Number(POLL_INTERVAL_MS));
  }

  state = await getState();

  return {
    data: {
      ok: Boolean(state.success),
      attempts,
      state,
      lastClick
    },
    type: "application/json"
  };
}
`.trim();

  // --------------------
  // Call Browserless (NEVER return 5xx for retryable failures)
  // --------------------
  try {
    const resp = await fetchWithRetry(
      functionUrl,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          code,
          context: {
            EMAIL: AMILIA_EMAIL,
            PASSWORD: AMILIA_PASSWORD,
            EVENING_START: rule.eveningStart,
            EVENING_END: rule.eveningEnd,
            ACTIVITY_URL: rule.activityUrl,
            DRY_RUN: rule.dryRun,
            POLL_SECONDS: rule.pollSeconds,
            POLL_INTERVAL_MS: rule.pollIntervalMs,
          },
        }),
      },
      {
        maxAttempts: DEFAULT_BW_ATTEMPTS,
        perAttemptTimeoutMs: DEFAULT_BW_PER_ATTEMPT_MS,
        overallTimeoutMs: DEFAULT_BW_OVERALL_MS,
        backoffBaseMs: 1000,
      }
    );

    const text = await resp.text();
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = { raw: text };
    }

    const payload = parsed?.data?.data || parsed?.data || parsed;

    console.log("BOOK_RESULT", JSON.stringify({ ok: true, rule, payload }).slice(0, 4000));

    return res.status(200).json({
      ok: true,
      status: "BROWSERLESS_OK",
      rule,
      browserless: payload,
    });
  } catch (err) {
    // ✅ Key change: return 200 (so Scheduler doesn’t mark job FAILED)
    // External dependency failures are “retryable outcomes”, not “service down”.
    const retryable =
      err?.name === "AbortError" ||
      err?.name === "RetryableHttpError" ||
      err?.name === "FetchWithRetryFailed" ||
      err?.name === "OverallTimeout";

    console.log(
      "BOOK_RETRYABLE_ERROR",
      JSON.stringify({
        retryable,
        name: err?.name,
        message: err?.message,
        causeName: err?.cause?.name,
        causeMessage: err?.cause?.message,
        causeHttpStatus: err?.cause?.httpStatus,
      }).slice(0, 4000)
    );

    return res.status(200).json({
      ok: false,
      status: retryable ? "RETRYABLE_ERROR" : "ERROR",
      retryable: Boolean(retryable),
      rule,
      error: {
        name: err?.name,
        message: err?.message,
        cause: err?.cause
          ? {
              name: err.cause.name,
              message: err.cause.message,
              httpStatus: err.cause.httpStatus,
            }
          : undefined,
      },
    });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
