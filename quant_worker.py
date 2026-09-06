# 루트의 분석 엔진 프로세스를 관리하고 최신 성공·실패 상태를 보관한다.
import copy
import json
import os
from pathlib import Path
import subprocess
import threading
import time

SECRET_KEYS = ("CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_D1_DATABASE_ID", "CLOUDFLARE_API_TOKEN")


def node_executable():
    import nodejs_wheel
    root = Path(nodejs_wheel.__file__).parent
    return str(root / "node.exe" if os.name == "nt" else root / "bin" / "node")


def fresh_payload(payload, now_ms):
    return (not payload.get("stale") and not payload.get("error")
            and 0 <= now_ms - payload["generatedAt"] <= 180_000)


def public_snapshot(state, now_ms=None):
    now_ms = int(time.time() * 1000) if now_ms is None else now_ms
    view = copy.deepcopy(state)
    payload = view.get("payload")
    if not payload:
        return view
    stale = bool(view.get("error") or not fresh_payload(payload, now_ms))
    payload["stale"] = stale
    for strategy in ("scalp", "swing"):
        payload[strategy] = [] if stale else [
            c for c in payload.get(strategy, [])
            if c.get("entryStatus", "ready") == "ready"
            and c.get("entryValidUntil", c["plan"]["expiresAt"]) > now_ms
        ]
    # 원래 분석 시각·가격 계획은 유지하고 현재 시각으로 신규 진입만 막는다.
    for plan in payload.get("savedPlans", []):
        if plan.get("entryStatus") != "stopped" and (stale or plan.get("entryValidUntil", 0) <= now_ms):
            plan["entryStatus"] = "waiting"
            plan["entryBlockReason"] = "최신 분석과 진입 조건 재확인 대기"
    for row in payload.get("watchlist", []):
        if now_ms - row.get("analyzedAt", 0) > 1_200_000:
            row["reason"] = "분석 지연 · 재분석 대기"
    return view


class AnalysisWorker:
    def __init__(self, credentials, command=None):
        self.credentials = dict(credentials)
        self.command = command or [node_executable(), str(Path(__file__).with_name("engine.mjs"))]
        self._lock = threading.Lock()
        self._stop = threading.Event()
        self._thread = None
        self._process = None
        self._last_event = time.monotonic()
        self._state = {"payload": None, "running": False, "error": None, "last_success": None}

    def start(self):
        with self._lock:
            if self._thread and self._thread.is_alive():
                return
            if self._stop.is_set():
                return
            self._thread = threading.Thread(target=self._supervise, daemon=True, name="quant-analysis")
            self._thread.start()

    def snapshot(self):
        with self._lock:
            return public_snapshot(self._state)

    def _accept(self, event):
        with self._lock:
            self._last_event = time.monotonic()
            now_ms = int(time.time() * 1000)
            if event["type"] == "started":
                self._state["running"] = True
                self._state["started_at"] = event["at"]
                self._state["waiting"] = None
            elif event["type"] == "snapshot":
                payload = event["payload"]
                self._state.update(payload=payload, received_at=now_ms)
                # 다른 실행이 저장한 최신 정상 결과도 복구로 인정하되 자체 분석 완료로 기록하지 않는다.
                if fresh_payload(payload, now_ms):
                    self._state.update(error=None, error_at=None, waiting=None)
            elif event["type"] == "completed":
                self._state.update(running=False, error=None, error_at=None, waiting=None, last_success=event["at"])
            elif event["type"] == "waiting":
                self._state.update(running=False, waiting=event["message"])
            elif event["type"] == "error":
                message = str(event["message"])
                token = self.credentials.get("CLOUDFLARE_API_TOKEN", "")
                if token:
                    message = message.replace(token, "[숨김]")
                self._state.update(running=False, error=message, error_at=event.get("at", now_ms), waiting=None)

    def _read_events(self, process):
        for line in process.stdout:
            try:
                event = json.loads(line)
                if isinstance(event, dict) and event.get("type") in {"started", "snapshot", "completed", "waiting", "error"}:
                    self._accept(event)
            except (ValueError, KeyError, TypeError):
                # 라이브러리 경고는 서버 로그에만 남기며 비밀을 포함한 원문을 화면에 보내지 않는다.
                continue

    def _supervise(self):
        while not self._stop.is_set():
            try:
                environment = os.environ.copy()
                environment.update(self.credentials)
                flags = subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0
                process = subprocess.Popen(self.command, env=environment, stdout=subprocess.PIPE,
                                           stderr=subprocess.STDOUT, text=True, encoding="utf-8",
                                           creationflags=flags)
                with self._lock:
                    self._process = process
                    self._last_event = time.monotonic()
                reader = threading.Thread(target=self._read_events, args=(process,), daemon=True)
                reader.start()
                while process.poll() is None and not self._stop.wait(1):
                    if time.monotonic() - self._last_event > 180:
                        self._accept({"type": "error", "message": "분석기가 3분 동안 응답하지 않아 재시작합니다."})
                        process.kill()
                        break
                if process.poll() is None:
                    process.terminate()
                    try:
                        process.wait(timeout=5)
                    except subprocess.TimeoutExpired:
                        process.kill()
                process.wait()
                reader.join(timeout=2)
                process.stdout.close()
                with self._lock:
                    self._process = None
                    self._state["running"] = False
                    if not self._stop.is_set() and not self._state.get("error"):
                        self._state["error"] = "분석 프로세스가 종료되어 60초 후 재시작합니다."
            except (OSError, RuntimeError) as error:
                self._accept({"type": "error", "message": f"분석기 실행 실패. {type(error).__name__}"})
            if self._stop.wait(60):
                break

    def stop(self):
        self._stop.set()
        if self._thread:
            self._thread.join(timeout=8)
