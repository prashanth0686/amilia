import express from "express";
import { chromium } from "playwright";

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 8080;

function maskWs(ws) {
  // Remove/obfuscate token if present, so it’s safe to log
  try {
    const u = new URL(ws.replace(/^wss:/, "https:"));
    if (u.searchParams.has("token")) u.searchParams.set("token", "****");
    return u.toString().replace(/^https:/, "wss:");
  } catch {
    return ws.replace(/token=[^&]+/i, "token=****");
  }
}

function buildBrowserlessWs(base, token) {
  // If base already contains token=, use as-is
  if (base.includes("token=")) return base;

  // Normalize trailing slash behavior
  const trimmed = base.trim();

  // If it already has a query string, append with &
  const joiner = trimmed.includes("?") ? "&" : "?";

  return `${trimmed}${joiner}token=${token}`;
}

// Health check
app.get("/", (req, res) => {
  res.json({ status: "ok" });
});

app.post("/book", async (req, res) => {
  const apiKey = req.headers["x-api-key"];
  if (!apiKey || apiKey !== process.env.API_KEY) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const { BROWSERLESS_WS, BROWSERLESS_TOKEN } = process.env;

  // If you configured BROWSERLESS_WS with ?token=... then token can be optional
  if (!BROWSERLESS_WS) {
    return res.status(500).json({ error: "Browserless not configured: missing BROWSERLESS_WS" });
  }
  if (!BROWSERLESS_TOKEN && !BROWSERLESS_WS.includes("token=")) {
    return res.status(500).json({ error: "Browserless not configured: missing BROWSERLESS_TOKEN" });
  }

  let browser;
  try {
    const ws = buildBrowserlessWs(BROWSERLESS_WS, BROWSERLESS_TOKEN || "");

    console.log("BOOK: starting");
    console.log("BOOK: Browserless WS =", maskWs(ws));

    // Fail fast if connect hangs
    const connectPromise = chromium.connect(ws);
    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error("Browserless connect timeout after 20 seconds")), 20000)
    );

    browser = await Promise.race([connectPromise, timeoutPromise]);

    console.log("BOOK: connected to Browserless");

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
    } catch (closeErr) {
      console.error("BOOK: error closing browser:", closeErr?.message || String(closeErr));
    }

    return res.status(500).json({ error: message });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
