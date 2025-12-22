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
  // "H:MM" or "HH:MM"
  return /^([01]?\d|2[0-3]):[0-5]\d$/.test(v || "");
}

function normalizeBaseUrl(u) {
  return String(u || "").replace(/\/$/, "");
}

function parseBool(v, defaultValue = false) {
  if (v === undefined || v === null) return defaultValue;
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v !== 0;
  if (typeof v === "string") {
    const s = v.trim().toLowerCase();
    if (["true", "1", "yes", "y"].includes(s)) return true;
    if (["false", "0", "no", "n"].includes(s)) return false;
  }
  return defaultValue;
}

function computeBookingOpensInfo(targetDay, timeZone, openHourLocal = 8, leadHours = 48) {
  // Conceptually: booking opens 48h before at 8:00 AM local time.
  // We return the "rule" explanation + an example mapping (day -> open day).
  // This is NOT scheduling; just info to confirm the logic.
  const idx = VALID_DAYS.indexOf(targetDay);
  const openDayIdx = (idx - 2 + 7) % 7; // 48h ~= 2 days
  return {
    ruleText: "Booking opens 48 hours before at 8:00 AM (local time).",
    targetDay,
    opensOnDay: VALID_DAYS[openDayIdx],
    opensAtLocal: `${String(openHourLocal).padStart(2, "0")}:00`,
    timeZone,
    leadHours,
  };
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

  // ========= DEFAULTS (Cloud Run env vars) =========
  const DEFAULT_TARGET_DAY = process.env.TARGET_DAY || "Wednesday";
  const DEFAULT_EVENING_START = process.env.EVENING_START || "18:00";
  const DEFAULT_EVENING_END = process.env.EVENING_END || "21:00";
  const DEFAULT_TIMEZONE = process.env.LOCAL_TZ || "America/Toronto";
  const DEFAULT_ACTIVITY_URL =
    process.env.ACTIVITY_URL ||
    "https://app.amilia.com/store/en/ville-de-quebec1/shop/activities/6564610?scrollToCalendar=true&view=month";

  // ========= OVERRIDES (request body) =========
  const body = req.body || {};

  const rule = {
    targetDay: body.targetDay ?? DEFAULT_TARGET_DAY,
    eveningStart: body.eveningStart ?? DEFAULT_EVENING_START,
    eveningEnd: body.eveningEnd ?? DEFAULT_EVENING_END,
    timeZone: body.timeZone ?? DEFAULT_TIMEZONE,
    activityUrl: body.activityUrl ?? DEFAULT_ACTIVITY_URL,
    // safety switch: default to true (no click) unless explicitly false
    dryRun: parseBool(body.dryRun, true),
  };

  // ========= VALIDATION =========
  if (!VALID_DAYS.includes(rule.targetDay)) {
    return res.status(400).json({
      error: "Invalid targetDay",
      provided: rule.targetDay,
      allowed: VALID_DAYS,
    });
  }

  if (!isValidHHMM(rule.eveningStart) || !isValidHHMM(rule.eveningEnd)) {
    return res.status(400).json({
      error: "Invalid eveningStart/eveningEnd (expected HH:MM)",
      provided: { eveningStart: rule.eveningStart, eveningEnd: rule.eveningEnd },
      examples: ["17:00", "18:30", "21:00"],
    });
  }

  if (typeof rule.activityUrl !== "string" || !rule.activityUrl.includes("/shop/activities/")) {
    return res.status(400).json({
      error: "Invalid activityUrl (must include /shop/activities/)",
      provided: rule.activityUrl,
      example:
        "https://app.amilia.com/store/en/ville-de-quebec1/shop/activities/6564610?scrollToCalendar=true&view=month",
    });
  }

  const functionUrl = `${normalizeBaseUrl(BROWSERLESS_HTTP_BASE)}/function?token=${encodeURIComponent(
    BROWSERLESS_TOKEN
  )}`;

  // ========= Browserless Function (Puppeteer-like runtime) =========
  // We:
  //  - login
  //  - go to ACTIVITY_URL
  //  - DOM probe: count "Register" buttons + sample HTML
  //  - if dryRun=false, click the first "Register" button and return what happens (URL/modal text)
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

  const truncate = (s, n = 1200) => {
    s = String(s || "");
    return s.length > n ? s.slice(0, n) + " ...[truncated]" : s;
  };

  const hhmmToMinutes = (hhmm) => {
    const m = /^([01]?\\\\d|2[0-3]):([0-5]\\\\d)$/.exec(hhmm || "");
    if (!m) return null;
    return Number(m[1]) * 60 + Number(m[2]);
  };

  // 1) Login page
  await page.goto("https://app.amilia.com/en/login", {
    waitUntil: "domcontentloaded",
    timeout: 60000
  });

  // 2) Fill credentials (resilient selectors)
  const emailSel = 'input[type="email"], input[name*="email" i]';
  const passSel  = 'input[type="password"], input[name*="password" i]';
  const submitSel = 'button[type="submit"], input[type="submit"]';

  await page.waitForSelector(emailSel, { timeout: 25000 });
  await page.click(emailSel);
  await page.keyboard.type(String(EMAIL), { delay: 10 });

  await page.waitForSelector(passSel, { timeout: 25000 });
  await page.click(passSel);
  await page.keyboard.type(String(PASSWORD), { delay: 10 });

  // 3) Submit
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

  // 5) Go directly to the activity calendar page
  await page.goto(String(ACTIVITY_URL), {
    waitUntil: "networkidle2",
    timeout: 60000
  });

  // Give it a moment for any calendar widgets to render
  await page.waitForTimeout(1500);

  // 6) DOM probe: count + sample the "Register" buttons & surrounding containers
  const domProbe = await page.evaluate(() => {
    const truncate = (s, n = 1200) => {
      s = String(s || "");
      return s.length > n ? s.slice(0, n) + " ...[truncated]" : s;
    };

    const candidates = Array.from(document.querySelectorAll('button, a, [role="button"]'));
    const registerButtons = candidates.filter((el) => {
      const t = (el.innerText || el.textContent || "").trim().toLowerCase();
      return t === "register" || t.includes("register");
    });

    const samples = registerButtons.slice(0, 2).map((el) => ({
      tag: el.tagName,
      text: (el.innerText || el.textContent || "").trim(),
      id: el.id || null,
      className: el.className || null,
      outerHTML: truncate(el.outerHTML, 1600),
    }));

    const containerSamples = registerButtons.slice(0, 2).map((btn) => {
      let node = btn;
      for (let i = 0; i < 4; i++) {
        if (node && node.parentElement) node = node.parentElement;
      }
      return { aroundButtonOuterHTML: truncate(node?.outerHTML || "", 2200) };
    });

    // also check if a "Cannot register" dialog exists (your screenshot)
    const dialogText = Array.from(document.querySelectorAll("div, section, article"))
      .map(el => (el.innerText || "").trim())
      .find(t => t.toLowerCase().includes("cannot register")) || null;

    return {
      pageTitle: document.title,
      registerButtonsCount: registerButtons.length,
      registerButtonsSamples: samples,
      containerSamples,
      cannotRegisterTextFound: dialogText ? truncate(dialogText, 600) : null
    };
  });

  let clickResult = null;

  if (!DRY_RUN) {
    // Click the first visible "Register" button by scanning candidates
    const didClick = await page.evaluate(() => {
      const candidates = Array.from(document.querySelectorAll('button, a, [role="button"]'));
      const registerButtons = candidates.filter((el) => {
        const t = (el.innerText || el.textContent || "").trim().toLowerCase();
        return t === "register" || t.includes("register");
      });

      const visible = registerButtons.find((el) => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      });

      if (!visible) return false;
      visible.click();
      return true;
    });

    // Wait a moment for modal/redirect
    await page.waitForTimeout(1500);

    const postClick = await page.evaluate(() => {
      const truncate = (s, n = 800) => {
        s = String(s || "");
        return s.length > n ? s.slice(0, n) + " ...[truncated]" : s;
      };

      // Find "Cannot register" dialog
      const maybeDialog = Array.from(document.querySelectorAll("div, section, article"))
        .map(el => (el.innerText || "").trim())
        .find(t => t.toLowerCase().includes("cannot register"));

      // Capture current URL (it may add quickRegisterId=...)
      return {
        url: location.href,
        cannotRegisterText: maybeDialog ? truncate(maybeDialog, 1000) : null
      };
    });

    clickResult = {
      attempted: true,
      clickedSomething: didClick,
      postClick
    };
  }

  return {
    data: {
      status: DRY_RUN ? "DOM_PROBE_OK" : "CLICK_TEST_DONE",
      url: page.url(),
      domProbe,
      clickResult,
      rule: {
        targetDay: TARGET_DAY,
        eveningStart: EVENING_START,
        eveningEnd: EVENING_END,
        timeZone: TIME_ZONE,
        activityUrl: ACTIVITY_URL,
        dryRun: DRY_RUN,
        eveningStartMin: hhmmToMinutes(EVENING_START),
        eveningEndMin: hhmmToMinutes(EVENING_END)
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

    // include booking-open logic explanation in output (so you can confirm Saturday->Thursday, etc.)
    const bookingOpens = computeBookingOpensInfo(rule.targetDay, rule.timeZone, 8, 48);

    return res.json({
      status: "BROWSERLESS_HTTP_OK",
      browserless: parsed,
      rule,
      bookingOpens,
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
