/**
 * 備品購入 — Apps Script backend (bidirectional sync with Sheet)
 *
 * Consolidated version incorporating:
 *  - Rank-based merge for requests/history (prevents stale sheet rows from
 *    resurrecting deleted/done items)
 *  - 参考価格 (price) column for requests
 *  - Bidirectional sync for items (品目) and categories (分類), with a
 *    short-lived server-side tombstone so deletions made on either side
 *    (app or spreadsheet) are respected instead of being silently
 *    resurrected by the other side.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * データ消失対策の改修点（このバージョンで修正した内容）
 *
 *  (1) 品目(items)・分類(cats)の「まるごと後勝ち上書き」を廃止し、ID/名前
 *      単位のマージにした。アプリからの保存が、スプレッドシートで直前に
 *      追加・編集された行を巻き込んで消してしまう問題を防ぐ。
 *      各レコードに updatedAt（更新時刻）を持たせ、直近 KEEP_RECENT_MS 以内に
 *      片側で更新されたレコードは、もう片側の保存に含まれていなくても消さない
 *      （＝クライアントがまだ取得していないだけ、とみなして保持する）。
 *
 *  (2) シート取得(pull)の「全消し」バグを修正。品目・分類のシートが一瞬
 *      空（ミラー書き込み中や手動クリア直後など）に読めたとき、全レコードを
 *      削除＆tombstone していた。行が 0 件のときは何もしない（＝リクエスト/
 *      履歴と同じガード）ようにした。
 *
 *  (3) 日付列の往復破壊を修正。getValues() は日付セルを Date オブジェクトで
 *      返すため、毎回「変更あり」と誤判定して 15 秒ごとにシート全体を
 *      clearContents＋書き直し（手動編集と衝突）していた。さらに Date→JSON で
 *      タイムゾーンずれ・NaN年NaN月NaN日 の原因にもなっていた。日付は常に
 *      'yyyy-MM-dd' 文字列に正規化して比較・保存する。
 *
 *  (4) 意味的に同じレコードでは「変更なし」と判定するよう比較を厳密化し、
 *      不要なミラー書き込み（手動編集を潰す最大の原因）を大幅に削減。
 *
 *  (5) 楽観ロックの土台として state.version（単調増加）を追加し、応答に含める。
 *      LockService は tryLock にして、ロック取得失敗時に例外で落ちて実行失敗
 *      メールが飛ぶのを防ぐ（busy 応答を返す）。
 *
 *  ※ 「同一レコードを2台で同時に編集したときの最終的な勝敗確定」までは、
 *     クライアントが各レコードに updatedAt を付けて送る改修（クライアント側）が
 *     必要。本バックエンドはその updatedAt を受け取れる形になっている。
 * ─────────────────────────────────────────────────────────────────────────
 */

const PROP_STATE = 'bihin_state_v1';
const PROP_TOMBSTONES = 'bihin_tombstones_v1';
const PROP_LAST_PULL = 'bihin_last_sheet_pull_v1';

const SHEET_ID = '18veCS8VCdD9JbEnENR9Vh6310vtgODd-s99mHZzOsOY';

const REQUEST_SHEET_NAME = 'リクエスト';
const REQUEST_HEADERS = ['ID', '日付', '品名', '数量', '部署', '依頼者', 'メモ', '参考価格', '状態'];

const HISTORY_SHEET_NAME = '履歴';
const HISTORY_HEADERS = ['ID', '日付', '品名', '数量', '部署', '依頼者', 'メモ', '参考価格', '状態'];

const ITEM_SHEET_NAME = '品目';
const ITEM_HEADERS = ['ID', '品名', '購入先', '規定数', '現在庫', '単位', '標準単価', '分類'];

const CAT_SHEET_NAME = '分類';
const CAT_HEADERS = ['分類名'];

const TZ = 'Asia/Tokyo';

const SHEET_PULL_INTERVAL_MS = 15000;
const TOMBSTONE_GRACE_MS = 60000;

// 片側で直近に更新されたレコードを、もう片側の保存(=まだ未取得の可能性)で
// 消さないための保護時間。クライアントのポーリング間隔(5秒)・シート取得間隔
// (15秒)を十分に上回る値にして、次の同期までに確実に伝播させる。
const KEEP_RECENT_MS = 30000;

const RANK = { pending: 0, done: 1, deleted: 2 };

function doGet(e) {
  return handle(e);
}

function doPost(e) {
  return handle(e);
}

function handle(e) {
  const lock = LockService.getScriptLock();
  let locked = false;
  try {
    locked = lock.tryLock(30000);
  } catch (err) {
    locked = false;
  }
  if (!locked) {
    // ロックが取れないときは例外で落とさず busy を返す（実行失敗メールを防ぐ）。
    // クライアントは次の編集/ポーリングで再送されるため、状態は保持される。
    return jsonOut({ error: 'busy' });
  }

  try {
    const props = PropertiesService.getScriptProperties();
    const state = loadState(props);
    const tomb = loadTombstones(props);

    const pullResult = maybePullSheets(props, state, tomb);

    let body = {};
    if (e && e.postData && e.postData.contents) {
      try { body = JSON.parse(e.postData.contents); } catch (err) { body = {}; }
    }

    let changed = pullResult.changed;
    let result = state;

    if (body && body.action === 'save' && body.state) {
      result = merge(state, body.state, tomb);
      changed = true;
    }

    if (changed) {
      result.version = (Number(result.version) || 0) + 1;
      saveState(props, result);
      mirror(result);
    }
    if (pullResult.ran) {
      saveTombstones(props, tomb);
    }

    return jsonOut(result);
  } finally {
    lock.releaseLock();
  }
}

function jsonOut(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

/* ───────────────────────── state / tombstones ───────────────────────── */

function loadState(props) {
  const raw = props.getProperty(PROP_STATE);
  const s = raw ? safeParse(raw) : null;
  const src = s || {};
  return {
    items: (src.items || []).map(normalizeItemFull),
    requests: src.requests || [],
    history: src.history || [],
    cats: (src.cats || []).map(function (n) { return String(n); }),
    buyer: src.buyer || '',
    version: Number(src.version) || 0,
    // 分類ごとの更新時刻。クライアントは送ってこないのでサーバー側で保持する。
    catMeta: src.catMeta || {}
  };
}

function saveState(props, state) {
  props.setProperty(PROP_STATE, JSON.stringify(state));
}

function loadTombstones(props) {
  const raw = props.getProperty(PROP_TOMBSTONES);
  let tomb = {};
  if (raw) {
    tomb = safeParse(raw) || {};
  }
  const now = Date.now();
  const pruned = {};
  Object.keys(tomb).forEach(function (key) {
    if (now - tomb[key] <= TOMBSTONE_GRACE_MS) pruned[key] = tomb[key];
  });
  return pruned;
}

function saveTombstones(props, tomb) {
  props.setProperty(PROP_TOMBSTONES, JSON.stringify(tomb));
}

function markTombstone(tomb, key) {
  tomb[key] = Date.now();
}

function isTombstoned(tomb, key) {
  if (!(key in tomb)) return false;
  return Date.now() - tomb[key] <= TOMBSTONE_GRACE_MS;
}

function safeParse(raw) {
  try { return JSON.parse(raw); } catch (err) { return null; }
}

/* ───────────────────────────── merge (save) ───────────────────────────── */

function merge(server, client, tomb) {
  const now = Date.now();
  const result = {
    items: server.items,
    requests: server.requests,
    history: server.history,
    cats: server.cats,
    buyer: server.buyer,
    version: Number(server.version) || 0,
    catMeta: server.catMeta || {}
  };

  if (Array.isArray(client.requests)) {
    result.requests = upsertByRank(server.requests, client.requests);
  }
  if (Array.isArray(client.history)) {
    result.history = upsertByRank(server.history, client.history);
  }
  if (Array.isArray(client.items)) {
    result.items = mergeItems(server.items, client.items, tomb, now);
  }
  if (Array.isArray(client.cats)) {
    const m = mergeCats(server.cats, server.catMeta || {}, client.cats, tomb, now);
    result.cats = m.cats;
    result.catMeta = m.meta;
  }
  if (typeof client.buyer === 'string') {
    result.buyer = client.buyer;
  }

  return result;
}

/**
 * 品目のマージ。全置換をやめ、ID 単位で統合する。
 *  - クライアントが持つ品目は、そのクライアントの値を採用（アプリ編集を優先）。
 *    値が実際に変わっていれば updatedAt を更新する。
 *  - クライアントが含めていないがサーバーにある品目は、直近 KEEP_RECENT_MS 以内に
 *    更新されていれば保持（＝クライアントがまだ取得していないシート追加/編集）。
 *    それより古ければ、アプリ側で削除されたとみなして取り除く。
 *  - tombstone（片側で削除済み）の ID はクライアントが送ってきても復活させない。
 */
function mergeItems(serverItems, clientItems, tomb, now) {
  const byId = {};
  (serverItems || []).forEach(function (it) {
    if (it && it.id != null) byId[it.id] = it;
  });

  const clientIds = {};
  (clientItems || []).forEach(function (it) {
    if (!it || it.id == null) return;
    if (isTombstoned(tomb, 'item:' + it.id)) return;
    clientIds[it.id] = true;
    const prev = byId[it.id];
    const next = normalizeItem(it);
    if (!prev || !sameItem(prev, next)) {
      next.updatedAt = now;
    } else {
      next.updatedAt = prev.updatedAt || now;
    }
    byId[it.id] = next;
  });

  Object.keys(byId).forEach(function (id) {
    if (clientIds[id]) return;
    const ts = (byId[id] && byId[id].updatedAt) || 0;
    if (now - ts >= KEEP_RECENT_MS) {
      // 十分に古く、クライアントが把握していたはずなのに省いた = アプリ側の削除。
      delete byId[id];
    }
    // それ以外（直近のシート追加/編集）はアプリ保存で消さずに保持する。
  });

  return Object.keys(byId).map(function (id) { return byId[id]; });
}

/**
 * 分類のマージ。品目と同じ考え方（名前をキーに ID 相当として扱う）。
 */
function mergeCats(serverCats, serverMeta, clientCats, tomb, now) {
  const meta = {};
  Object.keys(serverMeta || {}).forEach(function (k) { meta[k] = serverMeta[k]; });

  const out = {};
  const clientSet = {};
  (clientCats || []).forEach(function (name) {
    if (name == null || name === '') return;
    name = String(name);
    if (isTombstoned(tomb, 'cat:' + name)) return;
    clientSet[name] = true;
    if (!(name in meta)) meta[name] = now;
    out[name] = true;
  });

  (serverCats || []).forEach(function (name) {
    name = String(name);
    if (out[name] || clientSet[name]) return;
    const ts = meta[name] || 0;
    if (now - ts < KEEP_RECENT_MS) {
      out[name] = true;
    } else {
      delete meta[name];
    }
  });

  const cats = Object.keys(out);
  Object.keys(meta).forEach(function (k) { if (!out[k]) delete meta[k]; });
  return { cats: cats, meta: meta };
}

function upsertByRank(serverList, clientList) {
  const byId = {};
  (serverList || []).forEach(function (item) { byId[item.id] = item; });
  (clientList || []).forEach(function (item) {
    const existing = byId[item.id];
    if (!existing) {
      byId[item.id] = item;
      return;
    }
    const existingRank = RANK[existing.status] != null ? RANK[existing.status] : 0;
    const incomingRank = RANK[item.status] != null ? RANK[item.status] : 0;
    if (incomingRank >= existingRank) {
      byId[item.id] = item;
    }
  });
  return Object.keys(byId).map(function (id) { return byId[id]; });
}

/* ─────────────────────────── normalize / compare ─────────────────────────── */

function num(v) {
  const n = Number(v);
  return isNaN(n) ? 0 : n;
}

function normStr(v) {
  return v == null ? '' : String(v).trim();
}

function normDate(v) {
  if (v == null || v === '') return '';
  if (Object.prototype.toString.call(v) === '[object Date]') {
    return isNaN(v.getTime()) ? '' : Utilities.formatDate(v, TZ, 'yyyy-MM-dd');
  }
  const s = String(v).trim();
  const m = s.match(/^(\d{4})[-\/](\d{1,2})[-\/](\d{1,2})/);
  if (m) {
    return m[1] + '-' + ('0' + m[2]).slice(-2) + '-' + ('0' + m[3]).slice(-2);
  }
  const d = new Date(s);
  return isNaN(d.getTime()) ? s : Utilities.formatDate(d, TZ, 'yyyy-MM-dd');
}

// 比較・保存に使う品目の正規形（updatedAt/guide などは含めない）。
function normalizeItem(it) {
  return {
    id: it.id,
    name: normStr(it.name),
    store: normStr(it.store),
    par: num(it.par),
    stock: num(it.stock),
    unit: normStr(it.unit),
    price: num(it.price),
    category: normStr(it.category)
  };
}

// 保存済み state 読み込み用（updatedAt を保持）。
function normalizeItemFull(it) {
  const n = normalizeItem(it || {});
  n.updatedAt = Number(it && it.updatedAt) || 0;
  return n;
}

function sameItem(a, b) {
  return JSON.stringify(normalizeItem(a)) === JSON.stringify(normalizeItem(b));
}

function sameReq(a, b) {
  const fields = ['id', 'name', 'dept', 'requester', 'note', 'status'];
  for (let i = 0; i < fields.length; i++) {
    const k = fields[i];
    if (normStr(a[k]) !== normStr(b[k])) return false;
  }
  if (num(a.qty) !== num(b.qty)) return false;
  if (num(a.price) !== num(b.price)) return false;
  if (normDate(a.date) !== normDate(b.date)) return false;
  return true;
}

/* ───────────────────────────── sheet pull ───────────────────────────── */

function maybePullSheets(props, state, tomb) {
  const now = Date.now();
  const last = Number(props.getProperty(PROP_LAST_PULL) || 0);
  if (now - last < SHEET_PULL_INTERVAL_MS) {
    return { ran: false, changed: false };
  }
  props.setProperty(PROP_LAST_PULL, String(now));

  const ss = SpreadsheetApp.openById(SHEET_ID);
  let changed = false;

  if (pullRequestsFromSheet(ss, state)) changed = true;
  if (pullHistoryFromSheet(ss, state)) changed = true;
  if (pullItemsFromSheet(ss, state, tomb)) changed = true;
  if (pullCatsFromSheet(ss, state, tomb)) changed = true;

  return { ran: true, changed: changed };
}

function pullRequestsFromSheet(ss, state) {
  return pullRowsWithRank(ss, REQUEST_SHEET_NAME, state, 'requests', 'pending');
}

function pullHistoryFromSheet(ss, state) {
  return pullRowsWithRank(ss, HISTORY_SHEET_NAME, state, 'history', 'done');
}

function pullRowsWithRank(ss, sheetName, state, key, defaultStatus) {
  const sheet = ss.getSheetByName(sheetName);
  if (!sheet) return false;
  const rows = readDataRows(sheet);
  if (!rows.length) return false;

  const byId = {};
  (state[key] || []).forEach(function (r) { byId[r.id] = r; });
  let changed = false;

  rows.forEach(function (row) {
    const name = normStr(row[2]);
    if (!name) return; // 空行や __meta__（品名なし）は state 側を維持する

    const id = row[0] || newId();
    const next = {
      id: id,
      date: normDate(row[1]),
      name: name,
      qty: num(row[3]),
      dept: normStr(row[4]),
      requester: normStr(row[5]),
      note: normStr(row[6]),
      price: num(row[7]),
      status: normStr(row[8]) || defaultStatus
    };

    const existing = byId[id];
    if (!existing) {
      byId[id] = next;
      changed = true;
    } else {
      const existingRank = RANK[existing.status] != null ? RANK[existing.status] : 0;
      const incomingRank = RANK[next.status] != null ? RANK[next.status] : 0;
      if (incomingRank >= existingRank && !sameReq(existing, next)) {
        byId[id] = next;
        changed = true;
      }
    }
  });

  if (changed) {
    state[key] = Object.keys(byId).map(function (id) { return byId[id]; });
  }
  return changed;
}

function pullItemsFromSheet(ss, state, tomb) {
  const sheet = ss.getSheetByName(ITEM_SHEET_NAME);
  if (!sheet) return false;
  const rows = readDataRows(sheet);
  // FIX(2): 空読み（ミラー書き込み中/手動クリア直後など）で全消ししない。
  if (!rows.length) return false;

  const now = Date.now();
  const byId = {};
  (state.items || []).forEach(function (it) { byId[it.id] = it; });
  let changed = false;

  const seenIds = {};
  rows.forEach(function (row) {
    const name = normStr(row[1]);
    if (!name) return;

    const id = row[0] || newId();
    seenIds[id] = true;
    const next = normalizeItem({
      id: id,
      name: name,
      store: row[2],
      par: row[3],
      stock: row[4],
      unit: row[5],
      price: row[6],
      category: row[7]
    });

    const existing = byId[id];
    if (!existing || !sameItem(existing, next)) {
      next.updatedAt = now; // シート側の新規/編集は「直近の更新」として印を付ける
      byId[id] = next;
      changed = true;
    }
  });

  // シートに存在した ID が消えている = シート側で削除された。
  Object.keys(byId).forEach(function (id) {
    if (!seenIds[id]) {
      delete byId[id];
      markTombstone(tomb, 'item:' + id);
      changed = true;
    }
  });

  if (changed) {
    state.items = Object.keys(byId).map(function (id) { return byId[id]; });
  }
  return changed;
}

function pullCatsFromSheet(ss, state, tomb) {
  const sheet = ss.getSheetByName(CAT_SHEET_NAME);
  if (!sheet) return false;
  const rows = readDataRows(sheet);
  // FIX(2): 空読みで全分類を消さない。
  if (!rows.length) return false;

  const now = Date.now();
  state.catMeta = state.catMeta || {};

  const sheetNames = {};
  rows.forEach(function (row) {
    const name = normStr(row[0]);
    if (name) sheetNames[name] = true;
  });

  let changed = false;
  const current = {};
  (state.cats || []).forEach(function (name) { current[String(name)] = true; });

  Object.keys(current).forEach(function (name) {
    if (!sheetNames[name]) {
      markTombstone(tomb, 'cat:' + name);
      delete state.catMeta[name];
      changed = true;
    }
  });

  Object.keys(sheetNames).forEach(function (name) {
    if (!current[name]) {
      state.catMeta[name] = now;
      changed = true;
    }
  });

  if (changed) {
    state.cats = Object.keys(sheetNames);
  }
  return changed;
}

function readDataRows(sheet) {
  const lastRow = sheet.getLastRow();
  const lastCol = sheet.getLastColumn();
  if (lastRow < 2 || lastCol < 1) return [];
  return sheet.getRange(2, 1, lastRow - 1, lastCol).getValues();
}

function newId() {
  return Utilities.getUuid();
}

/* ─────────────────────────────── mirror ─────────────────────────────── */

function mirror(state) {
  const ss = SpreadsheetApp.openById(SHEET_ID);
  mirrorRankRows(ss, REQUEST_SHEET_NAME, REQUEST_HEADERS, state.requests);
  mirrorRankRows(ss, HISTORY_SHEET_NAME, HISTORY_HEADERS, state.history);
  mirrorItems(ss, state.items);
  mirrorCats(ss, state.cats);
}

function getOrCreateSheet(ss, name, headers) {
  let sheet = ss.getSheetByName(name);
  if (!sheet) {
    sheet = ss.insertSheet(name);
  }
  sheet.clearContents();
  sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  return sheet;
}

function mirrorRankRows(ss, sheetName, headers, list) {
  const sheet = getOrCreateSheet(ss, sheetName, headers);
  if (!list || !list.length) return;
  const rows = list.map(function (r) {
    return [r.id, normDate(r.date), r.name || '', num(r.qty), r.dept || '',
      r.requester || '', r.note || '', r.price || '', r.status || ''];
  });
  // FIX(3): 日付列(2列目)を文字列書式にして、書き戻し時に Date へ再変換されるのを防ぐ。
  sheet.getRange(2, 2, rows.length, 1).setNumberFormat('@');
  sheet.getRange(2, 1, rows.length, headers.length).setValues(rows);
  sheet.hideColumns(1);
}

function mirrorItems(ss, items) {
  const sheet = getOrCreateSheet(ss, ITEM_SHEET_NAME, ITEM_HEADERS);
  if (!items || !items.length) return;
  const rows = items.map(function (it) {
    return [it.id, it.name || '', it.store || '', num(it.par), num(it.stock),
      it.unit || '', num(it.price), it.category || ''];
  });
  sheet.getRange(2, 1, rows.length, ITEM_HEADERS.length).setValues(rows);
  sheet.hideColumns(1);
}

function mirrorCats(ss, cats) {
  const sheet = getOrCreateSheet(ss, CAT_SHEET_NAME, CAT_HEADERS);
  if (!cats || !cats.length) return;
  const rows = cats.map(function (name) { return [name]; });
  sheet.getRange(2, 1, rows.length, CAT_HEADERS.length).setValues(rows);
}
