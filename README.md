# RSS → Discord Cloudflare Worker

Polls one or more RSS/Atom feeds every hour and posts any items published in the last 60 minutes to a Discord channel via a webhook.

## Files

| File | Purpose |
|---|---|
| `worker.js` | The Cloudflare Worker (single-file, no dependencies) |
| `wrangler.toml` | Wrangler configuration with cron schedule |

---

## Setup

### 1. Install Wrangler

```bash
npm install -g wrangler
wrangler login
```

### 2. Set secrets

```bash
# Your Discord webhook URL
wrangler secret put DISCORD_WEBHOOK_URL

# Newline-separated RSS feed URLs
wrangler secret put RSS_SOURCES
```

When prompted for `RSS_SOURCES`, paste your feeds one per line, e.g.:

```
https://feeds.bbci.co.uk/news/rss.xml
https://rss.nytimes.com/services/xml/rss/nyt/HomePage.xml
https://techcrunch.com/feed/
```

### 3. Deploy

```bash
wrangler deploy
```

---

## Local development

Create a `.dev.vars` file (never commit this):

```ini
DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/YOUR_ID/YOUR_TOKEN
RSS_SOURCES=https://feeds.bbci.co.uk/news/rss.xml
https://techcrunch.com/feed/
```

Then run:

```bash
wrangler dev
```

Visit `http://localhost:8787/run` to trigger the worker manually and see results in the terminal.

---

## How it works

1. **Cron** fires at the top of every hour (`0 * * * *`).
2. Each feed URL from `RSS_SOURCES` is fetched and parsed (RSS 2.0 & Atom 1.0 supported, no external libraries).
3. Items whose `pubDate` / `updated` field falls within the **last 60 minutes** are selected.
4. Each item is sent to Discord as a rich embed containing:
   - Clickable **title** linking to the article
   - **Description** (HTML stripped, truncated to 300 chars)
   - Source hostname in the footer
   - Publication timestamp
5. A 500 ms delay between posts keeps the worker within Discord's webhook rate limits.
6. You can also trigger the worker manually via `GET /run`.

---

## Discord embed preview

```
┌─────────────────────────────────────────────────┐
│  RSS Bot                                        │
│  ▌ Article Title (linked)                      │
│    Short description of the article…           │
│                                                 │
│    techcrunch.com          • May 10, 2026 14:00 │
└─────────────────────────────────────────────────┘
```
