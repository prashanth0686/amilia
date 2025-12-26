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

/**
 * A small helper to wait (used by retry logic)
 */
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Fetch with:
 * - overallBudgetMs (hard deadline)
 * - perAttemptTimeoutMs (AbortController per attempt)
 * - retry on 429, 408, 5xx, network errors
 */
async function fetchWithRetry(url, options, cfg) {
  const {
    maxAttempts = 3,
    perAttemptTimeoutMs = 90000,
    overallBudgetMs = 540000,
    baseDelayMs = 1500,
    maxDelayMs = 8000,
  } = cfg;

  const start = Date.now();
  let lastErr = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const elapsed = Date.now() - start;
    const remaining = overallBudgetMs - elapsed;

    if (remaining <= 0) {
      throw new Error(
        `Overall budget exceeded before attempt ${attempt} (elapsed=${elapsed}ms, budget=${overallBudgetMs}ms)`
      );
    }

    // Don’t start an attempt if we can’t give it at least a little time
    const thisAttemptTimeout = Math.min(perAttemptTimeoutMs, remaining);

    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), thisAttemptTimeout);

    try {
      const resp = await fetch(url, { ...options, signal: controller.signal });

      // Retry on 429/5xx/408
      if (
        resp.status === 429 ||
        resp.status === 408 ||
        (resp.status >= 500 && resp.status <= 599)
      ) {
        const raw = await resp.text().catch(() => "");
        lastErr = new Error(`HTTP ${resp.status} from Browserless`);
        lastErr.details = raw?.slice?.(0, 4000) || raw;

        // Backoff with jitter
        const delay = Math.min(
          maxDelayMs,
          baseDelayMs * Math.pow(2, attempt - 1)
        );
        const jitter = Math.floor(Math.random() * 400);
        console.log(
          "BROWSERLESS_RETRYABLE_HTTP",
          JSON.stringify({
            attempt,
            status: resp.status,
            delayMs: delay + jitter,
            perAttemptTimeoutMs: thisAttemptTimeout,
          })
        );
        clearTimeout(t);
        await sleep(delay + jitter);
        continue;
      }

      clearTimeout(t);
      return resp;
    } catch (err) {
      clearTimeout(t);

      // AbortError due to our per-attempt controller => treat as retryable
      const name = err?.name || "Error";
      const message = String(err?.message || err);

      const retryable =
        name === "AbortError" ||
        /network|fetch|ECONNRESET|ETIMEDOUT|EAI_AGAIN/i.test(message);

      console.log(
        "BROWSERLESS_ERR",
        JSON.stringify({
          attempt,
          perAttemptTimeoutMs: thisAttemptTimeout,
          retryable,
          name,
          message,
        })
      );

      lastErr = err;

      if (!retryable) break;

      // backoff
      const delay = Math.min(maxDelayMs, baseDelayMs * Math.pow(2, attempt - 1));
      const jitter = Math.floor(Math.random() * 400);
      await sleep(delay + jitter);
    }
  }

  const elapsed = Date.now() - start;
  const msg = `fetchWithRetry failed after ${cfg.maxAttempts || 3} attempt(s) in ${elapsed}ms: ${String(
    lastErr?.message || lastErr
  )}`;
  const e = new Error(msg);
  e.cause = lastErr;
  throw e;
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
      rule,
    });
  }

  const functionUrl = `${normalizeBaseUrl(BROWSERLESS_HTTP_BASE)}/function?token=${encodeURIComponent(
    BROWSERLESS_TOKEN
  )}`;

  // Browserless Function (Puppeteer runtime)
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

  // -------- 1) Login --------
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

  // -------- 2) Go to calendar --------
  await page.goto(ACTIVITY_URL, { waitUntil: "networkidle2", timeout: 60000 });
  await sleep(1200);

  const maxAttempts = Math.max(1, Math.floor((Number(POLL_SECONDS) * 1000) / Number(POLL_INTERVAL_MS)));
  let attempts = 0;

  // STRICT success detection (avoid false positives)
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
    return { data: { status: "POLLING_DONE", url: lastState.url, attempts: 0, finalState: lastState, clickResult: { outcome: "SUCCESS_ALREADY", attempts: 0, state: lastState } }, type: "application/json" };
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
    data: { status: "POLLING_DONE", url: finalState.url, attempts, finalState, clickResult: lastClick ? { outcome, attempts, lastClick, state: finalState } : { outcome, attempts, state: finalState } },
    type: "application/json"
  };
}
`.trim();

  // ====== FINAL TIMEOUTS (must match Scheduler+Cloud Run) ======
  // Cloud Run timeout should be 600s
  // Scheduler attempt deadline should be 600s
  // Our own overall budget should be slightly less: 540s
  const overallBudgetMs = Number(process.env.BROWSERLESS_OVERALL_TIMEOUT_MS || "540000");
  const perAttemptTimeoutMs = Number(process.env.BROWSERLESS_PER_ATTEMPT_TIMEOUT_MS || "90000");
  const maxAttempts = Number(process.env.BROWSERLESS_MAX_ATTEMPTS || "3");

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
        maxAttempts,
        perAttemptTimeoutMs,
        overallBudgetMs,
        baseDelayMs: 1500,
        maxDelayMs: 8000,
      }
    );

    const text = await resp.text();
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = { raw: text };
    }

    if (!resp.ok) {
      console.log("BROWSERLESS_ERROR_BODY", JSON.stringify(parsed).slice(0, 4000));
      return res.status(502).json({
        error: "Browserless Function API error",
        httpStatus: resp.status,
        body: parsed,
        rule,
      });
    }

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
        overallBudgetMs,
        perAttemptTimeoutMs,
        maxAttempts,
      })
    );

    return res.json({
      status: "BROWSERLESS_HTTP_OK",
      browserless: parsed,
      rule,
    });
  } catch (err) {
    console.log(
      "BROWSERLESS_FINAL_FAIL",
      JSON.stringify({ message: String(err?.message || err) }).slice(0, 2000)
    );

    const msg = String(err?.message || err);
    const isTimeout = /budget exceeded|aborted|AbortError|timed out/i.test(msg);

    return res.status(isTimeout ? 504 : 502).json({
      error: isTimeout ? "Browserless timed out / exceeded budget" : "Browserless request failed",
      details: msg,
      rule,
      timeouts: { overallBudgetMs, perAttemptTimeoutMs, maxAttempts },
    });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
