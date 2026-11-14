// 后台脚本：
// 1. 监听所有网页请求，把视频/音频/m3u8 地址记下来（通用嗅探）
// 2. 接收弹窗发来的下载任务，打开下载页去执行
// 3. 给下载页的请求补上 Referer（B站、抖音的视频服务器会检查来源）

importScripts('shared.js', 'providers.js');

const SELF_ORIGIN = `chrome-extension://${chrome.runtime.id}`;
const MAX_ITEMS = 60;
const MIN_MEDIA_BYTES = 300 * 1024; // 小于 300KB 的音视频多半是音效/预览，忽略

const VIDEO_EXT = /\.(mp4|webm|mov|m4v|flv|mkv)$/i;
const AUDIO_EXT = /\.(mp3|m4a|aac|ogg|opus|wav|flac)$/i;
const HLS_EXT = /\.m3u8$/i;
const DASH_EXT = /\.mpd$/i;
const SEGMENT_EXT = /\.(ts|m4s|cmfv|cmfa)$/i;
// 这些站点的视频是分片加密流，嗅探到的地址没法直接下载，不显示
const IGNORED_HOSTS = /(^|\.)(googlevideo\.com|youtube\.com|ytimg\.com)$/i;

// ---------- 每个标签页嗅探到的资源 ----------
const tabItems = new Map(); // tabId -> items[]
const loading = new Map(); // tabId -> Promise

function loadItems(tabId) {
  if (tabItems.has(tabId)) return Promise.resolve(tabItems.get(tabId));
  if (!loading.has(tabId)) {
    const key = `tab_${tabId}`;
    loading.set(
      tabId,
      chrome.storage.session.get(key).then((r) => {
        if (!tabItems.has(tabId)) tabItems.set(tabId, r[key] || []);
        loading.delete(tabId);
        return tabItems.get(tabId);
      })
    );
  }
  return loading.get(tabId);
}

function saveItems(tabId) {
  const items = tabItems.get(tabId) || [];
  chrome.storage.session.set({ [`tab_${tabId}`]: items }).catch(() => {});
  chrome.action
    .setBadgeText({ tabId, text: items.length ? String(items.length) : '' })
    .catch(() => {});
}

function clearItems(tabId) {
  tabItems.set(tabId, []);
  saveItems(tabId);
}

chrome.action.setBadgeBackgroundColor({ color: '#1677ff' }).catch(() => {});

function header(headers, name) {
  const h = (headers || []).find((x) => x.name.toLowerCase() === name);
  return h ? h.value || '' : '';
}

function classify(pathname, contentType) {
  const ct = (contentType || '').toLowerCase().split(';')[0].trim();
  if (SEGMENT_EXT.test(pathname) || ct === 'video/mp2t') return null;
  if (HLS_EXT.test(pathname) || ct.includes('mpegurl')) return 'hls';
  if (DASH_EXT.test(pathname) || ct.includes('dash+xml')) return 'dash';
  if (ct.startsWith('video/') || (VIDEO_EXT.test(pathname) && !ct.startsWith('text/'))) return 'video';
  if (ct.startsWith('audio/') || (AUDIO_EXT.test(pathname) && !ct.startsWith('text/'))) return 'audio';
  return null;
}

chrome.webRequest.onResponseStarted.addListener(
  (d) => {
    if (d.tabId < 0) return;
    if (d.initiator === SELF_ORIGIN) return; // 自己下载页发的请求不算
    if (d.statusCode !== 200 && d.statusCode !== 206) return;
    if (['image', 'font', 'stylesheet', 'script', 'main_frame'].includes(d.type)) return;

    let u;
    try {
      u = new URL(d.url);
    } catch {
      return;
    }
    if (!/^https?:$/.test(u.protocol) || IGNORED_HOSTS.test(u.hostname)) return;

    const ct = header(d.responseHeaders, 'content-type');
    const kind = classify(u.pathname, ct);
    if (!kind) return;

    // 文件大小：分段请求看 Content-Range 的总长度，否则看 Content-Length
    let size = 0;
    const range = header(d.responseHeaders, 'content-range').match(/\/(\d+)\s*$/);
    if (range) size = Number(range[1]);
    else if (d.statusCode === 200) size = Number(header(d.responseHeaders, 'content-length')) || 0;
    if ((kind === 'video' || kind === 'audio') && size > 0 && size < MIN_MEDIA_BYTES) return;
    // 没有长度的 flv 是直播流（永远下不完），不列出来
    if (size === 0 && (/\.flv$/i.test(u.pathname) || /x-flv/i.test(ct))) return;

    const key = u.origin + u.pathname;
    loadItems(d.tabId).then((items) => {
      const old = items.find((x) => x.key === key);
      if (old) {
        old.url = d.url; // 保留最新的地址（签名可能会更新）
        if (size && !old.size) old.size = size;
      } else {
        let name = '';
        try {
          name = decodeURIComponent(u.pathname.split('/').pop() || '');
        } catch {
          name = u.pathname.split('/').pop() || '';
        }
        items.unshift({ key, kind, url: d.url, size, contentType: ct, name, host: u.hostname, time: Date.now() });
        if (items.length > MAX_ITEMS) items.length = MAX_ITEMS;
      }
      saveItems(d.tabId);
    });
  },
  { urls: ['<all_urls>'] },
  ['responseHeaders']
);

// 页面整体跳转/刷新时清空这个标签页的记录
chrome.webRequest.onBeforeRequest.addListener(
  (d) => {
    if (d.tabId >= 0 && d.initiator !== SELF_ORIGIN) clearItems(d.tabId);
  },
  { urls: ['<all_urls>'], types: ['main_frame'] }
);

chrome.tabs.onRemoved.addListener((tabId) => {
  tabItems.delete(tabId);
  chrome.storage.session.remove(`tab_${tabId}`).catch(() => {});
  chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [tabId] }).catch(() => {});
});

// ---------- 下载任务 ----------
// embedded：发请求的是嵌在网页里的批量面板。这时规则只对插件自己发的请求生效，不动网页自己的请求。
// 独立的下载页 / 批量窗口保持原来的规则（那条路已经实测过）。
async function setReferer(tabId, referer, embedded) {
  if (!referer) return;
  let origin = '';
  try {
    origin = new URL(referer).origin;
  } catch {
    return;
  }
  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: [tabId],
    addRules: [
      {
        id: tabId,
        priority: 1,
        action: {
          type: 'modifyHeaders',
          requestHeaders: [
            { header: 'Referer', operation: 'set', value: referer },
            { header: 'Origin', operation: 'set', value: origin },
          ],
        },
        condition: embedded ? { tabIds: [tabId], initiatorDomains: [chrome.runtime.id], resourceTypes: ['xmlhttprequest'] } : { tabIds: [tabId], resourceTypes: ['xmlhttprequest'] },
      },
    ],
  });
}

function sanitizeFilename(name) {
  return (
    String(name || '')
      .replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ')
      .replace(/[​-‏‪-‮﻿]/g, '')
      .replace(/\s+/g, ' ')
      .replace(/^[.\s]+|[.\s]+$/g, '')
      .slice(0, 100) || '视频'
  );
}

async function createJob(jobIn, fromTab) {
  const id = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const job = { ...jobIn, id, filename: sanitizeFilename(jobIn.filename) };
  await chrome.storage.session.set({ [`job_${id}`]: job });
  await chrome.tabs.create({
    url: chrome.runtime.getURL(`job.html?id=${id}`),
    active: false,
    index: fromTab ? fromTab.index + 1 : undefined,
  });
  return { id };
}

// 页面上某个作品的下载按钮被点了：查出这个作品的下载地址，建一个下载任务
async function quickDownload(msg, tab) {
  if (!tab) return { error: '找不到页面' };
  const run = async (func, args = []) => {
    const r = await chrome.scripting.executeScript({ target: { tabId: tab.id }, world: 'MAIN', func, args });
    return r && r[0] ? r[0].result : null;
  };
  let it = null;
  let audioUrls = [];
  if (msg.site === 'bili') {
    const info = ((await run(biliInfo, [[msg.id]])) || {})[msg.id] || {};
    const r = await run(biliResolve, [{ id: msg.id, cid: info.cid }]);
    if (!r || r.error) return { error: (r && r.error) || '获取视频地址失败' };
    it = { id: msg.id, title: info.title || msg.id, author: info.author || '', formats: r.formats, images: [] };
    audioUrls = r.audioUrls || [];
  } else if (msg.site === 'xhs') {
    const r = await run(xhsResolve, [{ id: msg.id, url: msg.url, title: '' }]);
    if (!r || r.error) return { error: (r && r.error) || '获取笔记内容失败' };
    it = { id: msg.id, title: (r.extra && r.extra.title) || msg.id, author: (r.extra && r.extra.author) || '', formats: r.formats, images: r.images };
  } else {
    const r = await run((id) => {
      const s = window.__vdl;
      if (!s || !s.list) return { nohook: true };
      return { item: s.list().find((x) => x.id === id) || null };
    }, [msg.id]);
    if (!r || r.nohook) return { error: '请刷新一下这个页面，然后再试。' };
    if (!r.item) return { error: '还没读到这个作品的数据。把它点开播放一下，再点下载。' };
    it = r.item;
  }
  if (!it.formats.length && !it.images.length) return { error: '没有找到可下载的内容' };

  const first = String(it.title || '').split('\n')[0].trim();
  const filename = (it.author ? it.author + ' - ' : '') + (first || it.id);
  const referer = new URL(tab.url).origin + '/';
  let note = '';
  if (it.formats.length) {
    const f = pickFormat(it.formats, msg.pref || 'max');
    note = f.res ? f.res + 'P' : '';
    if (audioUrls.length) await createJob({ kind: 'merge', videoUrls: f.urls, audioUrls, filename, referer }, tab);
    else await createJob({ kind: 'direct', urls: f.urls, ext: '.mp4', filename, referer }, tab);
  } else {
    const items = [];
    for (const img of it.images) {
      items.push({ url: img.url });
      if (img.liveUrl) items.push({ url: img.liveUrl, video: true });
    }
    note = `${it.images.length} 张图`;
    await createJob({ kind: 'images', items, toJpg: true, filename, referer }, tab);
  }
  return { ok: true, title: first || it.id, note };
}

async function saveTextFile(filename, ext, text) {
  const mime = ext === '.txt' ? 'text/plain' : 'application/octet-stream';
  const url = `data:${mime};charset=utf-8,` + encodeURIComponent(text);
  await chrome.downloads.download({ url, filename: sanitizeFilename(filename) + ext });
}

// 页面上某个视频的“字幕”按钮被点了（只有平台自带字幕的 B站 有这个按钮）。
async function quickSubtitle(msg, tab) {
  if (!tab) return { error: '找不到页面' };
  if (msg.site !== 'bili') return { error: '这个平台不提供字幕' };
  const res = await chrome.scripting.executeScript({ target: { tabId: tab.id }, world: 'MAIN', func: biliSubtitle, args: [msg.id] });
  const r = res && res[0] ? res[0].result : null;
  if (!r) return { error: '没有取到数据' };
  if (r.error) return r;
  if (r.none || !r.cues || !r.cues.length) return { ok: true, kind: 'none', title: r.title };
  await saveTextFile(`${r.title}${r.lang ? '.' + r.lang : ''}`, '.srt', buildSubtitleText(r.cues, '.srt'));
  return { ok: true, kind: 'srt', title: r.title, count: r.cues.length, lang: r.lang };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    switch (msg.type) {
      case 'getSniffed':
        return await loadItems(msg.tabId);

      case 'clearSniffed':
        clearItems(msg.tabId);
        return true;

      case 'startJob':
        return await createJob(msg.job, sender.tab);

      case 'quickSubtitle':
        // 页面上的“字幕”按钮（B站）
        return await quickSubtitle(msg, sender.tab);

      case 'whoami':
        return { tabId: sender.tab ? sender.tab.id : -1 };

      case 'quickDownload':
        // 页面上的下载按钮：按作品编号直接下载
        return await quickDownload(msg, sender.tab);

      case 'getJob': {
        // 下载页加载后来取任务；先把 Referer 规则设好再把任务交给它
        const key = `job_${msg.id}`;
        const job = (await chrome.storage.session.get(key))[key];
        if (job && sender.tab) await setReferer(sender.tab.id, job.referer);
        return job || null;
      }

      case 'saveText': {
        // .srt 用通用类型，否则 Chrome 会把扩展名改成 .txt
        const mime = msg.ext === '.txt' ? 'text/plain' : 'application/octet-stream';
        const url = `data:${mime};charset=utf-8,` + encodeURIComponent(msg.text);
        const downloadId = await chrome.downloads.download({ url, filename: sanitizeFilename(msg.filename) + msg.ext });
        return { downloadId };
      }

      case 'ytCaption': {
        // 在后台做，弹窗中途被关掉也不影响
        const r = await chrome.scripting.executeScript({
          target: { tabId: msg.tabId },
          world: 'MAIN',
          func: ytFetchCaption,
          args: [msg.track, msg.videoId, msg.tlang, msg.uniqueLang],
        });
        const res = (r && r[0] && r[0].result) || {};
        if (!res.body) return { ok: false, reason: res.reason || 'timeout' };
        const cues = json3ToCues(res.body);
        if (!cues.length) return { ok: false, reason: 'empty' };
        const mime = msg.ext === '.txt' ? 'text/plain' : 'application/octet-stream';
        const url = `data:${mime};charset=utf-8,` + encodeURIComponent(buildSubtitleText(cues, msg.ext));
        await chrome.downloads.download({ url, filename: sanitizeFilename(msg.filename) + msg.ext });
        return { ok: true, count: cues.length };
      }

      case 'openBatch':
        // 用独立小窗口打开，原页面保持可见（自动翻页需要原页面在前台）
        await chrome.windows.create({ url: chrome.runtime.getURL(`batch.html?tab=${msg.tabId}`), type: 'popup', width: 980, height: 760 });
        return true;

      case 'setReferer':
        if (sender.tab) await setReferer(sender.tab.id, msg.referer, !String(sender.tab.url || '').startsWith('chrome-extension://'));
        return true;

      case 'focusMe':
        if (sender.tab) await chrome.tabs.update(sender.tab.id, { active: true });
        return true;

      case 'closeMe':
        if (sender.tab) await chrome.tabs.remove(sender.tab.id);
        return true;
    }
    return null;
  })()
    .then(sendResponse)
    .catch((e) => sendResponse({ error: String((e && e.message) || e) }));
  return true;
});
