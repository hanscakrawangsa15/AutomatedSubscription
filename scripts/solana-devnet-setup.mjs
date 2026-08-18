// One-time devnet bring-up for the Solana pilot: creates a test SPL mint
// (standing in for USDT — devnet has no real USDT), a treasury token
// account, calls `initialize`, and creates the same 5-tier plan set used
// on every other chain (frontend/src/lib/pricingTiers.ts).
import "dotenv/config";
import fs from "fs";
import os from "os";
import path from "path";
import * as anchor from "@coral-xyz/anchor";
import BN from "bn.js";
import { Connection, Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  createMint,
  getOrCreateAssociatedTokenAccount,
} from "@solana/spl-token";

const DAY = 86_400;

// Mirrors frontend/src/lib/pricingTiers.ts's PRICING_TIERS.
const TIER_PLANS = [
  { label: "Starter (monthly)", cents: 1000, days: 30, graceDays: 5 },
  { label: "Basic (monthly)", cents: 2900, days: 30, graceDays: 5 },
  { label: "Basic (yearly)", cents: 27840, days: 365, graceDays: 10 },
  { label: "Advance (monthly)", cents: 6900, days: 30, graceDays: 5 },
  { label: "Advance (yearly)", cents: 66240, days: 365, graceDays: 10 },
];

function centsToRaw(cents, decimals) {
  return BigInt(cents) * 10n ** BigInt(decimals - 2);
}

function loadKeypair(p) {
  const raw = JSON.parse(fs.readFileSync(p, "utf8"));
  return Keypair.fromSecretKey(Uint8Array.from(raw));
}

async function main() {
  const walletPath = path.join(os.homedir(), ".config/solana/id.json");
  const payer = loadKeypair(walletPath);
  const connection = new Connection("https://api.devnet.solana.com", "confirmed");

  const idl = JSON.parse(fs.readFileSync(new URL("../target/idl/subscription_manager.json", import.meta.url)));
  const provider = new anchor.AnchorProvider(connection, new anchor.Wallet(payer), { commitment: "confirmed" });
  anchor.setProvider(provider);
  const program = new anchor.Program(idl, provider);

  console.log(`Payer: ${payer.publicKey.toBase58()}`);
  console.log(`Program: ${program.programId.toBase58()}`);

  const decimals = 6;
  // Reuse an already-created mint/config (pass its base58 address as argv[2])
  // instead of minting a fresh one every run — each run costs real (if
  // small) devnet SOL for new accounts, and SOL here is scarce.
  const existingMint = process.argv[2];
  let mint, treasuryAta;
  if (existingMint) {
    mint = new PublicKey(existingMint);
    treasuryAta = await getOrCreateAssociatedTokenAccount(connection, payer, mint, payer.publicKey);
    console.log(`Reusing mint: ${mint.toBase58()}`);
  } else {
    mint = await createMint(connection, payer, payer.publicKey, null, decimals);
    console.log(`Mint (test USDT): ${mint.toBase58()}`);
    treasuryAta = await getOrCreateAssociatedTokenAccount(connection, payer, mint, payer.publicKey);
    console.log(`Treasury token account: ${treasuryAta.address.toBase58()}`);
  }

  const [config] = PublicKey.findProgramAddressSync(
    [Buffer.from("config"), mint.toBuffer()],
    program.programId,
  );
  console.log(`Config PDA: ${config.toBase58()}`);

  const existingConfig = await connection.getAccountInfo(config);
  if (existingConfig) {
    console.log("Config already initialized, skipping.");
  } else {
    const keeperRewardBps = 0;
    await program.methods
      .initialize(keeperRewardBps)
      .accounts({
        admin: payer.publicKey,
        paymentMint: mint,
        treasuryTokenAccount: treasuryAta.address,
        config,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
    console.log("Config initialized.");
  }

  for (const tier of TIER_PLANS) {
    const configAccount = await program.account.config.fetch(config);
    const planId = configAccount.planCount;
    const [plan] = PublicKey.findProgramAddressSync(
      [Buffer.from("plan"), config.toBuffer(), planId.toArrayLike(Buffer, "le", 8)],
      program.programId,
    );
    await program.methods
      .createPlan(
        new BN(centsToRaw(tier.cents, decimals).toString()),
        new BN(tier.days * DAY),
        new BN(tier.graceDays * DAY),
      )
      .accounts({
        config,
        admin: payer.publicKey,
        plan,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
    console.log(`Created plan #${planId}: ${tier.label} — ${(tier.cents / 100).toFixed(2)} tokens / ${tier.days}d`);
  }

  console.log("\n--- Add these to frontend/.env for the Solana tab ---");
  console.log(`VITE_SOLANA_DEVNET_USDT_MINT=${mint.toBase58()}`);
  console.log(`VITE_SOLANA_DEVNET_PROGRAM_ID=${program.programId.toBase58()}`);
  console.log(`VITE_SOLANA_DEVNET_CONFIG=${config.toBase58()}`);
  console.log(`VITE_SOLANA_DEVNET_TREASURY_TOKEN_ACCOUNT=${treasuryAta.address.toBase58()}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
