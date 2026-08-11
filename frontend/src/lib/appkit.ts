import { createAppKit } from "@reown/appkit/react";
import { EthersAdapter } from "@reown/appkit-adapter-ethers";
import { SUPPORTED_CHAINS, DEFAULT_CHAIN } from "./chains";

const projectId = import.meta.env.VITE_WALLETCONNECT_PROJECT_ID;

export const appKit = projectId
  ? createAppKit({
      adapters: [new EthersAdapter()],
      networks: SUPPORTED_CHAINS,
      defaultNetwork: DEFAULT_CHAIN,
      projectId,
      metadata: {
        name: "Subscribe",
        description: "Subscription checkout",
        url: window.location.origin,
        icons: [],
      },
      features: {
        analytics: false,
      },
    })
  : null;

if (!projectId) {
  console.warn(
    "VITE_WALLETCONNECT_PROJECT_ID is not set — get a free Project ID at https://cloud.reown.com and add it to frontend/.env to enable the wallet connect modal.",
  );
}
