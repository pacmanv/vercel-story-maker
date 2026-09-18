// Vercel serverless function (Node.js runtime).
// Keeps the Anthropic API key on the server — the browser never sees it.
//
// Set ANTHROPIC_API_KEY in your Vercel project's Environment Variables
// (Project Settings -> Environment Variables) before deploying.

// Rate limiting is enforced by Vercel's built-in Firewall (WAF) rather than
// an in-process counter, so it's shared across every serverless instance
// and actually holds up under real concurrent traffic (the old in-memory
// Map reset per-instance and didn't share state — fine for one person
// mashing the button, not for a public launch). The rule itself (20
// requests / 60s per IP) is configured in the Vercel dashboard under
// Project -> Firewall -> Rules -> "generate-story-rate-limit", and this
// code just asks that rule whether the current request should be blocked.
//
// checkRateLimit() expects a standard Web `Request` object, but this
// function uses the classic Node (req, res) handler shape, so we build a
// minimal Request from the incoming req below. If the rate-limit check
// itself fails for any reason (transient network hiccup talking to the
// Firewall service, etc.), we log it and let the request through rather
// than taking the whole story generator down over a rate-limit hiccup.
const RATE_LIMIT_RULE_ID = "rule_generate_story_rate_limit_X6dk5A";

function buildWebRequest(req) {
  const proto = req.headers["x-forwarded-proto"] || "https";
  const host = req.headers["x-forwarded-host"] || req.headers.host || "localhost";
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers || {})) {
    if (value == null) continue;
    headers.set(key, Array.isArray(value) ? value.join(", ") : String(value));
  }
  return new Request(`${proto}://${host}${req.url || "/"}`, {
    method: req.method || "GET",
    headers
  });
}

async function isRateLimited(req) {
  try {
    const { checkRateLimit } = await import("@vercel/firewall");
    const result = await checkRateLimit(RATE_LIMIT_RULE_ID, { request: buildWebRequest(req) });
    return !!(result && result.rateLimited);
  } catch (e) {
    console.error("Rate limit check failed, allowing request through", e && e.message);
    return false;
  }
}

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
  if (!prompt || typeof prompt !== "string" || prompt.length > 6000) {
    return res.status(400).json({ error: "invalid_request" });
  }

  // The client sends a target token budget based on the story length the
  // user picked (Quick / Classic / Long). Clamp it to a sane range so a
  // malformed or malicious value can't blow up cost or exceed model limits.
  const requestedMaxTokens = Number(req.body && req.body.maxTokens);
  const maxTokens = Number.isFinite(requestedMaxTokens)
    ? Math.min(Math.max(Math.round(requestedMaxTokens), 500), 6000)
    : 3000;

  if (await isRateLimited(req)) {
    return res.status(429).json({ error: "rate_limited" });
  }

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
        max_tokens: maxTokens,
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
