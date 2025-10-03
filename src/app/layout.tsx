import './globals.css';
import ThemeWrapper from './components/ThemeWrapper';

export const metadata = {
  title: {
    default: 'Yeez.ai',
    template: '%s | Yeez.ai',
  },
  description: 'AI-powered blog and writing tools on Yeez.ai',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>
        <ThemeWrapper>{children}</ThemeWrapper>
      </body>
    </html>
  );
}

