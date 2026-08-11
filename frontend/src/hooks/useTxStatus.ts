import { useCallback, useState } from "react";

export type TxStatus = "idle" | "pending" | "success" | "error";

export function useTxStatus() {
  const [status, setStatus] = useState<TxStatus>("idle");

  const run = useCallback(async (fn: () => Promise<void>) => {
    setStatus("pending");
    try {
      await fn();
      setStatus("success");
    } catch (err) {
      console.error(err);
      setStatus("error");
    }
  }, []);

  return { status, run };
}
