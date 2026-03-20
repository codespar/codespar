import { DocsLayout } from "fumadocs-ui/layouts/docs";
import type { ReactNode } from "react";
import { source } from "@/lib/source";

function Logo() {
  return (
    <span style={{ fontWeight: 700, fontSize: 18, letterSpacing: "-0.02em" }}>
      code
      <span style={{ color: "#3B82F6" }}>&lt;</span>
      spar
      <span style={{ color: "#3B82F6" }}>&gt;</span>
    </span>
  );
}

export default function Layout({ children }: { children: ReactNode }) {
  return (
    <DocsLayout
      tree={source.pageTree}
      nav={{ title: <Logo /> }}
    >
      {children}
    </DocsLayout>
  );
}
