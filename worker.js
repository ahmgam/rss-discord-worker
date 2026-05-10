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
    const desc  = htmlToDiscordMarkdown(
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
        desc:    truncate(desc.trim(), 2000), // Discord embed description limit
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

/**
 * Convert a subset of HTML to Discord Markdown.
 *
 * Discord embed descriptions support:
 *   **bold**  *italic*  __underline__  ~~strikethrough~~
 *   `inline code`  ```code block```
 *   [text](url)  > blockquote  ### heading  • list items
 *
 * Conversion map
 * ─────────────────────────────────────────────────────
 *  <b>, <strong>            → **text**
 *  <i>, <em>                → *text*
 *  <u>, <ins>               → __text__
 *  <s>, <del>, <strike>     → ~~text~~
 *  <code>                   → `text`
 *  <pre>, <pre><code>       → ```text```
 *  <a href="…">             → [text](url)
 *  <h1>–<h6>                → ### text  (Discord has one heading level)
 *  <p>, <br>                → newline
 *  <blockquote>             → > text
 *  <ul>/<ol> + <li>         → • item  /  1. item
 *  <hr>                     → ─────
 *  Everything else          → stripped (tag removed, text kept)
 */
function htmlToDiscordMarkdown(html) {
  if (!html) return "";

  let md = html;

  // ── Pre-process: unwrap CDATA, normalise line-breaks ──────────────────────
  md = md.replace(/<!?\[CDATA\[([\s\S]*?)\]\]>/gi, "$1");
  md = md.replace(/\r\n?/g, "\n");

  // ── Block elements (convert before inline so nesting resolves correctly) ──

  // <pre><code> … </code></pre>  or  <pre> … </pre>
  md = md.replace(/<pre[^>]*>\s*(?:<code[^>]*>)?([\s\S]*?)(?:<\/code>)?\s*<\/pre>/gi,
    (_, inner) => "```\n" + stripAllTags(inner).trim() + "\n```");

  // <blockquote>
  md = md.replace(/<blockquote[^>]*>([\s\S]*?)<\/blockquote>/gi, (_, inner) => {
    const lines = htmlToDiscordMarkdown(inner).trim().split("\n");
    return lines.map(l => "> " + l).join("\n") + "\n";
  });

  // Ordered lists — number each <li>
  md = md.replace(/<ol[^>]*>([\s\S]*?)<\/ol>/gi, (_, inner) => {
    let n = 0;
    return inner.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (__, li) =>
      `${++n}. ${htmlToDiscordMarkdown(li).trim()}\n`
    ) + "\n";
  });

  // Unordered lists
  md = md.replace(/<ul[^>]*>([\s\S]*?)<\/ul>/gi, (_, inner) =>
    inner.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (__, li) =>
      `• ${htmlToDiscordMarkdown(li).trim()}\n`
    ) + "\n"
  );

  // Headings  →  ### heading\n
  md = md.replace(/<h[1-6][^>]*>([\s\S]*?)<\/h[1-6]>/gi,
    (_, inner) => "### " + stripAllTags(inner).trim() + "\n");

  // Paragraphs / divs  →  double newline
  md = md.replace(/<\/p>/gi, "\n\n");
  md = md.replace(/<p[^>]*>/gi, "");
  md = md.replace(/<\/div>/gi, "\n");
  md = md.replace(/<div[^>]*>/gi, "");

  // <br>
  md = md.replace(/<br\s*\/?>/gi, "\n");

  // <hr>
  md = md.replace(/<hr\s*\/?>/gi, "\n─────────────────────\n");

  // ── Inline elements ────────────────────────────────────────────────────────

  // Bold
  md = md.replace(/<(?:b|strong)[^>]*>([\s\S]*?)<\/(?:b|strong)>/gi,
    (_, t) => "**" + t + "**");

  // Italic
  md = md.replace(/<(?:i|em)[^>]*>([\s\S]*?)<\/(?:i|em)>/gi,
    (_, t) => "*" + t + "*");

  // Underline
  md = md.replace(/<(?:u|ins)[^>]*>([\s\S]*?)<\/(?:u|ins)>/gi,
    (_, t) => "__" + t + "__");

  // Strikethrough
  md = md.replace(/<(?:s|del|strike)[^>]*>([\s\S]*?)<\/(?:s|del|strike)>/gi,
    (_, t) => "~~" + t + "~~");

  // Inline code  (must come after bold/italic to avoid double-wrapping)
  md = md.replace(/<code[^>]*>([\s\S]*?)<\/code>/gi,
    (_, t) => "`" + stripAllTags(t) + "`");

  // Links  →  [text](url)
  md = md.replace(/<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi,
    (_, url, text) => "[" + stripAllTags(text).trim() + "](" + url.trim() + ")");

  // Images  →  [image](src)  (shows as a link; Discord won't inline-embed)
  md = md.replace(/<img[^>]+src=["']([^"']+)["'][^>]*\/?>/gi,
    (_, src) => "[image](" + src.trim() + ")");

  // ── Strip any remaining tags ───────────────────────────────────────────────
  md = stripAllTags(md);

  // ── Decode HTML entities ───────────────────────────────────────────────────
  md = decodeEntities(md);

  // ── Collapse excessive blank lines (max 2 consecutive) ────────────────────
  md = md.replace(/\n{3,}/g, "\n\n").trim();

  return md;
}

/** Remove all remaining HTML tags, keeping their text content. */
function stripAllTags(html) {
  return html.replace(/<[^>]+>/g, "");
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