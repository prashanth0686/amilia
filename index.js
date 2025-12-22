import express from "express";

const app = express();
app.use(express.json({ limit: "2mb" }));

const PORT = process.env.PORT || 8080;

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
  // Accepts "H:MM" or "HH:MM"
  return /^([01]?\d|2[0-3]):[0-5]\d$/.test(String(v || ""));
}

function normalizeBaseUrl(u) {
  return String(u || "").replace(/\/$/, "");
}

function parseBool(v, defaultVal = false) {
  if (v === undefined || v === null) return defaultVal;
  if (typeof v === "boolean") return v;
  const s = String(v).trim().toLowerCase();
  if (["1", "true", "yes", "y", "on"].includes(s)) return true;
  if (["0", "false", "no", "n", "off"].includes(s)) return false;
  return defaultVal;
}

app.post("/book", async (req, res) => {
  if (!requireApiKey(req, res)) return;

  const {
    BROWSERLESS_HTTP_BASE,
    BROWSERLESS_TOKEN,
    AMILIA_EMAIL,
    AMILIA_PASSWORD,
  } = process.env;

  // Required envs
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

  // ===== DEFAULTS (Cloud Run env vars) =====
  const DEFAULT_TARGET_DAY = process.env.TARGET_DAY || "Wednesday";
  const DEFAULT_EVENING_START = process.env.EVENING_START || "18:00";
  const DEFAULT_EVENING_END = process.env.EVENING_END || "21:00";
  const DEFAULT_TIMEZONE = process.env.LOCAL_TZ || "America/Toronto";
  const DEFAULT_ACTIVITY_URL =
    process.env.ACTIVITY_URL ||
    "https://app.amilia.com/store/en/ville-de-quebec1/shop/activities/6112282?scrollToCalendar=true&view=month";

  // ===== OVERRIDES (request body) =====
  const body = req.body || {};

  const targetDay = body.targetDay ?? DEFAULT_TARGET_DAY;
  const eveningStart = body.eveningStart ?? DEFAULT_EVENING_START;
  const eveningEnd = body.eveningEnd ?? DEFAULT_EVENING_END;
  const timeZone = body.timeZone ?? DEFAULT_TIMEZONE;
  const activityUrl = body.activityUrl ?? DEFAULT_ACTIVITY_URL;

  // Safety: default dryRun=true (no registration click) unless explicitly set false
  const dryRun = parseBool(body.dryRun, true);

  const rule = { targetDay, eveningStart, eveningEnd, timeZone, activityUrl, dryRun };

  // ===== VALIDATION =====
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
        "https://app.amilia.com/store/en/ville-de-quebec1/shop/activities/6112282?scrollToCalendar=true&view=month",
    });
  }

  const functionUrl =
    `${normalizeBaseUrl(BROWSERLESS_HTTP_BASE)}` +
    `/function?token=${encodeURIComponent(BROWSERLESS_TOKEN)}`;

  // Browserless Function runtime is Puppeteer-like
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

  // Helpers
  const hhmmToMinutes = (hhmm) => {
    const m = /^([01]?\\d|2[0-3]):([0-5]\\d)$/.exec(String(hhmm || ""));
    if (!m) return null;
    return Number(m[1]) * 60 + Number(m[2]);
  };

  const parseTimeToMinutes = (s) => {
    // handles "7:00 pm", "7:55 PM", "19:30"
    if (!s) return null;
    const str = String(s).trim();

    // 24h format
    const m24 = /^([01]?\\d|2[0-3]):([0-5]\\d)$/.exec(str);
    if (m24) return Number(m24[1]) * 60 + Number(m24[2]);

    // 12h format
    const m12 = /^(\\d{1,2}):(\\d{2})\\s*(am|pm)$/i.exec(str.toLowerCase());
    if (!m12) return null;
    let h = Number(m12[1]);
    const min = Number(m12[2]);
    const ap = m12[3];
    if (ap === "pm" && h !== 12) h += 12;
    if (ap === "am" && h === 12) h = 0;
    return h * 60 + min;
  };

  const minutesToHHMM = (mins) => {
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    return String(h).padStart(2, "0") + ":" + String(m).padStart(2, "0");
  };

  const startMin = hhmmToMinutes(EVENING_START);
  const endMin   = hhmmToMinutes(EVENING_END);

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

  // SPA-safe wait: URL not including /login
  await page.waitForFunction(() => !location.href.includes("/login"), { timeout: 60000 }).catch(() => {});

  // 2) Go to activity calendar page directly (this is where Register buttons appear)
  await page.goto(ACTIVITY_URL, { waitUntil: "networkidle2", timeout: 60000 });

  // 3) Make sure calendar content is present
  await page.waitForFunction(() => {
    const txt = (document.body && document.body.innerText) ? document.body.innerText : "";
    return txt.includes("Register for a drop-in class") || txt.toLowerCase().includes("drop-in");
  }, { timeout: 60000 }).catch(() => {});

  // 4) Extract events currently visible in the month grid
  // We cannot rely on stable classes, so we scan for blocks that look like events
  const events = await page.evaluate(() => {
    // Find potential event blocks:
    // Often: a colored block with a time range and title, plus a "Register" button inside/near it.
    const candidates = Array.from(document.querySelectorAll("a, button, div"))
      .map(el => {
        const text = (el.innerText || "").trim();
        if (!text) return null;

        const hasTime = /\\b(\\d{1,2}:\\d{2}\\s*(am|pm)|\\d{1,2}:\\d{2})\\b/i.test(text) && text.includes("-");
        const hasRegisterWord = /\\bregister\\b/i.test(text);
        const looksEventy = hasTime || hasRegisterWord;

        if (!looksEventy) return null;

        return {
          tag: el.tagName,
          text: text.slice(0, 500),
        };
      })
      .filter(Boolean);

    // De-dup by text
    const seen = new Set();
    const unique = [];
    for (const c of candidates) {
      const key = c.text;
      if (seen.has(key)) continue;
      seen.add(key);
      unique.push(c);
    }
    return unique.slice(0, 200);
  });

  // 5) Click into the target day column by looking at headers (Sun..Sat)
  // then find "Register" buttons that belong to that day.
  // We'll do a more direct approach:
  // - locate column index for TARGET_DAY in the calendar header row
  // - collect cells under that column
  // - within those cells find event blocks & register buttons
  const target = await page.evaluate((TARGET_DAY) => {
    const dayShort = {
      Sunday:"Sun", Monday:"Mon", Tuesday:"Tue", Wednesday:"Wed",
      Thursday:"Thu", Friday:"Fri", Saturday:"Sat"
    }[TARGET_DAY] || TARGET_DAY;

    // Find header cells that contain the day label
    const headers = Array.from(document.querySelectorAll("th, .fc-col-header-cell, .fc-day-header"))
      .map((el, idx) => ({ idx, text: (el.innerText || "").trim() }))
      .filter(x => x.text);

    let headerIndex = -1;
    for (let i = 0; i < headers.length; i++) {
      const t = headers[i].text.toLowerCase();
      if (t === TARGET_DAY.toLowerCase() || t.startsWith(dayShort.toLowerCase())) {
        headerIndex = i;
        break;
      }
    }

    // If we can't find headers, we’ll still attempt to find register buttons globally.
    return { headerIndex, headers: headers.slice(0, 14) };
  }, TARGET_DAY);

  // 6) Find event buttons/blocks inside the TARGET_DAY column (best-effort)
  // We do it in DOM so we can grab the nearest time range and a register button if present.
  const matches = await page.evaluate((TARGET_DAY) => {
    const dayShort = {
      Sunday:"Sun", Monday:"Mon", Tuesday:"Tue", Wednesday:"Wed",
      Thursday:"Thu", Friday:"Fri", Saturday:"Sat"
    }[TARGET_DAY] || TARGET_DAY;

    // Find day header index in a calendar table-like structure
    const headerCells = Array.from(document.querySelectorAll("table thead th"));
    let col = -1;
    for (let i = 0; i < headerCells.length; i++) {
      const t = (headerCells[i].innerText || "").trim().toLowerCase();
      if (t === TARGET_DAY.toLowerCase() || t.startsWith(dayShort.toLowerCase())) {
        col = i;
        break;
      }
    }

    // Collect cells in that column
    let cells = [];
    const rows = Array.from(document.querySelectorAll("table tbody tr"));
    if (col >= 0 && rows.length) {
      for (const r of rows) {
        const tds = Array.from(r.querySelectorAll("td"));
        if (tds[col]) cells.push(tds[col]);
      }
    }

    // Fallback: whole document if not table-based
    if (!cells.length) cells = [document.body];

    const out = [];
    for (const cell of cells) {
      // Look for clickable register buttons in/near events
      const registerButtons = Array.from(cell.querySelectorAll("button, a"))
        .filter(el => (el.innerText || "").trim().toLowerCase() === "register"
                  || (el.innerText || "").trim().toLowerCase() === "register for drop-in"
                  || (el.innerText || "").trim().toLowerCase().includes("register"));

      for (const btn of registerButtons) {
        // attempt to grab surrounding text (event block)
        const container = btn.closest("div") || btn.parentElement || cell;
        const contextText = (container.innerText || "").trim();

        out.push({
          registerText: (btn.innerText || "").trim(),
          contextText: contextText.slice(0, 800),
          hasQuickRegisterId: String(location.href).includes("quickRegisterId=") // not perfect, just info
        });
      }
    }

    // de-dup by contextText
    const seen = new Set();
    const uniq = [];
    for (const x of out) {
      const key = x.contextText;
      if (seen.has(key)) continue;
      seen.add(key);
      uniq.push(x);
    }
    return uniq.slice(0, 50);
  }, TARGET_DAY);

  // 7) If we found a Register button, optionally click the first one (non-destructive test)
  let clickResult = null;
  if (matches.length > 0) {
    if (DRY_RUN) {
      clickResult = { attempted: false, reason: "dryRun=true (no click performed)" };
    } else {
      // click first visible "Register" button on page
      const didClick = await page.evaluate(() => {
        const btns = Array.from(document.querySelectorAll("button, a"))
          .filter(el => (el.innerText || "").trim().toLowerCase() === "register");
        const b = btns.find(x => x && x.offsetParent !== null);
        if (!b) return false;
        b.click();
        return true;
      });

      // Wait briefly to see if "Cannot register" modal appears
      await page.waitForTimeout(1500);

      const modal = await page.evaluate(() => {
        const text = (document.body && document.body.innerText) ? document.body.innerText : "";
        const cannot = text.toLowerCase().includes("cannot register")
                    || text.toLowerCase().includes("registration has not yet been opened");
        return { cannotRegisterModal: cannot };
      });

      clickResult = { attempted: true, didClick, modal };
    }
  }

  return {
    data: {
      status: "CALENDAR_READY",
      url: page.url(),
      foundCandidateDomSnippets: events.slice(0, 20),
      targetHeaderProbe: target,
      matchesInTargetDay: matches,
      clickResult,
      rule: {
        targetDay: TARGET_DAY,
        eveningStart: EVENING_START,
        eveningEnd: EVENING_END,
        timeZone: TIME_ZONE,
        activityUrl: ACTIVITY_URL,
        eveningStartMin: startMin,
        eveningEndMin: endMin
      }
    },
    type: "application/json"
  };
}
`.trim();

  // Cloud Run -> Browserless timeout
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

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
