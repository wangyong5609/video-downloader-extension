// 弹窗和后台共用的函数。

// 在 YouTube 页面里执行：取某条字幕的内容（json3 格式的文本）
// YouTube 的字幕请求必须带播放器生成的令牌，自己拼请求会被拒。
// 所以做法是：让播放器自己去加载这条字幕，hook.js 会把它拿到的内容抄一份，我们直接用。
async function ytFetchCaption(track, videoId, tlang, uniqueLang) {
  const store = window.__vdl;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // 1. 先直接试一次（少数情况下不需要令牌）
  try {
    const u = new URL(track.url, location.origin);
    u.searchParams.set('fmt', 'json3');
    if (tlang) u.searchParams.set('tlang', tlang);
    const f = (store && store.rawFetch) || fetch;
    const t = await (await f(u.href, { credentials: 'include' })).text();
    if (t && t.trim().startsWith('{')) return { body: t };
  } catch {}

  if (!store) return { body: '', reason: 'nohook' };

  // 在播放器已经加载过的字幕里找：同一个视频、同一种语言、同样的翻译目标
  const find = (fromIndex, strictKind) => {
    const list = store.timedtext;
    for (let i = list.length - 1; i >= fromIndex; i--) {
      try {
        const c = list[i];
        if (!c.body || !c.body.trim().startsWith('{')) continue;
        const q = new URL(c.url).searchParams;
        if (q.get('v') !== videoId || q.get('lang') !== track.lang) continue;
        if ((q.get('tlang') || '') !== (tlang || '')) continue;
        if (strictKind && (q.get('kind') === 'asr') !== !!track.auto) continue;
        return c.body;
      } catch {}
    }
    return '';
  };

  // 2. 播放器之前已经加载过这条字幕
  let body = find(0, !uniqueLang);
  if (body) return { body };

  // 3. 让播放器现在加载这条字幕
  const player = document.querySelector('#movie_player');
  const btn = document.querySelector('.ytp-subtitles-button');
  if (!player || !btn) return { body: '', reason: 'noplayer' };
  if (document.querySelector('.ad-showing')) return { body: '', reason: 'ad' };

  // 视频还没开始播放时，YouTube 不给字幕内容。先静音播放一下，拿到后再恢复原样。
  const state = player.getPlayerState ? player.getPlayerState() : 1;
  const cold = state === -1 || state === 5;
  let wasMuted = true;
  if (cold) {
    wasMuted = player.isMuted();
    player.mute();
    player.playVideo();
    for (let i = 0; i < 40; i++) {
      await sleep(200);
      if (player.getPlayerState() === 1 && player.getCurrentTime() > 0.2) break;
    }
    if (document.querySelector('.ad-showing')) {
      if (!wasMuted) player.unMute();
      return { body: '', reason: 'ad' };
    }
  }

  const wasOn = btn.getAttribute('aria-pressed') === 'true';
  const before = store.timedtext.length;
  const selectTrack = () => {
    try {
      const tracks = (player.getOption && player.getOption('captions', 'tracklist', { includeAsr: true })) || [];
      const target = tracks.find((t) => t.languageCode === track.lang && (t.kind === 'asr') === !!track.auto) || tracks.find((t) => t.languageCode === track.lang) || { languageCode: track.lang };
      const opt = Object.assign({}, target);
      if (tlang) opt.translationLanguage = { languageCode: tlang, languageName: tlang };
      player.setOption('captions', 'track', opt);
    } catch {}
  };
  const waitBody = async (rounds) => {
    for (let i = 0; i < rounds && !body; i++) {
      await sleep(200);
      body = find(before, false);
    }
  };
  if (!wasOn) btn.click();
  await sleep(300);
  selectTrack();
  await waitBody(20);
  if (!body) {
    // 没等到就让播放器重新加载一次字幕
    try {
      player.setOption('captions', 'reload', true);
    } catch {}
    selectTrack();
    await waitBody(30);
  }

  // 恢复原样：字幕原本关着就关回去；视频原本没在播就暂停并回到开头
  if (!wasOn && btn.getAttribute('aria-pressed') === 'true') btn.click();
  if (cold) {
    player.pauseVideo();
    player.seekTo(0, true);
    if (!wasMuted) player.unMute();
  }
  return { body, reason: body ? '' : 'timeout' };
}

// ---------- 字幕文本生成 ----------
function srtTime(ms) {
  ms = Math.max(0, Math.round(ms));
  const p = (n, l = 2) => String(n).padStart(l, '0');
  return `${p(Math.floor(ms / 3600000))}:${p(Math.floor(ms / 60000) % 60)}:${p(Math.floor(ms / 1000) % 60)},${p(ms % 1000, 3)}`;
}

// cues: [{start, end, text}]（毫秒）；ext 为 .srt 或 .txt
function buildSubtitleText(cues, ext) {
  // 自动字幕的时间会互相重叠，把每句的结束时间截到下一句开始
  for (let i = 0; i < cues.length - 1; i++) {
    if (cues[i + 1].start > cues[i].start) cues[i].end = Math.min(cues[i].end, cues[i + 1].start);
  }
  return ext === '.srt'
    ? cues.map((c, i) => `${i + 1}\n${srtTime(c.start)} --> ${srtTime(c.end)}\n${c.text}\n`).join('\n')
    : cues.map((c) => c.text.replace(/\n/g, ' ')).join('\n');
}

// YouTube json3 字幕 -> cues
function json3ToCues(body) {
  return ((JSON.parse(body).events || []).filter((e) => e.segs))
    .map((e) => ({ start: e.tStartMs || 0, end: (e.tStartMs || 0) + (e.dDurationMs || 0), text: e.segs.map((s) => s.utf8 || '').join('').trim() }))
    .filter((c) => c.text);
}
