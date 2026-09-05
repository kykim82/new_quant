// 사용자의 새로고침 요청을 받아 호출 간격을 지키며 새 분석을 실행한다
import { env } from 'cloudflare:workers';

import { refreshDashboard } from '@/lib/scanner';

export const dynamic = 'force-dynamic';

export async function POST(): Promise<Response> {
  try {
    const payload = await refreshDashboard(env.DB);
    return Response.json(payload, {
      headers: { 'Cache-Control': 'no-store, max-age=0' },
    });
  } catch (error) {
    console.error('수동 추천 갱신 실패', error);
    return Response.json(
      { error: error instanceof Error ? error.message : '새 분석을 완료하지 못했습니다.' },
      { status: 503, headers: { 'Cache-Control': 'no-store, max-age=0' } },
    );
  }
}
