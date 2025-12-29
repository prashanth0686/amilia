import express from "express";

const app = express();
app.use(express.json({ limit: "2mb" }));

const PORT = process.env.PORT || 8080;

app.get("/", (req, res) => res.json({ status: "ok" }));

function requireApiKey(req, res) {
  const apiKey = req.headers["x-api-key"];
  if (!apiKey || apiKey !== process.env.API_KEY) {
    res.status(401).json({ error: "Unauthorized (invalid x-api-key)" });
    return false;
  }
  return true;
}

const VALID_DAYS = ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"];

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

async function fetchWithRetry(url, options, cfg) {
  const maxAttempts = cfg.maxAttempts;
  const perAttemptTimeoutMs = cfg.perAttemptTimeoutMs;

  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), perAttemptTimeoutMs);

    try {
      const resp = await fetch(url, { ...options, signal: controller.signal });
      clearTimeout(t);

      // retry on transient Browserless errors
      if ([429, 502, 503, 504].includes(resp.status) && attempt < maxAttempts) {
        const body = await resp.text().catch(() => "");
        console.log("BROWSERLESS_RETRY_STATUS", JSON.stringify({ attempt, status: resp.status, body: body.slice(0, 600) }));
        await sleep(800 * attempt);
        continue;
      }

      return resp;
    } catch (err) {
      clearTimeout(t);
      lastErr = err;
      const retryable = attempt < maxAttempts;
      console.log("BROWSERLESS_ERR", JSON.stringify({
        attempt,
        perAttemptTimeoutMs,
        retryable,
        name: err?.name,
        message: String(err?.message || err)
      }));
      if (!retryable) break;
      await sleep(800 * attempt);
    }
  }

  throw new Error(`fetchWithRetry failed after ${maxAttempts} attempt(s): ${String(lastErr?.message || lastErr)}`);
}

function buildRule(reqBody) {
  // Defaults
  const DEFAULT_TARGET_DAY = process.env.TARGET_DAY || "Saturday";
  const DEFAULT_EVENING_START = process.env.EVENING_START || "13:00";
  const DEFAULT_EVENING_END = process.env.EVENING_END || "20:00";
  const DEFAULT_TIMEZONE = process.env.LOCAL_TZ || "America/Toronto";
  const DEFAULT_ACTIVITY_URL =
    process.env.ACTIVITY_URL ||
    "https://app.amilia.com/store/en/ville-de-quebec1/shop/programs/calendar/126867?view=basicWeek&scrollToCalendar=true";

  const DEFAULT_DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() === "true";
  const DEFAULT_POLL_SECONDS = Number(process.env.POLL_SECONDS || "120");
  const DEFAULT_POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS || "3000");

  const body = reqBody || {};

  const rule = {
    targetDay: body.targetDay ?? DEFAULT_TARGET_DAY,
    eveningStart: body.eveningStart ?? DEFAULT_EVENING_START,
    eveningEnd: body.eveningEnd ?? DEFAULT_EVENING_END,
    timeZone: body.timeZone ?? DEFAULT_TIMEZONE,
    activityUrl: body.activityUrl ?? DEFAULT_ACTIVITY_URL,
    dryRun: typeof body.dryRun === "boolean" ? body.dryRun : DEFAULT_DRY_RUN,
    pollSeconds: Number.isFinite(Number(body.pollSeconds)) ? Number(body.pollSeconds) : DEFAULT_POLL_SECONDS,
    pollIntervalMs: Number.isFinite(Number(body.pollIntervalMs)) ? Number(body.pollIntervalMs) : DEFAULT_POLL_INTERVAL_MS,
    playerName: body.playerName || "Hari Prashanth Vaidyula",
    address: body.address || "383 rue des maraichers, quebec, qc, G1C 0K2",
    loginOnly: Boolean(body.loginOnly),
  };

  // Validation
  if (!VALID_DAYS.includes(rule.targetDay)) {
    return { error: { status: 400, message: "Invalid targetDay", rule, allowed: VALID_DAYS } };
  }
  if (!isValidHHMM(rule.eveningStart) || !isValidHHMM(rule.eveningEnd)) {
    return { error: { status: 400, message: "Invalid eveningStart/eveningEnd", rule } };
  }
  if (!isValidCalendarUrl(rule.activityUrl)) {
    return { error: { status: 400, message: "Invalid activityUrl", rule } };
  }

  return { rule };
}

function buildBrowserlessCode() {
  // Puppeteer-like function executed on Browserless
  return `
export default async function ({ page, context }) {
  const {
    EMAIL,
    PASSWORD,
    ACTIVITY_URL,
    DRY_RUN,
    POLL_SECONDS,
    POLL_INTERVAL_MS,
    EVENING_START,
    EVENING_END,
    PLAYER_NAME,
    ADDRESS,
    LOGIN_ONLY
  } = context;

  page.setDefaultTimeout(60000);
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const norm = (s) => String(s || "").replace(/\\s+/g, " ").trim();

  const hhmmToMinutes = (hhmm) => {
    const m = /^([01]?\\d|2[0-3]):([0-5]\\d)$/.exec(hhmm || "");
    if (!m) return null;
    return Number(m[1]) * 60 + Number(m[2]);
  };

  const windowStartMin = hhmmToMinutes(EVENING_START);
  const windowEndMin = hhmmToMinutes(EVENING_END);

  // ---------- helpers ----------
  async function clickByText(selectors, texts) {
    const lowerTexts = (texts || []).map(t => String(t).toLowerCase());
    const ok = await page.evaluate(({ selectors, lowerTexts }) => {
      const candidates = [];
      for (const sel of selectors) {
        document.querySelectorAll(sel).forEach(el => candidates.push(el));
      }
      const norm = (s) => String(s || "").replace(/\\s+/g, " ").trim().toLowerCase();
      const isVisible = (el) => {
        const r = el.getBoundingClientRect();
        const st = window.getComputedStyle(el);
        return r.width > 0 && r.height > 0 && st.visibility !== "hidden" && st.display !== "none" && st.opacity !== "0";
      };
      for (const el of candidates) {
        if (!isVisible(el)) continue;
        const t = norm(el.innerText || el.value || el.getAttribute("aria-label") || "");
        if (!t) continue;
        if (lowerTexts.some(x => t.includes(x))) {
          el.click();
          return { clicked: true, text: t.slice(0,120) };
        }
      }
      return { clicked: false };
    }, { selectors, lowerTexts });
    return ok;
  }

  async function selectCheckboxByLabelText(labelText) {
    const target = String(labelText || "").toLowerCase();
    const res = await page.evaluate(({ target }) => {
      const norm = (s) => String(s || "").replace(/\\s+/g, " ").trim().toLowerCase();

      // Try label elements
      const labels = Array.from(document.querySelectorAll("label"));
      for (const lab of labels) {
        const t = norm(lab.innerText);
        if (t && t.includes(target)) {
          // label may wrap input OR be "for" input
          const input = lab.querySelector("input[type='checkbox']") || (lab.htmlFor ? document.getElementById(lab.htmlFor) : null);
          if (input && input.type === "checkbox") {
            input.click();
            return { selected: true, method: "label" };
          }
          // sometimes the label click itself toggles
          lab.click();
          return { selected: true, method: "label-click" };
        }
      }

      // Try checkbox containers
      const boxes = Array.from(document.querySelectorAll("input[type='checkbox']"));
      for (const cb of boxes) {
        const parentText = norm(cb.closest("div, li, tr, section, form")?.innerText || "");
        if (parentText.includes(target)) {
          cb.click();
          return { selected: true, method: "closest-text" };
        }
      }

      return { selected: false };
    }, { target });

    return res;
  }

  async function fillAddressAndPick(address) {
    // Heuristic: find address input by name/placeholder/label text
    const addr = String(address || "");
    const ok = await page.evaluate(() => true);

    // Prefer typing in Node context for better auto-complete triggering
    const input = await page.$("input[name*='address' i], input[autocomplete*='address' i], input[placeholder*='address' i], input[aria-label*='address' i]");
    if (!input) return { ok: false, reason: "NO_ADDRESS_INPUT" };

    await input.click({ clickCount: 3 });
    await page.keyboard.type(addr, { delay: 10 });
    await sleep(1200);

    // Try selecting from a suggestion list (common patterns)
    const picked = await page.evaluate(({ addr }) => {
      const norm = (s) => String(s || "").replace(/\\s+/g, " ").trim().toLowerCase();
      const target = norm(addr);

      const candidates = [];
      // common suggestion containers
      document.querySelectorAll("[role='listbox'] [role='option'], .pac-item, .autocomplete-item, li, div")
        .forEach(el => {
          const t = norm(el.innerText);
          if (!t) return;
          if (t.includes(target.split(",")[0])) candidates.push({ el, t });
        });

      if (candidates.length > 0) {
        candidates[0].el.click();
        return { picked: true, text: candidates[0].t.slice(0, 120) };
      }
      return { picked: false };
    }, { addr });

    // fallback: press down+enter (often selects first suggestion)
    if (!picked?.picked) {
      await page.keyboard.press("ArrowDown");
      await page.keyboard.press("Enter");
      await sleep(500);
      return { ok: true, picked: false, fallback: "ARROWDOWN_ENTER" };
    }

    return { ok: true, picked: true, pickedText: picked.text };
  }

  // ---------- 1) Login ----------
  await page.goto("https://app.amilia.com/en/login", { waitUntil: "domcontentloaded", timeout: 60000 });

  const emailSel = 'input[type="email"], input[name*="email" i]';
  const passSel  = 'input[type="password"], input[name*="password" i]';

  await page.waitForSelector(emailSel, { timeout: 30000 });
  await page.click(emailSel);
  await page.keyboard.type(EMAIL, { delay: 10 });

  await page.waitForSelector(passSel, { timeout: 30000 });
  await page.click(passSel);
  await page.keyboard.type(PASSWORD, { delay: 10 });

  const submitSel = 'button[type="submit"], input[type="submit"]';
  const submit = await page.$(submitSel);
  if (submit) await submit.click();
  else {
    await page.focus(passSel);
    await page.keyboard.press("Enter");
  }

  await page.waitForFunction(() => !location.href.includes("/login"), { timeout: 60000 }).catch(() => {});
  await sleep(1000);

  if (LOGIN_ONLY) {
    return {
      data: { status: "LOGIN_OK", url: location.href },
      type: "application/json"
    };
  }

  // ---------- 2) Go to calendar ----------
  await page.goto(ACTIVITY_URL, { waitUntil: "networkidle2", timeout: 60000 });
  await sleep(1200);

  const maxAttempts = Math.max(1, Math.floor((Number(POLL_SECONDS) * 1000) / Number(POLL_INTERVAL_MS)));
  let attempts = 0;

  const getState = async () => {
    return await page.evaluate(() => {
      const norm = (s) => String(s || "").replace(/\\s+/g, " ").trim();
      const bodyText = norm(document.body?.innerText || "");
      const url = location.href;

      const hasQuickReg = /[?&]quickRegisterId=\\d+/.test(url);
      const hasCheckout =
        /\\/cart\\b/i.test(url) ||
        /\\/checkout\\b/i.test(url) ||
        /my cart/i.test(bodyText) ||
        /order summary/i.test(bodyText);

      const cannotRegister = /cannot register/i.test(bodyText);
      const notOpenedYet = /registration has not yet been opened/i.test(bodyText);

      return { url, success: Boolean(hasQuickReg || hasCheckout), cannotRegister, notOpenedYet };
    });
  };

  const closeModalIfPresent = async () => {
    return await page.evaluate(() => {
      const buttons = Array.from(document.querySelectorAll("button, a, [role='button']"));
      const norm = (s) => String(s || "").replace(/\\s+/g, " ").trim().toLowerCase();
      for (const el of buttons) {
        const t = norm(el.innerText || el.getAttribute("aria-label") || "");
        if (t === "close" || t === "x" || t.includes("continue shopping")) {
          el.click();
          return true;
        }
      }
      const byAttr = document.querySelector("[aria-label='Close'], .modal .close, .modal-close, button.close");
      if (byAttr) { byAttr.click(); return true; }
      return false;
    });
  };

  const pickAndClickCalendarRegister = async () => {
    return await page.evaluate(({ windowStartMin, windowEndMin }) => {
      const norm = (s) => String(s || "").replace(/\\s+/g, " ").trim();
      const sNorm = (s) => norm(s).toLowerCase();

      const isVisible = (el) => {
        if (!el) return false;
        const r = el.getBoundingClientRect();
        const st = window.getComputedStyle(el);
        return r.width > 0 && r.height > 0 && st.visibility !== "hidden" && st.display !== "none" && st.opacity !== "0";
      };

      const eventContainers = Array.from(document.querySelectorAll(
        ".fc-event, .fc-day-grid-event, .fc-time-grid-event, .activity-segment, [id^='event-title-']"
      ));

      const candidates = [];
      for (const container of eventContainers) {
        const btn =
          container.querySelector("button.register, a.register, button[title*='Register' i], a[title*='Register' i]") ||
          Array.from(container.querySelectorAll("button, a")).find(el => /register/i.test(el.innerText || ""));
        if (!btn) continue;
        if (!isVisible(btn)) continue;

        const text = norm(container.innerText || "");
        candidates.push({ text, btn });
      }

      const parseStartMinutes = (text) => {
        const s = sNorm(text);

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
        .sort((a,b) => a.startMin - b.startMin);

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

  if (!lastState.success) {
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
      await sleep(1500);

      lastState = await getState();
      if (lastState.success) break;

      if (lastState.cannotRegister || lastState.notOpenedYet) {
        await closeModalIfPresent();
      }

      await sleep(Number(POLL_INTERVAL_MS));
    }
  }

  // ---------- 3) If register flow started, complete steps ----------
  let playerStep = null;
  let addressStep = null;
  let proceedStep = null;

  if (!DRY_RUN) {
    // Wait a moment for modal/page
    await sleep(2000);

    // Select player checkbox
    playerStep = await selectCheckboxByLabelText(PLAYER_NAME);
    await sleep(500);

    // Click Next/Proceed/Continue
    proceedStep = await clickByText(
      ["button", "a", "[role='button']", "input[type='submit']"],
      ["next", "proceed", "continue", "continue to", "suivant", "continuer"]
    );
    await sleep(2000);

    // Fill address and pick suggestion
    addressStep = await fillAddressAndPick(ADDRESS);
    await sleep(800);

    // Click Next/Proceed again
    const proceed2 = await clickByText(
      ["button", "a", "[role='button']", "input[type='submit']"],
      ["next", "proceed", "continue", "submit", "save", "checkout", "suivant", "continuer"]
    );
  }

  const finalState = await getState();
  const outcome =
    finalState.success ? "SUCCESS" :
    (attempts >= maxAttempts ? "TIMEOUT" : "STOPPED");

  return {
    data: {
      status: "DONE",
      outcome,
      attempts,
      finalState,
      lastClick,
      playerStep,
      proceedStep,
      addressStep
    },
    type: "application/json"
  };
}
`.trim();
}

async function callBrowserless(rule) {
  const { BROWSERLESS_HTTP_BASE, BROWSERLESS_TOKEN, AMILIA_EMAIL, AMILIA_PASSWORD } = process.env;

  if (!BROWSERLESS_HTTP_BASE || !BROWSERLESS_TOKEN) {
    return { error: { status: 500, message: "Browserless HTTP not configured" } };
  }
  if (!AMILIA_EMAIL || !AMILIA_PASSWORD) {
    return { error: { status: 500, message: "Amilia credentials not configured" } };
  }

  const functionUrl = `${normalizeBaseUrl(BROWSERLESS_HTTP_BASE)}/function?token=${encodeURIComponent(BROWSERLESS_TOKEN)}`;

  const overallTimeoutMs = Number(process.env.BROWSERLESS_OVERALL_TIMEOUT_MS || "540000");
  const perAttemptTimeoutMs = Number(process.env.BROWSERLESS_PER_ATTEMPT_TIMEOUT_MS || "90000");
  const maxAttempts = Number(process.env.BROWSERLESS_MAX_ATTEMPTS || "3");

  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), overallTimeoutMs);

  const code = buildBrowserlessCode();

  try {
    const resp = await fetchWithRetry(
      functionUrl,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          code,
          context: {
            EMAIL: AMILIA_EMAIL,
            PASSWORD: AMILIA_PASSWORD,
            ACTIVITY_URL: rule.activityUrl,
            DRY_RUN: rule.dryRun,
            POLL_SECONDS: rule.pollSeconds,
            POLL_INTERVAL_MS: rule.pollIntervalMs,
            EVENING_START: rule.eveningStart,
            EVENING_END: rule.eveningEnd,
            PLAYER_NAME: rule.playerName,
            ADDRESS: rule.address,
            LOGIN_ONLY: rule.loginOnly,
          },
        }),
      },
      { maxAttempts, perAttemptTimeoutMs }
    );

    const text = await resp.text();
    let parsed;
    try { parsed = JSON.parse(text); } catch { parsed = { raw: text }; }

    if (!resp.ok) {
      console.log("BROWSERLESS_ERROR_BODY", JSON.stringify(parsed).slice(0, 4000));
      return { error: { status: 502, message: "Browserless Function API error", httpStatus: resp.status, body: parsed } };
    }

    return { ok: true, data: parsed };
  } catch (err) {
    const isAbort = err?.name === "AbortError";
    return { error: { status: 504, message: isAbort ? "Browserless overall timeout" : "Browserless call failed", details: String(err?.message || err) } };
  } finally {
    clearTimeout(t);
  }
}

app.post("/warm", async (req, res) => {
  if (!requireApiKey(req, res)) return;

  const { rule, error } = buildRule({ ...(req.body || {}), loginOnly: true, dryRun: true });
  if (error) return res.status(error.status).json(error);

  console.log("WARM_START", JSON.stringify({ rule }));
  const out = await callBrowserless(rule);
  if (out.error) return res.status(out.error.status).json(out.error);

  return res.json({ status: "WARM_OK", browserless: out.data });
});

app.post("/book", async (req, res) => {
  if (!requireApiKey(req, res)) return;

  const { rule, error } = buildRule(req.body || {});
  if (error) return res.status(error.status).json(error);

  console.log("BOOK_START", JSON.stringify({ rule }));
  const out = await callBrowserless(rule);
  if (out.error) return res.status(out.error.status).json(out.error);

  return res.json({ status: "BOOK_OK", browserless: out.data, rule });
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
