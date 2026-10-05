import { JetBrains_Mono } from "next/font/google";
import "@rainbow-me/rainbowkit/styles.css";
import "@scaffold-hbar-ui/components/styles.css";
import { ScaffoldHbarAppWithProviders } from "~~/components/ScaffoldHbarAppWithProviders";
import { ThemeProvider } from "~~/components/ThemeProvider";
import "~~/styles/globals.css";
import { PRODUCT_NAME } from "~~/utils/desk/constants";
import { getMetadata } from "~~/utils/scaffold-hbar/getMetadata";

const jetbrains = JetBrains_Mono({ subsets: ["latin"], weight: ["400", "500", "700"], variable: "--font-jb" });

export const metadata = getMetadata({
  title: PRODUCT_NAME,
  description:
    "An RFQ order desk on Hedera. Post a swap, makers bid with signed quotes over Consensus Service, and a scheduled SaucerSwap fallback guarantees your floor.",
});

const ScaffoldHbarApp = ({ children }: { children: React.ReactNode }) => {
  return (
    <html suppressHydrationWarning>
      <body className={jetbrains.variable}>
        <ThemeProvider forcedTheme="gavel" enableSystem={false}>
          <ScaffoldHbarAppWithProviders>{children}</ScaffoldHbarAppWithProviders>
        </ThemeProvider>
      </body>
    </html>
  );
};

export default ScaffoldHbarApp;
