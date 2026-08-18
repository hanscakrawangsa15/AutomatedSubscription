import type { PublicKey } from "@solana/web3.js";
import { getProgram, getSolanaAddresses, planPda } from "./solanaProgram";
import { classifyInterval, formatDuration, type PlanKind } from "./plans";

export { formatDuration };

// Real Ethereum-mainnet USDT and this pilot's devnet test mint are both 6
// decimals — fetched as a constant here (not dynamically via a decimals()
// call) only because SPL mint decimals aren't exposed through this
// program's own accounts; the EVM side's "always fetch live" rule still
// holds for everything the program itself owns (price, interval, status,
// etc).
const DECIMALS = 6;

export type SolanaPlanInfo = {
  id: number;
  planPda: PublicKey;
  priceRaw: bigint;
  price: string;
  intervalSeconds: number;
  intervalDays: number;
  graceDays: number;
  active: boolean;
  kind: PlanKind;
};

function formatUnitsPlain(raw: bigint, decimals: number): string {
  const divisor = 10n ** BigInt(decimals);
  const whole = raw / divisor;
  const frac = raw % divisor;
  if (frac === 0n) return whole.toString();
  return `${whole}.${frac.toString().padStart(decimals, "0")}`.replace(/0+$/, "").replace(/\.$/, "");
}

// Reads through the read-only (dummy-wallet) Program instance so plans are
// visible before connecting a wallet, mirroring fetchPlans (EVM).
export async function fetchSolanaPlans(): Promise<SolanaPlanInfo[]> {
  const program = getProgram();
  const addrs = getSolanaAddresses();
  if (!program || !addrs) return [];

  const config = await program.account.config.fetch(addrs.config);
  const planCount = Number(config.planCount);

  const plans: SolanaPlanInfo[] = [];
  for (let i = 0; i < planCount; i++) {
    const pda = planPda(addrs.config, i, addrs.programId);
    const p = await program.account.plan.fetch(pda);
    const intervalDays = Number(p.interval) / 86400;
    const priceRaw = BigInt(p.price.toString());
    plans.push({
      id: i,
      planPda: pda,
      priceRaw,
      price: formatUnitsPlain(priceRaw, DECIMALS),
      intervalSeconds: Number(p.interval),
      intervalDays,
      graceDays: Number(p.gracePeriod) / 86400,
      active: p.active,
      kind: classifyInterval(intervalDays),
    });
  }
  return plans;
}
