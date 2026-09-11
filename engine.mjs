// 전 종목 거래대금 수집과 ST 추적·TT 전용 추천을 증분 저장한다.
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { VERSION, HISTORY_BARS, assessHistory, UNITS, RECOMMEND_UNITS, endOf, rawBars, validBar, covered, mergeRanges, turnoverClass, evaluateMarket, promisingMarket, pricePlan, observePlan, rsi, sma } from './quant_core.mjs';
// lib/upbit.ts
var API_BASE = "https://api.upbit.com/v1";
var UpbitApiError = class extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
    this.name = "UpbitApiError";
  }
};
function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
async function requestJson(path) {
  const response = await fetch(`${API_BASE}${path}`, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(12e3)
  });
  if (/sec=0(?:;|$)/.test(response.headers.get("Remaining-Req") ?? "")) await delay(1050);
  if (response.ok) return await response.json();
  const text = await response.text();
  throw new UpbitApiError(`업비트 API ${response.status}: ${text.slice(0, 160)}`, response.status);
}
var marketStateCache;
async function fetchMarketStates(codes, now = Date.now()) {
  if (marketStateCache && now - marketStateCache.at < 60000 && codes.every((code) => marketStateCache.states.has(code))) return marketStateCache;
  const states = await new Promise((resolve, reject) => {
    const pending = new Set(codes), received = new Map();
    const socket = new WebSocket("wss://api.upbit.com/websocket/v1");
    socket.binaryType = "arraybuffer";
    let done = false;
    const finish = (error) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (socket.readyState < 2) socket.close();
      if (error) reject(error); else resolve(received);
    };
    const timer = setTimeout(() => finish(new Error(`공식 거래지원 상태 수신 대기 ${received.size}/${codes.length}`)), 8000);
    socket.addEventListener("open", () => socket.send(JSON.stringify([
      { ticket: "quant-market-status" }, { type: "ticker", codes, is_only_snapshot: true }, { format: "DEFAULT" }
    ])));
    socket.addEventListener("message", (event) => {
      try {
        const row = JSON.parse(typeof event.data === "string" ? event.data : new TextDecoder().decode(event.data));
        if (row.error) throw new Error("공식 거래지원 상태 요청 오류");
        if (!pending.has(row.code)) return;
        if (row.type !== "ticker" || typeof row.market_state !== "string" || !row.market_state
          || !Object.hasOwn(row, "delisting_date") || row.delisting_date === undefined) throw new Error(`${row.code} 거래지원 상태·종료일 필드 확인 필요`);
        received.set(row.code, { state: row.market_state, delistingDate: row.delisting_date });
        pending.delete(row.code);
        if (pending.size === 0) finish();
      } catch (error) { finish(error); }
    });
    socket.addEventListener("error", () => finish(new Error("공식 거래지원 상태 WebSocket 연결 실패")));
    socket.addEventListener("close", () => finish(new Error(`공식 거래지원 상태 수신 중 연결 종료 ${received.size}/${codes.length}`)));
  });
  return marketStateCache = { at: now, states };
}
async function fetchKrwMarkets() {
  const response = (await requestJson("/market/all?is_details=true")).filter((item) => item.market.startsWith("KRW-"));
  let states = marketStateCache?.states ?? new Map(), status;
  try {
    if (!response.length || response.some((item) => typeof item.market_event?.warning !== "boolean")) throw new Error("공식 유의 종목 필드 확인 필요");
    const checked = await fetchMarketStates(response.map((item) => item.market));
    states = checked.states;
    status = { ready: true, checkedAt: checked.at, source: "upbit-open-api" };
  } catch (error) {
    status = { ready: false, checkedAt: marketStateCache?.at ?? 0, source: "upbit-open-api", error: error.message };
  }
  const markets = response.map((item) => {
    const state = states.get(item.market);
    const ending = state && (state.delistingDate !== null || state.state === "PREDELISTING" || state.state === "DELISTED");
    const inactive = state && state.state !== "ACTIVE";
    return { market: item.market, koreanName: item.korean_name, englishName: item.english_name,
      warned: Boolean(item.market_event?.warning) || Boolean(ending || inactive),
      exclusionReason: ending ? "거래지원 종료 예정·종료" : item.market_event?.warning ? "거래 유의 종목" : inactive ? "거래지원 비활성 상태" : null,
      caution: item.market_event?.caution ?? {} };
  });
  markets.exclusionStatus = status;
  return markets;
}
async function fetchKrwTickers() {
  const response = await requestJson("/ticker/all?quote_currencies=KRW");
  const receivedAt = Date.now();
  return response.map((item) => ({
    receivedAt,
    market: item.market,
    tradePrice: item.trade_price,
    signedChangeRate: item.signed_change_rate,
    quoteVolume24h: item.acc_trade_price_24h,
    timestamp: item.timestamp
  }));
}
// runtime/storage.ts
import { setTimeout as sleep } from "node:timers/promises";
var Statement = class _Statement {
  constructor(execute, sql, params = []) {
    this.execute = execute;
    this.sql = sql;
    this.params = params;
  }
  bind(...params) {
    return new _Statement(this.execute, this.sql, params);
  }
  async all() {
    return (await this.execute([this]))[0];
  }
  async first(column) {
    const row = (await this.all()).results[0];
    return row ? column ? row[column] : row : null;
  }
  async run() {
    return (await this.execute([this]))[0];
  }
};
function databaseAdapter(execute) {
  return {
    prepare: (sql) => new Statement(execute, sql),
    batch: (statements) => execute(statements)
  };
}
function remoteDatabase(config, transport = fetch, intervalMs = 350) {
  if (!/^[a-f0-9]{32}$/i.test(config.accountId) || !/^[a-f0-9-]{36}$/i.test(config.databaseId) || !config.token.trim()) {
    throw new Error("Cloudflare D1 연결 설정을 확인해 주세요.");
  }
  const endpoint = `https://api.cloudflare.com/client/v4/accounts/${config.accountId}/d1/database/${config.databaseId}/query`;
  let nextRequestAt = 0;
  let queue = Promise.resolve();
  return databaseAdapter((queries) => {
    const operation = queue.then(async () => {
      await sleep(Math.max(0, nextRequestAt - Date.now()));
      nextRequestAt = Date.now() + intervalMs;
      const batch = queries.map(({ sql, params }) => ({ sql, params }));
      const response = await transport(endpoint, {
        method: "POST",
        headers: { Authorization: `Bearer ${config.token}`, "Content-Type": "application/json" },
        body: JSON.stringify(batch.length === 1 ? batch[0] : { batch }),
        signal: AbortSignal.timeout(3e4)
      });
      if (response.status === 429) {
        const retry = Number(response.headers.get("retry-after"));
        nextRequestAt = Date.now() + Math.max(60, Number.isFinite(retry) ? retry : 60) * 1e3;
      }
      if (!response.ok) throw new Error(`D1 연결 실패(HTTP ${response.status}). 토큰 권한·무료 사용량을 확인해 주세요.`);
      const data = await response.json();
      if (!data.success || !Array.isArray(data.result) || data.result.length !== queries.length || data.result.some((r) => !r.success)) {
        throw new Error(`D1 쿼리 실패(코드 ${data.errors?.[0]?.code ?? "unknown"}). 저장이 완료되지 않았습니다.`);
      }
      return data.result.map((r) => ({ ...r, results: r.results ?? [] }));
    });
    queue = operation.then(() => void 0, () => void 0);
    return operation;
  });
}
async function localDatabase(path) {
  const { DatabaseSync } = await import("node:sqlite");
  const sqlite = new DatabaseSync(path);
  sqlite.exec("PRAGMA journal_mode=WAL");
  sqlite.exec("PRAGMA busy_timeout=5000");
  const db = databaseAdapter(async (queries) => {
    sqlite.exec("BEGIN");
    try {
      const results = queries.map((q) => {
        const statement = sqlite.prepare(q.sql);
        const results2 = statement.all(...q.params);
        return { results: results2, success: true };
      });
      sqlite.exec("COMMIT");
      return results;
    } catch (error) {
      sqlite.exec("ROLLBACK");
      throw error;
    }
  });
  return { db, close: () => sqlite.close() };
}


// 저장 스키마는 구형 원장과 분리하며 봉 캐시는 합쳐서 보존한다.
export async function ensureSchema(db) {
  await db.batch([
    'CREATE TABLE IF NOT EXISTS candle_cache (market TEXT PRIMARY KEY, candles_json TEXT NOT NULL)',
    'CREATE TABLE IF NOT EXISTS radar_state (market TEXT PRIMARY KEY, payload_json TEXT NOT NULL)',
    'CREATE TABLE IF NOT EXISTS radar_plans (id TEXT PRIMARY KEY, market TEXT NOT NULL, payload_json TEXT NOT NULL)',
    'CREATE TABLE IF NOT EXISTS radar_snapshot (id INTEGER PRIMARY KEY, payload_json TEXT NOT NULL)',
    'CREATE TABLE IF NOT EXISTS scan_lease (id INTEGER PRIMARY KEY, until_ms INTEGER NOT NULL, token TEXT NOT NULL, last_run INTEGER NOT NULL)',
    "INSERT OR IGNORE INTO scan_lease VALUES (1, 0, '', 0)"
  ].map(s=>db.prepare(s)));
}
const parse = (text, fallback={}) => {try{return JSON.parse(text);}catch{return fallback;}};
export async function collectCandles(cache,market,unit,now,desired,request=requestJson) {
  const end=endOf(unit,now),width=unit*60000;
  cache[unit]??=[];cache.verified??={};
  const meta=cache.verified[unit]??={ranges:[],checkedThrough:0,exhausted:false};
  const bars=rawBars(cache,unit,end),latestDue=meta.checkedThrough<end;
  if(!latestDue&&meta.exhausted&&covered(cache,unit,0,end))return false;
  const historical=desired>=HISTORY_BARS,historyNeeded=historical&&!assessHistory(cache,unit,now).ready;
  if(!latestDue&&(historical?!historyNeeded:bars.length>=desired||meta.exhausted&&covered(cache,unit,0,end)))return false;
  // 긴 중단은 최신 응답부터 이전 확인 지점까지 페이지를 연결한 후에만 최신 판정으로 바꾼다.
  const recover=latestDue&&Number.isFinite(meta.gapBefore);
  const suffix=meta.ranges.find(r=>r[1]>=end);
  const to=recover?meta.gapBefore:latestDue?end:historyNeeded?(suffix?.[0]??end):bars[0]?.openTime??end;
  meta.attemptedAt=now;
  try {
    const route=unit===1440?'/candles/days':`/candles/minutes/${unit}`;
    const rows=await request(`${route}?market=${encodeURIComponent(market)}&to=${encodeURIComponent(new Date(to).toISOString())}&count=200`);
    if(!Array.isArray(rows))throw new Error('캔들 응답 형식 오류');
    const incoming=rows.map(r=>({openTime:Date.parse(r.candle_date_time_utc+'Z'),closeTime:Date.parse(r.candle_date_time_utc+'Z')+width,open:r.opening_price,high:r.high_price,low:r.low_price,close:r.trade_price,baseVolume:r.candle_acc_trade_volume,quoteVolume:r.candle_acc_trade_price}));
    if(incoming.some(b=>!validBar(b)||b.closeTime>to||b.openTime%width!==0)||new Set(incoming.map(b=>b.openTime)).size!==incoming.length)throw new Error('캔들 값·완료 시각 검증 실패');
    const merged=new Map(cache[unit].map(b=>[b.openTime,b]));incoming.forEach(b=>merged.set(b.openTime,b));cache[unit]=[...merged.values()].sort((a,b)=>a.openTime-b.openTime);
    const first=incoming.length?Math.min(...incoming.map(b=>b.openTime)):to;
    if(rows.length<200)meta.exhausted=true;
    meta.ranges=mergeRanges([...meta.ranges,[rows.length<200?0:first,to]]);
    if(latestDue){
      const target=meta.recoveryEnd??end,prior=meta.checkedThrough;
      if(!prior||meta.ranges.some(r=>r[0]<=prior&&r[1]>=target)){
        meta.checkedThrough=target;delete meta.gapBefore;delete meta.recoveryEnd;
      } else {meta.gapBefore=first;meta.recoveryEnd=target;meta.error='장기 중단 구간 복구 중';return true;}
    }
    delete meta.error;return true;
  } catch(error){meta.error=error.message;throw error;}
}
export class Radar {
  constructor(db,{request=requestJson,markets=fetchKrwMarkets,tickers=fetchKrwTickers,emit=()=>{},clock=Date.now}={}) {
    this.db=db;this.request=request;this.getMarkets=markets;this.getTickers=tickers;this.emit=emit;this.clock=clock;
    this.markets=[];this.exclusions={ready:false};this.states=new Map();this.caches=new Map();this.plans=new Map();this.quotes=new Map();this.errors=[];this.processing=false;this.detailQueue=[];this.token=null;this.dirty=new Set();this.planDirty=new Set();this.lastSave=0;this.lastMarkets=0;this.lastQuote=0;
  }
  async init(){await ensureSchema(this.db);
    for(const row of (await this.db.prepare('SELECT market,payload_json FROM radar_state').all()).results){const v=parse(row.payload_json);if(v.version===VERSION)this.states.set(row.market,v);}
    for(const row of (await this.db.prepare('SELECT id,payload_json FROM radar_plans').all()).results){const v=parse(row.payload_json);if(v.plan?.id===row.id){this.plans.set(row.id,v);if(row.id.startsWith('v7:')&&UNITS.includes(v.unit)&&v.firstShownAt)this.registerUpper(v.market,v.firstShownAt);}}
    const old=await this.db.prepare('SELECT payload_json FROM radar_snapshot WHERE id=1').first();if(old)this.emit({type:'snapshot',payload:parse(old.payload_json)});
  }
  registerUpper(market,at){
    const state=this.states.get(market)??{version:VERSION,market,frames:{},trends:{}};
    if(!state.upperTracking){state.upperTracking={firstQualifiedAt:at,attempts:{}};this.states.set(market,state);this.dirty.add(market);}
  }
  error(message){this.errors.push({at:this.clock(),message});this.errors=this.errors.slice(-12);this.emit({type:'error',at:this.clock(),message});}
  async load(code){if(this.caches.has(code))return this.caches.get(code);
    let row=await this.db.prepare('SELECT candles_json FROM candle_cache WHERE market=?').bind(code).first();
    if(!row){const table=await this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='market_analysis'").first();if(table)row=await this.db.prepare('SELECT candles_json FROM market_analysis WHERE market=?').bind(code).first();}
    const cache=row?JSON.parse(row.candles_json):{};cache.verified??={};this.caches.set(code,cache);return cache;
  }
  async acquire(){const now=this.clock(),token=randomUUID();const row=await this.db.prepare('UPDATE scan_lease SET token=?, until_ms=?, last_run=? WHERE id=1 AND until_ms<=? RETURNING token').bind(token,now+180000,now,now).first();if(row?.token===token){this.token=token;return true;}return false;}
  async renew(){if(!this.token)return false;const row=await this.db.prepare('UPDATE scan_lease SET until_ms=? WHERE id=1 AND token=? RETURNING token').bind(this.clock()+180000,this.token).first();if(!row){this.token=null;throw new Error('분석 저장 잠금이 변경되었습니다. 다음 회차에 다시 연결합니다.');}return true;}
  async release(){if(this.token)await this.db.prepare('UPDATE scan_lease SET until_ms=0 WHERE id=1 AND token=?').bind(this.token).run();this.token=null;}
  async refreshMarkets(){if(this.clock()-this.lastMarkets<60000&&this.markets.length)return;
    try{const markets=await this.getMarkets();this.markets=markets;this.exclusions=markets.exclusionStatus??{ready:false};this.lastMarkets=this.clock();if(!this.exclusions.ready)this.error(this.exclusions.error??'제외 정보 확인 대기');}
    catch(e){this.exclusions={...this.exclusions,ready:false,error:e.message};throw e;}}
  async refreshQuotes(){const rows=await this.getTickers();const now=this.clock();this.quotes=new Map(rows.map(q=>[q.market,q]));this.lastQuote=now;
    for(const [id,row] of this.plans){if(row.plan.stoppedAt||row.plan.completedAt)continue;const quote=this.quotes.get(row.market);const plan=observePlan(row.plan,[],quote,now);if(JSON.stringify(plan)!==JSON.stringify(row.plan)){this.plans.set(id,{...row,plan});this.planDirty.add(id);}}
  }
  remember(result){if(!result.plan)return;const id=result.plan.id,old=this.plans.get(id),now=this.clock();
    let plan=result.plan;
    if(!plan.entryTracking&&old?.plan.entryTracking)plan={...plan,entryTracking:old.plan.entryTracking};
    if(result.status==='ready'&&!plan.entryTracking){
      plan={...plan,entryTracking:{qualifiedAt:old?.firstShownAt??now,qualificationPrice:old?.firstShownAt?null:result.quote.tradePrice,
        startedAt:now,enteredAt:null,firstTargetAt:plan.hits.some(Boolean)?now:null,reviewAt:null,checkedThrough:now}};
      plan=observePlan(plan,[],result.quote,now);
    }
    const row={market:result.market,name:result.name,unit:result.unit,plan,firstShownAt:old?.firstShownAt??(result.status==='ready'?now:null)};
    if(JSON.stringify(row)!==JSON.stringify(old)){this.plans.set(id,row);this.planDirty.add(id);}
    if(result.status==='ready'&&UNITS.includes(result.unit))this.registerUpper(result.market,row.firstShownAt);}
  calculate(info,cache,unit,now){const state=this.states.get(info.market)??{version:VERSION,market:info.market,frames:{},trends:{}};
    const bars=rawBars(cache,unit,endOf(unit,now)),history=assessHistory(cache,unit,now),trend=history.trend;if(history.ready)state.trends[unit]=trend;
    const id=trend?.signal?`v7:${info.market}:${unit}:tt:${trend.signal.time}`:null;
    const upper=[240,1440].filter(u=>u>unit).map(u=>assessHistory(cache,u,now)).filter(h=>h.ready).map(h=>h.trend);
    const result=evaluateMarket({market:info,cache,unit,quote:this.quotes.get(info.market),now,exclusionsReady:this.exclusions.ready,previousPlan:this.plans.get(id)?.plan,turnover:turnoverClass(cache,now),upper,history});
    state.turnover=turnoverClass(cache,now);state.frames[unit]=result;state.checkedAt=now;this.states.set(info.market,state);this.dirty.add(info.market);this.remember(result);
    // 과거에 표시한 같은 시간대의 가격도 실제 봉으로 계속 추적한다.
    for(const [key,row] of this.plans){if(row.market!==info.market||row.unit!==unit||row.plan.stoppedAt||row.plan.completedAt)continue;const plan=observePlan(row.plan,bars,this.quotes.get(info.market),now);if(JSON.stringify(plan)!==JSON.stringify(row.plan)){this.plans.set(key,{...row,plan});this.planDirty.add(key);}}
    return result;
  }
  snapshot(){const now=this.clock(),eligible=this.markets.filter(m=>!m.warned&&m.market!=='KRW-USDT'),rows=[],waiting=[],details=[],promising=[];
    const exclusionReady=this.exclusions.ready&&now-this.exclusions.checkedAt>=0&&now-this.exclusions.checkedAt<=120000;
    for(const info of eligible){const state=this.states.get(info.market),cache=this.caches.get(info.market),turnover=cache?turnoverClass(cache,now):state?.turnover;
      const group=turnover?.ready&&turnover.asOf===endOf(60,now)?turnover.group:'pending';const frames={};
      for(const unit of RECOMMEND_UNITS){let r=state?.frames?.[unit];const current=r?.checkedThrough===endOf(unit,now);frames[unit]={status:current?r.status:'collecting',reason:current?r.reason:'주 시간대 재검사 중',checkedThrough:r?.checkedThrough??0,actualBars:r?.actualBars??0,historyReady:current&&r?.historyReady===true,st:current&&r?.trend?.atr10!=null?(r?.trend?.stDirection===1?'Buy':'Sell'):null};
        if(!r||!exclusionReady||unit>60&&!state?.upperTracking)continue;
        if(r.status==='tt_wait'&&r.trend?.stDirection===1&&current&&group==='high')waiting.push({...r,quote:this.quotes.get(info.market)??r.quote});
        // 이미 확인된 완성 계획은 1봉 이내 재검사 동안 근거 시각을 붙여 보존한다. 새 Sell/종료 결과는 즉시 제외한다.
        const liquidity=unit>60&&turnover?.ready?turnover:r.turnover;
        const grace=r.checkedThrough>=endOf(unit,now)-unit*60000&&liquidity?.asOf>=endOf(60,now)-3600000;
        const quote=this.quotes.get(info.market);const age=now-(quote?.receivedAt??0);
        if(r.status==='ready'&&group!=='low'&&grace&&age>=0&&age<=45000){const plan=this.plans.get(r.plan.id)?.plan??r.plan;
          if(!plan.stoppedAt&&!plan.completedAt&&quote.tradePrice>plan.stop&&quote.tradePrice<plan.targets[2])rows.push({...r,plan,quote,turnover:liquidity,rechecking:!current||group==='pending'});}
      }
      details.push({market:info.market,name:info.koreanName,group,average3d:turnover?.average3d??null,asOf:turnover?.asOf??0,frames,upperTracked:!!state?.upperTracking,error:state?.error??null});
      if(exclusionReady){const p=cache?promisingMarket(info,cache,turnover,this.quotes.get(info.market),now):group==='low'?state?.promising:null;if(p)promising.push({...p,quote:this.quotes.get(info.market)??p.quote});}
    }
    rows.sort((a,b)=>b.score-a.score||(b.turnover.average3d-a.turnover.average3d)||a.market.localeCompare(b.market));
    return {version:VERSION,generatedAt:now,analysisAt:Math.max(0,...[...this.states.values()].map(s=>s.checkedAt??0)),processing:this.processing,exclusions:{...this.exclusions,ready:exclusionReady},total:this.markets.length,excluded:this.markets.filter(m=>m.warned||m.market==='KRW-USDT').map(m=>({market:m.market,name:m.koreanName,reason:m.market==='KRW-USDT'?'테더 제외':m.exclusionReason})),coverage:{total:eligible.length,high:details.filter(d=>d.group==='high').length,low:details.filter(d=>d.group==='low').length,pending:details.filter(d=>d.group==='pending').length},details,rows,waiting,promising:promising.sort((a,b)=>b.score-a.score),history:[...this.plans.values()].filter(p=>p.firstShownAt).sort((a,b)=>b.firstShownAt-a.firstShownAt).slice(0,100),errors:this.errors.slice(-5),lastQuoteAt:this.lastQuote};
  }
  async flush(force=false){if(!this.token)return;const now=this.clock();if(!force&&now-this.lastSave<3000)return;await this.renew();
    const codes=[...this.dirty],ids=[...this.planDirty],planVersions=new Map(ids.map(id=>[id,JSON.stringify(this.plans.get(id))])),queries=[];codes.forEach(code=>{if(this.caches.has(code))queries.push(this.db.prepare('INSERT INTO candle_cache VALUES (?,?) ON CONFLICT(market) DO UPDATE SET candles_json=excluded.candles_json').bind(code,JSON.stringify(this.caches.get(code))));queries.push(this.db.prepare('INSERT INTO radar_state VALUES (?,?) ON CONFLICT(market) DO UPDATE SET payload_json=excluded.payload_json').bind(code,JSON.stringify(this.states.get(code))));});
    ids.forEach(id=>{const row=this.plans.get(id);queries.push(this.db.prepare('INSERT INTO radar_plans VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET payload_json=excluded.payload_json').bind(id,row.market,planVersions.get(id)));});
    for(let i=0;i<queries.length;i+=20)await this.db.batch(queries.slice(i,i+20));codes.forEach(c=>this.dirty.delete(c));ids.forEach(id=>{if(JSON.stringify(this.plans.get(id))===planVersions.get(id))this.planDirty.delete(id);});
    const payload=this.snapshot();if(queries.length||!this.snapshotSavedAt||now-this.snapshotSavedAt>=30000){await this.db.prepare('INSERT INTO radar_snapshot VALUES (1,?) ON CONFLICT(id) DO UPDATE SET payload_json=excluded.payload_json').bind(JSON.stringify(payload)).run();this.snapshotSavedAt=now;}this.lastSave=now;this.emit({type:'snapshot',payload});
  }
  async collect(info,unit,desired){const cache=await this.load(info.market);let changed=false;
    for(let pass=0;pass<3;pass++){const did=await collectCandles(cache,info.market,unit,this.clock(),desired,this.request);changed||=did;if(!did)break;await sleep(135);}
    if(changed)this.dirty.add(info.market);return cache;}
  async process(info,phase){const now=this.clock(),state=this.states.get(info.market)??{version:VERSION,market:info.market,frames:{},trends:{}};this.states.set(info.market,state);
    try {let cache=await this.collect(info,60,phase==='turnover'?72:HISTORY_BARS);state.turnover=turnoverClass(cache,this.clock());
      if(phase==='analysis'&&state.turnover.group==='high'){this.calculate(info,cache,60,this.clock());cache=await this.collect(info,15,HISTORY_BARS);this.calculate(info,cache,15,this.clock());}
      else state.checkedAt=this.clock();state.promising=promisingMarket(info,cache,state.turnover,this.quotes.get(info.market),this.clock());delete state.error;
    }catch(e){state.error=e.message;state.checkedAt=now;if(e.status===429||e.status===418)throw e;this.error(`${info.market} ${e.message}`);}
    this.dirty.add(info.market);await this.flush();
  }
  upperQueue(){const now=this.clock(),jobs=[];
    for(const info of this.markets){const state=this.states.get(info.market),t=state?.turnover;
      if(info.warned||info.market==='KRW-USDT'||!state?.upperTracking||!t?.ready||t.group!=='high'||t.asOf!==endOf(60,now))continue;
      for(const unit of [240,1440]){const f=state.frames?.[unit];
        if(!f||!f.historyReady||f.checkedThrough!==endOf(unit,now)||f.status==='quote_pending'||f.turnoverAsOf!==t.asOf||f.upperRuleVersion!==2)
          jobs.push({info,unit,lastAttempt:state.upperTracking.attempts?.[unit]??0,priority:Math.max(-1,...UNITS.map(u=>state.frames?.[u]?.status==='ready'?state.frames[u].score??0:-1))});
      }
    }
    return jobs.sort((a,b)=>a.lastAttempt-b.lastAttempt||b.priority-a.priority||a.unit-b.unit||a.info.market.localeCompare(b.info.market));
  }
  async processUpper(info,unit,{deadline=this.clock()+3000}={}){const state=this.states.get(info.market);state.upperTracking.attempts??={};state.upperTracking.attempts[unit]=this.clock();
    try{const cache=await this.load(info.market);
      const primaryEnd=endOf(15,this.clock());
      for(let page=0;page<16;page++){
        if(this.clock()>=deadline||endOf(15,this.clock())!==primaryEnd)break;
        const changed=await collectCandles(cache,info.market,unit,this.clock(),HISTORY_BARS,this.request);
        if(!changed)break;this.dirty.add(info.market);await sleep(135);
        if(assessHistory(cache,unit,this.clock()).ready)break;
      }
      const result=this.calculate(info,cache,unit,this.clock());result.turnoverAsOf=state.turnover.asOf;result.upperRuleVersion=2;delete state.upperTracking.error;
    }catch(e){state.upperTracking.error=e.message;if(e.status===429||e.status===418)throw e;this.error(`${info.market} ${unit}분 ${e.message}`);}
    this.dirty.add(info.market);await this.flush();
  }
  async detail(market){const info=this.markets.find(m=>m.market===market);if(!info)throw new Error('원화 종목 코드를 찾지 못했습니다.');const cache=await this.load(market),frames={};
    for(const unit of [15,60,240,1440]){const started=Date.now();do{await this.collect(info,unit,HISTORY_BARS);if(assessHistory(cache,unit,this.clock()).ready||cache.verified[unit]?.exhausted&&rawBars(cache,unit).length===0)break;await this.renew();}while(Date.now()-started<60000);const now=this.clock(),bars=rawBars(cache,unit,endOf(unit,now)),state=this.states.get(market)??{version:VERSION,market,frames:{},trends:{}};const history=assessHistory(cache,unit,now),trend=history.trend;if(history.ready)state.trends[unit]=trend;this.states.set(market,state);this.dirty.add(market);
      const current=history.ready;const raw=current&&trend?.signal?.direction==='up'?{...trend.signal,source:'tt'}:null;const calculated=pricePlan(raw,market,unit,now),stored=calculated?this.plans.get(calculated.id)?.plan:null,plan=observePlan(stored??calculated,bars,this.quotes.get(market),now);
      frames[unit]={st:!current||!trend||trend.atr10===null?'이력 수집 중':trend.stDirection===1?'Buy':'Sell',tt:!current||!trend||trend.ttDirection===null?'이력·신호 대기':trend.ttDirection?'상승':'하락',plan,checkedThrough:cache.verified[unit]?.checkedThrough??0,bars:bars.length,rsi:rsi(bars),sma20:sma(bars,20),reason:!history.ready?history.reason:!plan?'상승 TT 신호 대기':plan.stoppedAt||plan.completedAt?'종료된 TT 가격 · 새 신호 대기':'활성 TT 가격'};
    }
    await this.flush(true);return {market,name:info.koreanName,generatedAt:this.clock(),quote:this.quotes.get(market),frames};
  }
  async cycle({maxMarkets=Infinity}={}){if(!await this.acquire()){const row=await this.db.prepare('SELECT payload_json FROM radar_snapshot WHERE id=1').first();if(row)this.emit({type:'snapshot',payload:parse(row.payload_json)});this.emit({type:'waiting',message:'다른 실행이 수집한 저장 결과를 확인 중입니다.'});return;}
    this.processing=true;this.emit({type:'started',at:this.clock()});let used=0;
    try {await this.refreshMarkets();await this.refreshQuotes();await this.flush(true);
      const primaryAt=this.clock(),eligible=this.markets.filter(m=>!m.warned&&m.market!=='KRW-USDT');
      // 초기에는 모든 거래대금을 먼저 분류한다. 재실행은 DB 분류를 이어서 처리한다.
      const classify=eligible.filter(m=>this.states.get(m.market)?.turnover?.asOf!==endOf(60,this.clock())||!this.states.get(m.market)?.turnover?.ready);
      for(const info of classify){if(used++>=maxMarkets)return;await this.process(info,'turnover');}
      const queue=eligible.filter(m=>{const state=this.states.get(m.market);return state?.turnover?.group==='high'&&UNITS.some(u=>{const f=state.frames?.[u];return !f||f.checkedThrough!==endOf(u,this.clock())||f.status==='quote_pending'||!f.historyReady;});}).sort((a,b)=>{
        const priority=m=>{const s=this.states.get(m.market);return UNITS.some(u=>s?.frames[u]?.status==='ready')?0:UNITS.some(u=>s?.trends[u]?.stDirection===1)?1:2;};return priority(a)-priority(b)||(this.states.get(a.market)?.checkedAt??0)-(this.states.get(b.market)?.checkedAt??0);});
      for(const info of queue){if(used++>=maxMarkets)return;await this.process(info,'analysis');if(this.detailQueue.length)await this.runDetail();}
      while(this.detailQueue.length)await this.runDetail();
      // 상위 이력은 짧게 이어 수집하고 새 하위봉 검사에 우선권을 준다.
      const upperDeadline=this.clock()+4000;
      for(let pass=0;pass<4;pass++){
        if(this.clock()>=upperDeadline||endOf(15,this.clock())!==endOf(15,primaryAt))break;const job=this.upperQueue()[0];if(!job)break;
        await this.processUpper(job.info,job.unit,{deadline:Math.min(upperDeadline,this.clock()+3000)});
      }
    } finally {this.processing=false;try{await this.flush(true);}finally{await this.release();}this.emit({type:'completed',at:this.clock()});}
  }
  async runDetail(){const market=this.detailQueue.shift();this.emit({type:'detail_started',market,at:this.clock()});try{this.emit({type:'detail',payload:await this.detail(market)});}catch(e){this.emit({type:'detail_error',market,message:e.message});}}
}
export { localDatabase, remoteDatabase, fetchKrwMarkets, fetchKrwTickers };
async function main(){const local=process.env.QUANT_LOCAL_DB?await localDatabase(process.env.QUANT_LOCAL_DB):null;
  const db=local?.db??remoteDatabase({accountId:process.env.CLOUDFLARE_ACCOUNT_ID??'',databaseId:process.env.CLOUDFLARE_D1_DATABASE_ID??'',token:process.env.CLOUDFLARE_API_TOKEN??''});
  const emit=v=>process.stdout.write(JSON.stringify(v)+'\n'),radar=new Radar(db,{emit});let stopping=false,quoteBusy=false;
  process.on('SIGTERM',()=>{stopping=true;});process.on('SIGINT',()=>{stopping=true;});
  const input=createInterface({input:process.stdin});input.on('line',line=>{try{const c=JSON.parse(line);if(c.type==='detail'&&/^KRW-[A-Z0-9]{1,20}$/.test(c.market)&&!radar.detailQueue.includes(c.market))radar.detailQueue.push(c.market);}catch{}});
  await radar.init();
  const timer=setInterval(async()=>{if(!radar.token||quoteBusy)return;quoteBusy=true;try{await radar.refreshMarkets();await radar.refreshQuotes();emit({type:'snapshot',payload:radar.snapshot()});}catch(e){radar.error(e.message);}finally{quoteBusy=false;}},10000);
  try{do{try{await radar.cycle({maxMarkets:Number(process.env.QUANT_TEST_MAX_MARKETS)||Infinity});}catch(e){radar.error(e.message);if(e.status===429||e.status===418)await sleep(60000);}if(process.argv.includes('--once'))break;for(let i=0;i<5&&!stopping;i++)await sleep(1000);}while(!stopping);}
  finally{clearInterval(timer);while(quoteBusy)await sleep(50);input.close();local?.close();}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)main().catch(e=>{process.stdout.write(JSON.stringify({type:'error',at:Date.now(),message:e.message})+'\n');process.exitCode=1;});
