// TxLINE ingest + decode layer for Beat the Bookie.
//
// The game needs BOTH halves of the API that Sharp and Settlement Court each used
// separately: the live de-margined ODDS line (the "sharp line" fans are trying to
// beat) and the SCORES feed (to resolve in-play micro-markets as they complete).
//
// Real byte shapes confirmed against the live World Cup feed (txline-dev.txodds.com):
//   odds:   { FixtureId, MessageId, Ts, Bookmaker:"TXLineStablePriceDemargined",
//             SuperOddsType, MarketPeriod, PriceNames, Prices (odds*1000), Pct (%, or "NA") }
//   scores: { FixtureId, Seq, Ts, StatusId, Score:{Participant1:{Total:{Goals,Corners,...}},
//             Participant2:{...}} }

import { authHeaders } from "./auth.js";

/** Decimal-odds integer (price*1000) -> decimal odds. 1738 -> 1.738. */
export function decodePrice(intPrice) {
  return intPrice / 1000;
}

/** Pct string -> probability in [0,1], or null when the feed reports "NA" (quarter handicap). */
export function decodePct(pctStr) {
  if (pctStr == null || pctStr === "NA") return null;
  const n = Number(pctStr);
  return Number.isFinite(n) ? n / 100 : null;
}

/** Stable, human-readable identity for a market within a fixture. */
export function marketKey(o) {
  return `${o.SuperOddsType}|${o.MarketParameters ?? "null"}|${o.MarketPeriod ?? "null"}`;
}

/** Short label for chat/UI, e.g. "1X2" or "O/U 2.5". */
export function marketLabel(o) {
  const t = o.SuperOddsType || "";
  if (t.startsWith("1X2")) return o.MarketPeriod ? `1X2 (${o.MarketPeriod})` : "1X2";
  if (t.startsWith("OVERUNDER")) {
    const line = (o.MarketParameters || "").replace("line=", "");
    return `O/U ${line}`;
  }
  if (t.startsWith("ASIANHANDICAP")) {
    const line = (o.MarketParameters || "").replace("line=", "");
    return `AH ${line}`;
  }
  return t;
}

/** Normalize a raw OddsPayload into a Quote: one market snapshot, de-margined. */
export function toQuote(o) {
  const names = o.PriceNames || [];
  const prices = o.Prices || [];
  const pct = o.Pct || [];
  const outcomes = names.map((name, i) => ({
    name,
    odds: prices[i] != null ? decodePrice(prices[i]) : null,
    prob: decodePct(pct[i]),
  }));
  return {
    fixtureId: o.FixtureId,
    market: marketKey(o),
    label: marketLabel(o),
    ts: o.Ts,
    inRunning: !!o.InRunning,
    period: o.MarketPeriod ?? null,
    outcomes,
    messageId: o.MessageId,
  };
}

/** True when a quote has at least 2 priced outcomes with usable de-margined probs. */
export function isTradeable(quote) {
  const usable = quote.outcomes.filter((o) => o.prob != null && o.odds > 1);
  return usable.length >= 2;
}

/**
 * Live odds feed over the TxLINE Server-Sent Events stream (/api/odds/stream).
 * Yields decoded Quote objects. Resumable via Last-Event-ID.
 */
export class LiveOddsStream {
  constructor(auth, { fixtureId = null, signal = null } = {}) {
    this.auth = auth;
    this.base = auth.api;
    this.fixtureId = fixtureId;
    this.signal = signal;
    this.lastEventId = null;
  }

  async *quotes() {
    const url = new URL(`${this.base}/api/odds/stream`);
    if (this.fixtureId) url.searchParams.set("fixtureId", String(this.fixtureId));
    const headers = { ...authHeaders(this.auth), Accept: "text/event-stream" };
    if (this.lastEventId) headers["Last-Event-ID"] = this.lastEventId;

    const res = await fetch(url, { headers, signal: this.signal });
    if (!res.ok || !res.body) throw new Error(`odds/stream HTTP ${res.status}`);

    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf("\n\n")) >= 0) {
        const raw = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const evt = parseSseEvent(raw);
        if (evt.id) this.lastEventId = evt.id;
        if (evt.data) {
          let payload;
          try { payload = JSON.parse(evt.data); } catch { continue; }
          yield toQuote(payload);
        }
      }
    }
  }
}

/** Parse one raw SSE event block ("data: {...}\nid: 123") into {id, event, data}. */
export function parseSseEvent(raw) {
  const out = { id: null, event: null, data: "" };
  for (const line of raw.split("\n")) {
    if (line.startsWith("data:")) out.data += line.slice(5).trim();
    else if (line.startsWith("id:")) out.id = line.slice(3).trim();
    else if (line.startsWith("event:")) out.event = line.slice(6).trim();
  }
  return out;
}

/** List live World Cup fixtures (CompetitionId 72), soonest first. */
export async function listWorldCupFixtures(auth) {
  const res = await fetch(`${auth.api}/api/fixtures/snapshot?competitionId=72`, { headers: authHeaders(auth) });
  if (!res.ok) throw new Error(`fixtures/snapshot HTTP ${res.status}`);
  const fx = await res.json();
  return fx
    .map((f) => ({
      fixtureId: f.FixtureId,
      home: f.Participant1,
      away: f.Participant2,
      startTime: f.StartTime,
      competition: f.Competition,
      participant1IsHome: !!f.Participant1IsHome,
    }))
    .sort((a, b) => a.startTime - b.startTime);
}

/** Full scores-event history for a fixture (latest snapshot of each action), raw feed shape. */
export async function scoresSnapshot(auth, fixtureId) {
  const res = await fetch(`${auth.api}/api/scores/snapshot/${fixtureId}`, { headers: authHeaders(auth) });
  if (!res.ok) throw new Error(`scores/snapshot HTTP ${res.status}`);
  return res.json();
}

/** Pull the full intra-interval odds time-series for one fixture, sorted by ts. */
export async function fetchFixtureUpdates(auth, fixtureId) {
  const res = await fetch(`${auth.api}/api/odds/updates/${fixtureId}`, { headers: authHeaders(auth) });
  if (!res.ok) throw new Error(`odds/updates HTTP ${res.status}`);
  const rows = await res.json();
  return rows.map(toQuote).sort((a, b) => a.ts - b.ts);
}
