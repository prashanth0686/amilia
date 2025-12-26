import express from "express";

const app = express();
app.use(express.json({ limit: "2mb" }));

const PORT = process.env.PORT || 8080;

// ---- Simple in-instance lock to avoid parallel runs on same container ----
let isRunning = false;

// Health check
app.get("/", (req, res) => res.json({ status: "ok" }));

function requireApiKey(req, res) {
  const apiKey = req.headers["x-api-key"];
  if (!apiKey || apiKey !== process.env.API_KEY) {
    res.status(401).json({ error: "Unauthorized (invalid x-api-key)" });
    return false;
  }
  return true;
}

const VALID_DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function isValidHHMM(v) {
  return /^([01]?\d|2[0-3]):[0-5]\d$/.test(v || "");
}

function normalizeBaseUrl(u) {
  return String(u || "").replace(/\/$/, "");
}

function isValidCalendarUrl(u) {
  if (typeof u !== "string") return false;
  return u.includes("/shop/activities/") || u.includes("/shop/programs/calendar/");
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Fetch with retry/backoff.
 * Retries: 429, 5xx, 408, 409, 425, 504, network errors, timeouts.
 * Uses Retry-After header when present (for 429).
 */
async function fetchWithRetry(url, options, cfg) {
  const {
    maxAttempts = 8,
    baseDelayMs = 1500,
    maxDelayMs = 15000,
    maxTotalMs = 240000, // total budget across retries
    logPrefix = "BROWSERLESS",
  } = cfg || {};

  const started = Date.now();
  let attempt = 0;
  let lastErr = null;

  while (attempt < maxAttempts && Date.now() - started < maxTotalMs) {
    attempt += 1;

    // per-attempt timeout (keep it short; we retry)
    const controller = new AbortController();
    const perAttemptTimeoutMs = Math.min(60000, Math.max(15000, maxTotalMs - (Date.now() - started)));
    const t = setTimeout(() => controller.abort(), perAttemptTimeoutMs);

    try {
      const resp = await fetch(url, { ...options, signal: controller.signal });

      // Success path
      if (resp.ok) {
        return resp;
      }

      // Read body for logging / debugging
      const bodyText = await resp.text().catch(() => "");
      const status = resp.status;

      const retryableStatuses = new Set([408, 409, 425, 429, 500, 502, 503, 504]);
      const retryable = retryableStatuses.has(status);

      console.log(
        `${logPrefix}_HTTP_${status}`,
        JSON.stringify({
          attempt,
          perAttemptTimeoutMs,
          retryable,
          retryAfter: resp.headers.get("retry-after") || null,
          bodySnippet: bodyText?.slice(0, 300) || "",
        })
      );

      if (!retryable) {
        // Not retryable -> return immediately
        // Re-create a response-like object for caller
        return new Response(bodyText, { status, headers: resp.headers });
      }

      // If 429 and Retry-After exists, respect it (seconds)
      let delay = Math.min(maxDelayMs, baseDelayMs * Math.pow(2, attempt - 1));
      const retryAfter = resp.headers.get("retry-after");
      if (retryAfter) {
        const sec = Number(retryAfter);
        if (Number.isFinite(sec) && sec > 0) delay = Math.min(maxDelayMs, sec * 1000);
      }

      // add jitter
      delay = Math.floor(delay * (0.7 + Math.random() * 0.6));

      // If we are out of budget, break
      if (Date.now() - started + delay > maxTotalMs) break;

      await sleep(delay);
      continue;
    } catch (e) {
      lastErr = e;
      const name = e?.name || "Error";
      const msg = String(e?.message || e);

      const retryable = name === "AbortError" || /network|fetch|timeout|ECONNRESET|ENOTFOUND|EAI_AGAIN/i.test(msg);

      console.log(
        `${logPrefix}_ERR`,
        JSON.stringify({
          attempt,
          perAttemptTimeoutMs,
          retryable,
          name,
          message: msg,
        })
      );

      if (!retryable) throw e;

      let delay = Math.min(maxDelayMs, baseDelayMs * Math.pow(2, attempt - 1));
      delay = Math.floor(delay * (0.7 + Math.random() * 0.6));

      if (Date.now() - started + delay > maxTotalMs) break;

      await sleep(delay);
      continue;
    } finally {
      clearTimeout(t);
    }
  }

  // If we reach here, we exhausted retry budget
  const elapsed = Date.now() - started;
  const message = lastErr ? String(lastErr?.message || lastErr) : "Retry budget exceeded";
  const err = new Error(`fetchWithRetry failed after ${attempt} attempt(s) in ${elapsed}ms: ${message}`);
  err.code = "RETRY_BUDGET_EXCEEDED";
  throw err;
}

app.post("/book", async (req, res) => {
  if (!requireApiKey(req, res)) return;

  // Prevent parallel /book calls per-instance (helps avoid rate-limits)
  if (isRunning) {
    // Return 429 so Scheduler can retry
    return res.status(429).json({ error: "Busy (booking already running). Retry later." });
  }

  isRunning = true;

  try {
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
      "https://app.amilia.com/store/en/ville-de-quebec1/shop/programs/calendar/126867?view=basicWeek&scrollToCalendar=true&date=2025-12-27";
    const DEFAULT_DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";
    const DEFAULT_POLL_SECONDS = Number(process.env.POLL_SECONDS || "240");
    const DEFAULT_POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS || "2000");

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

    // Browserless Function Code (strict success detection; clicks register in event tiles)
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
  else { await page.focus(passSel); await page.keyboard.press("Enter"); }

  await page.waitForFunction(() => !location.href.includes("/login"), { timeout: 60000 }).catch(() => {});

  // 2) Go to calendar
  await page.goto(ACTIVITY_URL, { waitUntil: "networkidle2", timeout: 60000 });
  await sleep(1200);

  const maxAttempts = Math.max(1, Math.floor((Number(POLL_SECONDS) * 1000) / Number(POLL_INTERVAL_MS)));
  let attempts = 0;

  // STRICT success: only URL cart/checkout OR quickRegisterId OR explicit summaries
  const getState = async () => {
    return await page.evaluate(() => {
      const normalize = (s) => String(s || "").replace(/\\s+/g, " ").trim();
      const bodyText = normalize(document.body?.innerText || "");
      const url = location.href;

      const hasQuickReg = /[?&]quickRegisterId=\\d+/.test(url);

      const hasCartCue =
        /\\/cart\\b/i.test(url) ||
        /\\/checkout\\b/i.test(url) ||
        /cart summary/i.test(bodyText) ||
        /order summary/i.test(bodyText) ||
        /my cart/i.test(bodyText);

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

    // IMPORTANT: Cloud Run request timeout is ~300s. Keep Browserless retry budget under that.
    const maxTotalMs = Math.min(240000, Math.max(60000, (rule.pollSeconds * 1000) + 60000));

    const payloadToBrowserless = {
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
    };

    console.log("BOOK_START", JSON.stringify({ rule }));

    // Call Browserless with robust retry/backoff
    let resp;
    try {
      resp = await fetchWithRetry(
        functionUrl,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payloadToBrowserless),
        },
        {
          maxAttempts: 8,
          baseDelayMs: 1500,
          maxDelayMs: 15000,
          maxTotalMs,
          logPrefix: "BROWSERLESS",
        }
      );
    } catch (err) {
      // Return 503 so Cloud Scheduler retries (configured in job)
      console.log("BROWSERLESS_FINAL_FAIL", JSON.stringify({ message: String(err?.message || err) }));
      return res.status(503).json({
        error: "Browserless unavailable (after retries). Cloud Scheduler should retry.",
        details: String(err?.message || err),
        rule,
      });
    }

    const text = await resp.text();
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = { raw: text };
    }

    if (!resp.ok) {
      // If Browserless returned non-OK (after retries decided it’s non-retryable), still return 503 to trigger Scheduler retry.
      console.log("BROWSERLESS_NONOK_FINAL", JSON.stringify({ status: resp.status, bodySnippet: text?.slice(0, 400) || "" }));
      return res.status(503).json({
        error: "Browserless Function API non-OK",
        httpStatus: resp.status,
        body: parsed,
        rule,
      });
    }

    const browserlessPayload = parsed?.data?.data || parsed?.data || parsed;

    console.log("[BOOK] Browserless response:", JSON.stringify(browserlessPayload).slice(0, 2000));
    console.log(
      "BOOK_SUMMARY",
      JSON.stringify({
        attempts: browserlessPayload?.attempts,
        outcome: browserlessPayload?.clickResult?.outcome,
        clicked: browserlessPayload?.clickResult?.lastClick?.clicked,
        finalSuccess: browserlessPayload?.finalState?.success,
        finalUrl: browserlessPayload?.finalState?.url,
      })
    );

    // Return 200 so Scheduler marks success *only when Browserless call succeeded*
    return res.json({
      status: "BROWSERLESS_HTTP_OK",
      rule,
      browserless: browserlessPayload,
    });
  } finally {
    isRunning = false;
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
