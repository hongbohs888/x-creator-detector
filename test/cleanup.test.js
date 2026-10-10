// 自动清理的测试：后台定时清理（background.js）和页面这边的清理（content.js）。
// 运行：node test/cleanup.test.js
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ext = (f) => fs.readFileSync(path.join(__dirname, '../extension', f), 'utf8');
const DAY = 86400000;
const now = Date.now();
const ago = (days) => now - days * DAY;
const tick = () => new Promise((r) => setImmediate(r));

function seed(keepDays) {
  const data = {
    xfl_users: {
      stale_user: { h: 'stale_user', f: 10, t: ago(40), hist: [], tw: {} },
      fresh_user: { h: 'fresh_user', f: 20, t: ago(2), hist: [], tw: {} }
    },
    xfl_rt: {
      // 很久没更新，也很久没打开过他的主页
      stale_profile: { ids: ['1'], rts: { 1: 'someone' }, qts: {}, t: ago(50), v: ago(45) },
      // 转发记录很旧，但最近打开过他的主页，应该保留
      visited_profile: { ids: ['2'], rts: { 2: ['someone', '99', '开头'] }, qts: {}, t: ago(50), v: ago(3) }
    }
  };
  if (keepDays !== undefined) data.xfl_settings = { keepDays };
  return data;
}

// ---------- background.js ----------

function loadBackground(data) {
  const listeners = {};
  const on = (name) => ({ addListener: (fn) => (listeners[name] = fn) });
  const alarms = {};
  const sandbox = {
    chrome: {
      storage: {
        local: {
          get: async (keys) => Object.fromEntries(keys.filter((k) => k in data).map((k) => [k, JSON.parse(JSON.stringify(data[k]))])),
          set: async (obj) => void Object.assign(data, JSON.parse(JSON.stringify(obj)))
        }
      },
      alarms: {
        get: (name, cb) => cb(alarms[name]),
        create: (name, info) => (alarms[name] = info),
        onAlarm: on('alarm')
      },
      runtime: { onInstalled: on('installed'), onStartup: on('startup'), onMessage: on('message') }
    }
  };
  sandbox.importScripts = (f) => vm.runInContext(ext(f), sandbox);
  vm.createContext(sandbox);
  vm.runInContext(ext('background.js'), sandbox);
  return { listeners, alarms, data };
}

async function testBackground() {
  // 安装时建好定时器，重复触发不会重建
  let bg = loadBackground(seed());
  bg.listeners.installed();
  assert.strictEqual(bg.alarms['xfl-cleanup'].periodInMinutes, 360, '每 6 小时一次');
  const first = bg.alarms['xfl-cleanup'];
  bg.listeners.installed();
  assert.strictEqual(bg.alarms['xfl-cleanup'], first);

  // 定时器触发：默认 30 天
  bg.listeners.alarm({ name: 'xfl-cleanup' });
  await tick();
  assert.deepStrictEqual(Object.keys(bg.data.xfl_users), ['fresh_user'], '40 天没出现的账号被清掉');
  assert.deepStrictEqual(Object.keys(bg.data.xfl_rt), ['visited_profile'], '最近打开过主页的转发记录保留');
  assert.deepStrictEqual([bg.data.xfl_cleanup.users, bg.data.xfl_cleanup.rt], [1, 1], '记下这次清了多少');
  assert.ok(bg.data.xfl_cleanup.t >= now);

  // 别的定时器不理会
  bg = loadBackground(seed());
  bg.listeners.alarm({ name: 'other' });
  await tick();
  assert.strictEqual(Object.keys(bg.data.xfl_users).length, 2);

  // 保留 90 天：都还没过期
  bg = loadBackground(seed(90));
  bg.listeners.alarm({ name: 'xfl-cleanup' });
  await tick();
  assert.strictEqual(Object.keys(bg.data.xfl_users).length, 2);
  assert.strictEqual(Object.keys(bg.data.xfl_rt).length, 2);
  assert.deepStrictEqual([bg.data.xfl_cleanup.users, bg.data.xfl_cleanup.rt], [0, 0]);

  // 不自动清理
  bg = loadBackground(seed(0));
  bg.listeners.alarm({ name: 'xfl-cleanup' });
  await tick();
  assert.strictEqual(Object.keys(bg.data.xfl_users).length, 2);

  // 保留 1 天：全清；弹窗改天数时走消息，能拿到结果
  bg = loadBackground(seed(1));
  const result = await new Promise((resolve) => assert.strictEqual(bg.listeners.message({ type: 'xfl-cleanup' }, null, resolve), true));
  assert.deepStrictEqual([result.users, result.rt], [2, 2]);
  assert.deepStrictEqual([Object.keys(bg.data.xfl_users).length, Object.keys(bg.data.xfl_rt).length], [0, 0]);

  // 浏览器启动时也清一次
  bg = loadBackground(seed());
  bg.listeners.startup();
  await tick();
  assert.deepStrictEqual(Object.keys(bg.data.xfl_users), ['fresh_user']);
  assert.ok(bg.alarms['xfl-cleanup']);
}

// ---------- content.js ----------

function loadContent(data) {
  const timers = [];
  let onMessage = null;
  let onStorage = null;
  const clone = (v) => JSON.parse(JSON.stringify(v));
  const sandbox = {
    Element: class {},
    MutationObserver: class {
      observe() {}
    },
    location: { pathname: '/home' },
    setTimeout: (fn) => timers.push(fn),
    clearTimeout: () => {},
    document: {
      body: null, // 没有页面，只测数据这一层
      visibilityState: 'visible',
      addEventListener: () => {},
      getElementById: () => null,
      querySelector: () => null,
      querySelectorAll: () => []
    },
    addEventListener: (type, fn) => {
      if (type === 'message') onMessage = fn;
    },
    chrome: {
      runtime: { onMessage: { addListener: () => {} } },
      storage: {
        onChanged: { addListener: (fn) => (onStorage = fn) },
        local: {
          get: (keys, cb) => cb(Object.fromEntries(keys.filter((k) => k in data).map((k) => [k, clone(data[k])]))),
          set: (obj, cb) => {
            Object.assign(data, clone(obj));
            cb();
          }
        }
      }
    }
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  for (const f of ['defaults.js', 'rules.js', 'content.js']) vm.runInContext(ext(f), sandbox);
  const win = vm.runInContext('window', sandbox); // 脚本里看到的 window，和外面的 sandbox 不是同一个对象
  return {
    data,
    send: (users, tweets) => onMessage({ source: win, data: { source: 'xfl-inject', users, tweets } }),
    changeSettings: (s) => onStorage({ xfl_settings: { newValue: s } }, 'local'),
    // 把排队的定时器（扫描、保存）都跑完
    flush: async () => {
      await tick();
      while (timers.length) {
        timers.shift()();
        await tick();
      }
    }
  };
}

const newUser = { handle: 'New_User', followers: 123, following: 5, created: ago(400) };
const newTweet = { id: '1900000000000000001', author: 'New_User', rtOf: 'fresh_user', rtId: '1900000000000000000', rtText: '原帖开头' };

async function testContent() {
  // 页面读到新数据后保存：过期的不会被写回去，新的和没过期的都在
  let page = loadContent(seed());
  await tick();
  page.send([newUser], [newTweet]);
  await page.flush();
  assert.deepStrictEqual(Object.keys(page.data.xfl_users).sort(), ['fresh_user', 'new_user']);
  assert.deepStrictEqual(Object.keys(page.data.xfl_rt).sort(), ['new_user', 'visited_profile']);
  assert.deepStrictEqual(page.data.xfl_rt.new_user.rts['1900000000000000001'], ['fresh_user', '1900000000000000000', '原帖开头']);

  // 后台刚清过，页面内存里还留着旧数据：页面保存时不能把它们写回去
  page = loadContent(seed(90));
  await tick();
  delete page.data.xfl_users.stale_user; // 模拟后台按更短的天数清过
  page.changeSettings({ keepDays: 30 });
  page.send([newUser], []);
  await page.flush();
  assert.ok(!('stale_user' in page.data.xfl_users), '过期账号没有被页面写回存储');
  assert.ok('fresh_user' in page.data.xfl_users);

  // 不自动清理：旧数据原样保留
  page = loadContent(seed(0));
  await tick();
  page.send([newUser], [newTweet]);
  await page.flush();
  assert.deepStrictEqual(Object.keys(page.data.xfl_users).sort(), ['fresh_user', 'new_user', 'stale_user']);
  assert.ok('stale_profile' in page.data.xfl_rt);
}

(async () => {
  await testBackground();
  console.log('background.js：全部通过');
  await testContent();
  console.log('content.js 清理：全部通过');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
