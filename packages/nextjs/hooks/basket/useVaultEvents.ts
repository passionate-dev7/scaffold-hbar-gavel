import { useQuery } from "@tanstack/react-query";
import { IS_DEPLOYED, POLL_MS, VAULT_ADDRESS } from "~~/utils/basket/constants";
import { fetchVaultEvents } from "~~/utils/basket/mirror";

/** The vault's newest decoded events from the mirror node, refreshed on a timer. */
export function useVaultEvents() {
  return useQuery({
    queryKey: ["basket", "events", VAULT_ADDRESS],
    enabled: IS_DEPLOYED,
    refetchInterval: POLL_MS,
    queryFn: () => fetchVaultEvents(VAULT_ADDRESS, 50),
  });
}
