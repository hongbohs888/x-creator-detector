// X 博主探测 · 标签规则
// 每个标签怎么判定都在这个文件里。数字门槛的默认值在 defaults.js，这里只管判定逻辑。
(() => {
  const DAY = 86400000;
  const RESTART_DAYS = 30; // 「老号重启」看最近多少天的发帖

  const trim1 = (x) => (Math.floor(x * 10) / 10).toFixed(1).replace(/\.0$/, '');

  function fmtCount(n) {
    if (n < 10000) return String(n);
    if (n < 1e8) {
      const w = n / 1e4;
      return (w < 100 ? trim1(w) : Math.round(w)) + '万';
    }
    return trim1(n / 1e8) + '亿';
  }

  const TWITTER_EPOCH = 1288834974657n;
  const SETTLE_MS = 6 * 3600000; // 刚发出来的帖子数据还在涨，6 小时内的不算

  // 帖子 ID 里带着发布时间
  function timeOfId(id) {
    try {
      return Number((BigInt(id) >> 22n) + TWITTER_EPOCH);
    } catch (e) {
      return 0;
    }
  }

  // 互动率 =（点赞 + 转发 + 回复 + 引用）÷ 浏览量。
  // 每条帖子单独算，再取中位数：一条投了广告、浏览量虚高的帖子，或者一条爆款，都带不偏结果。
  function engagement(r, th, now) {
    const rates = [];
    let views = 0;
    for (const id in r.tw || {}) {
      const [e, v] = r.tw[id];
      if (!(v > 0) || now - timeOfId(id) < SETTLE_MS) continue;
      rates.push((e / v) * 100);
      views += v;
    }
    if (rates.length < th.engMinTweets || views < th.engMinViews) return null;
    rates.sort((a, b) => a - b);
    const mid = rates.length >> 1;
    const rate = rates.length % 2 ? rates[mid] : (rates[mid - 1] + rates[mid]) / 2;
    return { rate, n: rates.length };
  }

  // 老号重启：注册好几年的号，停了很久之后最近又开始发。两种判定方式，满足一种就算。
  // act.gaps：在他主页上看到的断档，每个是 { resumed 恢复后第一条的时间, last 停更前最后一条的时间, since 恢复后已发几条 }
  // act.recent：最近 30 天里看到他发了几条
  function restart(r, act, th, now) {
    if (!r.c) return null;
    const ageDays = (now - r.c) / DAY;
    if (ageDays < th.restartYears * 365) return null;
    const years = Math.floor(ageDays / 365);

    // 方式一（最准）：主页上直接看到了停更。取最近一次够长的断档，看它是不是最近才恢复的。
    const MONTH = 30 * DAY;
    const long = (act.gaps || []).filter((x) => x.resumed - x.last >= th.restartGapMonths * MONTH).sort((a, b) => b.resumed - a.resumed)[0];
    if (long && now - long.resumed <= th.restartWithinMonths * MONTH && long.since >= th.restartSince) {
      const months = Math.floor((long.resumed - long.last) / MONTH);
      const when = new Date(long.resumed).toISOString().slice(0, 7);
      return { years, note: `注册 ${years} 年，停更 ${months} 个月后在 ${when} 恢复发帖，之后已发 ${long.since} 条以上` };
    }

    // 方式二：翻不到停更前的帖子时，看最近是不是比以前勤得多。
    // recent 是「看到」的条数，实际只多不少，所以不会把一直很活跃的号误判成重启。
    const recent = act.recent || 0;
    if (r.s == null || recent < th.restartMinPosts) return null;
    const before = Math.max(r.s - recent, 0) / (ageDays - RESTART_DAYS); // 以前平均每天发几条
    if (recent / RESTART_DAYS < before * th.restartTimes) return null;
    const was = before < 0.1 ? '不到 0.1' : before.toFixed(1);
    return { years, note: `注册 ${years} 年，以前平均每天 ${was} 条，近 ${RESTART_DAYS} 天至少发了 ${recent} 条` };
  }

  // 返回 [样式名, 文字, 判定依据]，顺序即优先级（「只留最重要的一个」时取第一个）
  // r 是账号记录：f 粉丝数、g 关注数、s 帖子总数、c 注册时间、fb 他关注了你、fg 你关注了他
  // act 是看到的发帖情况：{ recent, gaps }，见上面 restart 的说明
  function tags(r, act, settings, now) {
    const th = settings.th;
    const on = settings.tags;
    const out = [];
    const f = r.f;
    const g = r.g;

    if (on.mutual && r.fb && r.fg) out.push(['mutual', '互关', '你们互相关注']);
    else if (on.followsYou && r.fb) out.push(['fy', '关注了你', '他关注了你，你还没回关']);

    if (on.bigV && g != null && f >= th.bigVFollowers && f >= g * th.bigVRatio) {
      out.push(['bigv', '大V', `粉丝过 ${fmtCount(th.bigVFollowers)}，且是关注数的 ${th.bigVRatio} 倍以上`]);
    }

    // 正常人关注不了那么多人。关注数很高、粉丝却没比关注多多少，多半是靠关注换来的。分两档：
    // 互粉号（更严重）：关注数和粉丝数接近，关注是粉丝的 70%～150%
    // 疑似互粉：还没到那个程度，但粉丝数不到关注数的 10 倍
    // 关注数远多于粉丝数的两档都不标：互粉是「我关注你、你也回关我」，
    // 关注了一大堆人却没什么人回关，只是爱关注别人的普通账号。
    if (on.mutualFarm && g != null && g > th.farmFollowing && g <= f * th.farmMax) {
      if (g >= f * th.farmSevere) {
        out.push(['farm2', '互粉号', `关注 ${fmtCount(g)}、粉丝 ${fmtCount(f)}，两个数很接近（关注是粉丝的 ${Math.floor((g / f) * 100)}%）`]);
      } else if (f < g * th.farmTimes) {
        out.push(['farm', '疑似互粉', `关注了 ${fmtCount(g)} 人，粉丝只有关注数的 ${trim1(f / g)} 倍`]);
      }
    }

    const rs = on.restart ? restart(r, act || {}, th, now) : null;
    if (rs) out.push(['restart', '老号重启', rs.note]);

    const days = r.c ? (now - r.c) / DAY : null;
    if (on.newAcct && days != null && days < th.newDays) out.push(['new', '新号', `注册不到 ${th.newDays} 天`]);

    const eg = engagement(r, th, now);
    if (eg) {
      const note = `互动率 ${eg.rate.toFixed(2)}%（${eg.n} 条帖子的中位数）`;
      if (on.highEng && eg.rate >= th.highEng) out.push(['hot', '高互动', note]);
      else if (on.lowEng && eg.rate <= th.lowEng && f >= th.lowEngMinFollowers) out.push(['cold', '低互动', note]);
    }

    // 已经标了「老号重启」就不再重复标「老号」
    if (on.oldAcct && !rs && days != null && days > th.oldYears * 365) out.push(['old', '老号', `注册超过 ${th.oldYears} 年`]);
    return out;
  }

  globalThis.XFL_rules = { RESTART_DAYS, trim1, fmtCount, timeOfId, engagement, tags };
})();
