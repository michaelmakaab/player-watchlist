# Player Watchlist GitHub Proxy

A tiny Cloudflare Worker that proxies GitHub Issues API calls so the front-end never holds a PAT.

## Why

GitHub's secret scanner auto-revokes any PAT pushed to a public repo. The previous client-side
token (split into 3 chunks in `template.html`) was getting revoked. This worker holds the
token server-side as a Worker secret.

## Endpoints

- `POST /issues` — create an issue (player or coach suggestion)
- `POST /issues/:number/comments` — comment on an existing issue
- `GET /issues?labels=...&state=open` — list issues
- `GET /` — health check

Only the labels `player-suggestion`, `coach-suggestion`, `remove-player`, `needs-confirmation`
are allowed. Anything else returns 403.

## Deploy

1. **Install wrangler** (one-time):
   ```bash
   npm install -g wrangler
   wrangler login
   ```

2. **Generate a fine-grained PAT** at https://github.com/settings/personal-access-tokens
   - Repository: `michaelmakaab/player-watchlist` only
   - Permissions: **Issues: Read and write**, **Contents: Read** (for label list)
   - Expiration: 90 days (or whatever you prefer)
   - Save the token — you'll paste it in the next step

3. **Deploy + add the token**:
   ```bash
   cd /Users/mike/Desktop/player-watchlist/worker
   wrangler deploy
   wrangler secret put GH_TOKEN
   # paste the PAT when prompted
   ```

4. **Note the worker URL** that wrangler prints, e.g.
   `https://player-watchlist-proxy.<your-subdomain>.workers.dev`

5. **Update `src/template.html`** — replace the GitHub API base + token logic:

   Find this block (around lines 881–948):
   ```js
   const GITHUB_TOKEN = ["github_pat_...", "...", "..."].join("");
   const REPO_OWNER = "michaelmakaab";
   const REPO_NAME = "player-watchlist";
   ```

   Replace with:
   ```js
   const PROXY_URL = "https://player-watchlist-proxy.<your-subdomain>.workers.dev";
   ```

   Find every `fetch("https://api.github.com/repos/" + REPO_OWNER + ...)` call and:
   - Drop the `Authorization` header
   - Change the URL from `https://api.github.com/repos/<owner>/<repo>/issues` to `${PROXY_URL}/issues`
   - Change `https://api.github.com/repos/<owner>/<repo>/issues/<n>/comments` to `${PROXY_URL}/issues/<n>/comments`

6. **Rebuild + push**:
   ```bash
   cd /Users/mike/Desktop/player-watchlist
   bash build.sh
   git add -A
   git commit -m "move GitHub token to Cloudflare Worker proxy"
   git push
   ```

## Tighten security after deployment

In `worker.js`, change `ALLOWED_ORIGIN = "*"` to your actual front-end URL
(e.g. `https://yourdomain.com`) so random websites can't use the proxy.

Then redeploy:
```bash
wrangler deploy
```

## Rotating the PAT

```bash
# generate a new fine-grained PAT, then:
wrangler secret put GH_TOKEN
# paste new token. No code changes needed, no rebuild.
```

## Cost

Cloudflare Workers free tier: 100,000 requests/day. You'll never hit it.
