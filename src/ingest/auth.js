// Load the TxLINE auth bundle (guest JWT + activated API token) created by the
// one-time on-chain subscription. The bundle lives outside the repo in the
// machine's secrets dir, never committed. Identical pattern to Track 1/2.

import { readFileSync } from "node:fs";
import os from "node:os";

const DEFAULT_PATH = `${os.homedir()}/.config/me-secrets/txline-auth.json`;

export function loadAuth(path = process.env.TXLINE_AUTH || DEFAULT_PATH) {
  const auth = JSON.parse(readFileSync(path, "utf8"));
  if (!auth.jwt || !auth.apiToken || !auth.api) {
    throw new Error(`txline-auth at ${path} missing jwt/apiToken/api`);
  }
  return auth;
}

/** Auth headers for the TxLINE API (both the JWT and the long-lived API token are required). */
export function authHeaders(auth) {
  return {
    Authorization: `Bearer ${auth.jwt}`,
    "X-Api-Token": String(auth.apiToken),
  };
}
