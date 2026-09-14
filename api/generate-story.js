// Vercel serverless function (Node.js runtime).
// Keeps the Anthropic API key on the server — the browser never sees it.
//
// Set ANTHROPIC_API_KEY in your Vercel project's Environment Variables
// (Project Settings -> Environment Variables) before deploying.

// Very lightweight per-IP rate limit. This is best-effort only: it lives in
// memory, so it resets whenever the serverless instance is recycled and
// does not share state across multiple instances. It exists to blunt
// accidental abuse (e.g. someone leaving the tab open and mashing the
// button), not to be a real defense. For a public site you plan to share
// widely, consider a proper rate limiter backed by KV/Redis instead.
const rateLimitStore = new Map();
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const RATE_LIMIT_MAX = 5;

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "invalid_request" });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: "server_not_configured" });
  }

  const prompt = req.body && req.body.prompt;
  if (!prompt || typeof prompt !== "string" || prompt.length > 4000) {
    return res.status(400).json({ error: "invalid_request" });
  }

  const ip = String((req.headers["x-forwarded-for"] || req.socket.remoteAddress || "unknown"))
    .split(",")[0]
    .trim();
  const now = Date.now();
  const recentHits = (rateLimitStore.get(ip) || []).filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
  if (recentHits.length >= RATE_LIMIT_MAX) {
    return res.status(429).json({ error: "rate_limited" });
  }
  recentHits.push(now);
  rateLimitStore.set(ip, recentHits);

  try {
    const upstream = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: "claude-sonnet-5",
        max_tokens: 3000,
        messages: [{ role: "user", content: prompt }]
      })
    });

    if (upstream.status === 429) {
      return res.status(429).json({ error: "rate_limited" });
    }
    if (!upstream.ok) {
      const errBody = await upstream.text().catch(() => "");
      console.error("Anthropic API error", upstream.status, errBody.slice(0, 2000));
      return res.status(502).json({ error: "upstream_error" });
    }

    const data = await upstream.json();

    // Pull out every text block (the response can include non-text blocks,
    // e.g. a "thinking" block, ahead of the actual answer) and concatenate
    // them, rather than assuming content[0] is the text block.
    const blocks = Array.isArray(data && data.content) ? data.content : [];
    const text = blocks
      .filter((b) => b && b.type === "text" && typeof b.text === "string")
      .map((b) => b.text)
      .join("");

    if (!text) {
      console.error(
        "Empty completion. stop_reason=%s content_types=%s raw=%s",
        data && data.stop_reason,
        blocks.map((b) => b && b.type).join(","),
        JSON.stringify(data).slice(0, 2000)
      );
      return res.status(502).json({ error: "empty_completion" });
    }

    let parsed;
    try {
      const cleaned = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "");
      parsed = JSON.parse(cleaned);
    } catch (e) {
      return res.status(502).json({ error: "invalid_json" });
    }

    if (!parsed || typeof parsed.title !== "string" || typeof parsed.story !== "string") {
      return res.status(502).json({ error: "invalid_json" });
    }

    return res.status(200).json({ title: parsed.title, story: parsed.story });
  } catch (e) {
    return res.status(502).json({ error: "upstream_error" });
  }
};
