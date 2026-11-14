// 注入到抖音、YouTube、快手、微博页面里（和网页自己的脚本同一个环境，在页面脚本之前运行）。
// 作用：网页自己向服务器要数据时，顺手把返回的内容抄一份存起来：
//   - 抖音：接口返回的作品信息（里面有视频地址）
//   - 快手、微博：接口返回的作品信息（视频地址、图片地址、文案）
//   - YouTube：字幕接口 timedtext 的地址和内容
// 只存在页面内存里（window.__vdl），不往任何地方发送。
(() => {
  if (window.__vdl) return;
  const store = (window.__vdl = { awemes: {}, items: {}, timedtext: [], seq: 0 });
  const host = location.hostname;
  const isDouyin = /(^|\.)douyin\.com$/.test(host);
  const isYoutube = /(^|\.)youtube\.com$/.test(host);
  const isKuaishou = /(^|\.)kuaishou\.com$/.test(host);
  const isWeibo = /(^|\.)weibo\.com$/.test(host);

  const fix = (u) => (typeof u === 'string' ? u.replace(/^\/\//, 'https://').replace(/^http:/, 'https:') : '');
  const isUrl = (u) => typeof u === 'string' && /^(https?:)?\/\//.test(u);
  let fromProfile = false; // 当前正在处理的数据是否来自“博主主页的作品列表”接口

  // ---------- 抖音 ----------
  function saveAweme(a) {
    try {
      const v = a.video;
      const formats = [];
      const add = (label, addr, extra) => {
        const urls = ((addr && addr.url_list) || []).filter((u) => typeof u === 'string' && /^https?:/.test(u));
        if (!urls.length) return;
        formats.push({
          label,
          urls,
          width: addr.width || 0,
          height: addr.height || 0,
          size: addr.data_size || 0,
          h265: !!(extra && extra.is_h265),
          bitrate: (extra && extra.bit_rate) || 0,
        });
      };
      for (const b of v.bit_rate || []) add(b.gear_name || '', b.play_addr, b);
      if (!formats.length) add('默认', v.play_addr);
      // 图文作品：只有图片，没有视频
      const images = [];
      for (const im of Array.isArray(a.images) ? a.images : []) {
        const u = ((im && im.url_list) || []).filter((x) => typeof x === 'string' && /^https?:/.test(x)).pop();
        if (u) images.push({ url: u, liveUrl: '' });
      }
      if (images.length) formats.length = 0;
      if (!formats.length && !images.length) return;
      const st = a.statistics || {};
      const old = store.awemes[a.aweme_id];
      store.awemes[a.aweme_id] = {
        id: String(a.aweme_id),
        desc: a.desc || '',
        author: (a.author && a.author.nickname) || '',
        secUid: (a.author && a.author.sec_uid) || '',
        cover: (((v.cover || v.origin_cover || {}).url_list || []).filter((x) => typeof x === 'string' && /^https?:/.test(x))[0]) || (images[0] && images[0].url) || '',
        duration: v.duration || 0,
        formats,
        images,
        stats: { likes: st.digg_count, comments: st.comment_count, collects: st.collect_count, shares: st.share_count, plays: st.play_count },
        time: (Number(a.create_time) || 0) * 1000,
        seq: old ? old.seq : store.seq++,
        fromProfile: fromProfile || !!(old && old.fromProfile),
      };
    } catch {}
  }

  // ---------- 快手 ----------
  function saveKsPhoto(p, authorName, authorId) {
    try {
      const id = String(p.id || p.photoId || '');
      if (!id) return;
      const formats = [];
      let vr = p.videoResource;
      if (typeof vr === 'string') {
        try {
          vr = JSON.parse(vr);
        } catch {
          vr = null;
        }
      }
      if (vr && typeof vr === 'object') {
        for (const key of Object.keys(vr)) {
          const sets = (vr[key] && vr[key].adaptationSet) || [];
          for (const set of sets) {
            for (const rep of set.representation || []) {
              const urls = [rep.url].concat(rep.backupUrl || []).filter(isUrl).map(fix);
              if (urls.length) formats.push({ label: rep.qualityLabel || rep.qualityType || '', codec: /hevc|265/i.test(key) ? 'h265' : 'h264', width: rep.width || 0, height: rep.height || 0, size: rep.fileSize || 0, bitrate: rep.avgBitrate || 0, urls });
            }
          }
        }
      }
      // 新版接口：manifest（H.264）和 manifestH265 里按清晰度列出地址
      const durMs = Number(p.duration) || 0;
      for (const key of ['manifest', 'manifestH265']) {
        const man = p[key];
        for (const set of (man && man.adaptationSet) || []) {
          for (const rep of set.representation || []) {
            const urls = [rep.url].concat(rep.backupUrl || []).filter(isUrl).map(fix);
            if (!urls.length) continue;
            const h265 = /hevc|hvc|265/i.test(rep.videoCodec || rep.codecs || '') || key === 'manifestH265';
            formats.push({ label: rep.qualityLabel || rep.qualityType || '', codec: h265 ? 'h265' : 'h264', width: rep.width || 0, height: rep.height || 0, size: rep.fileSize || Math.round(((rep.avgBitrate || 0) * durMs) / 8), bitrate: rep.avgBitrate || 0, urls });
          }
        }
      }
      const plain = (list, codec) => {
        const urls = (Array.isArray(list) ? list : []).map((x) => (typeof x === 'string' ? x : x && x.url)).filter(isUrl).map(fix);
        if (urls.length && !formats.some((f) => f.codec === codec)) formats.push({ label: '默认', codec, width: p.width || 0, height: p.height || 0, size: 0, bitrate: 0, urls });
      };
      plain(p.photoUrls, 'h264');
      plain(p.photoH265Urls, 'h265');
      if (isUrl(p.photoUrl) && !formats.length) formats.push({ label: '默认', codec: 'h264', width: p.width || 0, height: p.height || 0, size: 0, bitrate: 0, urls: [fix(p.photoUrl)] });
      if (isUrl(p.photoH265Url) && !formats.some((f) => f.codec === 'h265')) formats.push({ label: '默认', codec: 'h265', width: p.width || 0, height: p.height || 0, size: 0, bitrate: 0, urls: [fix(p.photoH265Url)] });
      for (const m of Array.isArray(p.mainMvUrls) ? p.mainMvUrls : []) if (m && isUrl(m.url) && !formats.length) formats.push({ label: '默认', codec: 'h264', width: 0, height: 0, size: 0, bitrate: 0, urls: [fix(m.url)] });
      if (!formats.length) return;
      const old = store.items['ks:' + id];
      store.items['ks:' + id] = {
        id,
        title: p.caption || p.originCaption || (old && old.title) || '',
        author: authorName || p.userName || (old && old.author) || '',
        duration: Number(p.duration) || 0, // 毫秒
        formats,
        images: [],
        authorId: authorId || (old && old.authorId) || '',
        cover: fix(p.coverUrl || '') || (old && old.cover) || '',
        stats: { likes: p.likeCount, comments: p.commentCount, collects: p.collectCount, plays: p.viewCount },
        time: Number(p.timestamp) || 0,
        seq: old ? old.seq : store.seq++,
      };
    } catch {}
  }
  const looksLikeKsPhoto = (o) => (o.manifest || o.manifestH265 || o.photoUrls || o.photoUrl || o.videoResource || o.mainMvUrls) && (o.id || o.photoId);

  // ---------- 微博 ----------
  function weiboMedia(mi) {
    const formats = [];
    if (!mi) return formats;
    for (const pb of mi.playback_list || []) {
      const pi = pb.play_info || {};
      if (isUrl(pi.url)) formats.push({ label: pi.quality_desc || pi.label || '', codec: /hevc|hvc|265/i.test(pi.video_codecs || '') ? 'h265' : 'h264', width: pi.width || 0, height: pi.height || 0, size: pi.size || 0, bitrate: pi.bitrate || 0, urls: [fix(pi.url)] });
    }
    if (!formats.length) {
      const KEYS = [
        ['mp4_720p_mp4', '720P', 720],
        ['mp4_hd_url', '高清', 540],
        ['stream_url_hd', '高清', 540],
        ['mp4_sd_url', '标清', 360],
        ['stream_url', '标清', 360],
      ];
      const seen = new Set();
      for (const [k, label, hgt] of KEYS) {
        if (isUrl(mi[k]) && !seen.has(mi[k])) {
          seen.add(mi[k]);
          formats.push({ label, codec: 'h264', width: 0, height: hgt, size: 0, bitrate: 0, urls: [fix(mi[k])] });
        }
      }
    }
    return formats;
  }
  const picUrl = (p) => {
    if (!p) return '';
    for (const k of ['largest', 'original', 'mw2000', 'large', 'bmiddle']) if (p[k] && isUrl(p[k].url)) return fix(p[k].url);
    return '';
  };
  function saveWeiboStatus(o) {
    try {
      const formats = [];
      const images = [];
      const mi = o.page_info && o.page_info.media_info;
      formats.push(...weiboMedia(mi));
      for (const id of o.pic_ids || []) {
        const p = o.pic_infos && o.pic_infos[id];
        const u = picUrl(p);
        if (u) images.push({ url: u, liveUrl: p && isUrl(p.video) ? fix(p.video) : '' });
      }
      for (const it of (o.mix_media_info && o.mix_media_info.items) || []) {
        const d = it.data || {};
        if (it.type === 'video' || d.media_info) {
          if (!formats.length) formats.push(...weiboMedia(d.media_info));
        } else {
          const u = picUrl(d);
          if (u && !images.some((x) => x.url === u)) images.push({ url: u, liveUrl: '' });
        }
      }
      if (!formats.length && !images.length) return;
      const item = {
        id: String(o.mblogid || o.idstr || o.id),
        title: o.text_raw || String(o.text || '').replace(/<[^>]+>/g, ''),
        author: (o.user && o.user.screen_name) || '',
        duration: mi && mi.duration ? mi.duration * 1000 : 0,
        formats,
        images,
        authorId: (o.user && String(o.user.idstr || o.user.id || '')) || '',
        cover: fix((o.page_info && o.page_info.page_pic) || '') || (images[0] && images[0].url) || '',
        stats: { likes: o.attitudes_count, comments: o.comments_count, shares: o.reposts_count },
        time: Date.parse(o.created_at) || 0,
        seq: store.seq++,
      };
      const prev = store.items['wb:' + (o.mblogid || o.idstr || o.id)];
      if (prev) item.seq = prev.seq;
      if (o.mblogid) store.items['wb:' + o.mblogid] = item;
      if (o.idstr || o.id) store.items['wb:' + (o.idstr || o.id)] = item;
      const oid = (o.page_info && o.page_info.object_id) || '';
      if (oid && formats.length) store.items['wbtv:' + oid] = item;
    } catch {}
  }
  function saveWeiboTv(c) {
    try {
      const formats = [];
      for (const [label, u] of Object.entries(c.urls || {})) {
        if (!isUrl(u)) continue;
        const m = String(label).match(/(\d{3,4})\s*[Pp]/);
        formats.push({ label, codec: 'h264', width: 0, height: m ? Number(m[1]) : 0, size: 0, bitrate: 0, urls: [fix(u)] });
      }
      if (!formats.length) return;
      const item = { id: String(c.oid || c.mid || ''), title: c.title || c.text || '', author: c.author || c.nickname || '', duration: (Number(c.duration_time) || 0) * 1000, formats, images: [] };
      if (c.oid) store.items['wbtv:' + c.oid] = item;
      if (c.mid) store.items['wb:' + c.mid] = item;
    } catch {}
  }

  // ---------- 在返回的数据里找作品 ----------
  function walk(o, depth) {
    if (!o || typeof o !== 'object' || depth > 12) return;
    if (Array.isArray(o)) {
      for (const x of o) walk(x, depth + 1);
      return;
    }
    if (isDouyin) {
      if (o.aweme_id && o.video && o.video.play_addr) {
        saveAweme(o);
        return;
      }
    } else if (isKuaishou) {
      if (o.photo && typeof o.photo === 'object' && looksLikeKsPhoto(o.photo)) {
        saveKsPhoto(o.photo, (o.author && (o.author.name || o.author.user_name)) || '', (o.author && String(o.author.id || '')) || '');
        return;
      }
      if (looksLikeKsPhoto(o)) {
        saveKsPhoto(o, '', '');
        return;
      }
    } else if (isWeibo) {
      if (o.Component_Play_Playinfo && typeof o.Component_Play_Playinfo === 'object') saveWeiboTv(o.Component_Play_Playinfo);
      if ((o.mblogid || o.idstr) && (o.page_info || o.pic_infos || o.mix_media_info)) saveWeiboStatus(o);
    }
    for (const k in o) {
      const x = o[k];
      if (x && typeof x === 'object') walk(x, depth + 1);
    }
  }
  store.walk = (o) => walk(o, 0); // 弹窗也会用它来解析页面里现成的数据

  // 画面里正在播放的播放器的地址（网页直接用 mp4 地址播放时才有）
  store.playing = () => {
    const list = [...document.querySelectorAll('video')]
      .map((v) => ({ v, r: v.getBoundingClientRect() }))
      .filter((x) => x.r.width > 100 && x.r.bottom > 0 && x.r.top < innerHeight)
      .sort((a, b) => Number(a.v.paused) - Number(b.v.paused) || b.r.width * b.r.height - a.r.width * a.r.height);
    if (!list[0]) return [];
    const v = list[0].v;
    return [v.currentSrc, v.src, ...[...v.querySelectorAll('source')].map((s) => s.src)].filter((u, i, arr) => /^https?:/.test(u || '') && arr.indexOf(u) === i);
  };
  // 按播放地址反查是哪个作品
  store.findByUrl = (prefix, urls) => {
    const paths = new Set();
    for (const u of urls) {
      try {
        paths.add(new URL(u).pathname);
      } catch {}
    }
    for (const key of Object.keys(store.items)) {
      if (!key.startsWith(prefix)) continue;
      for (const f of store.items[key].formats) {
        for (const u of f.urls) {
          try {
            if (paths.has(new URL(u).pathname)) return store.items[key];
          } catch {}
        }
      }
    }
    return null;
  };

  // 本页已经加载过的全部作品（批量下载和数据表用），按出现顺序排列
  store.list = () => {
    const out = [];
    const res = (f) => (f.width && f.height ? Math.min(f.width, f.height) : f.height || 0);
    if (isDouyin) {
      const onSelf = /^\/user\/self/.test(location.pathname);
      for (const a of Object.values(store.awemes)) {
        out.push({ cover: a.cover || '', id: a.id, title: a.desc, author: a.author, authorId: onSelf ? (a.fromProfile ? 'self' : '') : a.secUid, duration: a.duration, formats: a.formats.map((f) => ({ res: res(f), codec: f.h265 ? 'h265' : 'h264', size: f.size, bitrate: f.bitrate, urls: f.urls })), images: a.images || [], stats: a.stats || {}, time: a.time || 0, seq: a.seq || 0, url: 'https://www.douyin.com/video/' + a.id });
      }
    } else {
      const seen = new Set();
      for (const key of Object.keys(store.items)) {
        const it = store.items[key];
        if (seen.has(it)) continue;
        seen.add(it);
        const url = isKuaishou ? 'https://www.kuaishou.com/short-video/' + it.id : isWeibo && it.authorId ? `https://weibo.com/${it.authorId}/${it.id}` : '';
        out.push({ cover: it.cover || '', id: it.id, title: it.title, author: it.author, authorId: it.authorId || '', duration: it.duration, formats: it.formats.map((f) => ({ res: res(f), codec: f.codec, size: f.size, bitrate: f.bitrate, urls: f.urls })), images: it.images || [], stats: it.stats || {}, time: it.time || 0, seq: it.seq || 0, url });
      }
    }
    return out.sort((x, y) => x.seq - y.seq);
  };
  // 当前是不是某个博主的主页；是的话返回博主编号，用来只列出这个博主的作品
  store.pageOwner = () => {
    const p = location.pathname;
    let m = null;
    if (isDouyin) m = p.match(/^\/user\/([^/?#]+)/);
    else if (isKuaishou) m = p.match(/^\/profile\/([^/?#]+)/);
    else if (isWeibo) m = p.match(/^\/u\/(\d+)/);
    return m ? m[1] : ''; // 抖音“我的主页”是 self，列表里用同样的标记对上
  };

  function interested(url) {
    if (isDouyin) return /\/aweme\/v\d+\//.test(url);
    if (isYoutube) return url.includes('/api/timedtext');
    if (isKuaishou) return /\/graphql|\/rest\//.test(url);
    if (isWeibo) return /\/ajax\/|\/tv\/api\//.test(url);
    return false;
  }

  function handle(url, text) {
    try {
      if (isYoutube) {
        store.timedtext.push({ url: new URL(url, location.href).href, body: text || '' });
        if (store.timedtext.length > 30) store.timedtext.shift();
      } else if (text && text.length > 2 && (text[0] === '{' || text[0] === '[')) {
        const parsed = JSON.parse(text);
        fromProfile = isDouyin && /\/aweme\/v\d+\/web\/aweme\/post\//.test(url);
        try {
          walk(parsed, 0);
        } finally {
          fromProfile = false;
        }
      }
    } catch {}
  }

  // fetch
  const rawFetch = window.fetch;
  if (typeof rawFetch === 'function') {
    store.rawFetch = rawFetch.bind(window); // 插件自己发请求时用原始的 fetch，不记录
    window.fetch = function (input, init) {
      const p = rawFetch.apply(this, arguments);
      try {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : (input && input.url) || '';
        if (interested(url)) {
          p.then((res) => res.clone().text().then((t) => handle(url, t))).catch(() => {});
        }
      } catch {}
      return p;
    };
  }

  // XMLHttpRequest
  const XP = XMLHttpRequest.prototype;
  const rawOpen = XP.open;
  const rawSend = XP.send;
  XP.open = function (method, url) {
    try {
      this.__vdlUrl = String(url);
    } catch {}
    return rawOpen.apply(this, arguments);
  };
  XP.send = function () {
    try {
      const url = this.__vdlUrl || '';
      if (interested(url)) {
        this.addEventListener('load', () => {
          try {
            let text = '';
            if (this.responseType === '' || this.responseType === 'text') text = this.responseText;
            else if (this.responseType === 'json') text = JSON.stringify(this.response);
            handle(url, text);
          } catch {}
        });
      }
    } catch {}
    return rawSend.apply(this, arguments);
  };
})();
