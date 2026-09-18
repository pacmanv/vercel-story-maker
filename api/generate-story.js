// Vercel serverless function (Node.js runtime).
// Keeps the Anthropic API key on the server — the browser never sees it.
//
// Set ANTHROPIC_API_KEY in your Vercel project's Environment Variables
// (Project Settings -> Environment Variables) before deploying.

// Rate limiting is enforced entirely by Vercel's built-in Firewall (WAF),
// not by any code in this file. There's a custom rule configured in the
// dashboard under Project -> Firewall -> Rules -> "generate-story-rate-limit"
// (condition: path equals /api/generate-story, action: Rate Limit, 20
// requests / 60s per IP, fixed window). Because it runs at Vercel's edge
// network, a client that exceeds the limit gets a 429 before the request
// ever reaches this function — it's shared across every serverless
// instance automatically and doesn't cost any compute time to enforce,
// unlike the old approach below.
//
// (We previously tried wiring this up through the @vercel/firewall
// `checkRateLimit()` SDK from inside this function, but that's a
// different mechanism meant for app-level keys — e.g. rate-limiting by
// authenticated user ID — that requires a rule matched on a
// `rate_limit_api_id` condition, not a plain path condition. Since we
// don't need per-user keys here, the plain dashboard rule above is the
// simpler, complete fix and needs no code at all. The original version of
// this file used an in-memory Map instead, which reset per-instance and
// didn't share state across concurrent instances — fine for blunting one
// person mashing the button, not a real defense for public traffic.)

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
