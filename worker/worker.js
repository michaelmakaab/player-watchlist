/**
 * Player Watchlist GitHub Proxy — Cloudflare Worker
 *
 * Proxies safe GitHub Issues API operations so the front-end never holds a PAT.
 * The PAT lives as a Worker secret named GH_TOKEN.
 *
 * Allowed endpoints (anything else → 403):
 *   POST   /issues                          → create issue
 *   POST   /issues/:number/comments         → comment on issue
 *   GET    /issues?labels=...&state=...     → list issues
 *
 * Set ALLOWED_ORIGIN to your front-end origin (e.g. https://watchlist.example.com)
 * to lock CORS down. Use "*" only for testing.
 */

const REPO = "michaelmakaab/player-watchlist";
const ALLOWED_ORIGIN = "*"; // tighten this once deployed (e.g. "https://yourdomain.com")

const ALLOWED_LABELS = new Set([
  "player-suggestion",
  "coach-suggestion",
  "remove-player",
  "needs-confirmation",
]);

function corsHeaders(extra = {}) {
  return {
    "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    ...extra,
  };
}

function json(body, status = 200, extra = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders(extra) },
  });
}

async function ghFetch(path, init, env) {
  const url = `https://api.github.com/repos/${REPO}${path}`;
  const headers = {
    "Authorization": `Bearer ${env.GH_TOKEN}`,
    "Accept": "application/vnd.github+json",
    "User-Agent": "player-watchlist-proxy",
    ...(init.headers || {}),
  };
  return fetch(url, { ...init, headers });
}

async function handleCreateIssue(req, env) {
  let body;
  try {
    body = await req.json();
  } catch {
    return json({ error: "Invalid JSON" }, 400);
  }

  const { title, body: issueBody, labels } = body || {};
  if (typeof title !== "string" || title.length < 3 || title.length > 200) {
    return json({ error: "Invalid title" }, 400);
  }
  if (typeof issueBody !== "string" || issueBody.length > 10000) {
    return json({ error: "Invalid body" }, 400);
  }
  if (!Array.isArray(labels) || labels.length === 0) {
    return json({ error: "Labels required" }, 400);
  }
  for (const l of labels) {
    if (!ALLOWED_LABELS.has(l)) {
      return json({ error: `Label not allowed: ${l}` }, 403);
    }
  }

  const gh = await ghFetch("/issues", {
    method: "POST",
    body: JSON.stringify({ title, body: issueBody, labels }),
  }, env);

  const data = await gh.json().catch(() => ({}));
  return json(data, gh.status);
}

async function handleAddComment(req, env, issueNumber) {
  if (!/^\d+$/.test(issueNumber)) {
    return json({ error: "Invalid issue number" }, 400);
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return json({ error: "Invalid JSON" }, 400);
  }

  const { body: comment } = body || {};
  if (typeof comment !== "string" || comment.length < 1 || comment.length > 5000) {
    return json({ error: "Invalid comment body" }, 400);
  }

  const gh = await ghFetch(`/issues/${issueNumber}/comments`, {
    method: "POST",
    body: JSON.stringify({ body: comment }),
  }, env);

  const data = await gh.json().catch(() => ({}));
  return json(data, gh.status);
}

async function handleListIssues(url, env) {
  const params = new URLSearchParams();
  const labels = url.searchParams.get("labels");
  const state = url.searchParams.get("state") || "open";
  const perPage = url.searchParams.get("per_page") || "30";

  if (labels) {
    for (const l of labels.split(",")) {
      if (!ALLOWED_LABELS.has(l.trim())) {
        return json({ error: `Label not allowed: ${l}` }, 403);
      }
    }
    params.set("labels", labels);
  }
  if (!["open", "closed", "all"].includes(state)) {
    return json({ error: "Invalid state" }, 400);
  }
  params.set("state", state);
  params.set("per_page", String(Math.min(parseInt(perPage, 10) || 30, 100)));

  const gh = await ghFetch(`/issues?${params.toString()}`, { method: "GET" }, env);
  const data = await gh.json().catch(() => ([]));
  return json(data, gh.status);
}

export default {
  async fetch(req, env) {
    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    if (!env.GH_TOKEN) {
      return json({ error: "Server not configured" }, 500);
    }

    const url = new URL(req.url);
    const path = url.pathname.replace(/\/+$/, ""); // strip trailing slashes

    // POST /issues  → create
    if (req.method === "POST" && path === "/issues") {
      return handleCreateIssue(req, env);
    }

    // POST /issues/:number/comments  → comment
    const commentMatch = path.match(/^\/issues\/(\d+)\/comments$/);
    if (req.method === "POST" && commentMatch) {
      return handleAddComment(req, env, commentMatch[1]);
    }

    // GET /issues  → list
    if (req.method === "GET" && path === "/issues") {
      return handleListIssues(url, env);
    }

    // Health check
    if (req.method === "GET" && path === "") {
      return json({ ok: true, service: "player-watchlist-proxy" });
    }

    return json({ error: "Not found" }, 404);
  },
};
