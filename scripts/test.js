// Offline unit tests — no network. Run: npm test
import assert from "node:assert/strict";
import { latestState, deriveOutcome, classifyMarket, outcomeFeedName, PHASE } from "../src/game/resolve.js";
import { PredictionBook, Leaderboard, clvProb, POINTS } from "../src/game/score.js";
import { snapshotMemo, snapshotHash } from "../src/chain/anchor.js";
import { GameManager } from "../src/game/manager.js";

let n = 0;
function t(name, fn) {
  n++;
  try { fn(); console.log(`ok ${n} - ${name}`); }
  catch (e) { console.error(`not ok ${n} - ${name}\n  ${e.message}`); process.exitCode = 1; }
}

const ev = (seq, ts, statusId, p1Goals, p2Goals) => ({
  FixtureId: 1, Seq: seq, Ts: ts, StatusId: statusId,
  Score: { Participant1: { Total: { Goals: p1Goals } }, Participant2: { Total: { Goals: p2Goals } } },
});
const quote = (fixtureId, market, label, ts, outcomes) => ({
  fixtureId, market, label, ts, inRunning: true,
  outcomes: outcomes.map(([name, odds, prob]) => ({ name, odds, prob })),
});

// ── resolve.js: latestState / deriveOutcome (same domain logic as Settlement Court) ──
t("latestState picks newest scored event", () => {
  const s = latestState([ev(1, 100, PHASE.H1, 0, 0), ev(9, 50, PHASE.H1, 0, 1), ev(5, 200, PHASE.FINISHED, 2, 1)]);
  assert.equal(s.goals.p1, 2);
  assert.equal(s.final, true);
});
t("deriveOutcome 1X2 home/draw/away", () => {
  const fin = (p1, p2) => latestState([ev(1, 1, PHASE.FINISHED, p1, p2)]);
  assert.equal(deriveOutcome({ type: "1X2" }, fin(2, 0)).outcome, "home");
  assert.equal(deriveOutcome({ type: "1X2" }, fin(1, 1)).outcome, "draw");
  assert.equal(deriveOutcome({ type: "1X2" }, fin(0, 3)).outcome, "away");
});
t("deriveOutcome O/U over/under/push", () => {
  const fin = (p1, p2) => latestState([ev(1, 1, PHASE.FINISHED, p1, p2)]);
  assert.equal(deriveOutcome({ type: "OVER_UNDER", line: 2.5 }, fin(2, 1)).outcome, "over");
  assert.equal(deriveOutcome({ type: "OVER_UNDER", line: 2.5 }, fin(1, 1)).outcome, "under");
  assert.equal(deriveOutcome({ type: "OVER_UNDER", line: 2 }, fin(1, 1)).outcome, "push");
});
t("deriveOutcome unfinished -> null, abandoned -> void", () => {
  assert.equal(deriveOutcome({ type: "1X2" }, latestState([ev(1, 1, PHASE.H2, 1, 0)])).outcome, null);
  assert.equal(deriveOutcome({ type: "1X2" }, latestState([ev(1, 1, PHASE.ABANDONED, 0, 0)])).outcome, "void");
});
t("classifyMarket + outcomeFeedName round-trip", () => {
  assert.deepEqual(classifyMarket({ market: "1X2_PARTICIPANT_RESULT|null|null" }), { type: "1X2" });
  assert.deepEqual(classifyMarket({ market: "OVERUNDER_PARTICIPANT_GOALS|line=2.5|null" }), { type: "OVER_UNDER", line: 2.5 });
  assert.equal(classifyMarket({ market: "ASIANHANDICAP|line=-1|null" }), null);
  assert.equal(outcomeFeedName("1X2", "home"), "part1");
  assert.equal(outcomeFeedName("1X2", "away"), "part2");
  assert.equal(outcomeFeedName("OVER_UNDER", "over"), "over");
});

// ── score.js: CLV math ──
t("clvProb: line moving toward the pick is positive", () => {
  assert.equal(clvProb(0.45, 0.55), 0.1);
  assert.equal(clvProb(0.55, 0.45), -0.1);
});

// ── score.js: PredictionBook lifecycle ──
t("PredictionBook: correct pick + favorable line move scores both bonuses", () => {
  const book = new PredictionBook({ horizonMs: 1000 });
  book.register({ userId: "u1", fixtureId: 1, market: "1X2|null|null", marketLabel: "1X2", outcome: "home", feedOutcomeName: "part1", ts: 0, entryProb: 0.45 });
  assert.equal(book.open.length, 1);
  // Line moves toward "home" after horizon — favorable CLV.
  book.onQuote(quote(1, "1X2|null|null", "1X2", 1500, [["part1", 1.9, 0.55], ["draw", 3.6, 0.25], ["part2", 5.0, 0.20]]));
  assert.equal(book.open[0].clvDone, true);
  assert.equal(book.open[0].clvPp, 0.1);
  // Fixture finishes home win — correct.
  book.onFinal(1, "1X2|null|null", "home");
  assert.equal(book.open.length, 0);
  assert.equal(book.scored.length, 1);
  const p = book.scored[0];
  assert.equal(p.correct, true);
  assert.equal(p.points, POINTS.correct + 0.1 * POINTS.clvPerPp / 100);
});
t("PredictionBook: wrong pick still scores line-skill points independently", () => {
  const book = new PredictionBook({ horizonMs: 1000 });
  book.register({ userId: "u1", fixtureId: 2, market: "1X2|null|null", marketLabel: "1X2", outcome: "away", feedOutcomeName: "part2", ts: 0, entryProb: 0.20 });
  book.onQuote(quote(2, "1X2|null|null", "1X2", 1500, [["part1", 1.5, 0.65], ["draw", 4.0, 0.20], ["part2", 8.0, 0.15]]));
  book.onFinal(2, "1X2|null|null", "home"); // away pick was wrong
  const p = book.scored[0];
  assert.equal(p.correct, false);
  assert.equal(p.clvPp, -0.05); // line moved AWAY from the pick (0.20 -> 0.15)
  assert.equal(p.points, 0 + (-0.05) * POINTS.clvPerPp / 100); // negative line-skill, no correct bonus
});
t("PredictionBook: void fixture refunds without correctness penalty", () => {
  const book = new PredictionBook({ horizonMs: 1000 });
  book.register({ userId: "u1", fixtureId: 3, market: "1X2|null|null", marketLabel: "1X2", outcome: "home", feedOutcomeName: "part1", ts: 0, entryProb: 0.5 });
  book.onFinal(3, "1X2|null|null", "void");
  const p = book.scored[0];
  assert.equal(p.correct, null);
  assert.equal(p.clvDone, true); // auto-resolved neutral since match ended before horizon
  assert.equal(p.points, POINTS.pushRefund);
});
t("PredictionBook: reference inside the settlement zone is excluded (neutral, not counted as skill)", () => {
  const book = new PredictionBook({ horizonMs: 1000, settlementZone: 0.95 });
  book.register({ userId: "u1", fixtureId: 4, market: "1X2|null|null", marketLabel: "1X2", outcome: "home", feedOutcomeName: "part1", ts: 0, entryProb: 0.6 });
  book.onQuote(quote(4, "1X2|null|null", "1X2", 1500, [["part1", 1.02, 0.98], ["draw", 30, 0.015], ["part2", 60, 0.005]]));
  assert.equal(book.open[0].clvPp, 0); // in settlement zone -> neutral, not a huge +0.38 "skill" claim
});

// ── score.js: Leaderboard ranking ──
t("Leaderboard: ranks by points, tie-breaks by avg CLV", () => {
  const lb = new Leaderboard();
  lb.apply({ userId: "a", correct: true, clvDone: true, clvPp: 0.1, points: 11 });
  lb.apply({ userId: "b", correct: true, clvDone: true, clvPp: 0.2, points: 11 });
  lb.apply({ userId: "c", correct: false, clvDone: true, clvPp: -0.1, points: 0 });
  const ranked = lb.rank();
  assert.equal(ranked[0].userId, "b"); // same points as a, higher avgClvPp wins tiebreak
  assert.equal(ranked[1].userId, "a");
  assert.equal(ranked[2].userId, "c");
});
t("Leaderboard: accuracy excludes voided picks from the denominator", () => {
  const lb = new Leaderboard();
  lb.apply({ userId: "a", correct: true, clvDone: true, clvPp: 0, points: 10 });
  lb.apply({ userId: "a", correct: null, clvDone: true, clvPp: 0, points: 0 }); // void
  lb.apply({ userId: "a", correct: false, clvDone: true, clvPp: 0, points: 0 });
  const ranked = lb.rank();
  assert.equal(ranked[0].picks, 3);
  assert.equal(ranked[0].voided, 1);
  assert.equal(ranked[0].accuracy, 0.5); // 1 correct / (3 picks - 1 void) = 0.5, not 1/3
});

// ── chain/anchor.js: memo stability ──
t("snapshot memo + hash are stable and citable", () => {
  const snap = [{ userId: "u1", points: 42, picks: 5, correct: 3, avgClvPp: 0.08 }];
  assert.ok(snapshotMemo(snap, 12345).startsWith("BOOKIE|lb|n1|t12345|top:u1@42"));
  assert.equal(snapshotHash(snap), snapshotHash([...snap]));
});

// ── game/manager.js: end-to-end wiring with a stubbed auth (no network in unit tests) ──
t("GameManager: pick rejects unknown fixture", () => {
  const gm = new GameManager({ auth: { api: "http://stub", jwt: "x", apiToken: "x" }, anchor: { anchor: async () => ({ dryRun: true }) } });
  const r = gm.pick({ userId: "u1", fixtureId: 999, marketType: "1X2", outcome: "home" });
  assert.equal(r.ok, false);
  assert.match(r.error, /unknown fixture/);
});
t("GameManager: full pick -> quote -> final -> leaderboard flow", () => {
  const gm = new GameManager({ auth: { api: "http://stub", jwt: "x", apiToken: "x" }, anchorEvery: 1, anchor: { anchor: async () => ({ dryRun: true }) } });
  gm.fixtures.set(7, { fixtureId: 7, home: "France", away: "Sweden", startTime: Date.now() - 1000, participant1IsHome: true });
  gm.onQuote(quote(7, "1X2_PARTICIPANT_RESULT|null|null", "1X2", Date.now(), [["part1", 1.8, 0.55], ["draw", 3.8, 0.26], ["part2", 4.5, 0.19]]));

  const r = gm.pick({ userId: "u1", fixtureId: 7, marketType: "1X2", outcome: "home" });
  assert.equal(r.ok, true);
  assert.equal(r.pick.entryProb, 0.55);

  // Line firms further toward home post-horizon (simulate elapsed time via a future ts on the quote).
  gm.onQuote(quote(7, "1X2_PARTICIPANT_RESULT|null|null", "1X2", Date.now() + 400_000, [["part1", 1.5, 0.66], ["draw", 4.0, 0.20], ["part2", 6.0, 0.14]]));

  // Directly resolve (pollResolutions would hit the network; test the resolution path it calls).
  gm.book.onFinal(7, "1X2_PARTICIPANT_RESULT|null|null", "home");
  gm._drainScored();

  const lb = gm.leaderboard();
  assert.equal(lb.length, 1);
  assert.equal(lb[0].userId, "u1");
  assert.equal(lb[0].correct, 1);
  assert.ok(lb[0].points > POINTS.correct); // correct + positive line-skill bonus
});

console.log(`\n1..${n}`);
