import React from "react";
import { HederaPortalFaucet } from "@scaffold-hbar-ui/components";
import { hedera } from "viem/chains";
import { useTargetNetwork } from "~~/hooks/scaffold-hbar/useTargetNetwork";
import { DESK_ADDRESS } from "~~/utils/desk/constants";
import { hashscan } from "~~/utils/desk/hedera";

const WORDMARK = ["█▀▀ ▄▀▄ █ █ █▀▀ █  ", "█ █ █▀█ ▀▄▀ █▀▀ █  ", "▀▀▀ ▀ ▀  ▀  ▀▀▀ ▀▀▀"].join("\n");

/**
 * Site footer
 */
export const Footer = () => {
  const { targetNetwork } = useTargetNetwork();
  const isTestnet = targetNetwork.id !== hedera.id;

  return (
    <footer className="mt-24 border-t border-hair">
      <div className="mx-auto flex w-full max-w-[1120px] flex-col gap-6 px-4 py-8 text-sm text-sub sm:px-6 md:flex-row md:items-end md:justify-between">
        <pre aria-hidden="true" className="m-0 select-none text-[0.8125rem] leading-[1.15] text-ink">
          {WORDMARK}
        </pre>
        <ul className="m-0 flex list-none flex-wrap items-center gap-x-6 gap-y-1 p-0">
          <li>
            <a
              href={hashscan.contract(DESK_ADDRESS)}
              target="_blank"
              rel="noreferrer"
              className="link -my-2 inline-block py-2"
            >
              Desk on HashScan
            </a>
          </li>
          <li>
            <a
              href="https://docs.hedera.com/"
              target="_blank"
              rel="noreferrer"
              className="link -my-2 inline-block py-2"
            >
              Hedera docs
            </a>
          </li>
          {isTestnet && (
            <li>
              <HederaPortalFaucet showIcon />
            </li>
          )}
        </ul>
      </div>
    </footer>
  );
};
