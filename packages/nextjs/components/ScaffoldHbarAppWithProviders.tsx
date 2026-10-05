"use client";

import { RainbowKitProvider, lightTheme } from "@rainbow-me/rainbowkit";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AppProgressBar as ProgressBar } from "next-nprogress-bar";
import { Toaster } from "react-hot-toast";
import { hederaTestnet } from "viem/chains";
import { WagmiProvider } from "wagmi";
import { Footer } from "~~/components/Footer";
import { Header } from "~~/components/Header";
import { LocalChainErrorBanner } from "~~/components/LocalChainErrorBanner";
import { BlockieAvatar } from "~~/components/scaffold-hbar";
import { wagmiConfig } from "~~/services/web3/wagmiConfig";

const ScaffoldHbarApp = ({ children }: { children: React.ReactNode }) => {
  return (
    <>
      <div className="flex flex-col min-h-screen">
        <Header />
        <LocalChainErrorBanner />
        <main className="relative flex flex-col flex-1">{children}</main>
        <Footer />
      </div>
      <Toaster />
    </>
  );
};

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
    },
  },
});

export const ScaffoldHbarAppWithProviders = ({ children }: { children: React.ReactNode }) => {
  const rainbowKitTheme = lightTheme({
    accentColor: "#201d1d",
    accentColorForeground: "#fdfcfc",
    borderRadius: "small",
    fontStack: "system",
    overlayBlur: "none",
  });

  return (
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>
        <ProgressBar height="2px" color="#201d1d" />
        <RainbowKitProvider avatar={BlockieAvatar} initialChain={hederaTestnet} theme={rainbowKitTheme}>
          <ScaffoldHbarApp>{children}</ScaffoldHbarApp>
        </RainbowKitProvider>
      </QueryClientProvider>
    </WagmiProvider>
  );
};
