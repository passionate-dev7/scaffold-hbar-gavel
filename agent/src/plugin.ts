import type { Context, Plugin } from "@hashgraph/hedera-agent-kit";
import type { Tool } from "@hashgraph/hedera-agent-kit";
import type { Hex } from "viem";
import { DeskChain, type DeskReader } from "./chain";
import { type DeskConfig, configFromEnv } from "./config";
import { CancelQuotes, MAKER_TOOLS, QuoteOrder } from "./maker";
import { AcceptQuote, CancelOrder, GetOrderStatus, ListQuotes, PostOrder, TAKER_TOOLS } from "./taker";

export const gavelToolNames = { ...TAKER_TOOLS, ...MAKER_TOOLS } as const;

export type GavelPluginOptions = {
  config?: DeskConfig;
  /** Injectable so tests run the tools without a network. */
  chain?: DeskReader;
  /** ECDSA private key (0x hex) the maker signs quotes with. Taker-only agents leave it out; it never appears in a tool parameter or result. */
  makerKey?: Hex;
};

/**
 * The Gavel RFQ desk plugin for the Hedera Agent Kit: the taker side (post_order, list_quotes, accept_quote,
 * cancel_order, get_order_status) and the maker side (quote_order, cancel_quotes). The desk address and ABI come
 * from deployedContracts.ts at runtime.
 */
export function createGavelPlugin(options: GavelPluginOptions = {}): Plugin {
  const config = options.config ?? options.chain?.cfg ?? configFromEnv();
  const chain = options.chain ?? new DeskChain(config);
  return {
    name: "gavel",
    version: "1.0.0",
    description:
      "Trade on the Gavel RFQ desk on Hedera. As a taker: post a swap order, read and verify market-maker quotes from the HCS topic, accept the best one, cancel, check status. As a market maker: price an order from SaucerSwap V2, sign an EIP-712 quote, submit it to the topic, cancel quotes. Every order is backed by a network-scheduled SaucerSwap fallback.",
    tools: (_context: Context): Tool[] => [
      new GetOrderStatus(chain),
      new ListQuotes(chain),
      new PostOrder(chain),
      new AcceptQuote(chain),
      new CancelOrder(chain),
      new QuoteOrder(chain, options.makerKey),
      new CancelQuotes(chain),
    ],
  };
}
