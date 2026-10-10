// 用仿真的 X 响应跑一遍 inject.js，确认用户和转发关系能正确抽出来。
// 运行：node test/inject.test.js
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const posted = [];
class FakeXHR {
  constructor() {
    this.listeners = {};
    this.responseType = '';
  }
  open() {}
  send() {}
  addEventListener(type, fn) {
    this.listeners[type] = fn;
  }
}
const sandbox = {
  XMLHttpRequest: FakeXHR,
  URL,
  location: { origin: 'https://x.com' },
  setTimeout: (fn) => fn(),
  window: { fetch: undefined, postMessage: (msg) => posted.push(msg) }
};
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../extension/inject.js'), 'utf8'), sandbox);

function respond(url, body) {
  posted.length = 0;
  const xhr = new FakeXHR();
  xhr.open('GET', url);
  xhr.responseText = JSON.stringify(body);
  xhr.send();
  if (xhr.listeners.load) xhr.listeners.load();
  return posted[0];
}

// 2026 年的新结构：core / relationship_counts / tweet_counts
const user = (handle, followers, following, extra = {}) => ({
  __typename: 'User',
  rest_id: 'id_' + handle,
  core: { screen_name: handle, name: handle + ' 名字', created_at: 'Sun Mar 30 11:17:05 +0000 2025' },
  avatar: { image_url: 'https://pbs.twimg.com/profile_images/1/a_normal.jpg' },
  relationship_counts: { followers, following },
  relationship_perspectives: { followed_by: false, following: false },
  tweet_counts: { tweets: 478 },
  is_blue_verified: true,
  ...extra
});
const tweet = (id, author, legacy = {}, extra = {}) => ({
  __typename: 'Tweet',
  rest_id: id,
  core: { user_results: { result: author } },
  views: { count: '7374', state: 'EnabledWithCount' },
  legacy: { id_str: id, favorite_count: 25, retweet_count: 5, reply_count: 21, quote_count: 12, is_quote_status: false, ...legacy },
  ...extra
});
const timeline = (...tweets) => ({
  data: {
    user: {
      result: {
        __typename: 'User', // 外层这个 User 没有粉丝数，但下面挂着整条时间线
        timeline: {
          timeline: {
            instructions: [
              {
                type: 'TimelineAddEntries',
                entries: tweets.map((t) => ({ content: { itemContent: { __typename: 'TimelineTweet', tweet_results: { result: t } } } }))
              }
            ]
          }
        }
      }
    }
  }
});

const big = user('gamma_big', 230000000, 1200, { relationship_perspectives: { followed_by: true, following: true } });
const writer = user('Alpha_Writer', 480000, 9000);
const reader = user('Beta_Reader', 3200, 3100);

// 1. 普通帖子 + 纯转发 + 转发了一条「引用帖」+ 引用转发 + 被包了一层可见性的转发
const original = tweet('100', writer, { full_text: 'Watch  @Grok build\nthis https://t.co/abc123 right now' });
const quotedInside = tweet('200', reader, { is_quote_status: true }, { quoted_status_result: { result: tweet('201', big) } });
const msg = respond(
  'https://x.com/i/api/graphql/abc/UserRepostsTimeline?variables=x',
  timeline(
    tweet('1', big),
    tweet('2', big, { retweeted_status_result: { result: original } }),
    tweet('3', big, { is_quote_status: true, quoted_status_id_str: '201', retweeted_status_result: { result: quotedInside } }),
    tweet('4', big, { is_quote_status: true, full_text: '说得对 https://t.co/zzz' }, { quoted_status_result: { result: tweet('300', writer) } }),
    tweet('5', big, { retweeted_status_result: { result: { __typename: 'TweetWithVisibilityResults', tweet: tweet('400', reader) } } }),
    tweet('6', big, {
      is_quote_status: true,
      quoted_status_permalink: { expanded: 'https://twitter.com/SomeOne_9/status/999' }
    })
  )
);

assert.ok(msg, '应该发出一条消息');
assert.strictEqual(msg.source, 'xfl-inject');
const byHandle = Object.fromEntries(msg.users.map((u) => [u.handle, u]));
assert.deepStrictEqual(Object.keys(byHandle).sort(), ['Alpha_Writer', 'Beta_Reader', 'gamma_big'], '用户按账号去重');
assert.strictEqual(byHandle.gamma_big.followers, 230000000);
assert.strictEqual(byHandle.gamma_big.following, 1200);
assert.strictEqual(byHandle.gamma_big.tweets, 478);
assert.strictEqual(byHandle.gamma_big.followedBy, true);
assert.strictEqual(byHandle.gamma_big.followingThem, true);
assert.strictEqual(byHandle.gamma_big.verified, true);
assert.strictEqual(byHandle.gamma_big.created, Date.parse('2025-03-30T11:17:05Z'));
assert.strictEqual(byHandle.Alpha_Writer.followedBy, false);

const byId = Object.fromEntries(msg.tweets.map((t) => [t.id, t]));
assert.deepStrictEqual([byId['1'].rtOf, byId['1'].quoteOf], [null, null], '原创帖');
assert.strictEqual(byId['1'].views, 7374);
assert.strictEqual(byId['1'].likes + byId['1'].reposts + byId['1'].replies + byId['1'].quotes, 63);
assert.deepStrictEqual([byId['2'].rtOf, byId['2'].quoteOf], ['Alpha_Writer', null], '纯转发');
assert.deepStrictEqual([byId['2'].rtId, byId['2'].rtText], ['100', 'Watch @Grok build this right now'], '转发带上原帖 ID 和去掉链接的开头');
assert.deepStrictEqual([byId['1'].rtId, byId['1'].rtText], [null, ''], '原创帖没有原帖信息');
assert.deepStrictEqual([byId['3'].rtOf, byId['3'].quoteOf], ['Beta_Reader', null], '转发一条引用帖，只算转发');
assert.deepStrictEqual([byId['4'].rtOf, byId['4'].quoteOf], [null, 'Alpha_Writer'], '引用转发');
assert.strictEqual(byId['4'].text, '说得对', '引用带上他自己写的评语');
assert.deepStrictEqual([byId['5'].rtOf, byId['5'].quoteOf], ['Beta_Reader', null], '带可见性包装的转发');
assert.deepStrictEqual([byId['6'].rtOf, byId['6'].quoteOf], [null, 'SomeOne_9'], '被引用帖不可见时从链接取作者');
assert.strictEqual(byId['200'].quoteOf, 'gamma_big', '嵌套的原帖也会被记录');
assert.strictEqual(byId['100'].author, 'Alpha_Writer');

// 2. 旧的 graphql 结构（legacy）
const legacyMsg = respond('https://x.com/i/api/graphql/abc/UserByScreenName', {
  data: {
    user: {
      result: {
        __typename: 'User',
        rest_id: '42',
        is_blue_verified: false,
        legacy: {
          screen_name: 'old_shape',
          name: '旧结构',
          followers_count: 1234,
          friends_count: 56,
          statuses_count: 7,
          created_at: 'Tue Jun 02 20:12:29 +0000 2009',
          followed_by: true,
          following: false
        }
      }
    }
  }
});
assert.strictEqual(legacyMsg.users.length, 1, '外层 User 和 legacy 不重复计');
assert.deepStrictEqual(
  [legacyMsg.users[0].id, legacyMsg.users[0].followers, legacyMsg.users[0].following, legacyMsg.users[0].followedBy, legacyMsg.users[0].followingThem],
  ['42', 1234, 56, true, false]
);

// 3. REST 扁平结构（1.1 接口）
const restMsg = respond('https://x.com/i/api/1.1/friends/following/list.json?x=1', {
  users: [{ id_str: '7', screen_name: 'flat_user', name: 'Flat', followers_count: 99, friends_count: 100, created_at: 'Tue Jun 02 20:12:29 +0000 2009' }]
});
assert.deepStrictEqual([restMsg.users[0].handle, restMsg.users[0].followers, restMsg.users[0].followedBy], ['flat_user', 99, null]);

// 4. 不相关的请求不处理；没内容或坏掉的 API 响应只报一个空消息（给运行状态计数用），不报错
assert.strictEqual(respond('https://x.com/other/thing.json', { screen_name: 'x', followers_count: 1 }), undefined, '非 API 地址不处理');
const empty = respond('https://x.com/i/api/graphql/abc/DataSaverMode', { data: { viewer: { ok: true, pad: 'x'.repeat(60) } } });
assert.deepStrictEqual([empty.users.length, empty.tweets.length], [0, 0]);
posted.length = 0;
const bad = new FakeXHR();
bad.open('GET', 'https://x.com/i/api/graphql/abc/UserTweets');
bad.responseText = '{"screen_name": 这不是合法 JSON，凑够五十个字符的长度用来通过长度检查 ........';
bad.send();
bad.listeners.load();
assert.deepStrictEqual([posted.length, posted[0].users.length, posted[0].tweets.length], [1, 0, 0]);

// 5. 主页时间线上的断档（老号重启的证据）
const DAY = 86400000;
const base = Date.parse('2026-10-10T00:00:00Z');
const idOn = (daysAgo) => String((BigInt(base - daysAgo * DAY) - 1288834974657n) << 22n);
const studio = user('Old_Studio', 3810, 117, { rest_id: '777' });
const own = (daysAgo) => tweet(idOn(daysAgo), studio, { user_id_str: '777' });
const other = (daysAgo) => tweet(idOn(daysAgo), writer, { user_id_str: 'id_Alpha_Writer' });
const page = (cursor, ...tweets) =>
  respond(
    'https://x.com/i/api/graphql/abc/UserOriginalsTimeline?variables=' + encodeURIComponent(JSON.stringify({ userId: '777', count: 20, ...(cursor ? { cursor } : {}) })) + '&features=x',
    timeline(...tweets)
  );

// 第一页：最近 10 条，每 10 天一条，没有断档
let res = page(null, ...[10, 20, 30, 40, 50, 60, 70, 80, 90, 100].map(own));
assert.strictEqual(res.gaps.length, 0, '每 10 天一条，不算断档');
// 第二页接着往下翻：再 3 条，然后一下跳到 900 多天前
res = page('cursor-1', own(110), own(120), other(125), own(130), own(950), own(960));
assert.strictEqual(res.gaps.length, 1);
assert.deepStrictEqual(
  [res.gaps[0].handle, res.gaps[0].since, Math.round((base - res.gaps[0].resumed) / DAY), Math.round((base - res.gaps[0].last) / DAY)],
  ['Old_Studio', 13, 130, 950],
  '恢复后的条数跨页累计，别人的帖子不算'
);
// 断档正好落在两页之间也能认出来
page(null, own(5), own(15));
res = page('cursor-2', own(400), own(410));
assert.deepStrictEqual([res.gaps.length, res.gaps[0].since, Math.round((base - res.gaps[0].last) / DAY)], [1, 2, 400]);
// 从顶部重新加载会重新计数，不会和上一轮的位置拼出假断档
res = page(null, own(5), own(15));
assert.strictEqual(res.gaps.length, 0);
// 回复栏、别人的时间线不参与
res = respond('https://x.com/i/api/graphql/abc/UserTweetsAndReplies?variables=' + encodeURIComponent(JSON.stringify({ userId: '777' })), timeline(own(5), own(900)));
assert.strictEqual(res.gaps.length, 0);
res = respond('https://x.com/i/api/graphql/abc/HomeTimeline?variables=' + encodeURIComponent(JSON.stringify({ count: 20 })), timeline(own(5), own(900)));
assert.strictEqual(res.gaps.length, 0);

console.log('inject.js：全部通过');
