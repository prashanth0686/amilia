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

  const functionUrl = `${BROWSERLESS_HTTP_BASE.replace(/\/$/, "")}/function?token=${encodeURIComponent(
    BROWSERLESS_TOKEN
  )}`;

  // IMPORTANT: Browserless Function is Puppeteer-compatible, not Playwright.
  // So we avoid Playwright-only selectors like :has-text().
 const code = `
  export default async function ({ page, context }) {
    const { EMAIL, PASSWORD } = context;

    page.setDefaultTimeout(30000);

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

    // 4) Wait for login to complete
    await page.waitForFunction(
      () => !location.href.includes("/login"),
      { timeout: 60000 }
    ).catch(() => {});

    // 5) Go to badminton search
    const searchUrl =
      "https://app.amilia.com/store/en/ville-de-quebec1/api/Activity/Search?textCriteria=badminton";

    await page.goto(searchUrl, {
      waitUntil: "networkidle2",
      timeout: 60000
    });

    // 6) Return debug info
    const bodyText = await page.evaluate(() => document.body?.innerText || "");

    return {
      data: {
        status: "LOGGED_IN_AND_SEARCH_LOADED",
        url: page.url(),
        pageLength: bodyText.length
      },
      type: "application/json"
    };
  }
`.trim();


  const controller = new AbortController();
  const timeoutMs = 120000; // allow time for login + navigation
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
      browserless: parsed,
    });
  } catch (err) {
    const isAbort = err?.name === "AbortError";
    return res.status(504).json({
      error: isAbort ? "Browserless HTTP request timed out" : "Browserless HTTP request failed",
      details: String(err?.message || err),
    });
  } finally {
    clearTimeout(t);
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
