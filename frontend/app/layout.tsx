import "./globals.css";

export const metadata = {
  title: "AcreIQ",
  description: "AI spatial optimization for sustainable physical environments",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
