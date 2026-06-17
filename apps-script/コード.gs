/*** 備品ストック 共有・同期用スクリプト ***/
const TOKEN     = 'bihin-sync-7f3a9c2e';   // ← アプリ側と一致させる。変更しないでください
const STATE_KEY = 'bihin_state_v1';

function doGet(e)  { return handle(e); }
function doPost(e) { return handle(e); }

function handle(e) {
  const lock = LockService.getScriptLock();
  try { lock.waitLock(20000); } catch (err) {}
  try {
    const props = PropertiesService.getScriptProperties();
    let state = null;
    try { state = JSON.parse(props.getProperty(STATE_KEY)); } catch (err) {}
    if (!state) state = { items: [], requests: [], history: [], buyer: '' };

    let body = {};
    if (e && e.postData && e.postData.contents) {
      try { body = JSON.parse(e.postData.contents); } catch (err) {}
    }
    const p = (e && e.parameter) || {};
    if ((body.token || p.token) !== TOKEN) return out({ error: 'unauthorized' });

    const action = body.action || p.action || 'get';
    if (action === 'save' && body.state) {
      state = merge(state, body.state);
      props.setProperty(STATE_KEY, JSON.stringify(state));
      mirror(state);
    }
    return out(state);
  } finally {
    try { lock.releaseLock(); } catch (err) {}
  }
}

function merge(server, client) {
  const upsert = (a, b) => {
    const m = {};
    (a || []).forEach(x => { if (x && x.id != null) m[x.id] = x; });
    (b || []).forEach(x => { if (x && x.id != null) m[x.id] = x; }); // 同一idはクライアント優先
    return Object.keys(m).map(k => m[k]);
  };
  return {
    items:    Array.isArray(client.items) ? client.items : server.items,
    buyer:    (client.buyer != null) ? client.buyer : server.buyer,
    requests: upsert(server.requests, client.requests),
    history:  upsert(server.history,  client.history)
  };
}

function mirror(state) {
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    if (!ss) return;
    let sh = ss.getSheetByName('リクエスト');
    if (!sh) sh = ss.insertSheet('リクエスト');
    sh.clearContents();
    const rows = [['日付','品名','数量','部署','依頼者','メモ','状態']];
    (state.requests || [])
      .filter(r => r.status !== 'deleted')
      .forEach(r => rows.push([r.date||'', r.name||'', r.qty||'', r.dept||'', r.requester||'', r.note||'', r.status||'']));
    sh.getRange(1, 1, rows.length, 7).setValues(rows);

    let hh = ss.getSheetByName('履歴');
    if (!hh) hh = ss.insertSheet('履歴');
    hh.clearContents();
    const hrows = [['日付','品名','数量','単価','金額','購入先','購入者']];
    (state.history || [])
      .forEach(h => hrows.push([h.date||'', h.name||'', h.qty||'', h.price||'', (h.qty||0)*(h.price||0), h.store||'', h.buyer||'']));
    hh.getRange(1, 1, hrows.length, 7).setValues(hrows);
  } catch (err) {}
}

function out(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
