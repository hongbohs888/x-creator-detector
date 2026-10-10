// X 博主探测 · 内容脚本
// 接收 inject.js 读到的数据，缓存到本地，再把徽标、详情卡和转发榜画到页面上。
(() => {
  'use strict';
  if (window.__xflContent) return;
  window.__xflContent = true;

  const mergeSettings = globalThis.XFL_mergeSettings;
  const K_SETTINGS = 'xfl_settings';
  const K_USERS = 'xfl_users';
  const K_RT = 'xfl_rt';
  const MAX_USERS = 3000;
  const MAX_RT_PROFILES = 200;
  const MAX_RT_ITEMS = 300; // 每个账号最多保存多少条转发、多少条引用
  const MAX_GAPS = 5; // 每个账号最多记几次断档
  const MAX_RT_MEMORY = 2000; // 页面内存里最多留多少个账号的帖子记录
  const MAX_IDS = 800;
  const TWITTER_EPOCH = 1288834974657n;
  const MAX_TW = 12;
  const MAX_HIST = 15;
  const DAY = 86400000;
  const HANDLE_RE = /^[A-Za-z0-9_]{1,20}$/;
  const RESERVED = new Set([
    'home', 'explore', 'notifications', 'messages', 'i', 'search', 'settings', 'compose', 'login', 'logout',
    'signup', 'tos', 'privacy', 'jobs', 'about', 'hashtag', 'intent', 'share', 'account', 'bookmarks'
  ]);
  const PROFILE_TABS = new Set(['with_replies', 'reposts', 'media', 'articles', 'highlights', 'likes', 'affiliates', 'superfollows']);

  let settings = mergeSettings(null);
  let settingsRev = 0;
  const users = Object.create(null); // 小写账号名 -> 账号记录
  const rt = Object.create(null); // 小写账号名 -> 他发过/转过/引用过的帖子
  let dirtyUsers = false;
  let dirtyRt = false;
  let saveTimer = null;
  let scanQueued = false;
  // 本页的运行情况，弹窗里的「运行状态」读这个
  const stat = { responses: 0, last: 0, seen: new Set() };

  const el = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  // 浏览器里装了翻译插件时，别让它把我们画的内容再翻译一遍（会把名字挤没）
  const keepOriginal = (node) => {
    node.setAttribute('translate', 'no');
    node.classList.add('notranslate');
    return node;
  };

  // ---------- 本地存储 ----------

  const storage = {
    get: (keys) =>
      new Promise((resolve) => {
        try {
          chrome.storage.local.get(keys, (v) => resolve((!chrome.runtime.lastError && v) || {}));
        } catch (e) {
          resolve({});
        }
      }),
    set: (obj) =>
      new Promise((resolve) => {
        try {
          chrome.storage.local.set(obj, () => resolve(void chrome.runtime.lastError));
        } catch (e) {
          resolve();
        }
      })
  };

  const idOrder = (a, b) => a.length - b.length || (a < b ? -1 : a > b ? 1 : 0);

  function trimTw(tw) {
    const ids = Object.keys(tw);
    if (ids.length <= MAX_TW) return tw;
    const out = {};
    for (const id of ids.sort(idOrder).slice(-MAX_TW)) out[id] = tw[id];
    return out;
  }

  function validUser(r) {
    return r && typeof r === 'object' && typeof r.f === 'number' && typeof r.h === 'string';
  }

  // 多个标签页各自有一份内存数据，保存前先和存储里的合并，避免互相覆盖
  function mergeUser(a, b) {
    if (!validUser(b)) return a;
    if (!Array.isArray(b.hist)) b.hist = [];
    if (!b.tw || typeof b.tw !== 'object') b.tw = {};
    if (!a) return b;
    const [n, o] = (a.t || 0) >= (b.t || 0) ? [a, b] : [b, a];
    const hist = new Map();
    for (const [d, f] of o.hist) hist.set(d, f);
    for (const [d, f] of n.hist) hist.set(d, f);
    n.hist = [...hist].sort((x, y) => x[0] - y[0]).slice(-MAX_HIST);
    n.tw = trimTw(Object.assign({}, o.tw, n.tw));
    for (const k of ['id', 'n', 'g', 's', 'c', 'a', 'fb', 'fg']) if (n[k] == null && o[k] != null) n[k] = o[k];
    return n;
  }

  function getRt(key) {
    return rt[key] || (rt[key] = { ids: new Set(), rts: {}, qts: {}, t: 0, v: 0 });
  }

  function mergeRt(key, stored) {
    if (!stored || typeof stored !== 'object') return;
    const p = getRt(key);
    if (Array.isArray(stored.ids)) for (const id of stored.ids) p.ids.add(String(id));
    p.rts = Object.assign({}, stored.rts, p.rts);
    p.qts = Object.assign({}, stored.qts, p.qts);
    if (stored.gaps && typeof stored.gaps === 'object') p.gaps = Object.assign({}, stored.gaps, p.gaps);
    p.t = Math.max(p.t, stored.t || 0);
    p.v = Math.max(p.v, stored.v || 0);
  }

  function mergeFromStorage(data) {
    const su = data[K_USERS];
    if (su && typeof su === 'object') {
      for (const key in su) {
        const merged = mergeUser(users[key], su[key]);
        if (merged) users[key] = merged;
      }
    }
    const sr = data[K_RT];
    if (sr && typeof sr === 'object') for (const key in sr) mergeRt(key, sr[key]);
  }

  function serializeUsers() {
    const keys = Object.keys(users).sort((a, b) => (users[b].t || 0) - (users[a].t || 0));
    const out = {};
    for (const key of keys.slice(0, MAX_USERS)) out[key] = users[key];
    return out;
  }

  function serializeRt() {
    // 只保存有转发/引用记录的，或者你专门打开过主页的账号
    const keys = Object.keys(rt)
      .filter((k) => rt[k].v || rt[k].gaps || Object.keys(rt[k].rts).length || Object.keys(rt[k].qts).length)
      .sort((a, b) => rt[b].v - rt[a].v || rt[b].t - rt[a].t);
    const out = {};
    for (const key of keys.slice(0, MAX_RT_PROFILES)) {
      const p = rt[key];
      out[key] = { ids: [...p.ids].slice(-MAX_IDS), rts: newest(p.rts), qts: newest(p.qts), t: p.t, v: p.v };
      if (p.gaps) out[key].gaps = p.gaps;
    }
    return out;
  }

  function newest(map) {
    const ids = Object.keys(map);
    if (ids.length <= MAX_RT_ITEMS) return map;
    const out = {};
    for (const id of ids.sort(idOrder).slice(-MAX_RT_ITEMS)) out[id] = map[id];
    return out;
  }

  // 一条转发/引用记录：[对方账号, 可跳转的帖子 ID, 开头摘要]。早期版本只存了账号名。
  const entryOf = (v) => (typeof v === 'string' ? [v, '', ''] : v);

  function dropOldest(map, max, timeOf) {
    const keys = Object.keys(map);
    if (keys.length <= max) return 0;
    keys.sort((a, b) => timeOf(map[b]) - timeOf(map[a]));
    for (const k of keys.slice(max)) delete map[k];
    return keys.length - max;
  }

  // 清掉过期的数据，并给页面内存设上限：标签页开着不关时，内存里的数据不会一直涨
  function prune() {
    const userTime = (r) => r.t || 0;
    const rtTime = (p) => Math.max(p.t, p.v);
    const removed = { users: 0, rt: 0 };
    const cutoff = globalThis.XFL_cutoff(settings, Date.now());
    if (cutoff) {
      for (const k in users) {
        if (userTime(users[k]) < cutoff) {
          delete users[k];
          removed.users++;
        }
      }
      for (const k in rt) {
        if (rtTime(rt[k]) < cutoff) {
          delete rt[k];
          removed.rt++;
        }
      }
    }
    removed.users += dropOldest(users, MAX_USERS, userTime);
    removed.rt += dropOldest(rt, MAX_RT_MEMORY, rtTime);
    return removed;
  }

  async function save() {
    saveTimer = null;
    if (!dirtyUsers && !dirtyRt) return;
    const du = dirtyUsers;
    const dr = dirtyRt;
    dirtyUsers = dirtyRt = false;
    mergeFromStorage(await storage.get([K_USERS, K_RT]));
    const removed = prune();
    const out = {};
    if (du || removed.users) out[K_USERS] = serializeUsers();
    if (dr || removed.rt) out[K_RT] = serializeRt();
    await storage.set(out);
  }

  function scheduleSave() {
    if (!saveTimer) saveTimer = setTimeout(save, 4000);
  }

  // ---------- 接收数据 ----------

  function ingestUser(u) {
    if (!u || typeof u.handle !== 'string' || !HANDLE_RE.test(u.handle) || typeof u.followers !== 'number') return;
    const key = u.handle.toLowerCase();
    const now = Date.now();
    const r = users[key] || (users[key] = { hist: [], tw: {} });
    stat.seen.add(key);
    r.h = u.handle;
    r.f = u.followers;
    r.t = now;
    r.v = u.verified ? 1 : 0;
    if (u.id) r.id = String(u.id);
    if (u.name) r.n = String(u.name);
    if (typeof u.following === 'number') r.g = u.following;
    if (typeof u.tweets === 'number') r.s = u.tweets;
    if (typeof u.created === 'number') r.c = u.created;
    if (typeof u.avatar === 'string' && u.avatar.startsWith('https://pbs.twimg.com/')) r.a = u.avatar;
    if (u.followedBy != null) r.fb = u.followedBy ? 1 : 0;
    if (u.followingThem != null) r.fg = u.followingThem ? 1 : 0;
    // 每天留一个粉丝数快照，用来算近几天的涨跌
    const day = Math.floor(now / DAY);
    const last = r.hist[r.hist.length - 1];
    if (last && last[0] === day) last[1] = u.followers;
    else {
      r.hist.push([day, u.followers]);
      if (r.hist.length > MAX_HIST) r.hist.shift();
    }
    dirtyUsers = true;
  }

  function ingestTweet(t) {
    if (!t || typeof t.author !== 'string' || !HANDLE_RE.test(t.author) || !/^\d{1,25}$/.test(String(t.id))) return;
    const key = t.author.toLowerCase();
    const id = String(t.id);
    const p = getRt(key);
    let changed = false;
    if (!p.ids.has(id)) {
      p.ids.add(id);
      changed = true;
    }
    const text = (s) => (typeof s === 'string' ? s.slice(0, 48) : '');
    const record = (map, entry) => {
      const old = map[id];
      if (Array.isArray(old) && old[0] === entry[0] && old[1] === entry[1] && old[2] === entry[2]) return;
      map[id] = entry;
      changed = true;
    };
    if (typeof t.rtOf === 'string' && HANDLE_RE.test(t.rtOf)) {
      // 纯转发：存原帖的 ID 和原帖开头
      record(p.rts, [t.rtOf, /^\d{1,25}$/.test(String(t.rtId)) ? String(t.rtId) : '', text(t.rtText)]);
    } else if (typeof t.quoteOf === 'string' && HANDLE_RE.test(t.quoteOf)) {
      // 引用：存他自己这条帖子的 ID 和他写的评语
      record(p.qts, [t.quoteOf, id, text(t.text)]);
    }
    if (changed) {
      p.t = Date.now();
      dirtyRt = true;
    }
    // 互动率只算他自己发的帖子，转发的不算
    const r = users[key];
    if (r && !t.rtOf && typeof t.views === 'number' && t.views > 0) {
      const eng = (t.likes || 0) + (t.reposts || 0) + (t.replies || 0) + (t.quotes || 0);
      r.tw[id] = [eng, t.views];
      r.tw = trimTw(r.tw);
      dirtyUsers = true;
    }
  }

  // 主页时间线上的一次断档：停更前最后一条、恢复后第一条、恢复后已发几条
  function ingestGap(g) {
    if (!g || typeof g.handle !== 'string' || !HANDLE_RE.test(g.handle)) return;
    if (![g.resumed, g.last, g.since].every((n) => typeof n === 'number' && Number.isFinite(n)) || g.resumed <= g.last) return;
    const p = getRt(g.handle.toLowerCase());
    if (!p.gaps) p.gaps = {};
    const old = p.gaps[g.resumed];
    // 同一次断档再看到时，恢复后的条数只会越数越多
    if (old && old[0] === g.last && old[1] >= g.since) return;
    p.gaps[g.resumed] = [g.last, Math.max(g.since, old ? old[1] : 0)];
    const keys = Object.keys(p.gaps).sort((a, b) => b - a);
    for (const k of keys.slice(MAX_GAPS)) delete p.gaps[k];
    p.t = Date.now();
    dirtyRt = true;
  }

  window.addEventListener('message', (e) => {
    if (e.source !== window || !e.data || e.data.source !== 'xfl-inject') return;
    const us = Array.isArray(e.data.users) ? e.data.users : [];
    const ts = Array.isArray(e.data.tweets) ? e.data.tweets : [];
    stat.responses++;
    if (!us.length && !ts.length) return;
    stat.last = Date.now();
    us.forEach(ingestUser);
    ts.forEach(ingestTweet);
    if (Array.isArray(e.data.gaps)) e.data.gaps.forEach(ingestGap);
    scheduleSave();
    queueScan();
  });

  // ---------- 计算 ----------

  const { trim1, fmtCount, RESTART_DAYS } = globalThis.XFL_rules;

  const fmtFull = (n) => (n == null ? '—' : n.toLocaleString('en-US'));

  function fmtAge(created) {
    const days = Math.floor((Date.now() - created) / DAY);
    if (days < 90) return days + ' 天';
    if (days < 365) return Math.floor(days / 30) + ' 个月';
    const y = Math.floor(days / 365);
    const m = Math.min(11, Math.floor((days % 365) / 30));
    return y + ' 年' + (m ? ' ' + m + ' 个月' : '');
  }

  function tierOf(f) {
    if (!settings.colorTiers) return 0;
    return f < 1000 ? 0 : f < 1e4 ? 1 : f < 1e5 ? 2 : f < 1e6 ? 3 : 4;
  }

  const engagement = (r) => globalThis.XFL_rules.engagement(r, settings.th, Date.now());

  // 最近 30 天里看到他发了多少条（含转发、回复）。帖子 ID 里带着发布时间。
  function recentPosts(key) {
    const p = rt[key];
    if (!p) return 0;
    const day = Math.floor(Date.now() / DAY);
    if (p.rc && p.rc[0] === p.ids.size && p.rc[1] === day) return p.rc[2];
    const since = Date.now() - RESTART_DAYS * DAY;
    let n = 0;
    for (const id of p.ids) if (timeOfId(id) >= since) n++;
    p.rc = [p.ids.size, day, n];
    return n;
  }

  // 在他主页上看到的断档：[{ resumed, last, since }]
  function gapsOf(key) {
    const g = rt[key] && rt[key].gaps;
    return g ? Object.keys(g).map((resumed) => ({ resumed: Number(resumed), last: g[resumed][0], since: g[resumed][1] })) : [];
  }

  // 判定规则都在 rules.js
  function tagsFor(r) {
    const key = r.h.toLowerCase();
    return globalThis.XFL_rules.tags(r, { recent: recentPosts(key), gaps: gapsOf(key) }, settings, Date.now());
  }

  function shownTags(r) {
    if (settings.tagMode === 'none') return [];
    const tags = tagsFor(r);
    return settings.tagMode === 'one' ? tags.slice(0, 1) : tags;
  }

  function trend(r) {
    const today = Math.floor(Date.now() / DAY);
    let best = null;
    for (const [d, f] of r.hist || []) {
      if (d >= today || d < today - 14) continue;
      if (!best || Math.abs(d - (today - 7)) < Math.abs(best[0] - (today - 7))) best = [d, f];
    }
    return best ? { days: today - best[0], delta: r.f - best[1] } : null;
  }

  function repostStats(key) {
    const p = rt[key];
    const agg = Object.create(null);
    let nR = 0;
    let nQ = 0;
    const add = (id, value, field) => {
      const [handle, postId, text] = entryOf(value);
      const k = handle.toLowerCase();
      if (k === key) return; // 转自己的不进榜
      const row = agg[k] || (agg[k] = { key: k, handle, r: 0, q: 0, items: [] });
      row[field]++;
      row.items.push({ id, kind: field, postId, text });
    };
    if (p) {
      for (const id in p.rts) {
        nR++;
        add(id, p.rts[id], 'r');
      }
      for (const id in p.qts) {
        nQ++;
        add(id, p.qts[id], 'q');
      }
    }
    const rows = Object.values(agg).sort((a, b) => b.r + b.q - (a.r + a.q) || b.r - a.r || (a.key < b.key ? -1 : 1));
    return { total: p ? p.ids.size : 0, nR, nQ, rows };
  }

  // ---------- 徽标 ----------

  function fillBadge(badge, r) {
    badge.textContent = '';
    // 数字前面写明「粉丝」，不认识这个插件的人也能看懂这是什么数
    const count = el('span', 'xfl-count xfl-t' + tierOf(r.f));
    count.appendChild(el('i', 'xfl-count-k', '粉丝'));
    count.appendChild(document.createTextNode(fmtCount(r.f)));
    badge.appendChild(count);
    for (const [cls, text] of shownTags(r)) badge.appendChild(el('span', 'xfl-tag xfl-tag-' + cls, text));
  }

  function ensureBadge(host, key) {
    let badge = null;
    for (const c of host.children) {
      if (c.classList.contains('xfl-badge')) {
        badge = c;
        break;
      }
    }
    const r = users[key];
    if (!r || !settings.enabled) {
      if (badge) badge.remove();
      return;
    }
    const sig = [settingsRev, key, r.f, shownTags(r).map((t) => t[0]).join(',')].join('|');
    if (badge && badge.dataset.sig === sig) return;
    if (!badge) {
      badge = keepOriginal(el('span', 'xfl-badge'));
      // 徽标有自己的详情卡，鼠标移上来时不再触发 X 自带的资料卡
      badge.addEventListener('mouseover', (e) => e.stopPropagation());
      host.appendChild(badge);
    }
    badge.dataset.sig = sig;
    badge.dataset.h = key;
    fillBadge(badge, r);
  }

  function handleFromHref(href) {
    const m = /^\/([A-Za-z0-9_]{1,20})(?:[/?#]|$)/.exec(href || '');
    if (!m) return null;
    const key = m[1].toLowerCase();
    return RESERVED.has(key) ? null : key;
  }

  function handleOfUserName(un) {
    const a = un.querySelector('a[href^="/"]');
    if (a) return handleFromHref(a.getAttribute('href'));
    // 引用卡片里的用户名不是链接，从 @账号 文本里取
    for (const s of un.querySelectorAll('span')) {
      const m = /^@([A-Za-z0-9_]{1,20})$/.exec(s.textContent.trim());
      if (m) return m[1].toLowerCase();
    }
    return null;
  }

  function scanTweets() {
    for (const un of document.querySelectorAll('[data-testid="User-Name"]')) {
      const key = handleOfUserName(un);
      if (key && un.firstElementChild) ensureBadge(un.firstElementChild, key);
    }
  }

  function scanUserCells() {
    for (const cell of document.querySelectorAll('[data-testid="UserCell"]')) {
      for (const a of cell.querySelectorAll('a[href^="/"]')) {
        const text = a.textContent.trim();
        if (!text || text.startsWith('@') || !a.firstElementChild) continue;
        const key = handleFromHref(a.getAttribute('href'));
        if (key) ensureBadge(a.firstElementChild, key);
        break;
      }
    }
  }

  function scanProfileHeader() {
    const box = document.querySelector('[data-testid="primaryColumn"] [data-testid="UserName"]');
    if (!box) return;
    let at = null;
    for (const s of box.querySelectorAll('span')) {
      if (!s.closest('.xfl-badge') && /^@[A-Za-z0-9_]{1,20}$/.test(s.textContent.trim())) {
        at = s;
        break;
      }
    }
    if (!at) return;
    // 往上找到 @账号 所在的那一横排，把徽标放在它后面
    let host = at.parentElement;
    while (host && host !== box) {
      const cs = getComputedStyle(host);
      if (cs.display === 'flex' && cs.flexDirection === 'row') break;
      host = host.parentElement;
    }
    if (host && host !== box) ensureBadge(host, at.textContent.trim().slice(1).toLowerCase());
  }

  // ---------- 悬停详情卡 ----------

  let card = null;
  let cardTimer = null;

  function statCell(label, value) {
    const c = el('div', 'xfl-stat');
    c.appendChild(el('b', null, value));
    c.appendChild(el('span', null, label));
    return c;
  }

  function cardRow(label, value) {
    const row = el('div', 'xfl-card-row');
    row.appendChild(el('span', 'xfl-card-k', label));
    row.appendChild(el('span', 'xfl-card-v', value));
    return row;
  }

  function buildCard(key) {
    const r = users[key];
    const box = keepOriginal(el('div', 'xfl-card'));
    const head = el('div', 'xfl-card-head');
    head.appendChild(el('strong', null, r.n || r.h));
    head.appendChild(el('span', null, '@' + r.h));
    box.appendChild(head);

    const stats = el('div', 'xfl-stats');
    stats.appendChild(statCell('粉丝', fmtFull(r.f)));
    stats.appendChild(statCell('关注', fmtFull(r.g)));
    const ratio = r.g ? r.f / r.g : null;
    stats.appendChild(statCell('粉丝/关注', ratio == null ? '—' : ratio >= 10000 ? fmtCount(Math.round(ratio)) : trim1(ratio)));
    box.appendChild(stats);

    if (r.c) box.appendChild(cardRow('注册', new Date(r.c).toISOString().slice(0, 7) + '（' + fmtAge(r.c) + '）'));
    if (r.s != null) box.appendChild(cardRow('帖子数', fmtFull(r.s)));
    const recent = recentPosts(key);
    if (recent) box.appendChild(cardRow(`近 ${RESTART_DAYS} 天`, `看到他发了 ${recent} 条（实际只多不少）`));
    const tr = trend(r);
    box.appendChild(
      cardRow('粉丝涨跌', tr ? `近 ${tr.days} 天 ${tr.delta >= 0 ? '+' : ''}${fmtFull(tr.delta)}` : '今天刚开始记录，过几天再看')
    );
    const eg = engagement(r);
    box.appendChild(cardRow('互动率', eg ? `${eg.rate.toFixed(2)}%（${eg.n} 条帖子的中位数）` : '看到的帖子还不够，暂不计算'));

    const stat = repostStats(key);
    if (stat.rows.length) {
      const top = stat.rows.slice(0, 3).map((x) => `@${(users[x.key] && users[x.key].h) || x.handle} ×${x.r + x.q}`);
      box.appendChild(cardRow('常转', top.join('　')));
    }

    const tags = tagsFor(r);
    if (tags.length) {
      const list = el('div', 'xfl-card-tags');
      for (const [cls, text, note] of tags) {
        const line = el('div', 'xfl-card-tag');
        line.appendChild(el('span', 'xfl-tag xfl-tag-' + cls, text));
        line.appendChild(el('span', null, note));
        list.appendChild(line);
      }
      box.appendChild(list);
    }
    return box;
  }

  function hideCard() {
    clearTimeout(cardTimer);
    if (card) card.remove();
    card = null;
  }

  function showCard(badge) {
    clearTimeout(cardTimer);
    const key = badge.dataset.h;
    if (!settings.hoverCard || !users[key]) return;
    if (card && card.dataset.h === key) return;
    hideCard();
    card = buildCard(key);
    card.dataset.h = key;
    document.body.appendChild(card);
    const b = badge.getBoundingClientRect();
    const c = card.getBoundingClientRect();
    let top = b.bottom + 6;
    if (top + c.height > window.innerHeight - 8) top = Math.max(8, b.top - c.height - 6);
    const left = Math.max(8, Math.min(b.left, window.innerWidth - c.width - 8));
    card.style.top = top + 'px';
    card.style.left = left + 'px';
  }

  document.addEventListener(
    'mouseover',
    (e) => {
      const badge = e.target instanceof Element && e.target.closest('.xfl-badge');
      if (badge) showCard(badge);
    },
    true
  );
  document.addEventListener(
    'mouseout',
    (e) => {
      if (e.target instanceof Element && e.target.closest('.xfl-badge')) {
        clearTimeout(cardTimer);
        cardTimer = setTimeout(hideCard, 150);
      }
    },
    true
  );
  window.addEventListener('scroll', hideCard, { passive: true });

  // ---------- 转发榜 ----------

  let panelKey = null;
  let panelShowAll = false;
  let panelOnlyNew = false; // 只看你还没关注的人
  const panelOpen = new Set(); // 展开了帖子明细的行
  let auto = null; // 正在「多翻几屏」时的状态

  function profileKey() {
    const seg = location.pathname.split('/').filter(Boolean);
    if (!seg.length || seg.length > 2) return null;
    if (seg[1] && !PROFILE_TABS.has(seg[1].toLowerCase())) return null;
    const key = seg[0].toLowerCase();
    return HANDLE_RE.test(key) && !RESERVED.has(key) ? key : null;
  }

  async function autoLoad(key) {
    if (auto) {
      auto.stop = true;
      return;
    }
    auto = { round: 0, total: settings.autoScrollRounds, stop: false };
    queueScan();
    // 转发集中在 Reposts 标签里，先切过去
    const tab = document.querySelector('[data-testid="primaryColumn"] nav a[role="tab"][href$="/reposts" i]');
    if (tab && !/\/reposts\/?$/i.test(location.pathname)) {
      tab.click();
      await sleep(1800);
    }
    let still = 0;
    let lastHeight = 0;
    while (auto.round < auto.total && !auto.stop && profileKey() === key) {
      auto.round++;
      queueScan();
      window.scrollTo(0, document.documentElement.scrollHeight);
      await sleep(1500);
      const h = document.documentElement.scrollHeight;
      still = h === lastHeight ? still + 1 : 0;
      lastHeight = h;
      if (still >= 2) break; // 连续两次没有变长，说明到底了
    }
    if (profileKey() === key) window.scrollTo(0, 0);
    auto = null;
    queueScan();
  }

  function myKey() {
    const a = document.querySelector('a[data-testid="AppTabBar_Profile_Link"]');
    return a ? handleFromHref(a.getAttribute('href')) : null;
  }

  // 你关注了这个人没有：1 已关注，0 没关注，null 不知道或是你自己
  function followState(k) {
    const u = users[k];
    if (!u || u.fg == null || k === myKey()) return null;
    return u.fg ? 1 : 0;
  }

  // 帖子 ID 里带着发布时间
  function timeOfId(id) {
    try {
      return Number((BigInt(id) >> 22n) + TWITTER_EPOCH);
    } catch (e) {
      return 0;
    }
  }

  function fmtAgo(ms) {
    if (!ms) return '';
    const min = Math.floor((Date.now() - ms) / 60000);
    if (min < 60) return Math.max(1, min) + ' 分钟前';
    if (min < 1440) return Math.floor(min / 60) + ' 小时前';
    if (min < 43200) return Math.floor(min / 1440) + ' 天前';
    return new Date(ms).toISOString().slice(0, 10);
  }

  // 展开某一行：他具体转了、引用了这个人的哪几条，最新的在前
  function postList(row, handle, key) {
    const list = el('div', 'xfl-p-posts');
    const items = row.items.slice().sort((a, b) => idOrder(b.id, a.id));
    for (const it of items) {
      const a = el('a', 'xfl-p-post');
      // 转发跳原帖，引用跳他带评语的那一条；早期记录没存原帖 ID，就跳他的转发
      a.href = it.kind === 'r' && it.postId ? `/${handle}/status/${it.postId}` : `/${key}/status/${it.id}`;
      a.appendChild(el('span', 'xfl-p-kind xfl-p-kind-' + it.kind, it.kind === 'r' ? '转' : '引'));
      const fallback = it.kind === 'r' ? '（没存下开头，点开看原帖）' : '（没写评语，点开看）';
      a.appendChild(el('span', 'xfl-p-text', it.text || fallback));
      a.appendChild(el('span', 'xfl-p-time', fmtAgo(timeOfId(it.id))));
      list.appendChild(a);
    }
    return list;
  }

  function panelRow(rank, row, max, key) {
    const u = users[row.key];
    const handle = (u && u.h) || row.handle;
    const open = panelOpen.has(row.key);
    const item = el('div', 'xfl-p-item');
    const line = el('div', 'xfl-p-row');
    line.appendChild(el('span', 'xfl-p-rank', String(rank)));

    const who = el('a', 'xfl-p-user');
    who.href = '/' + handle;
    if (u && u.a) {
      const img = el('img', 'xfl-p-avatar');
      img.alt = '';
      // 头像偶尔会加载失败：重试一次，还不行就换成占位圆
      img.addEventListener('error', () => {
        if (img.dataset.retried) return img.replaceWith(el('span', 'xfl-p-avatar'));
        img.dataset.retried = '1';
        setTimeout(() => (img.src = u.a), 1500);
      });
      img.src = u.a;
      who.appendChild(img);
    } else {
      who.appendChild(el('span', 'xfl-p-avatar'));
    }
    const names = el('div', 'xfl-p-who');
    const name = el('div', 'xfl-p-name');
    name.appendChild(el('strong', null, (u && u.n) || handle));
    if (u) {
      const badge = keepOriginal(el('span', 'xfl-badge'));
      badge.dataset.h = row.key;
      fillBadge(badge, u);
      name.appendChild(badge);
    }
    names.appendChild(name);
    const sub = el('div', 'xfl-p-handle', '@' + handle);
    const fs = followState(row.key);
    if (fs === 0) sub.appendChild(el('span', 'xfl-p-new', '你还没关注'));
    else if (fs === 1) sub.appendChild(el('span', 'xfl-p-followed', '已关注'));
    names.appendChild(sub);
    who.appendChild(names);
    line.appendChild(who);

    const cnt = el('button', 'xfl-p-cnt');
    cnt.type = 'button';
    cnt.title = open ? '收起' : '看他具体转了哪几条';
    const parts = [];
    if (row.r) parts.push('转 ' + row.r);
    if (row.q) parts.push('引 ' + row.q);
    cnt.appendChild(el('span', null, parts.join(' · ') + (open ? ' ▴' : ' ▾')));
    const bar = el('i', 'xfl-p-bar');
    bar.style.width = Math.max(8, Math.round(((row.r + row.q) / max) * 100)) + '%';
    cnt.appendChild(bar);
    cnt.addEventListener('click', () => {
      if (open) panelOpen.delete(row.key);
      else panelOpen.add(row.key);
      queueScan();
    });
    line.appendChild(cnt);
    item.appendChild(line);
    if (open) item.appendChild(postList(row, handle, key));
    return item;
  }

  function renderPanel(panel, key) {
    const stat = repostStats(key);
    const nNew = stat.rows.filter((x) => followState(x.key) === 0).length;
    const all = panelOnlyNew ? stat.rows.filter((x) => followState(x.key) === 0) : stat.rows;
    const rows = all.slice(0, panelShowAll ? all.length : settings.rtTopN);
    const sig = JSON.stringify([
      settingsRev, key, stat.total, stat.nR, stat.nQ, stat.rows.length, nNew, panelShowAll, panelOnlyNew, settings.rtCollapsed,
      auto && [auto.round, auto.stop],
      rows.map((x) => [x.key, x.r, x.q, users[x.key] && users[x.key].f, followState(x.key), panelOpen.has(x.key)])
    ]);
    if (panel.dataset.sig === sig) return;
    panel.dataset.sig = sig;
    panel.textContent = '';

    const head = el('div', 'xfl-p-head');
    const title = el('div', 'xfl-p-title');
    title.appendChild(el('strong', null, '转发榜'));
    title.appendChild(el('span', null, '转发比关注诚实'));
    head.appendChild(title);
    const actions = el('div', 'xfl-p-actions');
    if (nNew || panelOnlyNew) {
      const newBtn = el('button', 'xfl-btn xfl-btn-ghost' + (panelOnlyNew ? ' xfl-btn-on' : ''), '只看未关注');
      newBtn.type = 'button';
      newBtn.addEventListener('click', () => {
        panelOnlyNew = !panelOnlyNew;
        queueScan();
      });
      actions.appendChild(newBtn);
    }
    const loadBtn = el('button', 'xfl-btn', auto ? `停止（${auto.round}/${auto.total}）` : '多翻几屏');
    loadBtn.type = 'button';
    loadBtn.addEventListener('click', () => autoLoad(key));
    actions.appendChild(loadBtn);
    const foldBtn = el('button', 'xfl-btn xfl-btn-ghost', settings.rtCollapsed ? '展开' : '收起');
    foldBtn.type = 'button';
    foldBtn.addEventListener('click', () => {
      settings.rtCollapsed = !settings.rtCollapsed;
      storage.set({ [K_SETTINGS]: settings });
      queueScan();
    });
    actions.appendChild(foldBtn);
    head.appendChild(actions);
    panel.appendChild(head);

    const handle = (users[key] && users[key].h) || key;
    panel.appendChild(
      el(
        'div',
        'xfl-p-sub',
        `已加载 @${handle} 的 ${stat.total} 条帖子 · 纯转发 ${stat.nR} 条 · 引用 ${stat.nQ} 条 · 涉及 ${stat.rows.length} 人` +
          (nNew ? `，其中 ${nNew} 人你还没关注` : '')
      )
    );
    if (settings.rtCollapsed) return;

    if (!stat.rows.length) {
      panel.appendChild(
        el('div', 'xfl-p-empty', '还没看到他转过谁。点「多翻几屏」，插件会切到 Reposts 标签并自动往下翻，看到多少统计多少。')
      );
      return;
    }
    if (!rows.length) {
      panel.appendChild(el('div', 'xfl-p-empty', '目前看到的他转过的人，你都已经关注了。'));
      return;
    }
    const list = el('div', 'xfl-p-list');
    const max = rows[0].r + rows[0].q;
    rows.forEach((row, i) => list.appendChild(panelRow(i + 1, row, max, key)));
    panel.appendChild(list);
    if (all.length > settings.rtTopN) {
      const more = el('button', 'xfl-btn xfl-btn-ghost xfl-p-more', panelShowAll ? `只看前 ${settings.rtTopN} 名` : `展开全部 ${all.length} 人`);
      more.type = 'button';
      more.addEventListener('click', () => {
        panelShowAll = !panelShowAll;
        queueScan();
      });
      panel.appendChild(more);
    }
  }

  function ensurePanel() {
    let panel = document.getElementById('xfl-rt-panel');
    const key = settings.enabled && settings.rtPanel ? profileKey() : null;
    const column = key && document.querySelector('[data-testid="primaryColumn"]');
    const nav = column && column.querySelector('[data-testid="UserName"]') && column.querySelector('nav[role="navigation"]');
    const anchor = nav && nav.parentElement;
    if (!anchor || !anchor.parentElement) {
      if (panel) panel.remove();
      return;
    }
    if (key !== panelKey) {
      panelKey = key;
      panelShowAll = false;
      panelOnlyNew = false;
      panelOpen.clear();
      getRt(key).v = Date.now();
      dirtyRt = true;
      scheduleSave();
    }
    if (!panel) {
      panel = keepOriginal(el('div'));
      panel.id = 'xfl-rt-panel';
    }
    if (panel.nextElementSibling !== anchor) anchor.parentElement.insertBefore(panel, anchor);
    renderPanel(panel, key);
  }

  // ---------- 页面扫描 ----------

  function updateTheme() {
    const m = getComputedStyle(document.body).backgroundColor.match(/\d+/g);
    if (!m) return;
    const lum = 0.299 * m[0] + 0.587 * m[1] + 0.114 * m[2];
    document.documentElement.classList.toggle('xfl-dark', lum < 128);
  }

  function scan() {
    scanQueued = false;
    if (!document.body) return;
    updateTheme();
    scanTweets();
    scanUserCells();
    scanProfileHeader();
    ensurePanel();
    if (!settings.enabled) hideCard();
  }

  function queueScan() {
    if (scanQueued) return;
    scanQueued = true;
    setTimeout(scan, 200);
  }

  new MutationObserver(queueScan).observe(document, { childList: true, subtree: true });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') save();
  });

  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return;
      if (changes[K_SETTINGS]) {
        settings = mergeSettings(changes[K_SETTINGS].newValue);
        settingsRev++;
        prune(); // 保留天数可能改短了
      }
      // 在弹窗里点了「清空本地数据」
      if (changes[K_USERS] && changes[K_USERS].newValue === undefined) {
        for (const k in users) delete users[k];
        dirtyUsers = false;
      }
      if (changes[K_RT] && changes[K_RT].newValue === undefined) {
        for (const k in rt) delete rt[k];
        dirtyRt = false;
        panelKey = null;
      }
      queueScan();
    });
  } catch (e) {}

  // 弹窗来问运行状态
  try {
    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
      if (!msg || msg.type !== 'xfl-status') return;
      const since = Date.now() - 300000;
      let recent = 0;
      for (const k in users) if (users[k].t > since) recent++;
      sendResponse({ responses: stat.responses, pageUsers: stat.seen.size, last: stat.last, recent });
    });
  } catch (e) {}

  storage.get([K_SETTINGS, K_USERS, K_RT]).then((data) => {
    settings = mergeSettings(data[K_SETTINGS]);
    settingsRev++;
    mergeFromStorage(data);
    prune();
    queueScan();
  });
})();
