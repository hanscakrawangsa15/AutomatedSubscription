import { useCallback, useState } from "react";
import { formatTxError } from "../lib/errors";

export type TxStatus = "idle" | "pending" | "success" | "error";

export function useTxStatus() {
  const [status, setStatus] = useState<TxStatus>("idle");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // actionLabel names the button to point back to in a "you rejected it,
  // click X to try again" message — see formatTxError.
  const run = useCallback(async (fn: () => Promise<void>, actionLabel = "try again") => {
    setStatus("pending");
    setErrorMessage(null);
    try {
      await fn();
      setStatus("success");
    } catch (err) {
      console.error(err);
      setErrorMessage(formatTxError(err, actionLabel));
      setStatus("error");
    }
  }, []);

  return { status, errorMessage, run };
}
