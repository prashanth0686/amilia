import express from "express";

const app = express();
app.use(express.json({ limit: "2mb" }));

const PORT = process.env.PORT || 8080;

// -------------------------
// Health check
// -------------------------
app.get("/", (req, res) => {
  res.status(200).json({ ok: true, status: "ok" });
});

// -------------------------
// Helpers
// -------------------------
function normalizeBaseUrl(u) {
  return String(u || "").replace(/\/$/, "");
}

function requireApiKey(req) {
  const apiKey = req.headers["x-api-key"];
  return Boolean(apiKey && process.env.API_KEY && apiKey === process.env.API_KEY);
}

const VALID_DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function isValidHHMM(v) {
  return /^([01]?\d|2[0-3]):[0-5]\d$/.test(v || "");
}

// Accept Activities OR Programs Calendar
function isValidCalendarUrl(u) {
  if (typeof u !== "string") return false;
  return u.includes("/shop/activities/") || u.includes("/shop/programs/calendar/");
}

function clampInt(n, min, max, fallback) {
  const v = Number(n);
  if (!Number.isFinite(v)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(v)));
}

/**
 * Fetch with retry for transient failures (429/5xx/timeouts)
 */
async function fetchWithRetry(url, options, retryOpts) {
  const {
    maxAttempts = 3,
    perAttemptTimeoutMs = 90000,
    overallTimeoutMs = 540000,
    minBackoffMs = 1000,
    maxBackoffMs = 8000,
  } = retryOpts || {};

  const start = Date.now();
  let attempt = 0;
  let lastErr = null;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  while (attempt < maxAttempts && Date.now() - start < overallTimeoutMs) {
    attempt += 1;

    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), perAttemptTimeoutMs);

    try {
      const resp = await fetch(url, { ...options, signal: controller.signal });
      const text = await resp.text();

      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = { raw: text };
      }

      if (resp.ok) {
        return { ok: true, resp, parsed, attempt };
      }

      // Retry on 429 and most 5xx
      const retryable = resp.status === 429 || (resp.status >= 500 && resp.status <= 599);

      if (!retryable) {
        return { ok: false, resp, parsed, attempt, retryable: false };
      }

      // Retryable error
      console.log(
        "BROWSERLESS_HTTP_RETRYABLE",
        JSON.stringify({ attempt, status: resp.status, perAttemptTimeoutMs, overallTimeoutMs }).slice(0, 1000)
      );

      lastErr = new Error(`HTTP_${resp.status}`);
      lastErr.parsed = parsed;
      lastErr.status = resp.status;

      const backoff = Math.min(maxBackoffMs, minBackoffMs * Math.pow(2, attempt - 1));
      await sleep(backoff);
    } catch (err) {
      const isAbort = err?.name === "AbortError";
      const retryable = true;

      console.log(
        "BROWSERLESS_ERR",
        JSON.stringify({
          attempt,
          perAttemptTimeoutMs,
          retryable,
          name: err?.name,
          message: String(err?.message || err),
        }).slice(0, 2000)
      );

      lastErr = err;

      const backoff = Math.min(maxBackoffMs, minBackoffMs * Math.pow(2, attempt - 1));
      await sleep(backoff);
    } finally {
      clearTimeout(t);
    }
  }

  return {
    ok: false,
    attempt,
    error: lastErr ? String(lastErr?.message || lastErr) : "Unknown error",
    lastErr,
  };
}

// -------------------------
// /book endpoint
// IMPORTANT: Always returns HTTP 200 so Cloud Scheduler never marks it Failed.
// Use { ok:false, status:... } in JSON to see errors.
// -------------------------
app.post("/book", async (req, res) => {
  // Always 200 design (for Scheduler reliability)
  const reply200 = (payload) => res.status(200).json(payload);

  // API key check (still returns 200, but ok:false)
  if (!requireApiKey(req)) {
    return reply200({
      ok: false,
      status: "UNAUTHORIZED",
      error: "Unauthorized (invalid x-api-key)",
    });
  }

  const {
    BROWSERLESS_HTTP_BASE,
    BROWSERLESS_TOKEN,
    AMILIA_EMAIL,
    AMILIA_PASSWORD,
    // Optional tuning
    BROWSERLESS_OVERALL_TIMEOUT_MS,
    BROWSERLESS_PER_ATTEMPT_TIMEOUT_MS,
    BROWSERLESS_MAX_ATTEMPTS,
  } = process.env;

  if (!BROWSERLESS_HTTP_BASE || !BROWSERLESS_TOKEN) {
    return reply200({
      ok: false,
      status: "CONFIG_ERROR",
      error: "Browserless HTTP not configured",
      missing: {
        BROWSERLESS_HTTP_BASE: !BROWSERLESS_HTTP_BASE,
        BROWSERLESS_TOKEN: !BROWSERLESS_TOKEN,
      },
    });
  }

  if (!AMILIA_EMAIL || !AMILIA_PASSWORD) {
    return reply200({
      ok: false,
      status: "CONFIG_ERROR",
      error: "Amilia credentials not configured",
      missing: {
        AMILIA_EMAIL: !AMILIA_EMAIL,
        AMILIA_PASSWORD: !AMILIA_PASSWORD,
      },
    });
  }

  // ---- Defaults from Cloud Run env vars
  const DEFAULT_TARGET_DAY = process.env.TARGET_DAY || "Wednesday";
  const DEFAULT_EVENING_START = process.env.EVENING_START || "13:00";
  const DEFAULT_EVENING_END = process.env.EVENING_END || "20:00";
  const DEFAULT_TIMEZONE = process.env.LOCAL_TZ || "America/Toronto";
  const DEFAULT_ACTIVITY_URL =
    process.env.ACTIVITY_URL ||
    "https://app.amilia.com/store/en/ville-de-quebec1/shop/programs/calendar/126867?view=basicWeek&scrollToCalendar=true";
  const DEFAULT_DRY_RUN = (process.env.DRY_RUN || "false").toLowerCase() === "true";

  // Polling: how long to keep checking/clicking during the run
  const DEFAULT_POLL_SECONDS = clampInt(process.env.POLL_SECONDS, 5, 900, 540);
  const DEFAULT_POLL_INTERVAL_MS = clampInt(process.env.POLL_INTERVAL_MS, 500, 15000, 2500);

  // Post-click steps
  const DEFAULT_PLAYER_NAME = process.env.PLAYER_NAME || "Hari Prashanth Vaidyula";
  const DEFAULT_ADDRESS =
    process.env.ADDRESS_FULL || "383 rue des maraichers, quebec, qc, G1C 0K2";

  // ---- Overrides from request body
  const body = req.body || {};

  const rule = {
    targetDay: body.targetDay ?? DEFAULT_TARGET_DAY,
    eveningStart: body.eveningStart ?? DEFAULT_EVENING_START,
    eveningEnd: body.eveningEnd ?? DEFAULT_EVENING_END,
    timeZone: body.timeZone ?? DEFAULT_TIMEZONE,
    activityUrl: body.activityUrl ?? DEFAULT_ACTIVITY_URL,
    dryRun: typeof body.dryRun === "boolean" ? body.dryRun : DEFAULT_DRY_RUN,
    pollSeconds: Number.isFinite(Number(body.pollSeconds))
      ? clampInt(body.pollSeconds, 5, 900, DEFAULT_POLL_SECONDS)
      : DEFAULT_POLL_SECONDS,
    pollIntervalMs: Number.isFinite(Number(body.pollIntervalMs))
      ? clampInt(body.pollIntervalMs, 500, 15000, DEFAULT_POLL_INTERVAL_MS)
      : DEFAULT_POLL_INTERVAL_MS,
    playerName: body.playerName ?? DEFAULT_PLAYER_NAME,
    addressFull: body.addressFull ?? DEFAULT_ADDRESS,
  };

  console.log("BOOK_START", JSON.stringify({ rule }).slice(0, 4000));

  // ---- Validation
  if (!VALID_DAYS.includes(rule.targetDay)) {
    return reply200({
      ok: false,
      status: "VALIDATION_ERROR",
      error: "Invalid targetDay",
      provided: rule.targetDay,
      allowed: VALID_DAYS,
      rule,
    });
  }

  if (!isValidHHMM(rule.eveningStart) || !isValidHHMM(rule.eveningEnd)) {
    return reply200({
      ok: false,
      status: "VALIDATION_ERROR",
      error: "Invalid eveningStart/eveningEnd (expected HH:MM)",
      provided: { eveningStart: rule.eveningStart, eveningEnd: rule.eveningEnd },
      examples: ["13:00", "18:30", "21:00"],
      rule,
    });
  }

  if (!isValidCalendarUrl(rule.activityUrl)) {
    return reply200({
      ok: false,
      status: "VALIDATION_ERROR",
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

  /**
   * Browserless Function API: Puppeteer-like runtime
   */
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
    POLL_INTERVAL_MS,
    PLAYER_NAME,
    ADDRESS_FULL
  } = context;

  // Safety defaults
  page.setDefaultTimeout(30000);
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  const hhmmToMinutes = (hhmm) => {
    const m = /^([01]?\\d|2[0-3]):([0-5]\\d)$/.exec(hhmm || "");
    if (!m) return null;
    return Number(m[1]) * 60 + Number(m[2]);
  };

  const windowStartMin = hhmmToMinutes(EVENING_START);
  const windowEndMin = hhmmToMinutes(EVENING_END);

  const normalize = (s) => String(s || "").replace(/\\s+/g, " ").trim();

  // -------------------------
  // 1) Login
  // -------------------------
  await page.goto("https://app.amilia.com/en/login", {
    waitUntil: "domcontentloaded",
    timeout: 60000
  });

  const emailSel = 'input[type="email"], input[name*="email" i]';
  const passSel  = 'input[type="password"], input[name*="password" i]';

  await page.waitForSelector(emailSel, { timeout: 20000 });
  await page.click(emailSel, { clickCount: 3 });
  await page.keyboard.type(EMAIL, { delay: 10 });

  await page.waitForSelector(passSel, { timeout: 20000 });
  await page.click(passSel, { clickCount: 3 });
  await page.keyboard.type(PASSWORD, { delay: 10 });

  const submitSel = 'button[type="submit"], input[type="submit"]';
  const submit = await page.$(submitSel);
  if (submit) {
    await submit.click();
  } else {
    await page.focus(passSel);
    await page.keyboard.press("Enter");
  }

  // Don't hard-fail if login redirect is slow; we proceed anyway
  await page.waitForFunction(() => !location.href.includes("/login"), { timeout: 60000 }).catch(() => {});

  // -------------------------
  // 2) Go to calendar
  // -------------------------
  await page.goto(ACTIVITY_URL, { waitUntil: "networkidle2", timeout: 60000 });
  await sleep(1200);

  // Strict success detection
  const getState = async () => {
    return await page.evaluate(() => {
      const normalizeLocal = (s) => String(s || "").replace(/\\s+/g, " ").trim();
      const bodyText = normalizeLocal(document.body?.innerText || "");
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
      const candidates = Array.from(document.querySelectorAll("button, a, [role='button']"));
      const byText = candidates.find(el => {
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
      const normalizeLocal = (s) => String(s || "").replace(/\\s+/g, " ").trim();

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
        const btn =
          container.querySelector("button.register, a.register, button[title='Register'], a[title='Register']") ||
          Array.from(container.querySelectorAll("button, a")).find(x => /register/i.test((x.innerText || "").trim()));

        if (!btn) continue;
        if (!isVisible(btn)) continue;

        const text = normalizeLocal(container.innerText || "");
        candidates.push({ text, btn });
      }

      const parseStartMinutes = (text) => {
        const s = (text || "").toLowerCase();

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
        pickedText: (pick.text || "").slice(0, 200),
        pickedStartMin: pick.startMin
      };
    }, { windowStartMin, windowEndMin });
  };

  // -------------------------
  // 3) After clicking Register: Select player + enter address + proceed
  // -------------------------
  const selectPlayerAndProceed = async () => {
    // Player checkbox by label text
    const didPlayer = await page.evaluate((playerName) => {
      const norm = (s) => String(s || "").replace(/\\s+/g, " ").trim().toLowerCase();
      const p = norm(playerName);

      // Try labels containing player name
      const labels = Array.from(document.querySelectorAll("label"));
      const lab = labels.find(l => norm(l.innerText).includes(p));
      if (lab) {
        const forId = lab.getAttribute("for");
        if (forId) {
          const input = document.getElementById(forId);
          if (input && input.type === "checkbox" && !input.checked) input.click();
          else lab.click();
          return { ok: true, via: "label_for" };
        }
        // If label wraps checkbox
        const cb = lab.querySelector("input[type='checkbox']");
        if (cb && !cb.checked) cb.click();
        else lab.click();
        return { ok: true, via: "label_wrap" };
      }

      // Fallback: any checkbox row containing text
      const rows = Array.from(document.querySelectorAll("div, li, tr"));
      const row = rows.find(r => norm(r.innerText).includes(p));
      if (row) {
        const cb = row.querySelector("input[type='checkbox']");
        if (cb) { if (!cb.checked) cb.click(); return { ok: true, via: "row_checkbox" }; }
      }

      return { ok: false, reason: "PLAYER_NOT_FOUND" };
    }, PLAYER_NAME);

    // Click Next/Proceed
    const didNext = await page.evaluate(() => {
      const norm = (s) => String(s || "").replace(/\\s+/g, " ").trim().toLowerCase();
      const btns = Array.from(document.querySelectorAll("button, a, [role='button'], input[type='submit']"))
        .filter(el => {
          const t = norm(el.innerText || el.value || "");
          return ["next", "proceed", "continue", "submit"].some(k => t === k || t.includes(k));
        });

      const b = btns.find(x => !x.disabled) || null;
      if (!b) return { ok: false, reason: "NEXT_NOT_FOUND" };
      b.click();
      return { ok: true };
    });

    return { didPlayer, didNext };
  };

  const fillAddressAndProceed = async () => {
    // Address input: search for inputs that look like address/autocomplete
    await sleep(800);

    const didFill = await page.evaluate((addressFull) => {
      const norm = (s) => String(s || "").replace(/\\s+/g, " ").trim().toLowerCase();

      const inputs = Array.from(document.querySelectorAll("input[type='text'], input:not([type])"));
      const addr = inputs.find(i => {
        const ph = norm(i.getAttribute("placeholder") || "");
        const nm = norm(i.getAttribute("name") || "");
        const ar = norm(i.getAttribute("aria-label") || "");
        const id = norm(i.getAttribute("id") || "");
        return (
          ph.includes("address") || ph.includes("search") ||
          nm.includes("address") || ar.includes("address") ||
          id.includes("address")
        );
      });

      if (!addr) return { ok: false, reason: "ADDRESS_INPUT_NOT_FOUND" };

      addr.focus();
      addr.value = "";
      addr.dispatchEvent(new Event("input", { bubbles: true }));

      // Type by setting value (faster / reliable in some headless contexts)
      addr.value = addressFull;
      addr.dispatchEvent(new Event("input", { bubbles: true }));
      addr.dispatchEvent(new Event("change", { bubbles: true }));

      return { ok: true };
    }, ADDRESS_FULL);

    // Wait for autocomplete and pick best match if present
    await sleep(1200);

    const didPickSuggestion = await page.evaluate((addressFull) => {
      const norm = (s) => String(s || "").replace(/\\s+/g, " ").trim().toLowerCase();
      const target = norm(addressFull);

      // Common suggestion containers
      const items = Array.from(document.querySelectorAll(
        "[role='option'], li, .pac-item, .autocomplete-item, .suggestion, .MuiAutocomplete-option"
      )).filter(el => (el.innerText || "").trim().length > 0);

      if (items.length === 0) return { ok: false, reason: "NO_SUGGESTIONS_FOUND" };

      // Best match or first
      const best = items.find(x => norm(x.innerText).includes(target.slice(0, 12))) || items[0];
      best.click();
      return { ok: true, picked: (best.innerText || "").slice(0, 120), count: items.length };
    }, ADDRESS_FULL);

    await sleep(600);

    const didNext = await page.evaluate(() => {
      const norm = (s) => String(s || "").replace(/\\s+/g, " ").trim().toLowerCase();
      const btns = Array.from(document.querySelectorAll("button, a, [role='button'], input[type='submit']"))
        .filter(el => {
          const t = norm(el.innerText || el.value || "");
          return ["next", "proceed", "continue", "save"].some(k => t === k || t.includes(k));
        });

      const b = btns.find(x => !x.disabled) || null;
      if (!b) return { ok: false, reason: "NEXT_NOT_FOUND" };
      b.click();
      return { ok: true };
    });

    return { didFill, didPickSuggestion, didNext };
  };

  // If already success, exit early
  let lastState = await getState();
  if (lastState.success) {
    return {
      data: { status: "DONE_ALREADY_SUCCESS", finalState: lastState },
      type: "application/json"
    };
  }

  const maxAttempts = Math.max(1, Math.floor((Number(POLL_SECONDS) * 1000) / Number(POLL_INTERVAL_MS)));
  let attempts = 0;
  let lastClick = null;
  let postSteps = null;

  // -------------------------
  // 4) Poll loop
  // -------------------------
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

    // Try post-register flow (player + next + address)
    // We do this opportunistically; if not on that step yet, these helpers just won't find elements.
    postSteps = postSteps || {};
    try {
      const sp = await selectPlayerAndProceed();
      postSteps.selectPlayer = sp;
    } catch {}

    try {
      const fa = await fillAddressAndProceed();
      postSteps.fillAddress = fa;
    } catch {}

    lastState = await getState();
    if (lastState.success) break;

    if (lastState.cannotRegister || lastState.notOpenedYet) {
      await closeModalIfPresent();
    }

    await sleep(Number(POLL_INTERVAL_MS));
  }

  const finalState = await getState();
  const outcome =
    finalState.success ? "SUCCESS" :
    (attempts >= maxAttempts ? "TIMEOUT" : "STOPPED");

  return {
    data: {
      status: "POLLING_DONE",
      outcome,
      attempts,
      lastClick,
      postSteps,
      finalState
    },
    type: "application/json"
  };
}
`.trim();

  // ---- Browserless tuning (from env vars)
  const retryOpts = {
    overallTimeoutMs: clampInt(BROWSERLESS_OVERALL_TIMEOUT_MS, 30000, 900000, 540000),
    perAttemptTimeoutMs: clampInt(BROWSERLESS_PER_ATTEMPT_TIMEOUT_MS, 10000, 240000, 90000),
    maxAttempts: clampInt(BROWSERLESS_MAX_ATTEMPTS, 1, 10, 3),
    minBackoffMs: 1000,
    maxBackoffMs: 8000,
  };

  // IMPORTANT: Cloud Run Request Timeout you already set to 900s,
  // so keep overall under 900s. We default to 540s.
  const payload = {
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
      PLAYER_NAME: rule.playerName,
      ADDRESS_FULL: rule.addressFull,
    },
  };

  const result = await fetchWithRetry(
    functionUrl,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    },
    retryOpts
  );

  // Always HTTP 200 back to Scheduler
  if (!result.ok) {
    const status = result?.resp?.status;
    const parsed = result?.parsed ?? result?.lastErr?.parsed ?? { error: result?.error };

    console.log(
      "BROWSERLESS_FINAL_FAIL",
      JSON.stringify({
        message: `fetchWithRetry failed after ${result.attempt || retryOpts.maxAttempts} attempt(s)`,
        status,
        error: result.error,
      }).slice(0, 2000)
    );

    return reply200({
      ok: false,
      status: status ? "BROWSERLESS_HTTP_ERROR" : "BROWSERLESS_FETCH_FAILED",
      httpStatus: status,
      rule,
      browserless: parsed,
      retry: {
        attempts: result.attempt || retryOpts.maxAttempts,
        perAttemptTimeoutMs: retryOpts.perAttemptTimeoutMs,
        overallTimeoutMs: retryOpts.overallTimeoutMs,
        maxAttempts: retryOpts.maxAttempts,
      },
    });
  }

  const safeBody = result.parsed?.data?.data || result.parsed?.data || result.parsed;

  console.log("[BOOK] Browserless response:", JSON.stringify(safeBody).slice(0, 2000));

  // IMPORTANT: Always respond 200
  return reply200({
    ok: true,
    status: "BROWSERLESS_OK",
    rule,
    browserless: safeBody,
    retry: {
      attempt: result.attempt,
      perAttemptTimeoutMs: retryOpts.perAttemptTimeoutMs,
      overallTimeoutMs: retryOpts.overallTimeoutMs,
      maxAttempts: retryOpts.maxAttempts,
    },
  });
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
