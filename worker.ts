// 웹 요청과 매분 전체시장 분할 분석을 함께 처리하는 Cloudflare Worker 진입점
import app from 'vinext/server/fetch-handler';

import { refreshDashboard } from '@/lib/scanner';

interface WorkerEnvironment {
  DB: D1Database;
}

export default {
  fetch(request, environment, context) {
    return app.fetch(request, environment, context);
  },
  scheduled(controller, environment, context) {
    context.waitUntil(
      refreshDashboard(environment.DB, { force: true, now: controller.scheduledTime })
        .then((payload) => {
          if (payload.error) throw new Error(payload.error);
        })
        .catch((error) => {
          console.error('예약 분석 실패', error);
          throw error;
        }),
    );
  },
} satisfies ExportedHandler<WorkerEnvironment>;
