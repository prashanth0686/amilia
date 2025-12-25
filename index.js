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

const VALID_DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function isValidHHMM(v) {
  // Accepts "H:MM" or "HH:MM"
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

app.post("/book", async (req, res) => {
  if (!requireApiKey(req, res)) return;

  const { BROWSERLESS_HTTP_BASE, BROWSERLESS_TOKEN, AMILIA_EMAIL, AMILIA_PASSWORD } = process.env;

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

  // === DEFAULTS (from Cloud Run env vars) ===
  const DEFAULT_TARGET_DAY = process.env.TARGET_DAY || "Saturday";
  const DEFAULT_EVENING_START = process.env.EVENING_START || "18:00";
  const DEFAULT_EVENING_END = process.env.EVENING_END || "21:00";
  const DEFAULT_TIMEZONE = process.env.LOCAL_TZ || "America/Toronto";
  const DEFAULT_ACTIVITY_URL =
    process.env.ACTIVITY_URL ||
    "https://app.amilia.com/store/en/ville-de-quebec1/shop/programs/calendar/126867?view=basicWeek&scrollToCalendar=true";
  const DEFAULT_DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";
  const DEFAULT_POLL_SECONDS = Number(process.env.POLL_SECONDS || "90");
  const DEFAULT_POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS || "3000");

  // === OVERRIDES (from request body) ===
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
    Number.isFinite(Number(body.pollIntervalMs))
      ? Number(body.pollIntervalMs)
      : DEFAULT_POLL_INTERVAL_MS;

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

  /**
   * Browserless Function API = Puppeteer-like runtime.
   * No page.waitForTimeout(). Use sleep().
   */
  const code = `
export default async function ({ page, context }) {
  const {
    EMAIL,
    PASSWORD,
    TARGET_DAY,
    EVENING_START,
    EVENING_END,
    TIME_ZONE,
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

  // STRICT success detection:
  // Only treat as success if we entered quick-register or cart/checkout flows (URL-based).
  const getState = async () => {
    return await page.evaluate(() => {
      const normalize = (s) => String(s || "").replace(/\\s+/g, " ").trim();
      const bodyText = normalize(document.body?.innerText || "");
      const url = location.href;

      const hasQuickReg = /[?&]quickRegisterId=\\d+/.test(url);
      const onCart = /\\/cart\\b/i.test(url);
      const onCheckout = /\\/checkout\\b/i.test(url);

      const cannotRegister = /cannot register/i.test(bodyText);
      const notOpenedYet = /registration has not yet been opened/i.test(bodyText);

      return {
        url,
        hasQuickReg,
        onCart,
        onCheckout,
        success: Boolean(hasQuickReg || onCart || onCheckout),
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

      // Only consider Register buttons inside calendar/event containers (ignore nav/menu)
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

        // 12h: 7:00 pm
        let m = s.match(/\\b(\\d{1,2}):(\\d{2})\\s*(am|pm)\\b/);
        if (m) {
          let hh = Number(m[1]);
          const mm = Number(m[2]);
          const ap = m[3];
          if (ap === "pm" && hh !== 12) hh += 12;
          if (ap === "am" && hh === 12) hh = 0;
          return hh * 60 + mm;
        }

        // 24h: 19:00
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
        return { clicked: false, reason: "NO_REGISTER_IN_CALENDAR", candidatesFound: candidates.length, filteredFound: filtered.length };
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

  // If already success (rare), return (STRICT now)
  const initial = await getState();
  if (initial.success) {
    return {
      data: {
        status: "POLLING_DONE",
        url: initial.url,
        attempts: 0,
        finalState: initial,
        clickResult: { outcome: "SUCCESS_ALREADY", attempts: 0, state: initial },
        rule: {
          targetDay: TARGET_DAY,
          eveningStart: EVENING_START,
          eveningEnd: EVENING_END,
          timeZone: TIME_ZONE,
          activityUrl: ACTIVITY_URL,
          dryRun: DRY_RUN,
          pollSeconds: POLL_SECONDS,
          pollIntervalMs: POLL_INTERVAL_MS,
          eveningStartMin: windowStartMin,
          eveningEndMin: windowEndMin
        }
      },
      type: "application/json"
    };
  }

  let lastClick = null;
  let lastState = initial;

  // -------- 3) Poll loop --------
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

    // small wait for SPA navigation to settle
    await sleep(800);

    // extra short loop to catch delayed quickRegister/cart transitions
    for (let i = 0; i < 5; i++) {
      await sleep(500);
      const s = await getState();
      if (s.success) { lastState = s; break; }
      lastState = s;
    }

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
      clickResult: lastClick ? { outcome, attempts, lastClick, state: finalState } : { outcome, attempts, state: finalState },
      rule: {
        targetDay: TARGET_DAY,
        eveningStart: EVENING_START,
        eveningEnd: EVENING_END,
        timeZone: TIME_ZONE,
        activityUrl: ACTIVITY_URL,
        dryRun: DRY_RUN,
        pollSeconds: POLL_SECONDS,
        pollIntervalMs: POLL_INTERVAL_MS,
        eveningStartMin: windowStartMin,
        eveningEndMin: windowEndMin
      }
    },
    type: "application/json"
  };
}
`.trim();

  // Cloud Run -> Browserless HTTP call timeout
  const controller = new AbortController();
  const timeoutMs = 240000; // 4 minutes to allow polling
  const t = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const resp = await fetch(functionUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({
        code,
        context: {
          EMAIL: AMILIA_EMAIL,
          PASSWORD: AMILIA_PASSWORD,
          TARGET_DAY: rule.targetDay,
          EVENING_START: rule.eveningStart,
          EVENING_END: rule.eveningEnd,
          TIME_ZONE: rule.timeZone,
          ACTIVITY_URL: rule.activityUrl,
          DRY_RUN: rule.dryRun,
          POLL_SECONDS: rule.pollSeconds,
          POLL_INTERVAL_MS: rule.pollIntervalMs,
        },
      }),
    });

    const text = await resp.text();

    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = { raw: text };
    }

    if (!resp.ok) {
      return res.status(502).json({
        error: "Browserless Function API error",
        httpStatus: resp.status,
        body: parsed,
        rule,
      });
    }

    // Helpful server-side log line for Cloud Run logs
    console.log("[BOOK] Browserless response:", JSON.stringify(parsed?.data || parsed).slice(0, 2000));
    console.log(
      "BOOK_RESULT",
      JSON.stringify({
        status: "BROWSERLESS_HTTP_OK",
        rule,
        browserless: parsed?.data?.data || parsed?.data || parsed,
      })
    );

    return res.json({
      status: "BROWSERLESS_HTTP_OK",
      browserless: parsed,
      rule,
    });
  } catch (err) {
    const isAbort = err?.name === "AbortError";
    return res.status(504).json({
      error: isAbort ? "Browserless HTTP request timed out" : "Browserless HTTP request failed",
      details: String(err?.message || err),
      rule,
    });
  } finally {
    clearTimeout(t);
  }
});

app.listen(PORT, () => {
  console.log(\`Server running on port \${PORT}\`);
});
