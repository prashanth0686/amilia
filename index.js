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

// Safer “contains” check for activity URL
function isValidActivityUrl(u) {
  if (typeof u !== "string") return false;
  return u.includes("/shop/activities/");
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
  const DEFAULT_EVENING_START = process.env.EVENING_START || "18:00";
  const DEFAULT_EVENING_END = process.env.EVENING_END || "21:00";
  const DEFAULT_TIMEZONE = process.env.LOCAL_TZ || "America/Toronto";
  const DEFAULT_ACTIVITY_URL =
    process.env.ACTIVITY_URL ||
    "https://app.amilia.com/store/en/ville-de-quebec1/shop/activities/6112282?scrollToCalendar=true&view=month";
  const DEFAULT_DRY_RUN =
    (process.env.DRY_RUN || "true").toLowerCase() === "true";

  // === OVERRIDES (from request body) ===
  const body = req.body || {};

  const targetDay = body.targetDay ?? DEFAULT_TARGET_DAY;
  const eveningStart = body.eveningStart ?? DEFAULT_EVENING_START;
  const eveningEnd = body.eveningEnd ?? DEFAULT_EVENING_END;
  const timeZone = body.timeZone ?? DEFAULT_TIMEZONE;
  const activityUrl = body.activityUrl ?? DEFAULT_ACTIVITY_URL;
  const dryRun = typeof body.dryRun === "boolean" ? body.dryRun : DEFAULT_DRY_RUN;

  const rule = { targetDay, eveningStart, eveningEnd, timeZone, activityUrl, dryRun };

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
      examples: ["17:00", "18:30", "21:00"],
      rule,
    });
  }

  if (!isValidActivityUrl(rule.activityUrl)) {
    return res.status(400).json({
      error: "Invalid activityUrl (must include /shop/activities/)",
      provided: rule.activityUrl,
      example:
        "https://app.amilia.com/store/en/ville-de-quebec1/shop/activities/6112282?scrollToCalendar=true&view=month",
      rule,
    });
  }

  const functionUrl = `${normalizeBaseUrl(BROWSERLESS_HTTP_BASE)}/function?token=${encodeURIComponent(
    BROWSERLESS_TOKEN
  )}`;

  /**
   * IMPORTANT:
   * Browserless Function API = Puppeteer-like runtime.
   * Also, page.waitForTimeout() is NOT available in this runtime.
   * Use: await new Promise(r => setTimeout(r, ms));
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
    DRY_RUN
  } = context;

  page.setDefaultTimeout(30000);

  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  const hhmmToMinutes = (hhmm) => {
    const m = /^([01]?\\d|2[0-3]):([0-5]\\d)$/.exec(hhmm || "");
    if (!m) return null;
    return Number(m[1]) * 60 + Number(m[2]);
  };

  // ---- 1) Login ----
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

  // SPA-safe “login finished”
  await page.waitForFunction(() => !location.href.includes("/login"), { timeout: 60000 }).catch(() => {});

  // ---- 2) Go to activity calendar page ----
  await page.goto(ACTIVITY_URL, {
    waitUntil: "networkidle2",
    timeout: 60000
  });

  // let the calendar JS finish painting
  await sleep(1500);

  // ---- 3) DOM probe: ignore NAV “Register”, only count calendar-slot registers ----
  const domProbe = await page.evaluate(() => {
    const truncate = (s, n = 1200) => {
      const t = String(s || "");
      return t.length > n ? t.slice(0, n) + " ...[truncated]" : t;
    };

    const isRegisterText = (el) => {
      const t = (el.innerText || el.textContent || el.value || "").trim();
      return /\\bregister\\b/i.test(t);
    };

    const isVisible = (el) => {
      const r = el.getBoundingClientRect();
      if (!r || r.width === 0 || r.height === 0) return false;
      const style = window.getComputedStyle(el);
      if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") return false;
      return true;
    };

    // Probe ALL "Register" (for comparison/debugging)
    const allCandidates = Array.from(
      document.querySelectorAll("button, a, [role='button'], input[type='button'], input[type='submit']")
    );
    const allRegister = allCandidates.filter(el => isRegisterText(el));
    const allRegisterSamples = allRegister.slice(0, 2).map(el => ({
      tag: el.tagName,
      text: (el.innerText || el.value || "").trim(),
      href: el.getAttribute("href"),
      className: el.className || null,
      outerHTML: truncate(el.outerHTML, 1000)
    }));

    // Calendar-root scoping (this is the important part)
    // The “slot” register buttons are inside the calendar table.
    const calendarRoot =
      document.querySelector("table") ||
      document.querySelector("[class*=calendar]") ||
      document.querySelector("[id*=calendar]");

    let calendarRegister = [];
    let calendarRegisterSamples = [];

    if (calendarRoot) {
      const calendarCandidates = Array.from(
        calendarRoot.querySelectorAll("button, a, [role='button'], input[type='button'], input[type='submit']")
      );

      calendarRegister = calendarCandidates
        .filter(el => isRegisterText(el) && isVisible(el))
        // Extra safety: ignore top nav tabs/menus even if they appear under calendarRoot
        .filter(el => !el.closest("nav, header, [role='navigation'], .navbar, .nav, .nav-tabs"));

      calendarRegisterSamples = calendarRegister.slice(0, 2).map(el => {
        const container =
          el.closest("td, .fc-daygrid-event, .fc-event, .event, .slot, .tile, div, article, section") ||
          el.parentElement;

        return {
          tag: el.tagName,
          text: (el.innerText || el.value || "").trim(),
          href: el.getAttribute("href"),
          className: el.className || null,
          outerHTML: truncate(el.outerHTML, 1200),
          containerHTML: truncate(container?.outerHTML || "", 2000),
        };
      });
    }

    return {
      pageTitle: document.title,
      allRegisterButtonsCount: allRegister.length,
      allRegisterSamples,
      calendarRegisterButtonsCount: calendarRegister.length,
      calendarRegisterSamples,
      calendarRootFound: !!calendarRoot
    };
  });

  // ---- 4) Try clicking a visible calendar Register (optional) ----
  let clickResult = null;

  if (!DRY_RUN) {
    // Click FIRST calendar register button if present
    const clicked = await page.evaluate(() => {
      const isRegisterText = (el) => {
        const t = (el.innerText || el.textContent || el.value || "").trim();
        return /\\bregister\\b/i.test(t);
      };

      const isVisible = (el) => {
        const r = el.getBoundingClientRect();
        if (!r || r.width === 0 || r.height === 0) return false;
        const style = window.getComputedStyle(el);
        if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") return false;
        return true;
      };

      const calendarRoot =
        document.querySelector("table") ||
        document.querySelector("[class*=calendar]") ||
        document.querySelector("[id*=calendar]");

      if (!calendarRoot) return { attempted: true, clickedSomething: false, reason: "no_calendar_root" };

      const candidates = Array.from(
        calendarRoot.querySelectorAll("button, a, [role='button'], input[type='button'], input[type='submit']")
      )
        .filter(el => isRegisterText(el) && isVisible(el))
        .filter(el => !el.closest("nav, header, [role='navigation'], .navbar, .nav, .nav-tabs"));

      const target = candidates[0];
      if (!target) return { attempted: true, clickedSomething: false, reason: "no_calendar_register" };

      target.click();
      return { attempted: true, clickedSomething: true };
    });

    await sleep(1500);

    const postClick = await page.evaluate(() => {
      const normalize = (s) => String(s || "").replace(/\\s+/g, " ").trim();
      const bodyText = normalize(document.body?.innerText || "");

      const cannotRegister = /cannot register/i.test(bodyText);
      const notOpened = /registration has not yet been opened/i.test(bodyText);

      let snippet = null;
      const headline = Array.from(document.querySelectorAll("h1,h2,h3,div,span"))
        .map(el => (el.innerText || "").trim())
        .find(t => /cannot register/i.test(t));
      if (headline) snippet = headline;

      return {
        url: location.href,
        cannotRegister,
        notOpenedYet: notOpened,
        snippet
      };
    });

    clickResult = { ...clicked, postClick };
  }

  // ---- Return ----
  return {
    data: {
      status: "DOM_PROBE_OK",
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
