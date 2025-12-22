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

// --------------------
// Auth
// --------------------
function requireApiKey(req, res) {
  const apiKey = req.headers["x-api-key"];
  if (!apiKey || apiKey !== process.env.API_KEY) {
    res.status(401).json({ error: "Unauthorized (invalid x-api-key)" });
    return false;
  }
  return true;
}

// --------------------
// Validation helpers
// --------------------
const VALID_DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function isValidHHMM(v) {
  // "H:MM" or "HH:MM"
  return /^([01]?\d|2[0-3]):[0-5]\d$/.test(v || "");
}

function normalizeBaseUrl(u) {
  return String(u || "").replace(/\/$/, "");
}

function isValidActivityUrl(u) {
  if (typeof u !== "string") return false;
  return u.includes("/shop/activities/");
}

function hhmmToMinutes(hhmm) {
  const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(hhmm || "");
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

// --------------------
// /book
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

  // ---------- DEFAULTS (Cloud Run env vars) ----------
  const DEFAULT_TARGET_DAY = process.env.TARGET_DAY || "Wednesday";
  const DEFAULT_EVENING_START = process.env.EVENING_START || "18:00";
  const DEFAULT_EVENING_END = process.env.EVENING_END || "21:00";
  const DEFAULT_TIMEZONE = process.env.LOCAL_TZ || "America/Toronto";
  const DEFAULT_ACTIVITY_URL =
    process.env.ACTIVITY_URL ||
    "https://app.amilia.com/store/en/ville-de-quebec1/shop/activities/6564610?scrollToCalendar=true&view=month";
  const DEFAULT_DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

  // ---------- OVERRIDES (request body) ----------
  const body = req.body || {};

  const targetDay = body.targetDay ?? DEFAULT_TARGET_DAY;
  const eveningStart = body.eveningStart ?? DEFAULT_EVENING_START;
  const eveningEnd = body.eveningEnd ?? DEFAULT_EVENING_END;
  const timeZone = body.timeZone ?? DEFAULT_TIMEZONE;
  const activityUrl = body.activityUrl ?? DEFAULT_ACTIVITY_URL;
  const dryRun = typeof body.dryRun === "boolean" ? body.dryRun : DEFAULT_DRY_RUN;

  const rule = { targetDay, eveningStart, eveningEnd, timeZone, activityUrl, dryRun };

  // ---------- VALIDATION ----------
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
      examples: ["17:00", "18:30", "21:00"],
      rule,
    });
  }

  if (!isValidActivityUrl(rule.activityUrl)) {
    return res.status(400).json({
      error: "Invalid activityUrl (must include /shop/activities/)",
      provided: rule.activityUrl,
      example:
        "https://app.amilia.com/store/en/ville-de-quebec1/shop/activities/6564610?scrollToCalendar=true&view=month&date=2025-12-30",
      rule,
    });
  }

  const functionUrl = `${normalizeBaseUrl(BROWSERLESS_HTTP_BASE)}/function?token=${encodeURIComponent(
    BROWSERLESS_TOKEN
  )}`;

  // Browserless Function API = Puppeteer-like runtime.
  // IMPORTANT: no page.waitForTimeout() -> use sleep helper
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
    DRY_RUN
  } = context;

  page.setDefaultTimeout(30000);

  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  const hhmmToMinutes = (hhmm) => {
    const m = /^([01]?\\d|2[0-3]):([0-5]\\d)$/.exec(hhmm || "");
    if (!m) return null;
    return Number(m[1]) * 60 + Number(m[2]);
  };

  // Parse strings like:
  // "7:00 pm - 7:55 pm"
  const parseTimeRangeToMinutes = (s) => {
    const t = String(s || "").toLowerCase().replace(/\\s+/g, " ").trim();
    const m = /(\\d{1,2}):(\\d{2})\\s*(am|pm)\\s*[-–]\\s*(\\d{1,2}):(\\d{2})\\s*(am|pm)/i.exec(t);
    if (!m) return null;

    const toMin = (hh, mm, ap) => {
      let h = Number(hh);
      const minutes = Number(mm);
      const isPm = ap === "pm";
      const isAm = ap === "am";
      if (isPm && h !== 12) h += 12;
      if (isAm && h === 12) h = 0;
      return h * 60 + minutes;
    };

    return {
      startMin: toMin(m[1], m[2], m[3]),
      endMin: toMin(m[4], m[5], m[6]),
      raw: t
    };
  };

  // --------------------
  // 1) Login
  // --------------------
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

  // SPA-safe: wait until we're not on /login (best-effort)
  await page.waitForFunction(() => !location.href.includes("/login"), { timeout: 60000 }).catch(() => {});

  // --------------------
  // 2) Go to activity calendar page
  // --------------------
  await page.goto(ACTIVITY_URL, {
    waitUntil: "networkidle2",
    timeout: 60000
  });

  // Let client JS paint the calendar
  await sleep(1500);

  // --------------------
  // 3) Extract REAL slot tiles + register buttons (ignore nav "Register")
  //    We only look inside fullcalendar event tiles:
  //    div.fc-event.activity-segment ...
  // --------------------
  const probe = await page.evaluate(() => {
    const norm = (s) => String(s || "").replace(/\\s+/g, " ").trim();

    const tiles = Array.from(document.querySelectorAll("div.fc-event.activity-segment"));
    const results = tiles.map(tile => {
      const timeText = norm(tile.querySelector(".fc-time")?.innerText);
      const titleText = norm(tile.querySelector(".fc-title")?.innerText);
      const registerBtn = tile.querySelector("button.register");

      return {
        hasRegisterButton: !!registerBtn,
        timeText,
        titleText,
        buttonTag: registerBtn ? registerBtn.tagName : null,
        buttonClass: registerBtn ? registerBtn.className : null,
        buttonTitle: registerBtn ? registerBtn.getAttribute("title") : null,
        // small HTML snippet so we can debug if needed
        tileClass: tile.className
      };
    });

    const registerTileCount = results.filter(r => r.hasRegisterButton).length;

    return {
      calendarTilesCount: tiles.length,
      tilesWithRegisterCount: registerTileCount,
      sampleTiles: results.slice(0, 5)
    };
  });

  const startWindowMin = hhmmToMinutes(EVENING_START);
  const endWindowMin   = hhmmToMinutes(EVENING_END);

  // --------------------
  // 4) Find candidate slot(s) by time window (client-side)
  // --------------------
  const candidates = await page.evaluate(({ startWindowMin, endWindowMin }) => {
    const norm = (s) => String(s || "").replace(/\\s+/g, " ").trim();

    const parseRange = (s) => {
      const t = String(s || "").toLowerCase().replace(/\\s+/g, " ").trim();
      const m = /(\\d{1,2}):(\\d{2})\\s*(am|pm)\\s*[-–]\\s*(\\d{1,2}):(\\d{2})\\s*(am|pm)/i.exec(t);
      if (!m) return null;

      const toMin = (hh, mm, ap) => {
        let h = Number(hh);
        const minutes = Number(mm);
        if (ap === "pm" && h !== 12) h += 12;
        if (ap === "am" && h === 12) h = 0;
        return h * 60 + minutes;
      };

      return {
        startMin: toMin(m[1], m[2], m[3]),
        endMin: toMin(m[4], m[5], m[6]),
        raw: t
      };
    };

    const tiles = Array.from(document.querySelectorAll("div.fc-event.activity-segment"));
    const matched = [];

    for (let i = 0; i < tiles.length; i++) {
      const tile = tiles[i];
      const btn = tile.querySelector("button.register");
      if (!btn) continue;

      const timeText = norm(tile.querySelector(".fc-time")?.innerText);
      const titleText = norm(tile.querySelector(".fc-title")?.innerText);

      const range = parseRange(timeText);
      if (!range) continue;

      // Keep only those whose start time is within [startWindowMin, endWindowMin]
      // and end time <= endWindowMin (strict)
      const within =
        range.startMin >= startWindowMin &&
        range.endMin <= endWindowMin;

      if (within) {
        matched.push({
          index: i,
          timeText,
          titleText,
          startMin: range.startMin,
          endMin: range.endMin,
          tileClass: tile.className
        });
      }
    }

    return matched;
  }, { startWindowMin, endWindowMin });

  // --------------------
  // 5) Click (if not dryRun)
  // --------------------
  let clickResult = null;

  if (!DRY_RUN && candidates.length > 0) {
    const targetIndex = candidates[0].index;

    const clicked = await page.evaluate(({ targetIndex }) => {
      const tiles = Array.from(document.querySelectorAll("div.fc-event.activity-segment"));
      const tile = tiles[targetIndex];
      if (!tile) return { attempted: true, clicked: false, reason: "tile_not_found" };

      const btn = tile.querySelector("button.register");
      if (!btn) return { attempted: true, clicked: false, reason: "button_not_found" };

      btn.click();
      return { attempted: true, clicked: true };
    }, { targetIndex });

    await sleep(1500);

    // detect modal outcome / url change
    const postClick = await page.evaluate(() => {
      const bodyText = String(document.body?.innerText || "").toLowerCase();
      const cannotRegister = bodyText.includes("cannot register");
      const notOpenedYet =
        bodyText.includes("registration has not yet been opened") ||
        bodyText.includes("has not yet been opened");

      const url = location.href;
      const hasQuickId = url.includes("quickRegisterId=");

      return { url, cannotRegister, notOpenedYet, hasQuickId };
    });

    clickResult = { ...clicked, postClick };
  }

  // --------------------
  // 6) Return summary
  // --------------------
  return {
    data: {
      status: DRY_RUN ? "DRY_RUN_OK" : "CLICK_ATTEMPTED",
      url: page.url(),
      probe,
      candidates,
      clickResult,
      rule: {
        targetDay: TARGET_DAY,
        eveningStart: EVENING_START,
        eveningEnd: EVENING_END,
        timeZone: TIME_ZONE,
        activityUrl: ACTIVITY_URL,
        dryRun: DRY_RUN,
        eveningStartMin: startWindowMin,
        eveningEndMin: endWindowMin
      }
    },
    type: "application/json"
  };
}
`.trim();

  // Cloud Run -> Browserless HTTP call timeout
  const controller = new AbortController();
  const timeoutMs = 180000; // 3 minutes
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
  console.log(`Server running on port ${PORT}`);
});
