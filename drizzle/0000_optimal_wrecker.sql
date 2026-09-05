-- 추천 결과와 분석 이력을 저장하는 초기 D1 스키마
CREATE TABLE `scan_results` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`generated_at` integer NOT NULL,
	`status` text NOT NULL,
	`payload_json` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_scan_results_generated_at` ON `scan_results` (`generated_at`);
--> statement-breakpoint
PRAGMA optimize;
