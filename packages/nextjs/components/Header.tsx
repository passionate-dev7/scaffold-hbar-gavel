"use client";

import React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Mark } from "~~/components/desk/Mark";
import { RainbowKitCustomConnectButton } from "~~/components/scaffold-hbar";
import { PRODUCT_NAME } from "~~/utils/desk/constants";

type HeaderMenuLink = {
  label: string;
  href: string;
};

export const menuLinks: HeaderMenuLink[] = [
  {
    label: "Desk",
    href: "/",
  },
  {
    label: "Debug",
    href: "/debug",
  },
  {
    label: "Explorer",
    href: "/blockexplorer",
  },
];

export const HeaderMenuLinks = () => {
  const pathname = usePathname();

  return (
    <>
      {menuLinks.map(({ label, href }) => {
        const isActive = href === "/" ? pathname === href : pathname.startsWith(href);
        return (
          <li key={href} className="list-none">
            <Link
              href={href}
              aria-current={isActive ? "page" : undefined}
              className={`inline-flex min-h-9 items-center border-b-2 px-3 text-sm ${
                isActive ? "border-ash font-bold text-ink" : "border-transparent text-mute hover:text-ink"
              }`}
            >
              {label}
            </Link>
          </li>
        );
      })}
    </>
  );
};

/**
 * Site header
 */
export const Header = () => {
  return (
    <header className="z-20 shrink-0 border-b border-hair bg-canvas">
      <div className="mx-auto flex w-full max-w-[1120px] flex-wrap items-center justify-between gap-x-6 px-4 sm:px-6 lg:h-14 lg:flex-nowrap">
        <div className="flex h-14 items-center gap-8">
          <Link href="/" aria-label={`${PRODUCT_NAME} home`} className="flex shrink-0 items-center gap-3 text-ink">
            <Mark className="h-6 w-6" />
            <span className="font-bold">{PRODUCT_NAME}</span>
          </Link>
          <nav aria-label="Main" className="hidden lg:block">
            <ul className="m-0 flex list-none gap-1 p-0">
              <HeaderMenuLinks />
            </ul>
          </nav>
        </div>
        <div className="flex h-14 items-center">
          <RainbowKitCustomConnectButton />
        </div>
        <nav aria-label="Main" className="w-full border-t border-hair lg:hidden">
          <ul className="m-0 flex list-none gap-1 p-0 pb-1 pt-1">
            <HeaderMenuLinks />
          </ul>
        </nav>
      </div>
    </header>
  );
};
