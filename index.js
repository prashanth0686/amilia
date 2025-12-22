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

  // Browserless Function API runs Puppeteer-compatible code via HTTP
  // Docs: POST /function?token=...  Content-Type: application/javascript or application/json
  // We'll use JSON mode (easier/safer quoting).
  // https://docs.browserless.io/rest-apis/function :contentReference[oaicite:2]{index=2}
  const functionUrl = `${BROWSERLESS_HTTP_BASE.replace(/\/$/, "")}/function?token=${encodeURIComponent(
    BROWSERLESS_TOKEN
  )}`;

  // Minimal “prove it works” script:
  // - open example.com
  // - return page title
  const code = `
    export default async function ({ page }) {
      await page.goto("https://example.com/", { waitUntil: "domcontentloaded", timeout: 60000 });
      const title = await page.title();
      return {
        data: { ok: true, title },
        type: "application/json",
      };
    }
  `.trim();

  // Optional timeout control on our side
  const controller = new AbortController();
  const timeoutMs = 60000;
  const t = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const resp = await fetch(functionUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      signal: controller.signal,
      body: JSON.stringify({ code }),
    });

    const text = await resp.text();

    // Browserless should return JSON for our script, but if something fails we’ll still show raw text.
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
