// Telegram bot for Beat the Bookie — chat IS the UI (dodges our frontend weakness,
// per the hackathon debate). Native fetch long-polling, no telegram library
// dependency, matching house style (see cis-rag-bot's requests-only Python twin).
//
// Commands:
//   /start, /help      welcome + how to play
//   /matches            list live/upcoming World Cup fixtures with fixture IDs
//   /line <id>          show the current live 1X2 line for a fixture
//   /pick <id> <home|draw|away>   make a prediction against the live line
//   /board               top-10 leaderboard
//   /me                  your own stats
//
// Every pick is graded on TWO axes: did you call the result, AND did the market's
// own sharp line move your way after you picked (Closing-Line Value) — see
// src/game/score.js for why that second axis is the anti-luck, anti-clone core.

const API_BASE = "https://api.telegram.org/bot";

export class BookieBot {
  /**
   * @param {object} opts
   * @param {string} opts.token   Telegram bot token
   * @param {import("../game/manager.js").GameManager} opts.game
   */
  constructor({ token, game }) {
    if (!token) throw new Error("BookieBot requires a token");
    this.api = `${API_BASE}${token}`;
    this.game = game;
    this.offset = undefined;
    this.running = false;
  }

  async send(chatId, text) {
    try {
      const res = await fetch(`${this.api}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, text, parse_mode: "Markdown", disable_web_page_preview: true }),
      });
      if (res.status === 400) {
        // Markdown parse error on user-controlled content — resend plain so the reply still lands.
        await fetch(`${this.api}/sendMessage`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
        });
      }
    } catch (e) {
      console.error(`sendMessage failed for chat ${chatId}:`, e.message);
    }
  }

  async handleUpdate(update) {
    const message = update.message || update.edited_message;
    if (!message?.text) return;
    const chatId = message.chat.id;
    const userId = message.from?.id ?? chatId;
    const username = message.from?.username || message.from?.first_name || String(userId);
    const [cmd, ...args] = message.text.trim().split(/\s+/);

    try {
      switch (cmd.split("@")[0].toLowerCase()) {
        case "/start": case "/help": return this.send(chatId, WELCOME);
        case "/matches": return this.cmdMatches(chatId);
        case "/line": return this.cmdLine(chatId, args[0]);
        case "/pick": return this.cmdPick(chatId, userId, username, args);
        case "/board": return this.cmdBoard(chatId);
        case "/me": return this.cmdMe(chatId, userId, username);
        default:
          if (cmd.startsWith("/")) return this.send(chatId, "Unknown command. Try /help.");
      }
    } catch (e) {
      console.error("handler error:", e);
      await this.send(chatId, "⚠️ Something broke on my end — try again in a moment.");
    }
  }

  async cmdMatches(chatId) {
    const fx = [...this.game.fixtures.values()];
    if (!fx.length) return this.send(chatId, "No fixtures loaded yet — try again in a few seconds.");
    const now = Date.now();
    const live = fx.filter((f) => f.startTime <= now && !this.game.resolvedFixtures.has(f.fixtureId)).slice(-6);
    const upcoming = fx.filter((f) => f.startTime > now).slice(0, 6);
    const lines = ["⚽ *World Cup fixtures*", ""];
    if (live.length) {
      lines.push("*Live/recent:*");
      for (const f of live) lines.push(`\`${f.fixtureId}\`  ${f.home} vs ${f.away}`);
      lines.push("");
    }
    if (upcoming.length) {
      lines.push("*Upcoming:*");
      for (const f of upcoming) lines.push(`\`${f.fixtureId}\`  ${f.home} vs ${f.away}  — ${new Date(f.startTime).toISOString().slice(0, 16).replace("T", " ")} UTC`);
    }
    lines.push("", "Check a line: `/line <id>`   Make a pick: `/pick <id> home|draw|away`");
    return this.send(chatId, lines.join("\n"));
  }

  async cmdLine(chatId, fixtureIdRaw) {
    const fixtureId = Number(fixtureIdRaw);
    if (!fixtureId) return this.send(chatId, "Usage: `/line <fixtureId>` — see `/matches` for ids.");
    const fx = this.game.fixtures.get(fixtureId);
    if (!fx) return this.send(chatId, `Don't know fixture ${fixtureId}. Check /matches.`);
    let quote = null;
    for (const [key, q] of this.game.latestQuote) {
      if (key.startsWith(`${fixtureId}:1X2`)) quote = q;
    }
    if (!quote) return this.send(chatId, `No live 1X2 line for ${fx.home} vs ${fx.away} yet.`);
    const fmt = (o) => `${o.name === "part1" ? fx.home : o.name === "part2" ? fx.away : "Draw"}: ${(o.prob * 100).toFixed(1)}% (${o.odds.toFixed(2)})`;
    return this.send(chatId, [
      `*${fx.home} vs ${fx.away}* — live sharp line (de-margined):`,
      ...quote.outcomes.map(fmt),
      "", "`/pick " + fixtureId + " home|draw|away`",
    ].join("\n"));
  }

  async cmdPick(chatId, userId, username, args) {
    const [fixtureIdRaw, outcomeRaw] = args;
    const outcome = (outcomeRaw || "").toLowerCase();
    if (!fixtureIdRaw || !["home", "draw", "away"].includes(outcome)) {
      return this.send(chatId, "Usage: `/pick <fixtureId> home|draw|away`\ne.g. `/pick 18172280 home`");
    }
    const r = this.game.pick({ userId: `${userId}:${username}`, fixtureId: Number(fixtureIdRaw), marketType: "1X2", outcome });
    if (!r.ok) return this.send(chatId, `❌ ${r.error}`);
    const fx = this.game.fixtures.get(Number(fixtureIdRaw));
    const who = outcome === "home" ? fx?.home : outcome === "away" ? fx?.away : "Draw";
    return this.send(chatId, [
      `✅ Locked in: *${who}* on ${fx?.home} vs ${fx?.away}`,
      `Sharp line right now: ${(r.quote.prob * 100).toFixed(1)}% (${r.quote.odds.toFixed(2)})`,
      "",
      "Scored on 2 axes: did you call it right, AND did the line move your way after — the same edge pros chase. Check `/me` once it settles.",
    ].join("\n"));
  }

  async cmdBoard(chatId) {
    const top = this.game.leaderboard().slice(0, 10);
    if (!top.length) return this.send(chatId, "No scored picks yet — be the first! `/matches` to get started.");
    const medal = (i) => ["🥇", "🥈", "🥉"][i] || `${i + 1}.`;
    const lines = ["🏆 *Beat the Bookie — Leaderboard*", ""];
    top.forEach((u, i) => {
      const name = String(u.userId).split(":")[1] || u.userId;
      lines.push(`${medal(i)} ${name} — *${u.points}pts* (${u.correct}/${u.picks - u.voided} correct, line-skill ${(u.avgClvPp * 100).toFixed(1)}pp)`);
    });
    if (this.game.lastAnchorResult && !this.game.lastAnchorResult.dryRun) {
      lines.push("", `⛓️ Anchored on-chain: ${this.game.lastAnchorResult.explorer}`);
    }
    return this.send(chatId, lines.join("\n"));
  }

  async cmdMe(chatId, userId, username) {
    const key = `${userId}:${username}`;
    const me = this.game.leaderboard().find((u) => u.userId === key);
    if (!me) return this.send(chatId, "No scored picks yet. `/matches` to get started.");
    return this.send(chatId, [
      `📊 *Your football IQ*`,
      `Points: *${me.points}*`,
      `Record: ${me.correct}/${me.picks - me.voided} correct${me.voided ? ` (+${me.voided} void)` : ""}`,
      `Line-skill (avg CLV): ${(me.avgClvPp * 100).toFixed(1)} prob-points/pick`,
      me.avgClvPp > 0 ? "The sharp line keeps agreeing with you after the fact. That's real skill, not luck." : "Keep picking — beating the line takes reps.",
    ].join("\n"));
  }

  async poll() {
    this.running = true;
    console.log(`🤖 Beat the Bookie bot online`);
    while (this.running) {
      try {
        const url = new URL(`${this.api}/getUpdates`);
        url.searchParams.set("timeout", "30");
        if (this.offset != null) url.searchParams.set("offset", String(this.offset));
        const res = await fetch(url, { signal: AbortSignal.timeout(40_000) });
        if (!res.ok) { await sleep(5000); continue; }
        const { result } = await res.json();
        for (const update of result || []) {
          this.offset = update.update_id + 1;
          await this.handleUpdate(update);
        }
      } catch (e) {
        if (e.name !== "TimeoutError" && e.name !== "AbortError") console.error("poll error:", e.message);
        await sleep(2000);
      }
    }
  }

  stop() { this.running = false; }
}

const WELCOME = [
  "⚽ *Beat the Bookie — World Cup fan game*",
  "",
  "Predict live World Cup markets against TxODDS' sharp, de-margined line.",
  "Your score isn't just \"did you call it\" — it's whether the market *later agreed with you* (Closing-Line Value, the pro's edge metric). That's skill you can't fake with luck.",
  "",
  "*Commands:*",
  "`/matches` — list fixtures",
  "`/line <id>` — see the live sharp line",
  "`/pick <id> home|draw|away` — make your call",
  "`/board` — leaderboard (anchored on Solana)",
  "`/me` — your stats",
].join("\n");

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
