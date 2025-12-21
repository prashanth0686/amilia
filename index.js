import express from "express";
import { chromium } from "playwright";

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 8080;

// Health check
app.get("/", (req, res) => {
  res.json({ status: "ok" });
});

app.post("/book", async (req, res) => {
  const apiKey = req.headers["x-api-key"];
  if (!apiKey || apiKey !== process.env.API_KEY) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const {
    BROWSERLESS_WS,
    BROWSERLESS_TOKEN
  } = process.env;

  if (!BROWSERLESS_WS || !BROWSERLESS_TOKEN) {
    return res.status(500).json({ error: "Browserless not configured" });
  }

  let browser;
  try {
    const ws =
      BROWSERLESS_WS.includes("token=")
        ? BROWSERLESS_WS
        : `${BROWSERLESS_WS}?token=${BROWSERLESS_TOKEN}`;

    browser = await chromium.connect(ws);
    const context = await browser.newContext();
    const page = await context.newPage();

    await page.goto("https://example.com", { waitUntil: "domcontentloaded" });

    const title = await page.title();

    await browser.close();

    res.json({
      status: "CONNECTED",
      title
    });
  } catch (err) {
    try { await browser?.close(); } catch {}
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
