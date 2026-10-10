// X 博主探测 · 后台定时清理
// 每隔一段时间把过期的本地数据删掉，X 页面没开着也照常执行。不发任何网络请求。
importScripts('defaults.js');

const K_SETTINGS = 'xfl_settings';
const K_USERS = 'xfl_users';
const K_RT = 'xfl_rt';
const K_CLEANUP = 'xfl_cleanup';
const ALARM = 'xfl-cleanup';
const PERIOD_MINUTES = 360;

async function cleanup() {
  const data = await chrome.storage.local.get([K_SETTINGS, K_USERS, K_RT]);
  const now = Date.now();
  const cutoff = XFL_cutoff(XFL_mergeSettings(data[K_SETTINGS]), now);
  const result = { t: now, users: 0, rt: 0 };
  const out = { [K_CLEANUP]: result };
  if (cutoff) {
    const users = data[K_USERS] || {};
    for (const key in users) {
      if ((users[key].t || 0) < cutoff) {
        delete users[key];
        result.users++;
      }
    }
    // 转发记录看「最后一次打开他主页」和「最后一次有新转发」里较晚的那个
    const rt = data[K_RT] || {};
    for (const key in rt) {
      if (Math.max(rt[key].t || 0, rt[key].v || 0) < cutoff) {
        delete rt[key];
        result.rt++;
      }
    }
    if (result.users) out[K_USERS] = users;
    if (result.rt) out[K_RT] = rt;
  }
  await chrome.storage.local.set(out);
  return result;
}

function ensureAlarm() {
  chrome.alarms.get(ALARM, (alarm) => {
    if (!alarm) chrome.alarms.create(ALARM, { delayInMinutes: 1, periodInMinutes: PERIOD_MINUTES });
  });
}

chrome.runtime.onInstalled.addListener(ensureAlarm);
chrome.runtime.onStartup.addListener(() => {
  ensureAlarm();
  cleanup();
});
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM) cleanup();
});
// 在弹窗里改了保留天数，立刻清一次
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.type !== 'xfl-cleanup') return;
  cleanup().then(sendResponse);
  return true;
});
