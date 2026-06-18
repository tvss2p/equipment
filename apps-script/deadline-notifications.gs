const ONESIGNAL_APP_ID = 'cd25ba1b-2e6f-4585-8dc3-5c6203d36a24';
const EQUIPMENT_SITE_URL = 'https://tvss2p.github.io/equipment/';
const NOTICE_3_DAYS = '備品買い出しリクエスト締切３日前です';
const NOTICE_1_DAY = '備品買い出しリクエスト締切前日です';

/**
 * Run this from an Apps Script time-driven trigger every day at 10:00.
 * Set ONESIGNAL_REST_API_KEY in Script Properties before enabling it.
 */
function sendDeadlineNotifications() {
  const state = getState_();
  const requests = Array.isArray(state.requests) ? state.requests : [];
  const meta = requests.find((item) => item && item.id === '__meta__');

  if (!meta || !meta.deadline) {
    return;
  }

  const today = dateOnly_(new Date());
  const deadline = dateOnly_(new Date(String(meta.deadline) + 'T00:00:00+09:00'));
  const daysUntilDeadline = Math.round((deadline.getTime() - today.getTime()) / 86400000);

  if (daysUntilDeadline === 3 && meta.notifiedDeadline3 !== meta.deadline) {
    sendOneSignalPush_(NOTICE_3_DAYS);
    meta.notifiedDeadline3 = meta.deadline;
    saveState_(state);
  }

  if (daysUntilDeadline === 1 && meta.notifiedDeadline1 !== meta.deadline) {
    sendOneSignalPush_(NOTICE_1_DAY);
    meta.notifiedDeadline1 = meta.deadline;
    saveState_(state);
  }
}

function sendOneSignalPush_(message) {
  const apiKey = PropertiesService.getScriptProperties().getProperty('ONESIGNAL_REST_API_KEY');
  if (!apiKey) {
    throw new Error('Script PropertiesにONESIGNAL_REST_API_KEYを設定してください。');
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
      included_segments: ['Subscribed Users'],
      headings: { ja: '備品購入' },
      contents: { ja: message },
      url: EQUIPMENT_SITE_URL,
    }),
    muteHttpExceptions: true,
  });

  const status = response.getResponseCode();
  if (status < 200 || status >= 300) {
    throw new Error('OneSignal送信エラー: ' + status + ' ' + response.getContentText());
  }
}

function dateOnly_(date) {
  return new Date(Utilities.formatDate(date, 'Asia/Tokyo', 'yyyy/MM/dd 00:00:00'));
}

/**
 * Existing sync Apps Script should already have state load/save logic.
 * Replace these two functions with that project's actual storage accessors.
 */
function getState_() {
  throw new Error('既存の保存先からstateを取得する処理に差し替えてください。');
}

function saveState_(state) {
  throw new Error('既存の保存先へstateを保存する処理に差し替えてください。');
}
