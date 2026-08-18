import { AnchorProvider, Program } from "@coral-xyz/anchor";
import { Connection, PublicKey } from "@solana/web3.js";
// The JSON is the actual IDL (raw Rust/snake_case names) passed as the
// runtime value; the generated .ts file is a camelCase *type-only* helper
// Anchor emits alongside it — Program's own runtime proxy camelCases
// method/account names regardless of the JSON's casing (confirmed
// empirically: scripts/solana-devnet-setup.mjs's plain-JS `.methods.
// createPlan(...)` already works against this same raw JSON), so pairing
// the two like this is the standard Anchor TS pattern, not a workaround.
import idl from "../abi/SubscriptionManagerSolana.json";
import type { SubscriptionManager } from "../abi/SubscriptionManagerSolanaType";

// "mainnet" (default, matching the rest of the app) or "devnet" — set to
// devnet only while Solana Mainnet isn't deployed yet (getSolanaAddresses()
// below returns null until the VITE_SOLANA_MAINNET_* vars exist, so the app
// shows a graceful "not deployed yet" state rather than crashing).
const SOLANA_NETWORK_MODE = (import.meta.env.VITE_SOLANA_NETWORK_MODE || "mainnet") as "devnet" | "mainnet";
export const IS_SOLANA_MAINNET_MODE = SOLANA_NETWORK_MODE === "mainnet";

function envKey(suffix: string): string {
  return `VITE_SOLANA_${SOLANA_NETWORK_MODE.toUpperCase()}_${suffix}`;
}

export type SolanaAddresses = {
  programId: PublicKey;
  mint: PublicKey;
  config: PublicKey;
  treasuryTokenAccount: PublicKey;
};

// Unlike the EVM side (lib/contracts.ts), addresses here are not keyed by
// numeric chainId — Solana clusters aren't identified that way. A second
// payment token later is just a second Config PDA under the SAME deployed
// program (see the plan doc) — reachable by adding a second env-var group
// with a different suffix, not a new program deploy.
let cachedAddresses: SolanaAddresses | null | undefined;

export function getSolanaAddresses(): SolanaAddresses | null {
  if (cachedAddresses !== undefined) return cachedAddresses;
  const env = import.meta.env as unknown as Record<string, string | undefined>;
  const programId = env[envKey("PROGRAM_ID")];
  const mint = env[envKey("USDT_MINT")];
  const config = env[envKey("CONFIG")];
  const treasuryTokenAccount = env[envKey("TREASURY_TOKEN_ACCOUNT")];
  if (!programId || !mint || !config || !treasuryTokenAccount) {
    cachedAddresses = null;
    return null;
  }
  cachedAddresses = {
    programId: new PublicKey(programId),
    mint: new PublicKey(mint),
    config: new PublicKey(config),
    treasuryTokenAccount: new PublicKey(treasuryTokenAccount),
  };
  return cachedAddresses;
}

export function isSolanaConfigured(): boolean {
  return getSolanaAddresses() !== null;
}

const DEFAULT_RPC = IS_SOLANA_MAINNET_MODE ? "https://api.mainnet-beta.solana.com" : "https://api.devnet.solana.com";
const RPC_URL =
  (IS_SOLANA_MAINNET_MODE ? import.meta.env.VITE_SOLANA_MAINNET_RPC_URL : import.meta.env.VITE_SOLANA_DEVNET_RPC_URL) ||
  DEFAULT_RPC;

let connection: Connection | null = null;
export function getConnection(): Connection {
  if (!connection) connection = new Connection(RPC_URL, "confirmed");
  return connection;
}

// A dummy, non-signing wallet. Anchor's Program requires *some* wallet
// object even for read-only account fetches and pure instruction-building
// (no signature happens in either path) — real signing always goes through
// the connected wallet-adapter's own sendTransaction, called directly by
// components after assembling instructions here, never through this
// Provider.
const READ_ONLY_WALLET = {
  publicKey: PublicKey.default,
  signTransaction: () => Promise.reject(new Error("Read-only — connect a real wallet first.")),
  signAllTransactions: () => Promise.reject(new Error("Read-only — connect a real wallet first.")),
};

export type SubscriptionManagerProgram = Program<SubscriptionManager>;

let program: SubscriptionManagerProgram | null = null;

// Returns null (rather than throwing) when unconfigured, so callers can
// show a "not deployed yet" state — mirrors isChainDeployed.
// Typed via the generated SubscriptionManager type (not the generic `Idl`
// interface) so every caller gets real account/method names (config/plan/
// subscription, subscribe/payNow/retryCharge/...) instead of `any`.
export function getProgram(): SubscriptionManagerProgram | null {
  if (!isSolanaConfigured()) return null;
  if (!program) {
    const provider = new AnchorProvider(getConnection(), READ_ONLY_WALLET as never, { commitment: "confirmed" });
    program = new Program<SubscriptionManager>(idl as SubscriptionManager, provider);
  }
  return program;
}

export function planPda(config: PublicKey, planId: number, programId: PublicKey): PublicKey {
  const idBuf = Buffer.alloc(8);
  idBuf.writeBigUInt64LE(BigInt(planId));
  return PublicKey.findProgramAddressSync([Buffer.from("plan"), config.toBuffer(), idBuf], programId)[0];
}

export function subscriptionPda(config: PublicKey, user: PublicKey, programId: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("subscription"), config.toBuffer(), user.toBuffer()],
    programId,
  )[0];
}

// SubStatus enum order from programs/subscription-manager/src/state.rs —
// Inactive=0, Active=1, Overdue=2, Expired=3 (matches Solidity's Status
// enum exactly). Anchor's JS client decodes the Rust enum as an object
// keyed by the lowercased variant name (e.g. `{ active: {} }`), confirmed
// empirically against the real deployed program.
export const SUBSCRIPTION_STATUS_SOLANA = ["Inactive", "Active", "Overdue", "Expired"] as const;

export function solanaStatusToNumber(status: Record<string, unknown>): number {
  const key = Object.keys(status)[0]?.toLowerCase();
  return SUBSCRIPTION_STATUS_SOLANA.findIndex((s) => s.toLowerCase() === key);
}
