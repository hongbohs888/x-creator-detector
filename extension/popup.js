// X 博主探测 · 设置弹窗
(() => {
  const K_SETTINGS = 'xfl_settings';
  const K_USERS = 'xfl_users';
  const K_RT = 'xfl_rt';
  const K_CLEANUP = 'xfl_cleanup';
  const inputs = [...document.querySelectorAll('[data-key]')];
  let settings = XFL_mergeSettings(null);

  const read = (path) => path.split('.').reduce((o, k) => o[k], settings);
  const write = (path, value) => {
    const keys = path.split('.');
    const last = keys.pop();
    keys.reduce((o, k) => o[k], settings)[last] = value;
  };

  // 有的数字在界面上换了个单位显示：比如存的是百分之 0.1，界面上写「每 1000 次浏览 1 次」
  const scaleOf = (input) => Number(input.dataset.scale) || 1;
  const tidy = (x) => Math.round(x * 1e6) / 1e6;

  function fill() {
    for (const input of inputs) {
      const v = read(input.dataset.key);
      if (input.type === 'checkbox') input.checked = !!v;
      else input.value = scaleOf(input) === 1 ? v : tidy(v * scaleOf(input));
    }
  }

  async function onChange(e) {
    const input = e.target;
    let value;
    if (input.type === 'checkbox') value = input.checked;
    else if (input.type === 'number') {
      value = Number(input.value);
      if (input.value === '' || !Number.isFinite(value) || value < 0) return fill();
      value = tidy(value / scaleOf(input));
    } else value = input.dataset.type === 'number' ? Number(input.value) : input.value;
    write(input.dataset.key, value);
    await chrome.storage.local.set({ [K_SETTINGS]: settings });
    // 改了保留天数，让后台立刻按新天数清一次
    if (input.dataset.key === 'keepDays') {
      try {
        await chrome.runtime.sendMessage({ type: 'xfl-cleanup' });
      } catch (e) {}
      showStats();
    }
  }

  function fmtBytes(n) {
    if (n < 1024) return n + ' B';
    if (n < 1048576) return Math.round(n / 1024) + ' KB';
    return (n / 1048576).toFixed(1) + ' MB';
  }

  async function showStats() {
    const data = await chrome.storage.local.get([K_USERS, K_RT, K_CLEANUP]);
    const nUsers = Object.keys(data[K_USERS] || {}).length;
    const nRt = Object.keys(data[K_RT] || {}).length;
    const bytes = await chrome.storage.local.getBytesInUse(null);
    document.getElementById('stats').textContent = `已记录 ${nUsers} 个账号、${nRt} 份转发记录，占用磁盘 ${fmtBytes(bytes)}`;
    const last = data[K_CLEANUP];
    let note = '每 6 小时自动清理一次，X 页面没开着也会执行。';
    if (last && last.t) {
      const did = last.users || last.rt ? `清掉 ${last.users} 个账号、${last.rt} 份转发记录` : '没有过期数据';
      note += `上次清理：${fmtAgo(last.t)}，${did}。`;
    }
    document.getElementById('cleanup').textContent = note;
  }

  function fmtAgo(ms) {
    const min = Math.floor((Date.now() - ms) / 60000);
    if (min < 1) return '刚刚';
    if (min < 60) return min + ' 分钟前';
    if (min < 1440) return Math.floor(min / 60) + ' 小时前';
    return Math.floor(min / 1440) + ' 天前';
  }

  // 运行状态：分清「插件失效了」和「只是页面没加载」
  async function showHealth() {
    const box = document.getElementById('health');
    const set = (level, text) => {
      box.className = 'health ' + level;
      box.querySelector('span').textContent = text;
    };
    let page = null;
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab && tab.id != null) page = await chrome.tabs.sendMessage(tab.id, { type: 'xfl-status' });
    } catch (e) {}

    if (!page) {
      const data = await chrome.storage.local.get(K_USERS);
      const last = Math.max(0, ...Object.values(data[K_USERS] || {}).map((u) => u.t || 0));
      const tail = last ? `上次读到数据是${fmtAgo(last)}。` : '还没读到过数据。';
      return set('', '当前标签页不是 X，或者这个页面是在装插件/更新插件之前打开的，刷新一下即可。' + tail);
    }
    if (!page.responses) {
      return set('warn', '本页还没拦到 X 的请求。刷新页面试试；刷新后还是这样，说明拦截失效了，插件需要更新。');
    }
    if (!page.pageUsers) {
      if (page.responses < 5) return set('warn', `本页刚拦到 ${page.responses} 个响应，还没有账号数据。滚动一下页面再看。`);
      return set('bad', `本页拦到了 ${page.responses} 个响应，却没解析出任何账号。很可能是 X 改了数据结构，插件需要更新。`);
    }
    set('ok', `运行正常。最近 5 分钟读到 ${page.recent} 个账号，本页累计 ${page.pageUsers} 个（拦到 ${page.responses} 个响应）。`);
  }

  for (const input of inputs) input.addEventListener('change', onChange);

  document.getElementById('reset').addEventListener('click', () => {
    settings = XFL_mergeSettings(null);
    chrome.storage.local.set({ [K_SETTINGS]: settings });
    fill();
  });

  document.getElementById('clear').addEventListener('click', async () => {
    if (!confirm('清空本地记录的账号数据和转发记录？设置不受影响。')) return;
    await chrome.storage.local.remove([K_USERS, K_RT]);
    showStats();
  });

  chrome.storage.local.get(K_SETTINGS).then((data) => {
    settings = XFL_mergeSettings(data[K_SETTINGS]);
    fill();
  });
  showStats();
  showHealth();
})();
