# 새 분석기 프로세스와 완성 가격·TT 추적 결과를 화면에 전달한다.
import copy
import json
import math
import os
import re
import subprocess
import threading
import time
from collections import OrderedDict
from pathlib import Path

SECRET_KEYS = ('CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_D1_DATABASE_ID', 'CLOUDFLARE_API_TOKEN')


def node_executable():
    import nodejs_wheel
    root = Path(nodejs_wheel.__file__).parent
    return str(root / 'node.exe' if os.name == 'nt' else root / 'bin' / 'node')


def fresh_payload(payload, now_ms):
    return payload.get('version') == 7 and 0 <= now_ms - payload.get('generatedAt', 0) <= 45_000


def valid_plan(plan):
    if not isinstance(plan, dict) or plan.get('source') != 'tt':
        return False
    values = [plan.get('stop'), plan.get('entry'), *(plan.get('targets') or [])]
    return (len(values) == 5 and all(type(v) in (int, float) and math.isfinite(v) and v > 0 for v in values)
            and all(a < b for a, b in zip(values, values[1:])) and not plan.get('stoppedAt') and not plan.get('completedAt'))


def public_snapshot(state, now_ms=None):
    now_ms = int(time.time() * 1000) if now_ms is None else now_ms
    view = copy.deepcopy(state)
    payload = view.get('payload')
    if not payload:
        return view
    payload['viewedAt'] = now_ms
    exclusions = payload.get('exclusions') or {}
    allowed = (payload.get('version') == 7 and exclusions.get('ready')
               and 0 <= now_ms - exclusions.get('checkedAt', 0) <= 120_000)
    excluded = {r['market'] for r in payload.get('excluded', [])} | {'KRW-USDT'}
    accepted = []
    for row in payload.get('rows', []):
        unit, plan, quote = row.get('unit'), row.get('plan'), row.get('quote') or {}
        if unit not in (15, 60) or row.get('market') in excluded or not allowed or not valid_plan(plan):
            continue
        end = now_ms // (unit * 60_000) * unit * 60_000
        turnover = row.get('turnover') or {}
        received = quote.get('receivedAt', 0)
        value = quote.get('tradePrice')
        if (0 <= now_ms - received <= 45_000 and type(value) in (int, float) and math.isfinite(value)
                and plan['stop'] < value < plan['targets'][2]
                and end - unit * 60_000 <= row.get('checkedThrough', 0) <= end
                and turnover.get('average3d', 0) >= 1_000_000_000
                and now_ms // 3_600_000 * 3_600_000 - 3_600_000 <= turnover.get('asOf', 0) <= now_ms):
            row['rechecking'] = row.get('rechecking', False) or row['checkedThrough'] != end or turnover['asOf'] != now_ms // 3_600_000 * 3_600_000
            accepted.append(row)
    payload['rows'] = accepted
    payload['waiting'] = [r for r in payload.get('waiting', []) if allowed and r.get('code') == 'TT_SIGNAL_WAIT'
                          and r.get('market') not in excluded and r.get('unit') in (15, 60)
                          and r.get('checkedThrough') == now_ms // (r['unit'] * 60_000) * (r['unit'] * 60_000)]
    payload['promising'] = [r for r in payload.get('promising', []) if allowed and r.get('market') not in excluded
                            and r.get('turnover', {}).get('asOf') == now_ms // 3_600_000 * 3_600_000]
    payload['stale'] = not fresh_payload(payload, now_ms)
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
        self._detail_market = None
        self._details = OrderedDict()
        self._detail_queue = []

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

    def request_detail(self, market):
        if not isinstance(market, str) or not re.fullmatch(r"KRW-[A-Z0-9]{1,20}", market):
            raise ValueError("종목 코드를 확인해 주세요.")
        with self._lock:
            state = self._details.get(market)
            if state and (state["running"] or time.monotonic() - state["checked_at"] < 10):
                return
            if state is None:
                if len(self._details) >= 32:
                    completed = next((m for m, d in self._details.items() if not d["running"]), None)
                    if completed is None:
                        raise ValueError("상세 분석 요청이 많습니다. 잠시 후 다시 시도해 주세요.")
                    del self._details[completed]
                state = {"market": market, "payload": None, "error": None, "running": False, "checked_at": 0}
                self._details[market] = state
            self._details.move_to_end(market)
            state["running"] = True
            self._detail_queue.append(market)
            if self._detail_market is None:
                self._next_detail()

    def _next_detail(self):
        # 잠금을 보유한 호출자만 다음 종목을 선택한다. 동일 종목 요청은 합친다.
        self._detail_market = self._detail_queue.pop(0) if self._detail_queue else None
        self._send_detail()

    def _send_detail(self):
        # 자식 재시작 시에도 진행 중 종목을 다시 전달한다.
        if self._process and self._process.poll() is None and self._process.stdin:
            try:
                self._process.stdin.write(json.dumps({"type": "detail", "market": self._detail_market}) + "\n")
                self._process.stdin.flush()
            except (OSError, ValueError):
                if self._detail_market:
                    self._details[self._detail_market]["error"] = "분석기 재연결 대기 중입니다."

    def detail_snapshot(self, market):
        with self._lock:
            return copy.deepcopy(self._details.get(market) or {
                "market": market, "payload": None, "error": None, "running": False})

    def _accept(self, event):
        with self._lock:
            self._last_event = time.monotonic()
            now_ms = int(time.time() * 1000)
            if event["type"].startswith("detail"):
                market = event.get("payload", {}).get("market", event.get("market"))
                if market != self._detail_market:
                    return
                state = self._details[market]
                if event["type"] == "detail":
                    state.update(payload=event["payload"], error=None, running=False)
                elif event["type"] == "detail_started":
                    state["running"] = True
                elif event["type"] == "detail_error":
                    message = str(event["message"])
                    token = self.credentials.get("CLOUDFLARE_API_TOKEN", "")
                    state.update(error=message.replace(token, "[숨김]") if token else message, running=False)
                if event["type"] in {"detail", "detail_error"}:
                    state["checked_at"] = time.monotonic()
                    self._next_detail()
            elif event["type"] == "started":
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
                if isinstance(event, dict) and event.get("type") in {"started", "snapshot", "completed", "waiting", "error", "detail", "detail_started", "detail_error"}:
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
                process = subprocess.Popen(self.command, env=environment, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                           stderr=subprocess.STDOUT, text=True, encoding="utf-8",
                                           creationflags=flags)
                with self._lock:
                    self._process = process
                    self._last_event = time.monotonic()
                    self._send_detail()
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
                process.stdin.close()
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
