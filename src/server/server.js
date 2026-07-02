// Cockpit server for Beat the Bookie — a judge-facing "watch the game happen"
// surface. Telegram is the PRIMARY UI (fans play there); this is the secondary
// spectator view so judges don't need to install Telegram to see it working:
// live fixtures, live picks streaming in, live leaderboard, on-chain anchors.
//
// Run: npm run serve
//      PORT=8797 npm run serve

import http from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, extname } from "node:path";
import { loadAuth } from "../ingest/auth.js";
import { LiveOddsStream } from "../ingest/txline.js";
import { GameManager } from "../game/manager.js";
import { LeaderboardAnchor } from "../chain/anchor.js";
import { BookieBot } from "../bot/telegram.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC = join(__dirname, "public");
const PORT = Number(process.env.PORT || 8797);
const FIXTURE_REFRESH_MS = Number(process.env.FIXTURE_REFRESH_MS || 60_000);
const RESOLUTION_POLL_MS = Number(process.env.RESOLUTION_POLL_MS || 30_000);

const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json" };

const clients = new Set();
function broadcast(event, data) {
  const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) res.write(frame);
}

const auth = loadAuth();
const game = new GameManager({ auth, anchorEvery: Number(process.env.ANCHOR_EVERY || 5), anchor: new LeaderboardAnchor({ cluster: "devnet" }) });

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (url.pathname === "/events") {
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive", "Access-Control-Allow-Origin": "*" });
    res.write(`event: hello\ndata: ${JSON.stringify({ leaderboard: game.leaderboard(), fixtures: [...game.fixtures.values()].slice(-10), recent: game.events.slice(-30) })}\n\n`);
    clients.add(res);
    req.on("close", () => clients.delete(res));
    return;
  }
  if (url.pathname === "/api/state") {
    res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
    res.end(JSON.stringify({ leaderboard: game.leaderboard(), fixtures: [...game.fixtures.values()], recent: game.events.slice(-100) }));
    return;
  }

  let path = url.pathname === "/" ? "/index.html" : url.pathname;
  const file = join(PUBLIC, path);
  if (file.startsWith(PUBLIC) && existsSync(file)) {
    res.writeHead(200, { "Content-Type": MIME[extname(file)] || "application/octet-stream" });
    res.end(readFileSync(file));
    return;
  }
  res.writeHead(404); res.end("not found");
});

// Re-broadcast every game event onto the SSE stream.
const _emit = game._emit.bind(game);
game._emit = (kind, data) => { const e = _emit(kind, data); broadcast(kind, e.data); if (kind === "scored" || kind === "leaderboard-anchored") broadcast("leaderboard", game.leaderboard()); return e; };

server.listen(PORT, () => {
  console.log(`\n🎯  Beat the Bookie cockpit on http://localhost:${PORT}\n`);
  runFeeds().catch((e) => console.error("feed error:", e));
});

async function runFeeds() {
  await game.refreshFixtures().catch((e) => console.error("fixture refresh failed:", e.message));
  setInterval(() => game.refreshFixtures().catch((e) => console.error("fixture refresh failed:", e.message)), FIXTURE_REFRESH_MS);
  setInterval(() => game.pollResolutions().catch((e) => console.error("resolution poll failed:", e.message)), RESOLUTION_POLL_MS);

  // The Telegram bot is the primary surface — start it alongside the cockpit unless
  // explicitly disabled (e.g. local dev without a bot token configured).
  if (process.env.BOT_TOKEN && process.env.NO_BOT !== "1") {
    const bot = new BookieBot({ token: process.env.BOT_TOKEN, game });
    bot.poll().catch((e) => console.error("bot poll loop crashed:", e));
  } else {
    console.log("(BOT_TOKEN not set — running cockpit-only, no Telegram bot)");
  }

  for (;;) {
    try {
      const stream = new LiveOddsStream(auth);
      for await (const quote of stream.quotes()) {
        game.onQuote(quote);
        broadcast("quote", { fixtureId: quote.fixtureId, market: quote.market, label: quote.label, ts: quote.ts, outcomes: quote.outcomes });
      }
    } catch (err) {
      console.error("odds stream dropped, reconnecting in 5s:", err.message);
      await sleep(5000);
    }
  }
}
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
