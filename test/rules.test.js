// 标签规则的测试：每个标签在什么情况下该标、什么情况下不该标。
// 运行：node test/rules.test.js
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const sandbox = {};
vm.createContext(sandbox);
for (const f of ['defaults.js', 'rules.js']) vm.runInContext(fs.readFileSync(path.join(__dirname, '../extension', f), 'utf8'), sandbox);
const { XFL_rules: rules, XFL_mergeSettings: merge } = sandbox;

const DAY = 86400000;
const now = Date.parse('2026-10-10T12:00:00Z');
const settings = merge(null);

// 默认是一个注册 1 年、不新不老的普通账号
const account = (o) => ({ h: 'someone', f: 500, g: 100, s: 1000, c: now - 365 * DAY, tw: {}, ...o });
// Array.from：规则跑在独立环境里，返回的数组要转成这边的数组才能直接比较
// 第二个参数是看到的发帖情况：传数字表示「近 30 天看到几条」，传对象可以带上主页断档
const act = (x) => (typeof x === 'number' ? { recent: x } : x || {});
const labels = (o, a = 0, s = settings) => Array.from(rules.tags(account(o), act(a), s, now), (t) => t[1]);
const has = (label, o, a, s) => labels(o, a, s).includes(label);
const noteOf = (o, a) => rules.tags(account(o), act(a), settings, now)[0][2];

// ---------- 大V：粉丝过一万，且是关注数的 10 倍以上 ----------
assert.ok(has('大V', { f: 12000, g: 150 }));
assert.ok(!has('大V', { f: 9999, g: 10 }), '不到一万粉不算');
assert.ok(!has('大V', { f: 12000, g: 5000 }), '靠关注换来的一万粉不算');

// ---------- 疑似互粉：关注数超过 400，粉丝却不到关注数的 10 倍 ----------
assert.ok(!has('疑似互粉', { f: 5000, g: 400 }), '5000 粉、关注 400 以内是正常的');
assert.ok(!has('疑似互粉', { f: 5000, g: 150 }), '大V 常见的关注数');
assert.ok(has('疑似互粉', { f: 5000, g: 600 }), '5000 粉却关注了 600 人');
assert.ok(has('疑似互粉', { f: 3000, g: 1500 }), '粉丝是关注的 2 倍，还是偏少');
assert.ok(!has('互粉号', { f: 5000, g: 600 }), '关注只有粉丝的 12%，够不上更严重的一档');
assert.ok(!has('大V', { f: 20000, g: 15000 }));

// ---------- 互粉号（更严重）：关注数和粉丝数接近，关注是粉丝的 70%～150% ----------
assert.deepStrictEqual(labels({ f: 1200, g: 1100 }), ['互粉号'], '关注和粉丝几乎一样；只标严重的一档，不重复标疑似互粉');
assert.ok(has('互粉号', { f: 20000, g: 15000 }), '粉丝过万也一样，关注是粉丝的 75%');
assert.ok(has('互粉号', { f: 1000, g: 750 }));
assert.ok(has('互粉号', { f: 1000, g: 1300 }), '关注略多于粉丝：关注了 1300 人，大部分回关了');
assert.ok(has('互粉号', { f: 1000, g: 1500 }), '正好 150%');
// 关注远多于粉丝：关注了很多人但没人回关，是普通账号，两档都不标
assert.deepStrictEqual(labels({ f: 50, g: 600 }), [], '50 粉、关注 600');
assert.deepStrictEqual(labels({ f: 400, g: 700 }), [], '关注是粉丝的 175%');
assert.deepStrictEqual(labels({ f: 0, g: 900 }), [], '一个粉丝都没有');
assert.deepStrictEqual(labels({ f: 1000, g: 1600 }), [], '刚超过 150%');
assert.deepStrictEqual(labels({ f: 1000, g: 650 }), ['疑似互粉'], '关注是粉丝的 65%，没到 70%');
assert.ok(!has('互粉号', { f: 300, g: 250 }), '关注数没超过 400 的小号不标');
assert.strictEqual(noteOf({ f: 1200, g: 1100 }), '关注 1100、粉丝 1200，两个数很接近（关注是粉丝的 91%）');
const farmOff = merge(null);
farmOff.tags.mutualFarm = false;
assert.deepStrictEqual(labels({ f: 1200, g: 1100 }, 0, farmOff), [], '关掉开关后两档都不标');
assert.ok(!has('疑似互粉', { f: 80000, g: 800 }), '粉丝是关注的 100 倍，关注多一点也正常');
assert.ok(!has('疑似互粉', { f: 300, g: 200 }), '关注数没超过 400');

// ---------- 新号：注册不到半年；老号：注册超过 3 年 ----------
assert.ok(has('新号', { c: now - 100 * DAY }));
assert.ok(!has('新号', { c: now - 200 * DAY }));
assert.ok(has('老号', { c: now - 4 * 365 * DAY }));
assert.ok(!has('老号', { c: now - 2.5 * 365 * DAY }));
assert.deepStrictEqual(labels({}), [], '注册一年的普通账号什么都不标');

// ---------- 老号重启·方式二：注册超过 2 年，以前很少发，近 30 天突然发得很勤 ----------
const old = now - 4 * 365 * DAY;
assert.deepStrictEqual(labels({ c: old, s: 300 }, 40), ['老号重启'], '4 年共 300 条，近 30 天就发了 40 条；并且不再重复标老号');
assert.deepStrictEqual(labels({ c: old, s: 20000 }, 40), ['老号'], '一直很活跃的老号不算重启');
assert.deepStrictEqual(labels({ c: old, s: 300 }, 10), ['老号'], '近 30 天发得不够多');
assert.deepStrictEqual(labels({ c: old, s: 300 }, 0), ['老号'], '没看到近期帖子');
assert.ok(!has('老号重启', { c: now - 365 * DAY, s: 60 }, 40), '注册才一年，不算老号重启');
assert.ok(has('老号重启', { c: now - 2.5 * 365 * DAY, s: 100 }, 30), '注册两年半就够');
assert.ok(!has('老号', { c: now - 2.5 * 365 * DAY, s: 100 }, 30));
assert.ok(has('老号重启', { c: old, s: 25 }, 25), '旧帖删光了重新开始发的也算');
assert.ok(!has('老号重启', { c: old, s: null }, 40), '不知道帖子总数就不判断');
const off = merge(null);
off.tags.restart = false;
assert.deepStrictEqual(labels({ c: old, s: 300 }, 40, off), ['老号'], '关掉老号重启后退回标老号');
assert.strictEqual(noteOf({ c: old, s: 300 }, 40), '注册 4 年，以前平均每天 0.2 条，近 30 天至少发了 40 条');

// ---------- 老号重启·方式一：主页上直接看到停更，最近才恢复 ----------
const MONTH = 30 * DAY;
const gap = (resumedAgo, lengthMonths, since) => ({ resumed: now - resumedAgo * MONTH, last: now - (resumedAgo + lengthMonths) * MONTH, since });
// 实际案例：注册 6 年多，停更 27 个月，四个半月前恢复，之后发了 26 条，近 30 天只发了 3 条
const atlas = { c: now - 6.5 * 365 * DAY, s: 148 };
assert.deepStrictEqual(labels(atlas, { recent: 3, gaps: [gap(4.5, 27, 26)] }), ['老号重启'], '靠断档认出来，近 30 天发得不多也算');
assert.deepStrictEqual(labels(atlas, { recent: 3 }), ['老号'], '没翻到停更前的帖子时，只能标老号');
assert.match(noteOf(atlas, { recent: 3, gaps: [gap(4.5, 27, 26)] }), /^注册 6 年，停更 27 个月后在 2026-05 恢复发帖，之后已发 26 条以上$/);
assert.deepStrictEqual(labels(atlas, { gaps: [gap(4.5, 3, 26)] }), ['老号'], '只停了 3 个月，不算停更');
assert.deepStrictEqual(labels(atlas, { gaps: [gap(14, 27, 300)] }), ['老号'], '一年多以前就恢复了，不算最近重启');
assert.deepStrictEqual(labels(atlas, { gaps: [gap(1, 27, 4)] }), ['老号'], '恢复后才发了 4 条，还看不出是重启');
assert.deepStrictEqual(labels(atlas, { gaps: [gap(20, 12, 200), gap(2, 9, 30)] }), ['老号重启'], '有过两次停更，看最近那次');
assert.deepStrictEqual(labels(atlas, { gaps: [gap(2, 3, 30), gap(20, 12, 200)] }), ['老号'], '最近只是歇了 3 个月，真正的停更是很久以前的事');
assert.ok(!has('老号重启', { c: now - 365 * DAY, s: 60 }, { gaps: [gap(2, 8, 30)] }), '注册才一年，有断档也不算老号重启');

// ---------- 高互动 / 低互动：互动 ÷ 浏览量 ----------
// 帖子 ID 里带着发布时间：造一个若干小时前发的帖子 ID
const idAt = (hoursAgo, i = 0) => String(((BigInt(now - hoursAgo * 3600000) - 1288834974657n) << 22n) + BigInt(i));
const tw = (eng, views, n = 3, hoursAgo = 48) => Object.fromEntries(Array.from({ length: n }, (_, i) => [idAt(hoursAgo, i), [eng, views]]));
assert.ok(has('高互动', { tw: tw(40, 1000) }), '每 100 次浏览 4 次互动');
assert.ok(!has('高互动', { tw: tw(20, 1000) }));
assert.ok(has('低互动', { f: 50000, tw: tw(5, 10000) }), '每 1000 次浏览不到 1 次');
assert.ok(!has('低互动', { f: 500, tw: tw(5, 10000) }), '粉丝不到一千的不标低互动');
assert.ok(!has('高互动', { tw: tw(40, 1000, 2) }), '只看到 2 条帖子，不判断');
assert.ok(!labels({ f: 50000, tw: tw(5, 10000) }).includes('低活跃'), '旧名字不再出现');
// 中位数：一条投了广告、浏览量虚高的帖子带不偏结果（实际案例：12 条正常帖子 + 1 条广告帖）
const normal = tw(30, 5000, 12); // 每条 0.6%
const withAd = { ...normal, [idAt(72, 99)]: [300, 5000000] }; // 广告帖 0.006%
assert.ok(!has('低互动', { f: 3810, tw: withAd }), '不会因为一条广告帖就标低互动');
assert.strictEqual(rules.engagement(account({ tw: withAd }), settings.th, now).rate.toFixed(2), '0.60');
const withViral = { ...tw(5, 10000, 5), [idAt(72, 99)]: [90000, 1000000] }; // 5 条 0.05% + 1 条爆款 9%
assert.ok(has('低互动', { f: 50000, tw: withViral }), '一条爆款也救不了平时没人理的号');
// 刚发出来的帖子数据还在涨，6 小时内的不算
assert.strictEqual(rules.engagement(account({ tw: tw(40, 1000, 5, 2) }), settings.th, now), null);
assert.strictEqual(rules.engagement(account({ tw: { ...tw(40, 1000, 3), ...tw(1, 1000, 3, 1) } }), settings.th, now).n, 3);

// ---------- 互关 / 关注了你 ----------
assert.deepStrictEqual(labels({ fb: 1, fg: 1 }), ['互关']);
assert.deepStrictEqual(labels({ fb: 1, fg: 0 }), ['关注了你']);
assert.deepStrictEqual(labels({ fb: 0, fg: 1 }), []);

// ---------- 优先级：「只留最重要的一个」时取第一个 ----------
assert.deepStrictEqual(labels({ fb: 1, fg: 1, f: 12000, g: 150, c: old, s: 300 }, 40), ['互关', '大V', '老号重启']);

// ---------- 旧版本存下来的门槛作废，改用新默认值；其他偏好保留 ----------
const migrated = merge({ tagMode: 'one', keepDays: 90, tags: { oldAcct: false }, th: { newDays: 90, oldYears: 8, farmFollowing: 1000 } });
assert.deepStrictEqual([migrated.th.newDays, migrated.th.oldYears, migrated.th.farmFollowing], [180, 3, 400]);
assert.deepStrictEqual([migrated.tagMode, migrated.keepDays, migrated.tags.oldAcct, migrated.tags.restart], ['one', 90, false, true]);
const kept = merge({ ver: 2, th: { oldYears: 5 } });
assert.deepStrictEqual([kept.th.oldYears, kept.th.newDays, kept.ver], [5, 180, 2], '同版本下用户改过的数字保留');

console.log('rules.js：全部通过');
