/**
 * 備品買い出しリクエストの締切リマインドを OneSignal で自動送信する。
 *
 * これは「同期用 Apps Script」とは別の独立したスクリプトとして動かせる。
 * 在庫データ(state)は同期 Web アプリ(SYNC_URL)から HTTP で読み取るので、
 * 同期側の内部ストレージ実装を知らなくても動作する。
 *
 * ▼セットアップ（1回だけ）
 *  1. OneSignal ダッシュボード → Settings → Keys & IDs から
 *     「REST API Key」をコピーする。
 *  2. このスクリプトエディタで「プロジェクトの設定」→「スクリプト プロパティ」に
 *     キー: ONESIGNAL_REST_API_KEY / 値: 上記のREST API Key を登録する。
 *  3. 「トリガー」→「トリガーを追加」で sendDeadlineNotifications を
 *     「時間主導型」「日付ベースのタイマー」「午前10時〜11時」で毎日実行に設定する。
 *
 * ▼動作確認
 *  - testDeadlineNotification() を手動実行すると、今すぐテスト通知を1通送る。
 *    （購読済み端末に届けば、サーバー→OneSignal の送信経路は正常）
 *  - previewDeadlineStatus() を手動実行すると、締切まで何日か・次の10時に
 *    どの通知が送られるかを、実際には送らずにログ出力する。
 *  - 明日10時の自動送信を試すには、リクエスト締切日を「明後日」に設定しておくと
 *    明日の実行で「締切2日前」通知が、締切を「明日」に設定すると「前日」通知が送られる。
 */

const ONESIGNAL_APP_ID = 'cd25ba1b-2e6f-4585-8dc3-5c6203d36a24';
const EQUIPMENT_SITE_URL = 'https://tvss2p.github.io/equipment/';

// 同期 Web アプリ（在庫データの保存先）。アプリ本体と同じ値。
const SYNC_URL = 'https://script.google.com/macros/s/AKfycbxcWVi6_bxTTNt9ZFEe_jLFrfoDTvJI24hqxk6j4HnkREa_0CFXc_2jc6q_k8Chxo2hLA/exec';
const SYNC_TOKEN = 'bihin-sync-7f3a9c2e';

// 通知のタイミングと文面（締切2日前と前日）。
const NOTICE_2_DAYS = '備品買い出しリクエスト締切２日前です';
const NOTICE_1_DAY = '備品買い出しリクエスト締切前日です';

/**
 * 毎日10:00の時間主導トリガーから実行する。
 */
function sendDeadlineNotifications() {
  const deadline = getDeadline_();
  if (!deadline) {
    Logger.log('締切日が未設定のため、通知はありません。');
    return;
  }

  const days = daysUntil_(deadline);
  Logger.log('締切=' + deadline + ' / 残り' + days + '日');

  if (days === 2) {
    sendOnce_('NOTIFIED_2_' + deadline, NOTICE_2_DAYS);
  } else if (days === 1) {
    sendOnce_('NOTIFIED_1_' + deadline, NOTICE_1_DAY);
  }
}

/**
 * 同じ締切に対して二重送信しないよう、Script Properties で送信済みを記録する。
 * （共有stateを書き戻さないので、利用者の編集と競合しない）
 */
function sendOnce_(propKey, message) {
  const props = PropertiesService.getScriptProperties();
  if (props.getProperty(propKey) === '1') {
    Logger.log('送信済みのためスキップ: ' + propKey);
    return;
  }
  sendOneSignalPush_(message);
  props.setProperty(propKey, '1');
  Logger.log('送信しました: ' + message);
}

/**
 * 送信せず、状態だけ確認する（動作確認用）。
 */
function previewDeadlineStatus() {
  const deadline = getDeadline_();
  if (!deadline) {
    Logger.log('締切日が未設定です。');
    return;
  }
  const days = daysUntil_(deadline);
  let plan = '今日は送信対象外';
  if (days === 2) plan = '「' + NOTICE_2_DAYS + '」を送信予定';
  else if (days === 1) plan = '「' + NOTICE_1_DAY + '」を送信予定';
  Logger.log('締切=' + deadline + ' / 残り' + days + '日 / ' + plan);
}

/**
 * 今すぐテスト通知を1通送る（送信経路の確認用）。
 */
function testDeadlineNotification() {
  sendOneSignalPush_('【テスト】備品購入の通知が正しく届いています');
  Logger.log('テスト通知を送信しました。購読端末で受信を確認してください。');
}

function sendOneSignalPush_(message) {
  const apiKey = PropertiesService.getScriptProperties().getProperty('ONESIGNAL_REST_API_KEY');
  if (!apiKey) {
    throw new Error('Script Propertiesに ONESIGNAL_REST_API_KEY を設定してください。');
  }

  const response = UrlFetchApp.fetch('https://api.onesignal.com/notifications', {
    method: 'post',
    contentType: 'application/json; charset=utf-8',
    headers: {
      authorization: 'Key ' + apiKey,
    },
    payload: JSON.stringify({
      app_id: ONESIGNAL_APP_ID,
      target_channel: 'push',
      included_segments: ['Total Subscriptions'],
      headings: { ja: '備品購入' },
      contents: { ja: message },
      url: EQUIPMENT_SITE_URL,
    }),
    muteHttpExceptions: true,
  });

  const status = response.getResponseCode();
  const text = response.getContentText();
  if (status < 200 || status >= 300) {
    throw new Error('OneSignal送信エラー: ' + status + ' ' + text);
  }
  // 宛先0件などは200でも recipients:0 になるため、ログに残す。
  Logger.log('OneSignal応答: ' + text);
}

/**
 * 同期 Web アプリから state を読み取り、リクエスト締切日(YYYY-MM-DD)を返す。
 * 未設定なら null。
 */
function getDeadline_() {
  const state = getState_();
  const requests = state && Array.isArray(state.requests) ? state.requests : [];
  const meta = requests.find(function (item) {
    return item && item.id === '__meta__';
  });
  return meta && meta.deadline ? String(meta.deadline) : null;
}

/**
 * 同期 Web アプリ(SYNC_URL)から現在の state を取得する。
 * 同期側の保存実装に依存せず、アプリ本体と同じ get エンドポイントを使う。
 */
function getState_() {
  const url = SYNC_URL + '?action=get&token=' + encodeURIComponent(SYNC_TOKEN);
  const response = UrlFetchApp.fetch(url, {
    method: 'get',
    muteHttpExceptions: true,
    followRedirects: true,
  });
  const status = response.getResponseCode();
  if (status < 200 || status >= 300) {
    throw new Error('state取得エラー: ' + status + ' ' + response.getContentText());
  }
  const data = JSON.parse(response.getContentText());
  if (!data || data.error) {
    throw new Error('state取得エラー: ' + response.getContentText());
  }
  return data;
}

/**
 * 締切日(YYYY-MM-DD, 日本時間)まで、今日から何日あるか。
 */
function daysUntil_(deadlineYmd) {
  const today = dateOnly_(new Date());
  const deadline = dateOnly_(new Date(String(deadlineYmd) + 'T00:00:00+09:00'));
  return Math.round((deadline.getTime() - today.getTime()) / 86400000);
}

function dateOnly_(date) {
  return new Date(Utilities.formatDate(date, 'Asia/Tokyo', 'yyyy/MM/dd 00:00:00'));
}
