# Bedtime Story Maker — self-hosted

A static kids' story-picker page (`index.html`) plus one small serverless
function (`api/generate-story.js`) that calls the Anthropic API on the
server, so your API key never reaches the browser.

## 1. Get an Anthropic API key

1. Go to https://console.anthropic.com/settings/keys and sign in (or create
   an account).
2. This is a separate, pay-as-you-go account from a claude.ai chat
   subscription — you'll need to add billing details there before you can
   generate a key.
3. Create a key and copy it (starts with `sk-ant-...`). You won't be able
   to see it again after you navigate away, so save it somewhere safe for
   the next step.
4. Cost is small for this app: at current pricing (Claude Sonnet 5, $2 per
   million input tokens / $10 per million output tokens) each story costs
   roughly 1-2 cents. Pricing can change, so check
   https://platform.claude.com/docs/en/about-claude/pricing if you want the
   latest numbers.

## 2. Push this folder to GitHub

```bash
cd story-lab-selfhost
git init
git add .
git commit -m "Bedtime Story Maker"
git branch -M main
git remote add origin <your-new-empty-repo-url>
git push -u origin main
```

(Or just create a new repo on github.com and use "Add file → Upload files"
to drag this folder's contents in — either works.)

## 3. Deploy on Vercel

1. Go to https://vercel.com and sign in (you can sign in with your GitHub
   account — no separate password needed).
2. Click "Add New… → Project", then pick the repo you just pushed.
3. Vercel will auto-detect this as a static site with a serverless
   function — you shouldn't need to change any build settings.
4. **Before deploying**, go to the project's Settings → Environment
   Variables and add:
   - Key: `ANTHROPIC_API_KEY`
   - Value: the key you copied in step 1
   - Scope: Production (and Preview/Development too, if you want to test
     branches)
5. Click Deploy.

Once it finishes, Vercel gives you a live URL like
`https://your-project.vercel.app` — that's your hosted app. Test it end to
end (pick all the characters, tap "Tell Our Story") before sharing the
link with your kids.

## 4. (Optional) Use your own domain

In the Vercel project's Settings → Domains, add a domain you own and
follow the DNS instructions it gives you. Vercel handles HTTPS
automatically.

## Updating it later

Any push to your GitHub repo's main branch automatically redeploys on
Vercel. To change the app itself, edit `index.html` (UI/copy/story logic)
or `api/generate-story.js` (the server-side API call), commit, and push.

## Notes on the rate limiting

`api/generate-story.js` includes a very small, best-effort per-IP rate
limit (5 requests/minute) to blunt accidental abuse if the link gets
shared more widely than you intended. It's in-memory only — not a strong
guarantee, and it won't coordinate across multiple serverless instances.
If you're worried about cost from a widely-shared link, consider either
keeping the link private, or replacing this with a real rate limiter
backed by Vercel KV/Upstash Redis.
