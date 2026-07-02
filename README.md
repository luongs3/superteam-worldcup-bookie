# Beat the Bookie

**Superteam × TxODDS World Cup Hackathon — Track 3, "Consumer & Fan Experiences" ($16k)**

A Telegram-native World Cup fan game. You predict live match markets against TxODDS' de-margined line — but you're not just scored on whether you called it. You're scored on whether the market's own sharp line *agreed with you afterward*. That second axis is Closing-Line Value (CLV): the metric professional sports traders use to prove skill instead of luck, applied here as the core game mechanic.

**Play now: [@beat_the_bookie_wc_bot](https://t.me/beat_the_bookie_wc_bot)**
**Watch live (judge cockpit): http://31.220.75.26:8797/**

## Why this isn't just another prediction bot

Every other fan-prediction game scores 1 point for "called it right." That's a coin flip on any single match — luck dominates, skill is invisible, and it's trivial to clone.

Beat the Bookie scores differently:

1. **Result bonus** (10pts) — you called the outcome.
2. **Line-skill bonus** — after your pick, did TxODDS' own de-margined consensus line move *toward* your call? If the sharp market independently re-priced in your direction, that's a real, repeatable signal — the same CLV metric pro bettors chase, and it can't be faked by one lucky guess.

This is the anti-clone moat too: nobody else can build "beat the line" without TxODDS' de-vigged multi-book consensus feed. Predict-the-winner games are luck; this is skill, and it's provably TxODDS-flavored skill.

## Why Telegram-native

Chat is the UI. No frontend to design, no app to install — fans predict, get scored, and check the leaderboard entirely inside a conversation they already have open during the match. It also plays to a backend-strong build: the entire product is data pipeline + game logic + a chat interface, zero client-side rendering.

## How it works

```
TxLINE SSE odds stream ──┐
                          ├─► GameManager ──► PredictionBook (CLV + correctness)
TxLINE scores polling ────┘         │              │
                                     │              ▼
                              Telegram bot ◄──  Leaderboard ──► Solana (SPL Memo anchor)
                                     │
                              Cockpit UI (SSE, judge-facing)
```

- **`src/ingest/`** — TxLINE auth + live odds SSE + fixtures/scores REST, decoding the de-margined `TXLineStablePriceDemargined` feed into clean `{name, odds, prob}` quotes.
- **`src/game/resolve.js`** — re-derives a fixture's final state from the raw scores feed (TxODDS soccer-feed status codes) and the market outcome (1X2 / Over-Under).
- **`src/game/score.js`** — `PredictionBook` (per-pick lifecycle: open → CLV resolved → correctness resolved → scored) and `Leaderboard` (ranked by points, tie-broken by average line-skill).
- **`src/game/manager.js`** — wires live odds + fixture polling into picks and resolutions; the shared engine both the bot and cockpit drive.
- **`src/chain/anchor.js`** — anchors a hash + compact memo of the ranked leaderboard on Solana (SPL Memo program) every few settled picks, so standings are tamper-evident and citable, not a number anyone could quietly edit server-side.
- **`src/bot/telegram.js`** — the primary surface. Native `fetch` long-polling, no bot framework dependency. Commands: `/matches` `/line <id>` `/pick <id> home|draw|away` `/board` `/me`.
- **`src/server/`** — secondary judge-facing cockpit: live leaderboard, pick/resolution/anchor feed over SSE, fixtures in play. Runs in the same process as the bot.

## Commands

| Command | What it does |
|---|---|
| `/matches` | List live and upcoming World Cup fixtures with their ids |
| `/line <id>` | Show the current live, de-margined 1X2 line for a fixture |
| `/pick <id> home\|draw\|away` | Lock in a prediction at the current live price |
| `/board` | Top-10 leaderboard, with the on-chain anchor link once one exists |
| `/me` | Your own record: points, correct picks, average line-skill (CLV) |

## Run it

```bash
npm install
npm test              # offline unit tests, no network — 15/15
TXLINE_AUTH=~/.config/me-secrets/txline-auth.json \
BOT_TOKEN=<telegram-bot-token> \
PORT=8797 npm run serve
```

Requires a TxLINE auth bundle (see `src/ingest/auth.js`) and a Solana keypair at `~/.config/me-secrets/solana-worldcup-keypair.json` for live on-chain anchoring (dry-run by default — set `CHAIN_LIVE=1` to actually send).

## Built for the hackathon

Fresh code for this submission — not a reuse of the earlier Track 1 (Settlement Court) or Track 2 (The Sharp) repos, per the "1 unique project per track" rule. The TxLINE ingest pattern and Solana memo-attestation approach are shared internal know-how across all three tracks (same spine, three genuinely different products), each re-authored for its own product surface.
