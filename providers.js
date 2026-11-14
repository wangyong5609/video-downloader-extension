// 各平台“取作品列表 / 补数据 / 取下载地址”的函数。
// 批量面板（batch.js）和后台（background.js，页面上的单个下载按钮）共用。

// =====================================================================
// 各平台怎么取作品列表。下面这些函数都是送到原页面里去执行的，必须自成一体。
// =====================================================================

// 抖音、快手、微博：hook.js 已经把页面加载过的作品都记下来了
function hookedList() {
  const s = window.__vdl;
  if (!s || !s.list) return null;
  return { items: s.list(), owner: s.pageOwner(), title: document.title };
}

// B站：先从页面上找出所有视频链接
function biliList() {
  const map = new Map();
  for (const a of document.querySelectorAll('a[href*="/video/BV"]')) {
    const m = a.href.match(/\/video\/(BV[0-9A-Za-z]+)/);
    if (!m) continue;
    const t = (a.getAttribute('title') || a.textContent || '').trim();
    const cur = map.get(m[1]);
    if (cur == null || (t.length > cur.length && t.length < 200)) map.set(m[1], t);
  }
  const om = location.hostname === 'space.bilibili.com' ? location.pathname.match(/^\/(\d+)/) : null;
  const items = [...map].map(([bvid, title], i) => ({ id: bvid, title, author: '', authorId: '', duration: 0, formats: [], images: [], stats: {}, time: 0, seq: i, url: 'https://www.bilibili.com/video/' + bvid, kind: '视频', lazy: true, needInfo: true }));
  return { items, owner: om ? om[1] : '', title: document.title };
}

// B站：补上每个视频的标题、作者、时长、数据（一次查一小批）
async function biliInfo(bvids) {
  const out = {};
  await Promise.all(
    bvids.map(async (bvid) => {
      try {
        const j = await (await fetch(`https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`, { credentials: 'include' })).json();
        if (j.code !== 0) return;
        const d = j.data;
        const st = d.stat || {};
        out[bvid] = { cover: String(d.pic || '').replace(/^http:/, 'https:'), title: d.title, author: (d.owner && d.owner.name) || '', authorId: String((d.owner && d.owner.mid) || ''), duration: (d.duration || 0) * 1000, cid: d.cid, stats: { likes: st.like, comments: st.reply, collects: st.favorite, shares: st.share, plays: st.view }, time: (d.pubdate || 0) * 1000 };
      } catch {}
    })
  );
  return out;
}

// B站：下载前才去要视频地址（地址有时效）
async function biliResolve(it) {
  try {
    let cid = it.cid;
    if (!cid) {
      const v = await (await fetch(`https://api.bilibili.com/x/web-interface/view?bvid=${it.id}`, { credentials: 'include' })).json();
      if (v.code !== 0) return { error: v.message || '获取视频信息失败' };
      cid = v.data.cid;
    }
    const j = await (await fetch(`https://api.bilibili.com/x/player/playurl?bvid=${it.id}&cid=${cid}&qn=0&fnval=4048&fourk=1`, { credentials: 'include' })).json();
    if (j.code !== 0) return { error: j.message || '获取视频地址失败' };
    const d = j.data;
    if (d.dash) {
      const formats = (d.dash.video || []).map((v) => ({
        res: Math.min(v.width || 0, v.height || 0),
        codec: /^avc/.test(v.codecs) ? 'h264' : /^hev|^hvc/.test(v.codecs) ? 'h265' : 'av1',
        size: Math.round(((v.bandwidth || 0) * (d.dash.duration || 0)) / 8),
        bitrate: v.bandwidth || 0,
        urls: [v.baseUrl || v.base_url].concat(v.backupUrl || v.backup_url || []).filter(Boolean),
      }));
      const au = (d.dash.audio || []).slice().sort((a, b) => b.bandwidth - a.bandwidth)[0];
      return { formats, audioUrls: au ? [au.baseUrl || au.base_url].concat(au.backupUrl || au.backup_url || []).filter(Boolean) : [], images: [] };
    }
    if (d.durl && d.durl.length === 1) return { formats: [{ res: 0, codec: 'h264', size: d.durl[0].size, bitrate: 0, urls: [d.durl[0].url].concat(d.durl[0].backup_url || []) }], audioUrls: [], images: [] };
    return { error: '这个视频的格式暂不支持批量下载' };
  } catch (e) {
    return { error: String((e && e.message) || e) };
  }
}

// 小红书：笔记卡片的数据在页面的 __INITIAL_STATE__ 里（博主主页、发现页、搜索页都有）
function xhsList() {
  const un = (x) => (x && typeof x === 'object' && '_rawValue' in x ? x._rawValue : x);
  const st = window.__INITIAL_STATE__;
  if (!st) return null;
  const om = location.pathname.match(/^\/user\/profile\/([0-9a-f]+)/);
  const pools = [];
  try {
    if (om) {
      const notes = un(un(st.user).notes) || [];
      // 主页有“笔记/收藏/点赞”几个栏目，取内容最多的当前栏目
      for (const tab of notes) pools.push(un(tab) || []);
      pools.sort((a, b) => b.length - a.length);
      pools.length = Math.min(pools.length, 1);
    } else {
      for (const key of ['feed', 'search']) {
        const part = st[key] && un(st[key]);
        const feeds = part && un(part.feeds);
        if (Array.isArray(feeds)) pools.push(feeds);
      }
    }
  } catch {}
  const items = [];
  const seen = new Set();
  for (const pool of pools) {
    for (const raw of pool) {
      const c = un(raw) || {};
      const card = un(c.noteCard) || c;
      const id = c.id || c.noteId || card.noteId;
      if (!id || !/^[0-9a-f]{24}$/.test(id) || seen.has(id)) continue;
      seen.add(id);
      const user = un(card.user) || {};
      const info = un(card.interactInfo) || {};
      const token = c.xsecToken || card.xsecToken || '';
      items.push({
        id,
        title: card.displayTitle || card.title || '',
        author: user.nickname || user.nickName || '',
        authorId: user.userId || '',
        duration: 0,
        formats: [],
        images: [],
        stats: { likes: info.likedCount },
        time: 0,
        seq: items.length,
        url: `https://www.xiaohongshu.com/explore/${id}` + (token ? `?xsec_token=${encodeURIComponent(token)}&xsec_source=pc_feed` : ''),
        kind: card.type === 'video' ? '视频' : '图文',
        cover: String((un(card.cover) || {}).urlDefault || (un(card.cover) || {}).url || '').replace(/^http:/, 'https:'),
        lazy: true,
      });
    }
  }
  return { items: JSON.parse(JSON.stringify(items)), owner: om ? om[1] : '', title: document.title };
}

// 小红书：下载前打开这篇笔记的页面数据，取出视频地址 / 图片地址
async function xhsResolve(it) {
  try {
    const res = await fetch(it.url, { credentials: 'include' });
    const html = await res.text();
    const m = html.match(/window\.__INITIAL_STATE__\s*=\s*([\s\S]*?)<\/script>/);
    if (!m) return { error: '小红书没有返回笔记内容（可能要求验证）。先在原页面手动点开一篇笔记，再回来重试。' };
    const state = JSON.parse(m[1].replace(/\bundefined\b/g, 'null'));
    const entry = state.note && state.note.noteDetailMap && state.note.noteDetailMap[it.id];
    const n = entry && entry.note;
    if (!n || !n.noteId) return { error: '小红书没有返回笔记内容（可能要求验证）。先在原页面手动点开一篇笔记，再回来重试。' };
    const fix = (u) => (typeof u === 'string' ? u.replace(/^http:/, 'https:').replace(/^\/\//, 'https://') : '');
    const formats = [];
    const stream = (n.video && n.video.media && n.video.media.stream) || {};
    for (const key of Object.keys(stream)) {
      for (const v of Array.isArray(stream[key]) ? stream[key] : []) {
        const urls = [v.masterUrl].concat(v.backupUrls || []).map(fix).filter(Boolean);
        const c = String(v.videoCodec || v.codec || key).toLowerCase();
        if (urls.length) formats.push({ res: Math.min(v.width || 0, v.height || 0), codec: /hevc|h265|hvc/.test(c) ? 'h265' : 'h264', size: v.size || 0, bitrate: v.avgBitrate || 0, urls });
      }
    }
    const images = [];
    if (n.type !== 'video') {
      for (const img of n.imageList || []) {
        const url = fix(img.urlDefault || img.url || img.urlPre);
        if (!url) continue;
        const live = img.stream && (img.stream.h264 || img.stream.h265 || [])[0];
        images.push({ url, liveUrl: live && live.masterUrl ? fix(live.masterUrl) : '' });
      }
    }
    const info = n.interactInfo || {};
    return {
      formats,
      audioUrls: [],
      images,
      extra: { author: (n.user && (n.user.nickname || n.user.nickName)) || it.author || '', cover: fix(((n.imageList || [])[0] || {}).urlDefault || '') || it.cover || '', title: [n.title, n.desc].filter(Boolean).join('\n') || it.title, duration: ((n.video && n.video.capa && n.video.capa.duration) || 0) * 1000, time: n.time || 0, stats: { likes: info.likedCount, comments: info.commentCount, collects: info.collectedCount, shares: info.shareCount } },
    };
  } catch (e) {
    return { error: String((e && e.message) || e) };
  }
}

const PROVIDERS = {
  hooked: { list: hookedList, gap: 800 },
  bili: { list: biliList, info: biliInfo, resolve: biliResolve, gap: 1000 },
  xhs: { list: xhsList, resolve: xhsResolve, gap: 2000 }, // 小红书查得严，慢一点
};

// 按“清晰度偏好”挑一个版本：同分辨率优先 H.264（兼容性好）
function pickFormat(formats, pref) {
  const sorted = formats.slice().sort((a, b) => b.res - a.res || Number(a.codec === 'h265') - Number(b.codec === 'h265') || (b.size || b.bitrate) - (a.size || a.bitrate));
  if (pref === 'max') return sorted[0];
  if (pref === 'min') return sorted[sorted.length - 1];
  const want = Number(pref);
  return sorted.find((f) => f.res && f.res <= want) || sorted[sorted.length - 1];
}


// ---------- 字幕（都在原页面里执行）----------

// B站：取这个视频的字幕，返回 { title, lang, cues }；视频没有字幕时返回 { none, title }
async function biliSubtitle(bvid) {
  try {
    const j = async (u) => (await fetch(u, { credentials: 'include' })).json();
    const view = await j(`https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`);
    if (view.code !== 0) return { error: view.message || '获取视频信息失败' };
    const d = view.data;
    const pv = await j(`https://api.bilibili.com/x/player/wbi/v2?bvid=${bvid}&cid=${d.cid}`);
    const subs = ((pv.data && pv.data.subtitle && pv.data.subtitle.subtitles) || []).filter((x) => x.subtitle_url);
    if (!subs.length) return { none: true, title: d.title };
    const pick = subs.find((x) => /^zh/i.test(x.lan) && !/^ai-/i.test(x.lan)) || subs.find((x) => /zh/i.test(x.lan)) || subs[0];
    const url = pick.subtitle_url.startsWith('//') ? 'https:' + pick.subtitle_url : pick.subtitle_url;
    const body = await (await fetch(url)).json();
    const cues = (body.body || []).map((c) => ({ start: c.from * 1000, end: c.to * 1000, text: c.content }));
    return { title: d.title, lang: pick.lan_doc || pick.lan, cues };
  } catch (e) {
    return { error: String((e && e.message) || e) };
  }
}
