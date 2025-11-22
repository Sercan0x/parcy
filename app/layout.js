import "./globals.css";

export const metadata = {
  title: "Parcy (TEST)",
  description: "Decentralized invoicing platform on Arc Network Testnet",
  icons: {
    icon: 'https://i.ibb.co/0Rh5vh69/parcyicon.png',
    shortcut: 'https://i.ibb.co/0Rh5vh69/parcyicon.png',
    apple: 'https://i.ibb.co/0Rh5vh69/parcyicon.png',
  },
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link
          rel="preconnect"
          href="https://fonts.gstatic.com"
          crossOrigin="anonymous"
        />
        <link
          href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600&display=swap"
          rel="stylesheet"
        />
      </head>
      <body>{children}</body>
    </html>
  );
}
