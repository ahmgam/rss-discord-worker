/**
 * RSS → Discord Cloudflare Worker
 *
 * Env variables (set in wrangler.toml or Cloudflare dashboard):
 *   DISCORD_WEBHOOK_URL  – your Discord webhook URL
 *   RSS_SOURCES          – newline-separated list of RSS feed URLs
 */

export default {
  // Manual trigger via HTTP GET (useful for testing)
  async fetch(request, env) {
    if (new URL(request.url).pathname === "/run") {
      const result = await runFeeds(env);
      return new Response(JSON.stringify(result, null, 2), {
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response("RSS→Discord Worker is alive. GET /run to trigger manually.", { status: 200 });
  },

  // Scheduled trigger – runs every hour via cron
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runFeeds(env));
  },
};

/* ──────────────────────────────────────────────
   Core orchestrator
─────────────────────────────────────────────── */
async function runFeeds(env) {
  const webhookUrl = env.DISCORD_WEBHOOK_URL;
  if (!webhookUrl) throw new Error("DISCORD_WEBHOOK_URL is not set");

  const rawSources = env.RSS_SOURCES ?? "";
  const sources = rawSources
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);

  if (!sources.length) throw new Error("RSS_SOURCES is empty");

  const oneHourAgo = Date.now() - 60 * 60 * 1000;
  const summary = { sent: 0, skipped: 0, errors: [] };

  for (const feedUrl of sources) {
    try {
      const items = await fetchAndParseFeed(feedUrl);
      const recent = items.filter((item) => item.pubDate >= oneHourAgo);

      for (const item of recent) {
        await sendToDiscord(webhookUrl, item, feedUrl);
        summary.sent++;
        // Stay well within Discord's rate-limit (5 req / 2 s per webhook)
        await sleep(500);
      }

      summary.skipped += items.length - recent.length;
    } catch (err) {
      summary.errors.push({ feed: feedUrl, error: err.message });
    }
  }

  console.log("RSS run complete", summary);
  return summary;
}

/* ──────────────────────────────────────────────
   RSS fetching & parsing
─────────────────────────────────────────────── */
async function fetchAndParseFeed(url) {
  const res = await fetch(url, {
    headers: { "User-Agent": "RSStoDiscordBot/1.0 (Cloudflare Worker)" },
    cf: { cacheTtl: 300, cacheEverything: true },
  });

  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);

  const xml = await res.text();
  return parseRSS(xml);
}

/**
 * Lightweight XML RSS/Atom parser – no external dependencies.
 * Supports RSS 2.0 and Atom 1.0.
 */
function parseRSS(xml) {
  const isAtom = /<feed[\s>]/i.test(xml);
  const items = [];

  const entries = isAtom
    ? [...xml.matchAll(/<entry[\s>]([\s\S]*?)<\/entry>/gi)]
    : [...xml.matchAll(/<item[\s>]([\s\S]*?)<\/item>/gi)];

  for (const [, block] of entries) {
    const title = extractText(block, isAtom ? "title" : "title");
    const link  = isAtom ? extractAtomLink(block) : extractText(block, "link");
    const desc  = stripHtml(
      extractText(block, isAtom ? "summary" : "description") ||
      extractText(block, "content")
    );
    const dateStr = extractText(block, isAtom ? "updated" : "pubDate") ||
                    extractText(block, "dc:date");
    const pubDate = dateStr ? Date.parse(dateStr) : 0;

    if (title && link) {
      items.push({
        title:   decodeEntities(title.trim()),
        link:    link.trim(),
        desc:    truncate(decodeEntities(desc.trim()), 300),
        pubDate: pubDate || 0,
      });
    }
  }

  return items;
}

function extractText(block, tag) {
  // Handles <tag>, <tag attr="…"> and CDATA
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?<\\/${tag}>`, "i");
  const m = block.match(re);
  return m ? m[1] : "";
}

function extractAtomLink(block) {
  // Prefer <link href="…"/> alternate rel
  const m =
    block.match(/<link[^>]+href=["']([^"']+)["'][^>]*\/?>/i) ||
    block.match(/<link[^>]*>([^<]+)<\/link>/i);
  return m ? m[1] : "";
}

function stripHtml(html) {
  return html.replace(/<[^>]+>/g, " ").replace(/\s{2,}/g, " ").trim();
}

function decodeEntities(str) {
  return str
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
}

function truncate(str, max) {
  if (!str) return "";
  return str.length <= max ? str : str.slice(0, max - 1) + "…";
}

/* ──────────────────────────────────────────────
   Discord webhook sender
─────────────────────────────────────────────── */
async function sendToDiscord(webhookUrl, item, feedUrl) {
  const feedHost = (() => {
    try { return new URL(feedUrl).hostname; } catch { return feedUrl; }
  })();

  const payload = {
    username: "RSS Bot",
    avatar_url: `https://www.google.com/s2/favicons?sz=64&domain=${feedHost}`,
    embeds: [
      {
        title:       item.title,
        url:         item.link,
        description: item.desc || "*No description available.*",
        color:       0x5865f2, // Discord blurple
        footer: {
          text: feedHost,
        },
        timestamp: item.pubDate
          ? new Date(item.pubDate).toISOString()
          : new Date().toISOString(),
      },
    ],
  };

  const res = await fetch(webhookUrl, {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body:    JSON.stringify(payload),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Discord responded ${res.status}: ${body}`);
  }
}

/* ──────────────────────────────────────────────
   Helpers
─────────────────────────────────────────────── */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
