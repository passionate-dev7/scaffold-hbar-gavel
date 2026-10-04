import type { Metadata } from "next";
import { FundView } from "~~/components/basket/FundView";

export const metadata: Metadata = {
  title: { absolute: "Index Basket: live NAV, target against actual weights, deposit and redeem" },
};

export default function Home() {
  return <FundView />;
}
