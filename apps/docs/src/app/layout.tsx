import { RootProvider } from "fumadocs-ui/provider";
import "fumadocs-ui/style.css";
import type { ReactNode } from "react";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: {
    template: "%s | CodeSpar Docs",
    default: "CodeSpar Docs",
  },
  description:
    "Documentation for CodeSpar — autonomous AI coding agents deployed to WhatsApp, Slack, Telegram, and Discord.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body>
        <RootProvider>{children}</RootProvider>
      </body>
    </html>
  );
}
