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
  // Simple API key protection (your Cloud Run service can stay public)
  const apiKey = req.headers["x-api-key"];
  if (!apiKey || apiKey !== process.env.API_KEY) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const token = process.env.BROWSERLESS_TOKEN;
  const proxyServer = process.env.BROWSERLESS_PROXY || "http://proxy.browserless.io:3128";

  if (!token) {
    return res.status(500).json({ error: "Browserless not configured: missing BROWSERLESS_TOKEN" });
  }

  let browser;
  try {
    console.log("BOOK: launching Chromium via Browserless proxy");
    console.log("BOOK: proxy server =", proxyServer);

    // IMPORTANT:
    // - Browserless proxy auth uses username = token, password can be anything (often blank)
    // - This avoids WebSockets; works well from Cloud Run
    browser = await chromium.launch({
      headless: true,
      proxy: {
        server: proxyServer,
        username: token,
        password: "x",
      },
      // Cloud Run containers are locked down; these flags help reliability
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
    });

    const context = await browser.newContext();
    const page = await context.newPage();

    await page.goto("https://example.com", { waitUntil: "domcontentloaded", timeout: 30000 });
    const title = await page.title();

    await browser.close();

    console.log("BOOK: success");

    return res.json({
      status: "CONNECTED",
      title,
    });
  } catch (err) {
    const message = err?.message || String(err);
    console.error("BOOK ERROR MESSAGE:", message);
    console.error("BOOK ERROR STACK:", err?.stack);

    try {
      await browser?.close();
    } catch {}

    return res.status(500).json({ error: message });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
