// On-chain leaderboard anchor (Solana) for Beat the Bookie.
//
// A leaderboard anyone can edit server-side is worthless as a "football-IQ record."
// Anchoring a snapshot on Solana at fixed checkpoints (e.g. after each fixture
// resolves) makes the standings tamper-evident and citable — the same trust
// mechanic Sharp uses for its trade calls and Settlement Court uses for disputes,
// applied here to the leaderboard itself. SPL Memo — free, instant, explorer-
// readable, no custom program needed for a hackathon-scale leaderboard.
//
// Devnet by default (free). Dry-run unless CHAIN_LIVE=1, so we never spend by accident.

import { Connection, Keypair, PublicKey, Transaction, TransactionInstruction, sendAndConfirmTransaction, clusterApiUrl } from "@solana/web3.js";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import os from "node:os";

const MEMO_PROGRAM_ID = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");

/** Canonical SHA-256 over a leaderboard snapshot — the tamper-evidence anchor. */
export function snapshotHash(snapshot) {
  const canonical = JSON.stringify(
    snapshot.map((u) => [u.userId, u.points, u.picks, u.correct, u.avgClvPp])
  );
  return createHash("sha256").update(canonical).digest("hex");
}

/** Compact, explorer-readable memo, e.g. "BOOKIE|lb|n5|t1782815574138|h:9af3...". */
export function snapshotMemo(snapshot, ts) {
  const h = snapshotHash(snapshot).slice(0, 16);
  const top = snapshot[0];
  const topLine = top ? `|top:${String(top.userId).slice(0, 12)}@${top.points}` : "";
  return `BOOKIE|lb|n${snapshot.length}|t${ts}${topLine}|h:${h}`;
}

export function loadKeypair(path = `${os.homedir()}/.config/me-secrets/solana-worldcup-keypair.json`) {
  const sk = Uint8Array.from(JSON.parse(readFileSync(path, "utf8")));
  return Keypair.fromSecretKey(sk);
}

export class LeaderboardAnchor {
  constructor({ cluster = "devnet", keypair, dryRun } = {}) {
    this.cluster = cluster;
    this.keypair = keypair || null;
    this.dryRun = dryRun ?? (process.env.CHAIN_LIVE !== "1");
    this.connection = new Connection(process.env.SOLANA_RPC_URL || clusterApiUrl(cluster), "confirmed");
  }

  /** Anchor one leaderboard snapshot. Dry-run -> { dryRun, memo, hash }. Live -> adds { signature, explorer }. */
  async anchor(snapshot, ts = Date.now()) {
    const memo = snapshotMemo(snapshot, ts);
    const hash = snapshotHash(snapshot);
    if (this.dryRun) return { dryRun: true, memo, hash };

    if (!this.keypair) this.keypair = loadKeypair();
    const ix = new TransactionInstruction({
      keys: [{ pubkey: this.keypair.publicKey, isSigner: true, isWritable: true }],
      programId: MEMO_PROGRAM_ID,
      data: Buffer.from(memo, "utf8"),
    });
    const tx = new Transaction().add(ix);
    const signature = await sendAndConfirmTransaction(this.connection, tx, [this.keypair], { commitment: "confirmed" });
    const explorer = `https://explorer.solana.com/tx/${signature}?cluster=${this.cluster}`;
    return { dryRun: false, signature, memo, hash, explorer };
  }
}
