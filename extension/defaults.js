// 默认设置：content.js 和 popup.js 共用。
// 觉得某个门槛不合理，可以在插件弹窗里调，也可以直接改这里的默认值。
(() => {
  const DEFAULTS = {
    ver: 2, // 标签规则的版本。规则定义变了就加一，旧版本存下来的门槛数字会作废，改用新默认值
    enabled: true,
    colorTiers: true, // 粉丝数按量级分五档颜色
    tagMode: 'all', // all 全部标签 | one 只留最重要的一个 | none 只显示粉丝数
    hoverCard: true,
    rtPanel: true, // 个人主页上的转发榜
    rtTopN: 10,
    rtCollapsed: false,
    autoScrollRounds: 8, // 「多翻几屏」一次翻几屏
    keepDays: 30, // 自动清理：多少天没再出现的数据就删掉，0 表示不自动清理
    tags: {
      mutual: true, // 互关
      followsYou: true, // 关注了你
      bigV: true, // 大V
      mutualFarm: true, // 疑似互粉、互粉号
      restart: true, // 老号重启
      newAcct: true, // 新号
      oldAcct: true, // 老号
      highEng: true, // 高互动
      lowEng: true // 低互动
    },
    th: {
      bigVFollowers: 10000, // 大V：粉丝数下限
      bigVRatio: 10, // 大V：粉丝数至少是关注数的多少倍
      farmFollowing: 400, // 疑似互粉：关注数超过多少才算异常（正常人关注不了那么多人）
      farmTimes: 10, // 疑似互粉：粉丝数不到关注数的多少倍
      farmSevere: 0.7, // 互粉号（更严重的一档）：关注数达到粉丝数的多少（0.7 即 70%）
      farmMax: 1.5, // 关注数超过粉丝数的多少倍就不算互粉了：那是关注了很多人但没人回关的普通账号
      newDays: 180, // 新号：注册不到多少天（半年）
      oldYears: 3, // 老号：注册超过多少年
      restartYears: 2, // 老号重启：注册超过多少年
      // 判定方式一：在他主页上直接看到「停更很久，最近又恢复」
      restartGapMonths: 6, // 停更至少多少个月
      restartWithinMonths: 6, // 恢复发帖是最近多少个月内的事
      restartSince: 10, // 恢复之后至少已经发了多少条
      // 判定方式二：最近发帖比以前勤得多（翻不到停更前的帖子时用）
      restartMinPosts: 15, // 最近 30 天至少发了多少条
      restartTimes: 5, // 最近的发帖速度至少是以前的多少倍
      // 互动率按浏览量算，天然偏低：实测千万粉大号普遍在 0.1%～1% 之间
      highEng: 3, // 高互动：互动率不低于百分之几
      lowEng: 0.1, // 低互动：互动率不高于百分之几
      lowEngMinFollowers: 1000, // 低互动：粉丝数达到多少才标
      engMinTweets: 3, // 互动率：至少要看到几条帖子才算
      engMinViews: 1000 // 互动率：这些帖子的总浏览量下限
    }
  };

  globalThis.XFL_DEFAULTS = DEFAULTS;
  // 早于这个时间点的数据算过期；返回 0 表示不自动清理
  globalThis.XFL_cutoff = (settings, now) => (settings.keepDays > 0 ? now - settings.keepDays * 86400000 : 0);
  globalThis.XFL_mergeSettings = (saved) => {
    const s = JSON.parse(JSON.stringify(DEFAULTS));
    if (!saved || typeof saved !== 'object') return s;
    for (const k in s) {
      if (k === 'ver') continue;
      if (k === 'tags') Object.assign(s.tags, saved.tags || {});
      else if (k === 'th') Object.assign(s.th, saved.ver === DEFAULTS.ver ? saved.th : null);
      else if (k in saved) s[k] = saved[k];
    }
    return s;
  };
})();
