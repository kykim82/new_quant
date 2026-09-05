// 저장된 추천 결과를 반환하고 최초 요청에서는 즉시 분석을 수행한다
import { env } from 'cloudflare:workers';

import type { DashboardPayload } from '@/lib/domain';
import { getDashboard, refreshDashboard } from '@/lib/scanner';

export const dynamic = 'force-dynamic';

function json(data: unknown, status = 200): Response {
  return Response.json(data, {
    status,
    headers: { 'Cache-Control': 'no-store, max-age=0' },
  });
}

export async function GET(): Promise<Response> {
  let cached: DashboardPayload | null = null;
  try {
    cached = await getDashboard(env.DB);
  } catch {
    cached = null;
  }
  if (cached && !cached.stale) return json(cached);

  try {
    return json(await refreshDashboard(env.DB));
  } catch (error) {
    console.error('추천 데이터 갱신 실패', error);
    return json(
      { error: error instanceof Error ? error.message : '추천 데이터를 불러오지 못했습니다.' },
      503,
    );
  }
}
