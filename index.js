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

function normalizeBaseUrl(u) {
  return String(u || "").replace(/\/$/, "");
}

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

  // === DEFAULTS (Cloud Run env vars) ===
  const DEFAULT_TARGET_DAY = process.env.TARGET_DAY || "Saturday";
  const DEFAULT_EVENING_START = process.env.EVENING_START || "18:00";
  const DEFAULT_EVENING_END = process.env.EVENING_END || "21:00";
  const DEFAULT_TIMEZONE = process.env.LOCAL_TZ || "America/Toronto";
  const DEFAULT_ACTIVITY_URL =
    process.env.ACTIVITY_URL ||
    "https://app.amilia.com/store/en/ville-de-quebec1/shop/activities/6112282?scrollToCalendar=true&view=month";

  const DEFAULT_DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";

  // Polling defaults
  const DEFAULT_POLL_SECONDS = Number(process.env.POLL_SECONDS || 90);
  const DEFAULT_POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS || 3000);

  // === OVERRIDES (request body) ===
  const body = req.body || {};

  const targetDay = body.targetDay ?? DEFAULT_TARGET_DAY;
  const eveningStart = body.eveningStart ?? DEFAULT_EVENING_START;
  const eveningEnd = body.eveningEnd ?? DEFAULT_EVENING_END;
  const timeZone = body.timeZone ?? DEFAULT_TIMEZONE;
  const activityUrl = body.activityUrl ?? DEFAULT_ACTIVITY_URL;

  const dryRun = typeof body.dryRun === "boolean" ? body.dryRun : DEFAULT_DRY_RUN;

  const pollSeconds =
    Number.isFinite(body.pollSeconds) && body.pollSeconds > 0
      ? Number(body.pollSeconds)
      : DEFAULT_POLL_SECONDS;

  const pollIntervalMs =
    Number.isFinite(body.pollIntervalMs) && body.pollIntervalMs >= 250
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
      examples: ["17:00", "18:30", "21:00"],
      rule,
    });
  }

  if (!isValidActivityUrl(rule.activityUrl)) {
    return res.status(400).json({
      error: "Invalid activityUrl (must include /shop/activities/)",
      provided: rule.activityUrl,
      rule,
    });
  }

  const functionUrl = `${normalizeBaseUrl(BROWSERLESS_HTTP_BASE)}/function?token=${encodeURIComponent(
    BROWSERLESS_TOKEN
  )}`;

  // Browserless Function code (Puppeteer-like runtime)
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

  // --- 1) Login ---
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

  // --- 2) Go to activity calendar page ---
  await page.goto(ACTIVITY_URL, { waitUntil: "networkidle2", timeout: 60000 });
  await sleep(1200);

  // --- Helpers evaluated in-page (NO outer scope leakage) ---
  const detectState = () => {
    const norm = (s) => String(s || "").replace(/\\s+/g, " ").trim();
    const url = location.href;
    const bodyText = norm(document.body?.innerText || "");

    const success =
      url.includes("quickRegisterId=") ||
      /checkout|cart/i.test(url) ||
      /checkout|cart/i.test(bodyText);

    const cannotRegister = /cannot register/i.test(bodyText);
    const notOpenedYet = /registration has not yet been opened/i.test(bodyText);

    return { url, success, cannotRegister, notOpenedYet };
  };

  const closeCannotRegisterModalIfPresent = () => {
    const isVisible = (el) => {
      if (!el) return false;
      const r = el.getBoundingClientRect();
      if (!r || r.width === 0 || r.height === 0) return false;
      const style = window.getComputedStyle(el);
      if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") return false;
      return true;
    };

    const closeBtn =
      document.querySelector('button.close, button[aria-label*="close" i], .modal-dialog button.close, .modal button.close') ||
      Array.from(document.querySelectorAll("button"))
        .find(b => /close|ok|continue shopping/i.test((b.innerText || "").trim()));

    if (closeBtn && isVisible(closeBtn)) {
      closeBtn.click();
      return true;
    }
    return false;
  };

  // Real calendar button selector (NOT nav):
  // <button type="button" class="register" aria-describedby="event-title-...">
  const calendarRegisterSelector = 'button.register[aria-describedby^="event-title-"]';

  const startedAt = Date.now();
  const maxWaitMs = Math.max(1, Number(POLL_SECONDS || 90)) * 1000;
  const intervalMs = Math.max(250, Number(POLL_INTERVAL_MS || 3000));

  let attempts = 0;
  let clickResult = null;

  while ((Date.now() - startedAt) < maxWaitMs) {
    attempts++;

    const pre = await page.evaluate(detectState);
    if (pre.success) {
      clickResult = { outcome: "SUCCESS_ALREADY", attempts, state: pre };
      break;
    }

    const found = await page.evaluate((sel) => {
      const isVisible = (el) => {
        if (!el) return false;
        const r = el.getBoundingClientRect();
        if (!r || r.width === 0 || r.height === 0) return false;
        const style = window.getComputedStyle(el);
        if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") return false;
        return true;
      };

      const all = Array.from(document.querySelectorAll(sel));
      const visible = all.filter(isVisible);
      return { total: all.length, visible: visible.length };
    }, calendarRegisterSelector);

    if (found.visible > 0) {
      if (DRY_RUN) {
        clickResult = { outcome: "DRY_RUN_FOUND_REGISTER", attempts, found };
        break;
      }

      const clicked = await page.evaluate((sel) => {
        const isVisible = (el) => {
          if (!el) return false;
          const r = el.getBoundingClientRect();
          if (!r || r.width === 0 || r.height === 0) return false;
          const style = window.getComputedStyle(el);
          if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") return false;
          return true;
        };

        const all = Array.from(document.querySelectorAll(sel));
        const first = all.find(isVisible);
        if (!first) return { clicked: false };
        first.click();
        return { clicked: true };
      }, calendarRegisterSelector);

      await sleep(1200);

      const post = await page.evaluate(detectState);

      if (post.success) {
        clickResult = { outcome: "SUCCESS_CLICKED", attempts, clicked, state: post };
        break;
      }

      if (post.cannotRegister || post.notOpenedYet) {
        const closed = await page.evaluate(closeCannotRegisterModalIfPresent);
        await sleep(400);
        clickResult = { outcome: "NOT_OPENED_YET_RETRYING", attempts, closed, state: post };
      } else {
        clickResult = { outcome: "CLICKED_NO_SUCCESS_YET", attempts, clicked, state: post };
      }
    } else {
      clickResult = { outcome: "NO_REGISTER_VISIBLE_YET", attempts, found };
    }

    await sleep(intervalMs);

    // Refresh sometimes (helps repaint)
    if (attempts % 8 === 0) {
      try {
        await page.reload({ waitUntil: "networkidle2", timeout: 60000 });
        await sleep(800);
      } catch {}
    }
  }

  const finalState = await page.evaluate(detectState);

  return {
    data: {
      status: "POLLING_DONE",
      url: finalState.url,
      attempts,
      finalState,
      clickResult,
      rule: {
        targetDay: TARGET_DAY,
        eveningStart: EVENING_START,
        eveningEnd: EVENING_END,
        timeZone: TIME_ZONE,
        activityUrl: ACTIVITY_URL,
        dryRun: DRY_RUN,
        pollSeconds: POLL_SECONDS,
        pollIntervalMs: POLL_INTERVAL_MS,
        eveningStartMin: hhmmToMinutes(EVENING_START),
        eveningEndMin: hhmmToMinutes(EVENING_END)
      }
    },
    type: "application/json"
  };
}
`.trim();

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

    return res.json({
      status: "BROWSERLESS_HTTP_OK",
      browserless: parsed,
      rule,
    });
  } catch (err) {
    const isAbort = err?.name === "AbortError";
    return res.status(504).json({
      error: isAbort
        ? "Browserless HTTP request timed out"
        : "Browserless HTTP request failed",
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
