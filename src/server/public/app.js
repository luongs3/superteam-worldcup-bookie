// Cockpit frontend — plain JS, no build step (matches Sharp/Settlement Court house style).

const boardWrap = document.getElementById("board-wrap");
const feed = document.getElementById("feed");
const fixturesEl = document.getElementById("fixtures");
const botLink = document.getElementById("bot-link");

// The bot username is baked in server-side via a query the server doesn't need to expose;
// hardcode the known handle so judges can click straight through without extra plumbing.
botLink.href = "https://t.me/beat_the_bookie_wc_bot";

function renderBoard(rows) {
  if (!rows?.length) { boardWrap.innerHTML = '<div class="empty">No scored picks yet — waiting on the first World Cup result.</div>'; return; }
  const medal = (i) => ["🥇", "🥈", "🥉"][i] || (i + 1);
  const rowsHtml = rows.slice(0, 20).map((u, i) => {
    const name = String(u.userId).split(":")[1] || u.userId;
    const clvClass = u.avgClvPp > 0 ? "clv-pos" : u.avgClvPp < 0 ? "clv-neg" : "";
    return `<tr><td class="rank">${medal(i)}</td><td>${esc(name)}</td><td class="pts">${u.points}</td>
      <td>${u.correct}/${u.picks - u.voided}</td><td class="${clvClass}">${(u.avgClvPp * 100).toFixed(1)}pp</td></tr>`;
  }).join("");
  boardWrap.innerHTML = `<table><thead><tr><th></th><th>Player</th><th>Points</th><th>Record</th><th>Line-skill</th></tr></thead><tbody>${rowsHtml}</tbody></table>`;
}

function renderFixtures(fx) {
  if (!fx?.length) { fixturesEl.innerHTML = '<div class="empty">Loading fixtures…</div>'; return; }
  fixturesEl.innerHTML = fx.slice(-10).reverse().map((f) => {
    const when = new Date(f.startTime).toISOString().slice(0, 16).replace("T", " ");
    return `<div class="fx-item"><span>${esc(f.home)} vs ${esc(f.away)}</span><span class="when">${when} UTC</span></div>`;
  }).join("");
}

function pushEvent(kind, data) {
  const div = document.createElement("div");
  div.className = "ev";
  let label = kind, detail = "";
  if (kind === "pick") { label = "pick"; detail = `${nameOf(data.userId)} → ${data.outcome} on ${esc(data.label)} @ ${(data.entryProb * 100).toFixed(1)}%`; }
  else if (kind === "resolved") { label = "resolved"; detail = `fixture ${data.fixtureId} ${esc(data.market)} → ${data.outcome}`; }
  else if (kind === "scored") { label = "scored"; detail = `${nameOf(data.userId)} ${data.correct ? "✅" : data.correct === false ? "❌" : "↩️"} ${data.points >= 0 ? "+" : ""}${data.points}pts (total ${data.total})`; }
  else if (kind === "leaderboard-anchored") { label = "anchored"; detail = data.dryRun ? `memo ready (dry-run): ${data.memo}` : `⛓️ <a href="${data.explorer}" target="_blank" style="color:var(--gold)">on-chain</a>`; }
  else return;
  div.innerHTML = `<span class="k ${label}">${label}</span>${detail}`;
  feed.prepend(div);
  while (feed.children.length > 40) feed.removeChild(feed.lastChild);
}

function nameOf(userId) { return esc(String(userId).split(":")[1] || userId); }
function esc(s) { return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }

const es = new EventSource("/events");
es.addEventListener("hello", (e) => {
  const d = JSON.parse(e.data);
  renderBoard(d.leaderboard);
  renderFixtures(d.fixtures);
  for (const ev of d.recent || []) pushEvent(ev.kind, ev.data);
});
es.addEventListener("pick", (e) => pushEvent("pick", JSON.parse(e.data)));
es.addEventListener("resolved", (e) => pushEvent("resolved", JSON.parse(e.data)));
es.addEventListener("scored", (e) => pushEvent("scored", JSON.parse(e.data)));
es.addEventListener("leaderboard-anchored", (e) => pushEvent("leaderboard-anchored", JSON.parse(e.data)));
es.addEventListener("leaderboard", (e) => renderBoard(JSON.parse(e.data)));
es.addEventListener("fixtures", (e) => renderFixtures(JSON.parse(e.data)));

// Fixtures aren't re-broadcast on their own event; poll the state snapshot occasionally too.
setInterval(async () => {
  try {
    const r = await fetch("/api/state");
    const d = await r.json();
    renderFixtures(d.fixtures);
  } catch {}
}, 30000);
