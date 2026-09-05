// 대시보드의 한국어 문서 구조와 기본 메타데이터를 설정하는 루트 레이아웃
import type { Metadata, Viewport } from 'next';

import './globals.css';

export const metadata: Metadata = {
  title: 'KRW 퀀트 레이더',
  description: '업비트 원화마켓의 단타·스윙 후보와 가격 계획을 확인하는 비공개 대시보드',
  manifest: '/manifest.webmanifest',
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: '#080d18',
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="ko"><body>{children}</body></html>;
}
