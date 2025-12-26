import express from "express";

const app = express();
app.use(express.json({ limit: "2mb" }));

const PORT = process.env.PORT || 8080;

// Health check
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

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function parseRetryAfterMs(headers) {
  const ra = headers?.get?.("retry-after");
  if (!ra) return null;
  const sec = Number(ra);
  if (Number.isFinite(sec)) return sec * 1000;
  const dt = Date.parse(ra);
  if (!Number.isNaN(dt)) return Math.max(0, dt - Date.now());
  return null;
}

/**
 * Robust Browserless call with:
 * - overall timeout (hard cap)
 * - per-attempt timeout
 * - retries w/ exponential backoff + jitter
 * - special handling for 429/5xx/408
 */
async function fetchWithRetry(url, fetchOptions, cfg) {
  const {
    overallTimeoutMs,
    perAttemptTimeoutMs,
    maxAttempts,
    minBackoffMs,
    maxBackoffMs,
  } = cfg;

  const overallController = new AbortController();
  const overallTimer = setTimeout(() => overallController.abort(), overallTimeoutMs);

  const started = Date.now();
  let lastErr = null;

  try {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const attemptController = new AbortController();
      const attemptTimer = setTimeout(() => attemptController.abort(), perAttemptTimeoutMs);

      const mergedSignal = AbortSignal.any
        ? AbortSignal.any([overallController.signal, attemptController.signal])
        : overallController.signal; // fallback

      try {
        const resp = await fetch(url, { ...fetchOptions, signal: mergedSignal });
        const text = await resp.text();

        let parsed;
        try {
          parsed = JSON.parse(text);
        } catch {
          parsed = { raw: text };
        }

        if (resp.ok) {
          return { resp, parsed };
        }

        // Retry rules
        const retryableStatus = [408, 429, 500, 502, 503, 504].includes(resp.status);
        const retryAfterMs = resp.status === 429 ? parseRetryAfterMs(resp.headers) : null;

        console.log(
          "BROWSERLESS_HTTP_NON_OK",
          JSON.stringify({ attempt, status: resp.status, retryableStatus, retryAfterMs }).slice(0, 2000)
        );

        if (!retryableStatus || attempt === maxAttempts) {
          const err = new Error(`Browserless HTTP ${resp.status}`);
          err.httpStatus = resp.status;
          err.body = parsed;
          throw err;
        }

        // Backoff
        const base = clamp(minBackoffMs * Math.pow(2, attempt - 1), minBackoffMs, maxBackoffMs);
        const jitter = Math.floor(Math.random() * 500);
        const waitMs = retryAfterMs ?? (base + jitter);

        await sleep(waitMs);
        continue;
      } catch (err) {
        lastErr = err;

        const name = err?.name || "";
        const msg = String(err?.message || err);

        // If overall timed out, stop immediately
        if (overallController.signal.aborted) {
          throw new Error(`Overall timeout after ${Date.now() - started}ms`);
        }

        // AbortError per-attempt is retryable
        const retryable =
          name === "AbortError" ||
          /aborted/i.test(msg) ||
          /timeout/i.test(msg);

        console.log(
          "BROWSERLESS_ERR",
          JSON.stringify({
            attempt,
            perAttemptTimeoutMs,
            retryable,
            name,
            message: msg,
          }).slice(0, 2000)
        );

        if (!retryable || attempt === maxAttempts) {
          throw err;
        }

        const base = clamp(minBackoffMs * Math.pow(2, attempt - 1), minBackoffMs, maxBackoffMs);
        const jitter = Math.floor(Math.random() * 500);
        await sleep(base + jitter);
        continue;
      } finally {
        clearTimeout(attemptTimer);
      }
    }

    throw lastErr || new Error("fetchWithRetry failed");
  } finally {
    clearTimeout(overallTimer);
  }
}

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
  const DEFAULT_DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";
  const DEFAULT_POLL_SECONDS = Number(process.env.POLL_SECONDS || "120");
  const DEFAULT_POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS || "5000");

  // === OVERRIDES (request body) ===
  const body = req.body || {};

  const targetDay = body.targetDay ?? DEFAULT_TARGET_DAY;
  const eveningStart = body.eveningStart ?? DEFAULT_EVENING_START;
  const eveningEnd = body.eveningEnd ?? DEFAULT_EVENING_END;
  const timeZone = body.timeZone ?? DEFAULT_TIMEZONE;
  const activityUrl = body.activityUrl ?? DEFAULT_ACTIVITY_URL;
  const dryRun = typeof body.dryRun === "boolean" ? body.dryRun : DEFAULT_DRY_RUN;
  const pollSeconds =
    Number.isFinite(Number(body.pollSeconds)) ? Number(body.pollSeconds) : DEFAULT_POLL_SECONDS;
  const pollIntervalMs =
    Number.isFinite(Number(body.pollIntervalMs)) ? Number(body.pollIntervalMs) : DEFAULT_POLL_INTERVAL_MS;

  const rule = {
    targetDay,
    eveningStart,
    eveningEnd,
    timeZone,
    activityUrl,
    dryRun,
    pollSeconds,
    pollIntervalMs,
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
      examplePrograms:
        "https://app.amilia.com/store/en/ville-de-quebec1/shop/programs/calendar/126867?view=basicWeek&scrollToCalendar=true&date=2025-12-27",
      exampleActivities:
        "https://app.amilia.com/store/en/ville-de-quebec1/shop/activities/6112282?scrollToCalendar=true&view=month",
      rule,
    });
  }

  const functionUrl = `${normalizeBaseUrl(BROWSERLESS_HTTP_BASE)}/function?token=${encodeURIComponent(
    BROWSERLESS_TOKEN
  )}`;

  // Browserless Function code
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

  const hhmmToMinutes = (hhmm) => {
    const m = /^([01]?\\d|2[0-3]):([0-5]\\d)$/.exec(hhmm || "");
    if (!m) return null;
    return Number(m[1]) * 60 + Number(m[2]);
  };

  const normalizeText = (s) => String(s || "").replace(/\\s+/g, " ").trim();

  const windowStartMin = hhmmToMinutes(EVENING_START);
  const windowEndMin = hhmmToMinutes(EVENING_END);

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
  if (submit) await submit.click();
  else {
    await page.focus(passSel);
    await page.keyboard.press("Enter");
  }

  await page.waitForFunction(() => !location.href.includes("/login"), { timeout: 60000 }).catch(() => {});

  // 2) Go to calendar
  await page.goto(ACTIVITY_URL, { waitUntil: "networkidle2", timeout: 60000 });
  await sleep(1200);

  const maxAttempts = Math.max(1, Math.floor((Number(POLL_SECONDS) * 1000) / Number(POLL_INTERVAL_MS)));
  let attempts = 0;

  // Strict success detection
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

      return {
        url,
        success: Boolean(hasQuickReg || hasCartCue),
        cannotRegister,
        notOpenedYet
      };
    });
  };

  const closeModalIfPresent = async () => {
    return await page.evaluate(() => {
      const closeCandidates = Array.from(document.querySelectorAll("button, a, [role='button']"));
      const byText = closeCandidates.find(el => {
        const t = (el.innerText || "").trim();
        return /^close$/i.test(t) || /^x$/i.test(t) || /continue shopping/i.test(t);
      });
      if (byText) { byText.click(); return true; }

      const byAttr = document.querySelector("[aria-label='Close'], .modal .close, .modal-close, button.close");
      if (byAttr) { byAttr.click(); return true; }

      return false;
    });
  };

  const pickAndClickCalendarRegister = async () => {
    return await page.evaluate(({ windowStartMin, windowEndMin }) => {
      const normalize = (s) => String(s || "").replace(/\\s+/g, " ").trim();

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

      const candidates = [];
      for (const container of eventContainers) {
        const btn = container.querySelector("button.register, a.register, button[title='Register'], a[title='Register']");
        if (!btn) continue;
        if (!isVisible(btn)) continue;

        const text = normalize(container.innerText || "");
        candidates.push({ text, btn });
      }

      const parseStartMinutes = (text) => {
        const s = text.toLowerCase();
        let m = s.match(/\\b(\\d{1,2}):(\\d{2})\\s*(am|pm)\\b/);
        if (m) {
          let hh = Number(m[1]);
          const mm = Number(m[2]);
          const ap = m[3];
          if (ap === "pm" && hh !== 12) hh += 12;
          if (ap === "am" && hh === 12) hh = 0;
          return hh * 60 + mm;
        }
        m = s.match(/\\b([01]?\\d|2[0-3]):([0-5]\\d)\\b/);
        if (m) return Number(m[1]) * 60 + Number(m[2]);
        return null;
      };

      const filtered = candidates
        .map(c => ({ ...c, startMin: parseStartMinutes(c.text) }))
        .filter(c => c.startMin != null && c.startMin >= windowStartMin && c.startMin <= windowEndMin)
        .sort((a, b) => a.startMin - b.startMin);

      const pick = filtered[0] || candidates[0] || null;
      if (!pick) {
        return { clicked: false, reason: "NO_REGISTER_FOUND", candidatesFound: candidates.length, filteredFound: filtered.length };
      }

      pick.btn.click();
      return {
        clicked: true,
        reason: filtered[0] ? "CLICKED_TIME_MATCH" : "CLICKED_FALLBACK",
        candidatesFound: candidates.length,
        filteredFound: filtered.length,
        pickedText: pick.text.slice(0, 200),
        pickedStartMin: pick.startMin
      };
    }, { windowStartMin, windowEndMin });
  };

  let lastClick = null;
  let lastState = await getState();

  if (lastState.success) {
    return {
      data: {
        status: "POLLING_DONE",
        url: lastState.url,
        attempts: 0,
        finalState: lastState,
        clickResult: { outcome: "SUCCESS_ALREADY", attempts: 0, state: lastState }
      },
      type: "application/json"
    };
  }

  // 3) Poll loop
  while (attempts < maxAttempts) {
    attempts += 1;

    lastState = await getState();
    if (lastState.success) break;

    if (lastState.cannotRegister || lastState.notOpenedYet) {
      await closeModalIfPresent();
      await sleep(Number(POLL_INTERVAL_MS));
      continue;
    }

    if (DRY_RUN) {
      await sleep(Number(POLL_INTERVAL_MS));
      continue;
    }

    lastClick = await pickAndClickCalendarRegister();
    await sleep(1200);

    lastState = await getState();
    if (lastState.success) break;

    if (lastState.cannotRegister || lastState.notOpenedYet) {
      await closeModalIfPresent();
    }

    await sleep(Number(POLL_INTERVAL_MS));
  }

  const finalState = await getState();
  const outcome =
    finalState.success ? "SUCCESS_CLICKED" :
    (attempts >= maxAttempts ? "TIMEOUT" : "STOPPED");

  return {
    data: {
      status: "POLLING_DONE",
      url: finalState.url,
      attempts,
      finalState,
      clickResult: lastClick ? { outcome, attempts, lastClick, state: finalState } : { outcome, attempts, state: finalState }
    },
    type: "application/json"
  };
}
`.trim();

  const overallTimeoutMs = Number(process.env.BROWSERLESS_OVERALL_TIMEOUT_MS || "540000"); // 9m
  const perAttemptTimeoutMs = Number(process.env.BROWSERLESS_PER_ATTEMPT_TIMEOUT_MS || "120000"); // 2m
  const maxAttempts = Number(process.env.BROWSERLESS_MAX_ATTEMPTS || "3");
  const minBackoffMs = Number(process.env.BROWSERLESS_MIN_BACKOFF_MS || "5000");
  const maxBackoffMs = Number(process.env.BROWSERLESS_MAX_BACKOFF_MS || "30000");

  try {
    const { resp, parsed } = await fetchWithRetry(
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
      { overallTimeoutMs, perAttemptTimeoutMs, maxAttempts, minBackoffMs, maxBackoffMs }
    );

    const payload = parsed?.data?.data || parsed?.data || parsed;

    console.log("[BOOK] Browserless response:", JSON.stringify(payload).slice(0, 2000));
    console.log(
      "BOOK_SUMMARY",
      JSON.stringify({
        attempts: payload?.attempts,
        outcome: payload?.clickResult?.outcome,
        clicked: payload?.clickResult?.lastClick?.clicked,
        finalSuccess: payload?.finalState?.success,
        finalUrl: payload?.finalState?.url,
      })
    );

    return res.json({
      status: "BROWSERLESS_HTTP_OK",
      httpStatus: resp.status,
      browserless: payload,
      rule,
    });
  } catch (err) {
    const msg = String(err?.message || err);
    console.log("BROWSERLESS_FINAL_FAIL", JSON.stringify({ message: msg }).slice(0, 2000));

    // Return quickly with a clear failure (so Scheduler doesn't timeout)
    return res.status(503).json({
      error: "Browserless call failed",
      details: msg,
      rule,
      tips: [
        "If you see 429, reduce parallel runs (Cloud Run concurrency=1, max instances=1, only one Scheduler job enabled).",
        "Ensure Scheduler attempt deadline >= Cloud Run timeout.",
        "Increase per-attempt timeout if Browserless is slow.",
      ],
    });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
