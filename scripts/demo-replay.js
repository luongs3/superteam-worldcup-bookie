// Demo replay — drives the REAL game engine with the REAL recorded TxLINE history
// of a finished World Cup fixture (USA v Bosnia & Herzegovina, 2-0), so the cockpit
// can be shown mid-game with a populated leaderboard, feed, and a real on-chain
// anchor. Nothing is mocked: quotes are the actual de-margined feed rows, the final
// outcome is re-derived from the actual scores feed, and with CHAIN_LIVE=1 the
// leaderboard anchor lands as a real Solana devnet transaction.
//
// Run: node scripts/demo-replay.js            (dry-run anchor)
//      CHAIN_LIVE=1 node scripts/demo-replay.js  (real devnet anchor tx)
//
// Serves the standard cockpit UI on PORT (default 8790) with the replayed state.

import http from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, extname } from "node:path";
import { loadAuth } from "../src/ingest/auth.js";
import { fetchFixtureUpdates, scoresSnapshot, listWorldCupFixtures } from "../src/ingest/txline.js";
import { latestState } from "../src/game/resolve.js";
import { GameManager } from "../src/game/manager.js";
import { LeaderboardAnchor } from "../src/chain/anchor.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC = join(__dirname, "..", "src", "server", "public");
const PORT = Number(process.env.PORT || 8790);
const FIXTURE_ID = Number(process.env.FIXTURE_ID || 18172379); // USA v Bosnia, finished 2-0
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json" };

const auth = loadAuth();
const game = new GameManager({ auth, anchorEvery: 3, anchor: new LeaderboardAnchor({ cluster: "devnet" }) });

console.log(`Loading real fixture history for ${FIXTURE_ID}…`);
const [updates, scoreEvents, fixtures] = await Promise.all([
  fetchFixtureUpdates(auth, FIXTURE_ID),
  scoresSnapshot(auth, FIXTURE_ID),
  listWorldCupFixtures(auth),
]);
for (const f of fixtures) game.fixtures.set(f.fixtureId, f);
if (!game.fixtures.has(FIXTURE_ID)) {
  // finished fixtures drop off the upcoming list — reconstruct meta from the feed
  game.fixtures.set(FIXTURE_ID, { fixtureId: FIXTURE_ID, home: "USA", away: "Bosnia & Herzegovina", startTime: Date.now() - 3 * 3600e3, competition: "World Cup", participant1IsHome: true });
}
const fx = game.fixtures.get(FIXTURE_ID);
console.log(`fixture: ${fx.home} v ${fx.away}, ${updates.length} recorded quotes`);

// Replay in ts order. A handful of fans lock picks at REAL prices partway through
// the recorded stream — everything after that (CLV horizon, line movement, scoring)
// is the engine reacting to the genuine feed.
const oneX2Count = updates.filter((q) => q.market.startsWith("1X2_")).length;
// Fans lock picks at DIFFERENT points in the recorded stream, so entries land at
// genuinely different real prices (breaks artificial ties on the board).
const fans = [
  { userId: "heisenbd", outcome: "home", at: Math.floor(oneX2Count * 0.25) },
  { userId: "anna_wc", outcome: "home", at: Math.floor(oneX2Count * 0.45) },
  { userId: "minh.dev", outcome: "draw", at: Math.floor(oneX2Count * 0.35) },
  { userId: "kickoff_kai", outcome: "away", at: Math.floor(oneX2Count * 0.30) },
  { userId: "sofia_9", outcome: "home", at: Math.floor(oneX2Count * 0.60) },
];

// Register picks directly on the book at the quote's HISTORICAL ts so the CLV
// horizon resolves from the genuine subsequent feed (game.pick stamps Date.now(),
// which would leave every replayed quote "before" the pick and CLV stuck at 0).
const { outcomeFeedName } = await import("../src/game/resolve.js");
let seen1x2 = 0;
const pending = [...fans];
for (const q of updates) {
  if (pending.length && q.market.startsWith("1X2_")) {
    seen1x2++;
    for (let i = pending.length - 1; i >= 0; i--) {
      const f = pending[i];
      if (seen1x2 < f.at) continue;
      const feedName = outcomeFeedName("1X2", f.outcome);
      const priced = q.outcomes.find((o) => o.name === feedName);
      if (!priced || priced.prob == null) continue;
      game.book.register({
        userId: f.userId, fixtureId: FIXTURE_ID, market: q.market, marketLabel: q.label,
        outcome: f.outcome, feedOutcomeName: feedName, ts: q.ts, entryProb: priced.prob,
      });
      game._emit("pick", { userId: f.userId, fixtureId: FIXTURE_ID, label: q.label, outcome: f.outcome, entryProb: priced.prob, entryOdds: priced.odds });
      console.log(`pick ${f.userId} -> ${f.outcome}: locked @ ${priced.prob} (ts ${q.ts})`);
      pending.splice(i, 1);
    }
  }
  game.onQuote(q);
}

// Resolve from the REAL scores feed (2-0 home). The recorded history's newest
// event carries the last known real score.
const state = latestState(scoreEvents);
const outcome = state.goals.p1 > state.goals.p2 ? "home" : state.goals.p1 < state.goals.p2 ? "away" : "draw";
console.log(`real final score ${state.goals.p1}-${state.goals.p2} -> outcome=${outcome}`);
for (const marketKey of new Set(game.book.open.map((p) => p.market))) {
  game.book.onFinal(FIXTURE_ID, marketKey, outcome);
  game._emit("resolved", { fixtureId: FIXTURE_ID, market: marketKey, outcome, reason: `final ${state.goals.p1}-${state.goals.p2}` });
}
game._drainScored();
await new Promise((r) => setTimeout(r, 4000)); // let the async anchor land
console.log("leaderboard:", JSON.stringify(game.leaderboard(), null, 1));
console.log("anchor:", JSON.stringify(game.lastAnchorResult));

// Serve the standard cockpit with this state.
const clients = new Set();
const server = http.createServer((req, res) => {
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
server.listen(PORT, () => console.log(`replay cockpit on http://localhost:${PORT}`));
