// Truth resolution for Beat the Bookie — from the TxODDS scores feed, determine
// whether a fixture has finished and what the market outcome was.
//
// This is a trimmed sibling of Settlement Court's rederive.js: same domain facts
// (TxODDS soccer-feed status codes, stat semantics), but Bookie only needs the
// FINAL outcome to grade a fan's pick — it does NOT compile an on-chain Merkle
// predicate (that's Settlement Court's job). Different technical surface, same
// internal domain knowledge — that's the "shared spine, different product" split
// the hackathon plan calls for.
//
// Soccer on-chain encodings (TxODDS spec, documentation/scores/soccer-feed.mdx):
//   Game phase StatusId: 1=NS 2=H1 3=HT 4=H2 5=F 6=WET 7=ET1 8=HTET 9=ET2 10=FET
//                        11=WPE 12=PE 13=FPE 14=Interrupted 15=Abandoned 16=Cancelled
//                        17=TXCC 18=TXCS 19=Postponed

export const PHASE = {
  NOT_STARTED: 1, H1: 2, HT: 3, H2: 4, FINISHED: 5, WET: 6, ET1: 7, HTET: 8, ET2: 9,
  FINISHED_ET: 10, WPE: 11, PE: 12, FINISHED_PE: 13, INTERRUPTED: 14, ABANDONED: 15,
  CANCELLED: 16, TX_COVERAGE_CANCELLED: 17, TX_COVERAGE_SUSPENDED: 18, POSTPONED: 19,
};

export const FINAL_STATUSES = new Set([PHASE.FINISHED, PHASE.FINISHED_ET, PHASE.FINISHED_PE]);
export const DEAD_STATUSES = new Set([PHASE.ABANDONED, PHASE.CANCELLED, PHASE.POSTPONED]);

/**
 * Reduce a fixture's scores-event history to its latest authoritative state.
 * @returns {{fixtureId, seq, ts, statusId, phase, final:boolean, dead:boolean,
 *            goals:{p1,p2}}|null}
 */
export function latestState(events) {
  if (!events?.length) return null;
  const scored = events.filter((e) => e.Score && (e.Score.Participant1 || e.Score.Participant2));
  const pool = scored.length ? scored : events;
  const last = pool.reduce((a, b) =>
    (b.Ts ?? 0) > (a.Ts ?? 0) || ((b.Ts ?? 0) === (a.Ts ?? 0) && (b.Seq ?? -1) > (a.Seq ?? -1)) ? b : a
  );
  const statusId = last.StatusId ?? 0;
  const total = (p) => last.Score?.[p]?.Total ?? {};
  const phaseName = Object.entries(PHASE).find(([, v]) => v === statusId)?.[0] ?? `UNKNOWN_${statusId}`;
  return {
    fixtureId: last.FixtureId,
    seq: last.Seq,
    ts: last.Ts,
    statusId,
    phase: phaseName,
    final: FINAL_STATUSES.has(statusId),
    dead: DEAD_STATUSES.has(statusId),
    goals: { p1: total("Participant1").Goals ?? 0, p2: total("Participant2").Goals ?? 0 },
  };
}

/**
 * Resolve a fan's market pick against the final state.
 *   { type: "1X2" }              outcome: "home" | "draw" | "away"
 *   { type: "OVER_UNDER", line } outcome: "over" | "under"
 * @returns {{outcome:string|null, reason:string}} outcome is "push"/"void" for
 *   unresolvable/dead fixtures, null while still in progress.
 */
export function deriveOutcome(market, state, { participant1IsHome = true } = {}) {
  if (!state) return { outcome: null, reason: "no feed state" };
  if (state.dead) return { outcome: "void", reason: `fixture ${state.phase}` };
  if (!state.final) return { outcome: null, reason: `fixture not finished (${state.phase})` };

  const home = participant1IsHome ? state.goals.p1 : state.goals.p2;
  const away = participant1IsHome ? state.goals.p2 : state.goals.p1;

  switch (market.type) {
    case "1X2": {
      const outcome = home > away ? "home" : home < away ? "away" : "draw";
      return { outcome, reason: `final ${home}-${away} (${state.phase})` };
    }
    case "OVER_UNDER": {
      const total = state.goals.p1 + state.goals.p2;
      if (!Number.isFinite(market.line)) return { outcome: null, reason: "missing line" };
      if (total === market.line) return { outcome: "push", reason: `total ${total} == line` };
      const outcome = total > market.line ? "over" : "under";
      return { outcome, reason: `total goals ${total} vs line ${market.line}` };
    }
    default:
      return { outcome: null, reason: `unsupported market type ${market.type}` };
  }
}

/** Map a live SuperOddsType/MarketParameters pair to our supported market descriptor, or null. */
export function classifyMarket(quote) {
  if (quote.market.startsWith("1X2_PARTICIPANT_RESULT|null|null")) return { type: "1X2" };
  const ouMatch = quote.market.match(/^OVERUNDER_PARTICIPANT_GOALS\|line=([\d.]+)\|null$/);
  if (ouMatch) return { type: "OVER_UNDER", line: Number(ouMatch[1]) };
  return null;
}

/** Outcome-name mapping between our canonical names and the feed's PriceNames. */
export function outcomeFeedName(marketType, outcome) {
  if (marketType === "1X2") return { home: "part1", draw: "draw", away: "part2" }[outcome] ?? null;
  if (marketType === "OVER_UNDER") return { over: "over", under: "under" }[outcome] ?? null;
  return null;
}
