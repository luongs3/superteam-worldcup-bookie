// Game orchestration: wires live TxLINE odds + scores into picks, resolution, and
// the leaderboard. This is what the Telegram bot and the cockpit server both drive.

import { listWorldCupFixtures, scoresSnapshot, LiveOddsStream, isTradeable } from "../ingest/txline.js";
import { latestState, deriveOutcome, classifyMarket, outcomeFeedName } from "./resolve.js";
import { PredictionBook, Leaderboard } from "./score.js";
import { LeaderboardAnchor } from "../chain/anchor.js";

export class GameManager {
  constructor({ auth, anchorEvery = 5, anchor = new LeaderboardAnchor() } = {}) {
    this.auth = auth;
    this.book = new PredictionBook();
    this.board = new Leaderboard();
    this.anchor = anchor;
    this.anchorEvery = anchorEvery; // anchor the leaderboard every N settled picks
    this.settledSinceAnchor = 0;
    this.fixtures = new Map();       // fixtureId -> fixture meta
    this.latestQuote = new Map();    // `${fixtureId}:${market}` -> Quote
    this.resolvedFixtures = new Set(); // fixtureId -> already resolved, don't re-check
    this.lastAnchorResult = null;
    this.events = []; // append-only feed for the cockpit ("pick made", "resolved", "leaderboard")
  }

  _emit(kind, data) {
    const e = { ts: Date.now(), kind, data };
    this.events.push(e);
    if (this.events.length > 500) this.events.shift();
    return e;
  }

  async refreshFixtures() {
    const fx = await listWorldCupFixtures(this.auth);
    for (const f of fx) this.fixtures.set(f.fixtureId, f);
    return fx;
  }

  /** Feed one decoded odds Quote (call this from the SSE stream loop). */
  onQuote(quote) {
    if (!isTradeable(quote)) return;
    this.latestQuote.set(`${quote.fixtureId}:${quote.market}`, quote);
    this.book.onQuote(quote);
    this._drainScored();
  }

  /**
   * Register a fan's pick.
   * @returns {{ok:true, pick}|{ok:false, error:string}}
   */
  pick({ userId, fixtureId, marketType, line, outcome }) {
    const fixture = this.fixtures.get(Number(fixtureId));
    if (!fixture) return { ok: false, error: `unknown fixture ${fixtureId}` };
    if (fixture.startTime > Date.now() + 3 * 60 * 60 * 1000) {
      // Fine — pre-match picks allowed, no restriction needed there.
    }

    // Find the freshest quote for this fixture whose classified market matches.
    let quote = null, market = null, feedName = null;
    for (const [key, q] of this.latestQuote) {
      if (!key.startsWith(`${fixtureId}:`)) continue;
      const m = classifyMarket(q);
      if (!m || m.type !== marketType) continue;
      if (marketType === "OVER_UNDER" && m.line !== Number(line)) continue;
      quote = q; market = m;
    }
    if (!quote) return { ok: false, error: `no live line yet for fixture ${fixtureId} market ${marketType}${line ? " " + line : ""}` };

    feedName = outcomeFeedName(market.type, outcome);
    const priced = quote.outcomes.find((o) => o.name === feedName);
    if (!feedName || priced?.prob == null) return { ok: false, error: `outcome "${outcome}" not priced right now` };

    const rec = this.book.register({
      userId, fixtureId: Number(fixtureId), market: quote.market, marketLabel: quote.label,
      outcome, feedOutcomeName: feedName, ts: Date.now(), entryProb: priced.prob,
    });
    this._emit("pick", { userId, fixtureId: Number(fixtureId), label: quote.label, outcome, entryProb: priced.prob, entryOdds: priced.odds });
    return { ok: true, pick: rec, quote: { label: quote.label, odds: priced.odds, prob: priced.prob } };
  }

  /**
   * Poll fixtures for a final/dead state and resolve any open picks on them.
   * Call periodically (scores aren't on the SSE odds stream).
   */
  async pollResolutions() {
    const started = [...this.fixtures.values()].filter((f) => f.startTime <= Date.now() && !this.resolvedFixtures.has(f.fixtureId));
    for (const fx of started) {
      let events;
      try { events = await scoresSnapshot(this.auth, fx.fixtureId); } catch { continue; }
      const state = latestState(events);
      if (!state || (!state.final && !state.dead)) continue;

      // Resolve every market we have open picks against for this fixture.
      const markets = new Set(this.book.open.filter((p) => p.fixtureId === fx.fixtureId).map((p) => p.market));
      for (const marketKey of markets) {
        const quote = this.latestQuote.get(`${fx.fixtureId}:${marketKey}`);
        const market = quote ? classifyMarket(quote) : { type: "1X2" }; // 1X2 is the safe default shape
        const { outcome, reason } = deriveOutcome(market, state, { participant1IsHome: fx.participant1IsHome });
        if (!outcome) continue;
        this.book.onFinal(fx.fixtureId, marketKey, outcome);
        this._emit("resolved", { fixtureId: fx.fixtureId, market: marketKey, outcome, reason });
      }
      if (state.final || state.dead) this.resolvedFixtures.add(fx.fixtureId);
    }
    this._drainScored();
  }

  _drainScored() {
    const ready = this.book.scored.splice(0);
    for (const pick of ready) {
      const u = this.board.apply(pick);
      this._emit("scored", { userId: pick.userId, fixtureId: pick.fixtureId, label: pick.marketLabel, outcome: pick.outcome, correct: pick.correct, clvPp: pick.clvPp, points: pick.points, total: u.points });
      this.settledSinceAnchor++;
    }
    if (ready.length && this.settledSinceAnchor >= this.anchorEvery) {
      this.settledSinceAnchor = 0;
      this._anchorNow().catch(() => {});
    }
  }

  async _anchorNow() {
    const snap = this.board.rank();
    const result = await this.anchor.anchor(snap);
    this.lastAnchorResult = result;
    this._emit("leaderboard-anchored", result);
    return result;
  }

  leaderboard() { return this.board.rank(); }
}
