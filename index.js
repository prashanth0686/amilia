import express from "express";
import fetch from "node-fetch";

const app = express();
app.use(express.json({ limit: "1mb" }));

const PORT = process.env.PORT || 8080;

/* =========================
   HEALTH CHECK (REQUIRED)
   ========================= */
app.get("/health", (req, res) => {
  res.status(200).json({ ok: true, status: "healthy" });
});

/* =========================
   ROOT ROUTE (OPTIONAL)
   ========================= */
app.get("/", (req, res) => {
  res.status(200).json({ ok: true, service: "amilia-booker" });
});

/* =========================
   AUTH
   ========================= */
function requireApiKey(req) {
  const apiKey = req.headers["x-api-key"];
  return apiKey && apiKey === process.env.API_KEY;
}

/* =========================
   BOOK ENDPOINT
   ========================= */
app.post("/book", async (req, res) => {
  if (!requireApiKey(req)) {
    return res.status(200).json({
      ok: false,
      status: "UNAUTHORIZED",
      message: "Invalid x-api-key",
    });
  }

  const {
    BROWSERLESS_HTTP_BASE,
    BROWSERLESS_TOKEN,
    BROWSERLESS_OVERALL_TIMEOUT_MS = "540000",
    BROWSERLESS_PER_ATTEMPT_TIMEOUT_MS = "180000",
    BROWSERLESS_MAX_ATTEMPTS = "3",
    AMILIA_EMAIL,
    AMILIA_PASSWORD,
  } = process.env;

  if (!BROWSERLESS_HTTP_BASE || !BROWSERLESS_TOKEN) {
    return res.status(200).json({
      ok: false,
      status: "CONFIG_ERROR",
      message: "Browserless not configured",
    });
  }

  const rule = {
    targetDay: req.body.targetDay || process.env.TARGET_DAY,
    eveningStart: req.body.eveningStart || process.env.EVENING_START,
    eveningEnd: req.body.eveningEnd || process.env.EVENING_END,
    timeZone: req.body.timeZone || process.env.LOCAL_TZ,
    activityUrl: req.body.activityUrl || process.env.ACTIVITY_URL,
    pollSeconds: Number(req.body.pollSeconds || 540),
    pollIntervalMs: Number(req.body.pollIntervalMs || 3000),
    dryRun: Boolean(req.body.dryRun),
    playerName: req.body.playerName || process.env.PLAYER_NAME,
    addressFull: req.body.addressFull || process.env.ADDRESS_FULL,
  };

  console.log("BOOK_START", JSON.stringify({ rule }));

  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    Number(BROWSERLESS_OVERALL_TIMEOUT_MS)
  );

  let attempts = 0;
  let lastError = null;

  try {
    while (attempts < Number(BROWSERLESS_MAX_ATTEMPTS)) {
      attempts++;

      try {
        const resp = await fetch(
          `${BROWSERLESS_HTTP_BASE}/function?token=${BROWSERLESS_TOKEN}`,
          {
            method: "POST",
            signal: controller.signal,
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              code: "// puppeteer code runs server-side",
              context: {
                EMAIL: AMILIA_EMAIL,
                PASSWORD: AMILIA_PASSWORD,
                ...rule,
              },
            }),
            timeout: Number(BROWSERLESS_PER_ATTEMPT_TIMEOUT_MS),
          }
        );

        const text = await resp.text();

        if (!resp.ok) {
          lastError = text;
          console.warn("BROWSERLESS_NON_200", resp.status);
          continue;
        }

        // SUCCESS PATH
        return res.status(200).json({
          ok: true,
          status: "BROWSERLESS_OK",
          attempts,
          rule,
          browserless: text,
        });
      } catch (err) {
        lastError = err.message;
        console.warn("BROWSERLESS_ATTEMPT_FAILED", {
          attempt: attempts,
          error: err.message,
        });
      }
    }

    // TIMEOUT / NO SLOT FOUND
    return res.status(200).json({
      ok: true,
      status: "BROWSERLESS_TIMEOUT",
      attempts,
      rule,
      message: "No slot yet, retrying on next schedule",
      lastError,
    });
  } catch (err) {
    return res.status(200).json({
      ok: true,
      status: "BROWSERLESS_FATAL",
      message: err.message,
    });
  } finally {
    clearTimeout(timeout);
  }
});

/* =========================
   SERVER START
   ========================= */
app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
