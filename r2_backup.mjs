// 일반 자료는 15분마다 중요 원장은 즉시 R2에 보존하고 D1 확인된 백업만 정리한다.
import {createHash,randomUUID} from 'node:crypto';
import {gzipSync,gunzipSync} from 'node:zlib';
import {r2Client} from './r2_client.mjs';
const digest=v=>createHash('sha256').update(v).digest('hex');
const PERIOD=900000;
export function createBackup({sqlite,get,set,transaction,tables,restore,clock=Date.now,publish,config,client}){
  const prefix='quant-v1/'+config.identity+'/';
  sqlite.exec(`CREATE TABLE IF NOT EXISTS r2_objects (key TEXT PRIMARY KEY,body BLOB,size INTEGER NOT NULL,uploaded INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS r2_members (object_key TEXT NOT NULL,table_name TEXT NOT NULL,row_key TEXT NOT NULL,seq INTEGER NOT NULL,done INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(object_key,table_name,row_key));
    CREATE TABLE IF NOT EXISTS r2_sent (table_name TEXT NOT NULL,row_key TEXT NOT NULL,seq INTEGER NOT NULL,PRIMARY KEY(table_name,row_key));
    CREATE TABLE IF NOT EXISTS r2_confirmed (table_name TEXT NOT NULL,row_key TEXT NOT NULL,seq INTEGER NOT NULL,PRIMARY KEY(table_name,row_key));
    CREATE TABLE IF NOT EXISTS r2_usage (month TEXT NOT NULL,op TEXT NOT NULL,calls INTEGER NOT NULL,bytes INTEGER NOT NULL,PRIMARY KEY(month,op));`);
  let ready=false,busy=null,closed=false,retryAt=0,lastList=0,lastError=null;
  function meter(op,bytes){
    const month=new Date(clock()).toISOString().slice(0,10),since=new Date(clock()-31*86400000).toISOString().slice(0,10);
    const old=sqlite.prepare('SELECT COALESCE(SUM(calls),0) AS calls FROM r2_usage WHERE month>=? AND op=?').get(since,op).calls;
    if(op!=='delete'&&old>=(op==='A'?850000:8500000))throw new Error('R2 무료 범위 보호로 백업 전송 대기. 분석은 계속되지만 원격 백업 확인이 필요합니다.');
    sqlite.prepare('INSERT INTO r2_usage VALUES (?,?,1,?) ON CONFLICT(month,op) DO UPDATE SET calls=calls+1,bytes=bytes+excluded.bytes').run(month,op,bytes);
  }
  const remote=client??r2Client(config,{clock,meter});
  function status(){
    const month=new Date(clock()).toISOString().slice(0,7),since=new Date(clock()-31*86400000).toISOString().slice(0,10);
    const usage=Object.fromEntries(sqlite.prepare('SELECT op,SUM(calls) AS calls,SUM(bytes) AS bytes FROM r2_usage WHERE month>=? GROUP BY op').all(since).map(r=>[r.op,{calls:r.calls,bytes:r.bytes}]));
    return {enabled:true,ready,error:lastError,retryAt,lastBackupAt:get('r2LastBackup',0),nextGeneralAt:get('r2LastGeneral',0)+PERIOD,
      pendingObjects:sqlite.prepare('SELECT COUNT(*) AS n FROM r2_objects').get().n,
      storedBytes:sqlite.prepare('SELECT COALESCE(SUM(size),0) AS n FROM r2_objects').get().n,
      uploadedObjects:sqlite.prepare('SELECT COUNT(*) AS n FROM r2_objects WHERE uploaded=1').get().n,
      month,since,usage,usageScope:'최근 31일 이상 로컬 기록 기준. 서버 파일 소실·다른 앱 사용은 포함하지 않으므로 계정 전체 통계와 다를 수 있음',deletedObjects:get('r2Deleted',0)};
  }
  function seq(table,key){return sqlite.prepare('SELECT seq FROM buffer_versions WHERE table_name=? AND row_key=?').get(table,key)?.seq??0;}
  function remember(key,entries,size,uploaded,body=null){
    sqlite.prepare('INSERT INTO r2_objects VALUES (?,?,?,?) ON CONFLICT(key) DO UPDATE SET uploaded=excluded.uploaded,body=excluded.body').run(key,body,size,uploaded?1:0);
    for(const e of entries){
      const confirmed=sqlite.prepare('SELECT seq FROM r2_confirmed WHERE table_name=? AND row_key=?').get(e.table,e.key)?.seq??-1;
      sqlite.prepare('INSERT OR REPLACE INTO r2_members VALUES (?,?,?,?,?)').run(key,e.table,e.key,e.seq,confirmed>=e.seq?1:0);
    }
  }
  async function loadRemote(){
    let next=null;const objects=[];
    do{const page=await remote.list(prefix+'data/',next);objects.push(...page.items);next=page.next;}while(next);
    // 전체 목록을 읽은 뒤 복원한다. 실패 시 이미 내려받은 객체는 SQLite에서 재사용한다.
    for(const o of objects.sort((a,b)=>a.key.localeCompare(b.key))){
      if(!new RegExp('^'+prefix+'data/[0-9]+-[a-f0-9-]+-[a-f0-9]{64}\\.gz$').test(o.key))throw new Error('R2 복구 경로 검증 실패');
      if(sqlite.prepare('SELECT uploaded FROM r2_objects WHERE key=?').get(o.key)?.uploaded)continue;
      const body=await remote.get(o.key);if(body===null)continue;
      if(digest(body)!==o.key.slice(-67,-3))throw new Error('R2 백업 체크섬 불일치. 원본은 삭제하지 않습니다.');
      const record=JSON.parse(gunzipSync(body,{maxOutputLength:128000000}).toString('utf8'));
      if(record.version!==1||record.identity!==config.identity||!Array.isArray(record.entries))throw new Error('R2 백업 형식 확인 필요');
      transaction(()=>{
        const entries=[];
        for(const e of record.entries){
          const t=tables.find(t=>t.name===e.table);if(!t||!e.row||String(e.row[t.key])!==e.key||!Number.isFinite(e.at))throw new Error('R2 백업 행 검증 실패');
          restore(t,e.row,e.at);entries.push({...e,seq:seq(e.table,e.key)});
        }
        remember(o.key,entries,o.size,true);
      });
    }
    ready=true;lastList=clock();set('r2LastRestore',clock());
  }
  function capture(general){
    const pending=sqlite.prepare(`SELECT q.*,v.seq FROM buffer_queue q JOIN buffer_versions v USING(table_name,row_key)
      LEFT JOIN r2_sent s USING(table_name,row_key) WHERE (s.seq IS NULL OR s.seq<v.seq) ${general?'':"AND q.table_name='radar_plans'"}`).all();
    // 100행씩 묶어 메모리·단일 객체 크기를 제한한다. 각 행의 캔들은 기존 압축 형식 그대로 보존한다.
    for(let start=0;start<pending.length;start+=100){
      const entries=pending.slice(start,start+100).map(p=>{
        const t=tables.find(t=>t.name===p.table_name),row=sqlite.prepare(`SELECT * FROM ${t.name} WHERE ${t.key}=?`).get(p.row_key);
        return {table:t.name,key:p.row_key,seq:p.seq,at:clock(),row};
      });
      const body=gzipSync(JSON.stringify({version:1,identity:config.identity,entries}),{level:6});
      if(body.length>64000000)throw new Error('R2 백업 묶음이 너무 큽니다. 자료를 유지하고 확인이 필요합니다.');
      if(status().storedBytes+body.length>8000000000)throw new Error('R2 8GB 보호선 도달. 분석은 계속되지만 미전송 백업의 정리가 필요합니다.');
      const key=prefix+'data/'+String(clock()).padStart(13,'0')+'-'+randomUUID()+'-'+digest(body)+'.gz';
      transaction(()=>{
        remember(key,entries,body.length,false,body);
        for(const e of entries)sqlite.prepare('INSERT INTO r2_sent VALUES (?,?,?) ON CONFLICT(table_name,row_key) DO UPDATE SET seq=excluded.seq').run(e.table,e.key,e.seq);
      });
    }
  }
  async function work(){
    if(closed||clock()<retryAt)return;
    try{
      if(!ready||clock()-lastList>=PERIOD)await loadRemote();
      await settle();
      const general=!get('r2LastGeneral',0)||clock()-get('r2LastGeneral',0)>=PERIOD;
      capture(general);if(general)set('r2LastGeneral',clock());
      await settle();
      retryAt=0;lastError=null;
    }catch(e){lastError=e.message;retryAt=clock()+60000;}
    publish();
  }
  async function settle(){
      for(const o of sqlite.prepare('SELECT * FROM r2_objects WHERE uploaded=0 ORDER BY key').all()){
        await remote.put(o.key,Buffer.from(o.body));
        sqlite.prepare('UPDATE r2_objects SET uploaded=1,body=NULL WHERE key=?').run(o.key);set('r2LastBackup',clock());
      }
      // D1에서 확인된 버전만 정리한다. 미확인 버전이 하나라도 있으면 객체를 남긴다.
      for(const o of sqlite.prepare('SELECT key FROM r2_objects o WHERE uploaded=1 AND NOT EXISTS (SELECT 1 FROM r2_members m WHERE m.object_key=o.key AND m.done=0)').all()){
        await remote.remove(o.key);
        transaction(()=>{sqlite.prepare('DELETE FROM r2_members WHERE object_key=?').run(o.key);sqlite.prepare('DELETE FROM r2_objects WHERE key=?').run(o.key);set('r2Deleted',get('r2Deleted',0)+1);});
      }
  }
  function tick(){if(closed)return Promise.resolve();if(busy)return busy;busy=work().finally(()=>{busy=null;});return busy;}
  function confirm(rows){transaction(()=>{for(const r of rows){
    sqlite.prepare('INSERT INTO r2_confirmed VALUES (?,?,?) ON CONFLICT(table_name,row_key) DO UPDATE SET seq=MAX(seq,excluded.seq)').run(r.table_name,r.row_key,r.seq);
    sqlite.prepare('UPDATE r2_members SET done=1 WHERE table_name=? AND row_key=? AND seq<=?').run(r.table_name,r.row_key,r.seq);
  }});}
  return {tick,confirm,status,get ready(){return ready;},notify(){queueMicrotask(()=>{void tick();});},async close(){closed=true;if(busy)await busy;}};
}
