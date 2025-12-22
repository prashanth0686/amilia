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
  // Accepts "H:MM" or "HH:MM"
  return /^([01]?\d|2[0-3]):[0-5]\d$/.test(v || "");
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

  // === DEFAULTS (from Cloud Run env vars) ===
  const DEFAULT_TARGET_DAY = process.env.TARGET_DAY || "Saturday";
  const DEFAULT_EVENING_START = process.env.EVENING_START || "17:00";
  const DEFAULT_EVENING_END = process.env.EVENING_END || "22:00";
  const DEFAULT_TIMEZONE = process.env.LOCAL_TZ || "America/Toronto";
  const DEFAULT_ACTIVITY_URL =
    process.env.ACTIVITY_URL ||
    "https://app.amilia.com/store/en/ville-de-quebec1/shop/activities/6112282?scrollToCalendar=true&view=month";

  // === OVERRIDES (from request body) ===
  // Allows n8n / PowerShell to set a different day/time window/activity without redeploy
  const body = req.body || {};
  const targetDay = body.targetDay || DEFAULT_TARGET_DAY;
  const eveningStart = body.eveningStart || DEFAULT_EVENING_START;
  const eveningEnd = body.eveningEnd || DEFAULT_EVENING_END;
  const timeZone = body.timeZone || DEFAULT_TIMEZONE;
  const activityUrl = body.activityUrl || DEFAULT_ACTIVITY_URL;

  // Build rule object (requested format)
  const rule = { targetDay, eveningStart, eveningEnd, timeZone, activityUrl };

  // Validate overrides
  if (!VALID_DAYS.includes(targetDay)) {
    return res.status(400).json({
      error: "Invalid targetDay",
      provided: targetDay,
      allowed: VALID_DAYS,
    });
  }

  if (!isValidHHMM(eveningStart) || !isValidHHMM(eveningEnd)) {
    return res.status(400).json({
      error: "Invalid eveningStart/eveningEnd (expected HH:MM)",
      provided: { eveningStart, eveningEnd },
      examples: ["17:00", "18:30", "21:00"],
    });
  }

  if (typeof activityUrl !== "string" || !activityUrl.includes("/shop/activities/")) {
    return res.status(400).json({
      error: "Invalid activityUrl (must include /shop/activities/)",
      provided: activityUrl,
      example:
        "https://app.amilia.com/store/en/ville-de-quebec1/shop/activities/6112282?scrollToCalendar=true&view=month",
    });
  }

  const functionUrl = `${BROWSERLESS_HTTP_BASE.replace(
    /\/$/,
    ""
  )}/function?token=${encodeURIComponent(BROWSERLESS_TOKEN)}`;

  // IMPORTANT: Browserless Function is Puppeteer-compatible, not Playwright.
  const code = `
  export default async function ({ page, context }) {
    const {
      EMAIL,
      PASSWORD,
      TARGET_DAY,
      EVENING_START,
      EVENING_END,
      TIME_ZONE,
      ACTIVITY_URL
    } = context;

    page.setDefaultTimeout(30000);

    // Helper (inside Browserless runtime)
    const hhmmToMinutes = (hhmm) => {
      const m = /^([01]?\\d|2[0-3]):([0-5]\\d)$/.exec(hhmm || "");
      if (!m) return null;
      return Number(m[1]) * 60 + Number(m[2]);
    };

    // 1) Go to Amilia login
    await page.goto("https://app.amilia.com/en/login", {
      waitUntil: "domcontentloaded",
      timeout: 60000
    });

    // 2) Fill credentials
    const emailSel = 'input[type="email"], input[name*="email" i]';
    const passSel  = 'input[type="password"], input[name*="password" i]';

    await page.waitForSelector(emailSel);
    await page.type(emailSel, EMAIL, { delay: 10 });

    await page.waitForSelector(passSel);
    await page.type(passSel, PASSWORD, { delay: 10 });

    // 3) Submit
    const submitSel = 'button[type="submit"], input[type="submit"]';
    const submit = await page.$(submitSel);
    if (submit) {
      await submit.click();
    } else {
      await page.focus(passSel);
      await page.keyboard.press("Enter");
    }

    // 4) Wait for login to complete (SPA-safe)
    await page.waitForFunction(
      () => !location.href.includes("/login"),
      { timeout: 60000 }
    ).catch(() => {});

    // 5) Go to your activity calendar page (where slots show after clicking "Register for drop-in")
    await page.goto(ACTIVITY_URL, {
      waitUntil: "networkidle2",
      timeout: 60000
    });

    // 6) Return debug info (Phase 1 complete), plus rule values
    const bodyText = await page.evaluate(() => document.body?.innerText || "");

    return {
      data: {
        status: "LOGGED_IN_AND_ACTIVITY_PAGE_LOADED",
        url: page.url(),
        pageLength: bodyText.length,

        // Rule config that was applied (confirms overrides worked)
        rule: {
          targetDay: TARGET_DAY,
          eveningStart: EVENING_START,
          eveningEnd: EVENING_END,
          timeZone: TIME_ZONE,
          activityUrl: ACTIVITY_URL,
          eveningStartMin: hhmmToMinutes(EVENING_START),
          eveningEndMin: hhmmToMinutes(EVENING_END)
        }
      },
      type: "application/json"
    };
  }
`.trim();

  const controller = new AbortController();
  const timeoutMs = 180000; // allow time for login + navigation
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

          // pass rule config
          TARGET_DAY: targetDay,
          EVENING_START: eveningStart,
          EVENING_END: eveningEnd,
          TIME_ZONE: timeZone,
          ACTIVITY_URL: activityUrl,
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
      });
    }

    return res.json({
      status: "BROWSERLESS_HTTP_OK",
      rule,
      browserless: parsed,
    });
  } catch (err) {
    const isAbort = err?.name === "AbortError";
    return res.status(504).json({
      error: isAbort
        ? "Browserless HTTP request timed out"
        : "Browserless HTTP request failed",
      details: String(err?.message || err),
    });
  } finally {
    clearTimeout(t);
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
