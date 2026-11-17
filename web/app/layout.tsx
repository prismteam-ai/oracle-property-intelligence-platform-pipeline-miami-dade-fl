import type { Metadata } from "next";
import "leaflet/dist/leaflet.css";
import "./globals.css";

export const metadata: Metadata = {
  title: "Miami-Dade Oracle pipeline",
  description:
    "Miami-Dade County property, permit and contractor records: ingested incrementally, published to IPFS by content ID, and queried with DuckDB.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
