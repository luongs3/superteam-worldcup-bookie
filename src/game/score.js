// Scoring: the mechanic that makes Beat the Bookie a skill game, not a coin flip.
//
// A naive fan-prediction game scores 1 point for "called it right" — pure luck
// dominates on a single match. This game scores against the SHARP LINE instead:
// TxODDS' de-margined consensus already IS the market's best probability estimate,
// so if the line moves further toward your pick after you make it, the smart money
// independently agreed with you — that is a real, repeatable skill signal (the same
// Closing-Line-Value metric professional bettors use), and it can't be faked by luck
// the way a single right/wrong result can. "Beat the line" is the anti-clone moat:
// nobody else can build this without TxODDS' de-vigged consensus feed.
//
// Total points per pick = CORRECT bonus (did the result land) + LINE-SKILL points
// (did the market move your way). Both are tracked so the leaderboard can show a
// player their real skill (line-reading), separate from the noise of one result.

/** Once an outcome's prob crosses this, the result is effectively decided — a
 *  reference here is convergence, not skill. Same rule as The Sharp's CLV ledger. */
export const SETTLEMENT_ZONE = 0.95;

/** How long after a pick to look for the line-skill reference (one feed batch). */
export const DEFAULT_HORIZON_MS = 300_000;

export const POINTS = {
  correct: 10,        // hit the final result
  clvPerPp: 100,       // 1 probability-point of favorable line movement = 1 point
  pushRefund: 0,       // void/push fixtures: no points, no penalty
};

function round(x) { return Math.round(x * 1e4) / 1e4; }

/** Follow-through edge in probability points: ref firmed beyond entry => positive. */
export function clvProb(entryProb, refProb) {
  return round(refProb - entryProb);
}

/**
 * A single fan prediction moving through its lifecycle:
 *   open -> (line-skill resolved) -> (correctness resolved) -> scored
 */
export class PredictionBook {
  constructor({ settlementZone = SETTLEMENT_ZONE, horizonMs = DEFAULT_HORIZON_MS } = {}) {
    this.settlementZone = settlementZone;
    this.horizonMs = horizonMs;
    this.open = [];      // picks awaiting one or both resolutions
    this.scored = [];    // fully resolved picks
  }

  /**
   * Register a fan's pick.
   * @param {{userId:string|number, fixtureId:number, market:string, marketLabel:string,
   *          outcome:string, feedOutcomeName:string, ts:number, entryProb:number}} pick
   */
  register(pick) {
    const rec = {
      ...pick,
      dueTs: pick.ts + this.horizonMs,
      clvPp: null, clvDone: false,
      correct: null, correctDone: false,
    };
    this.open.push(rec);
    return rec;
  }

  /** Feed one decoded odds Quote — resolves the line-skill half of any due pick on this market. */
  onQuote(quote) {
    for (const pick of this.open) {
      if (pick.clvDone || pick.fixtureId !== quote.fixtureId || pick.market !== quote.market) continue;
      if (quote.ts < pick.dueTs) continue;
      const out = quote.outcomes.find((o) => o.name === pick.feedOutcomeName);
      const refProb = out?.prob;
      if (refProb != null && refProb < this.settlementZone) {
        pick.clvPp = clvProb(pick.entryProb, refProb);
      } else {
        pick.clvPp = 0; // in settlement zone or missing -> no clean skill signal, neutral
      }
      pick.clvDone = true;
    }
    this._settleReady();
  }

  /** Fixture reached a final (or void) state — resolves the correctness half of its picks. */
  onFinal(fixtureId, market, outcome) {
    for (const pick of this.open) {
      if (pick.correctDone || pick.fixtureId !== fixtureId || pick.market !== market) continue;
      if (outcome === "push" || outcome === "void") {
        pick.correct = null; // refunded, excluded from correctness tally
      } else {
        pick.correct = outcome === pick.outcome;
      }
      // The match is over — no more odds updates are coming on this market. If the
      // CLV horizon never fired (fast-finishing match, or a void/push with no further
      // quotes), resolve it neutral now rather than leaving the pick stuck open forever.
      if (!pick.clvDone) { pick.clvPp = 0; pick.clvDone = true; }
      pick.correctDone = true;
    }
    this._settleReady();
  }

  /** Move fully-resolved picks (both halves done) into `scored` and return the newly settled ones. */
  _settleReady() {
    const ready = this.open.filter((p) => p.clvDone && p.correctDone);
    this.open = this.open.filter((p) => !(p.clvDone && p.correctDone));
    for (const p of ready) {
      const clvPoints = round((p.clvPp ?? 0) * POINTS.clvPerPp / 100);
      const correctPoints = p.correct === true ? POINTS.correct : p.correct === false ? 0 : POINTS.pushRefund;
      p.points = round(correctPoints + clvPoints);
      this.scored.push(p);
    }
    return ready;
  }
}

/** Per-user tally, ranked leaderboard, and the "football IQ" report card. */
export class Leaderboard {
  constructor() {
    this.users = new Map(); // userId -> { points, picks, correct, voided, clvSum, clvCount }
  }

  _user(userId) {
    if (!this.users.has(userId)) {
      this.users.set(userId, { userId, points: 0, picks: 0, correct: 0, voided: 0, clvSum: 0, clvCount: 0 });
    }
    return this.users.get(userId);
  }

  /** Apply a fully-scored pick from PredictionBook. */
  apply(pick) {
    const u = this._user(pick.userId);
    u.picks += 1;
    u.points = round(u.points + pick.points);
    if (pick.correct === true) u.correct += 1;
    if (pick.correct === null) u.voided += 1;
    if (pick.clvDone && pick.correct !== null) { u.clvSum += pick.clvPp ?? 0; u.clvCount += 1; }
    return u;
  }

  /** Ranked snapshot: highest points first, tie-broken by beat-the-line rate. */
  rank() {
    return [...this.users.values()]
      .map((u) => {
        const decided = u.picks - u.voided; // exclude void/push picks from accuracy
        return {
          ...u,
          points: round(u.points),
          accuracy: decided > 0 ? round(u.correct / decided) : 0,
          avgClvPp: u.clvCount ? round(u.clvSum / u.clvCount) : 0,
        };
      })
      .sort((a, b) => b.points - a.points || b.avgClvPp - a.avgClvPp);
  }
}
