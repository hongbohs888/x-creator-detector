// X 博主探测 · 页面主环境脚本
// 只旁路读取 X 自己发出的请求的响应，不发起任何新请求，也不修改请求和响应。
(() => {
  if (window.__xflHooked) return;
  window.__xflHooked = true;

  const SOURCE = 'xfl-inject';
  const API_RE = /\/i\/api\/(graphql|1\.1|2)\//;

  const num = (v) => {
    if (v == null || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  const bool = (v) => (v == null ? null : !!v);
  const first = (...vals) => vals.find((v) => v != null);

  // 同时兼容新结构（core / relationship_counts）和旧结构（legacy / 扁平 REST）
  function pickUser(node) {
    const legacy = node.legacy || {};
    const core = node.core || {};
    const counts = node.relationship_counts || {};
    const rel = node.relationship_perspectives || {};
    const handle = core.screen_name || legacy.screen_name || node.screen_name;
    const followers = num(first(counts.followers, legacy.followers_count, node.followers_count));
    if (typeof handle !== 'string' || followers === null) return null;
    return {
      id: String(node.rest_id || node.id_str || legacy.id_str || ''),
      handle,
      name: core.name || legacy.name || node.name || '',
      followers,
      following: num(first(counts.following, legacy.friends_count, node.friends_count)),
      tweets: num(first((node.tweet_counts || {}).tweets, legacy.statuses_count, node.statuses_count)),
      created: Date.parse(core.created_at || legacy.created_at || node.created_at || '') || null,
      avatar: (node.avatar || {}).image_url || legacy.profile_image_url_https || node.profile_image_url_https || '',
      followedBy: bool(first(rel.followed_by, legacy.followed_by, node.followed_by)),
      followingThem: bool(first(rel.following, legacy.following, node.following)),
      verified: !!(node.is_blue_verified || (node.verification || {}).verified || legacy.verified || node.verified)
    };
  }

  const unwrap = (r) => (r && r.__typename === 'TweetWithVisibilityResults' ? r.tweet : r) || null;

  function authorOf(tweet) {
    const u = tweet && tweet.core && tweet.core.user_results && tweet.core.user_results.result;
    if (!u) return null;
    return (u.core && u.core.screen_name) || (u.legacy && u.legacy.screen_name) || null;
  }

  // 帖子开头的一小段，转发榜展开时用来认出是哪条
  function snippet(text) {
    if (typeof text !== 'string') return '';
    return text.replace(/https:\/\/t\.co\/\w+/g, '').replace(/\s+/g, ' ').trim().slice(0, 48);
  }

  function pickTweet(node) {
    const L = node.legacy;
    const author = authorOf(node);
    if (!L || !node.rest_id || !author) return null;
    const rt = unwrap(L.retweeted_status_result && L.retweeted_status_result.result);
    let quoteOf = null;
    if (!rt) {
      quoteOf = authorOf(unwrap(node.quoted_status_result && node.quoted_status_result.result));
      // 被引用的帖子不可见时，从永久链接里取作者
      if (!quoteOf && L.is_quote_status && L.quoted_status_permalink) {
        const m = /(?:twitter|x)\.com\/([A-Za-z0-9_]{1,20})\/status\//.exec(L.quoted_status_permalink.expanded || '');
        if (m) quoteOf = m[1];
      }
    }
    return {
      id: String(node.rest_id),
      author,
      text: snippet(L.full_text),
      rtId: rt && rt.rest_id ? String(rt.rest_id) : null,
      rtText: rt && rt.legacy ? snippet(rt.legacy.full_text) : '',
      likes: num(L.favorite_count) || 0,
      reposts: num(L.retweet_count) || 0,
      replies: num(L.reply_count) || 0,
      quotes: num(L.quote_count) || 0,
      views: num(node.views && node.views.count),
      rtOf: rt ? authorOf(rt) : null,
      quoteOf
    };
  }

  function extract(json) {
    const users = [];
    const tweets = [];
    const seenUsers = new Set();
    const stack = [json];
    while (stack.length) {
      const node = stack.pop();
      if (!node || typeof node !== 'object') continue;
      if (Array.isArray(node)) {
        for (let i = 0; i < node.length; i++) if (node[i] && typeof node[i] === 'object') stack.push(node[i]);
        continue;
      }
      if (node.__typename === 'User' || (typeof node.screen_name === 'string' && node.followers_count != null)) {
        const u = pickUser(node);
        if (u && !seenUsers.has(u.handle)) {
          seenUsers.add(u.handle);
          users.push(u);
        }
      } else if (node.__typename === 'Tweet' && node.legacy) {
        const t = pickTweet(node);
        if (t) tweets.push(t);
      }
      // User 节点下面可能挂着整条时间线，所以一律继续往下走
      for (const k in node) {
        const v = node[k];
        if (v && typeof v === 'object') stack.push(v);
      }
    }
    return { users, tweets };
  }

  // ---------- 老号重启的证据：主页时间线上相邻两条帖子之间的长时间断档 ----------
  // 主页的帖子列表是按时间连续排的，相邻两条隔了很久，就是实打实的停更。
  // 只看「帖子」这一栏（原创），回复栏里混着别人的帖子，转发栏另算。

  const TIMELINE_OP = /\/(UserTweets|UserOriginalsTimeline)\?/;
  const GAP_MIN = 60 * 86400000; // 断档不到 60 天的不上报，具体多久才算停更由设置决定
  const TWITTER_EPOCH = 1288834974657n;
  const runs = new Map(); // 账号 ID -> 从主页顶部一路翻下来，已经数到哪了

  const timeOfId = (id) => Number((BigInt(id) >> 22n) + TWITTER_EPOCH);

  function findInstructions(node, depth) {
    if (!node || typeof node !== 'object' || depth > 8) return null;
    if (Array.isArray(node.instructions)) return node.instructions;
    for (const k in node) {
      const found = findInstructions(node[k], depth + 1);
      if (found) return found;
    }
    return null;
  }

  function profileGaps(json, url) {
    if (!TIMELINE_OP.test(url)) return [];
    let vars;
    try {
      vars = JSON.parse(new URL(url, location.origin).searchParams.get('variables'));
    } catch (e) {
      return [];
    }
    const userId = vars && vars.userId ? String(vars.userId) : '';
    if (!userId) return [];

    let handle = null;
    const times = [];
    for (const ins of findInstructions(json, 0) || []) {
      // 置顶帖在单独的指令里，不在 entries 里，天然被排除
      for (const entry of ins.entries || []) {
        if (/^promoted/.test(entry.entryId || '')) continue;
        const content = entry.content || {};
        const contents = content.items ? content.items.map((i) => i.item && i.item.itemContent) : [content.itemContent];
        for (const ic of contents) {
          const t = unwrap(ic && ic.tweet_results && ic.tweet_results.result);
          if (!t || !t.rest_id || !t.legacy || String(t.legacy.user_id_str) !== userId || ic.promotedMetadata) continue;
          handle = handle || authorOf(t);
          times.push(timeOfId(t.rest_id));
        }
      }
    }
    if (!handle || !times.length) return [];

    // 带 cursor 的是接着上一页往下翻，不带的是从顶部重新开始
    const run = (vars.cursor && runs.get(userId)) || { oldest: null, count: 0 };
    const gaps = [];
    for (const ts of times.sort((a, b) => b - a)) {
      if (run.oldest !== null && ts >= run.oldest) continue;
      if (run.oldest !== null && run.oldest - ts >= GAP_MIN) {
        // resumed：断档之后的第一条；last：断档之前的最后一条；since：恢复之后已经数到多少条
        gaps.push({ handle, resumed: run.oldest, last: ts, since: run.count });
      }
      run.oldest = ts;
      run.count++;
    }
    runs.set(userId, run);
    return gaps;
  }

  // 每个响应都报一次，哪怕没抽到东西：弹窗里的运行状态靠它判断拦截是否还有效
  function post(users, tweets, gaps) {
    window.postMessage({ source: SOURCE, users, tweets, gaps: gaps || [] }, location.origin);
  }

  function handleJson(json, url) {
    if (!json || typeof json !== 'object') return post([], []);
    const data = extract(json);
    let gaps = [];
    try {
      gaps = profileGaps(json, url);
    } catch (e) {}
    post(data.users, data.tweets, gaps);
  }

  function handleText(text, url) {
    if (typeof text !== 'string') return;
    if (text.length < 50 || text.indexOf('screen_name') === -1) return post([], []);
    // 解析放到下一轮事件循环，不拖慢 X 自己处理响应
    setTimeout(() => {
      try {
        handleJson(JSON.parse(text), url);
      } catch (e) {
        post([], []);
      }
    }, 0);
  }

  const xhrUrls = new WeakMap();
  const xhrOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url) {
    try {
      xhrUrls.set(this, String(url));
    } catch (e) {}
    return xhrOpen.apply(this, arguments);
  };

  const xhrSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function () {
    const url = xhrUrls.get(this) || '';
    if (API_RE.test(url)) {
      this.addEventListener('load', () => {
        try {
          if (this.responseType === '' || this.responseType === 'text') handleText(this.responseText, url);
          else if (this.responseType === 'json') setTimeout(() => handleJson(this.response, url), 0);
        } catch (e) {}
      });
    }
    return xhrSend.apply(this, arguments);
  };

  const originalFetch = window.fetch;
  if (typeof originalFetch === 'function') {
    window.fetch = function (input) {
      const promise = originalFetch.apply(this, arguments);
      try {
        const url = typeof input === 'string' ? input : (input && input.url) || '';
        if (API_RE.test(url)) {
          promise
            .then((res) => res.clone().text())
            .then((text) => handleText(text, url))
            .catch(() => {});
        }
      } catch (e) {}
      return promise;
    };
  }
})();
