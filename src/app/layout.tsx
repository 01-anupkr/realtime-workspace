import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Commonplace | Collaborative Workspace",
  description: "A live, shared workspace for teams and their work.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
