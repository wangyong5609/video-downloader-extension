// 下载页：真正干活的地方。
// 任务类型：
//   direct —— 一个完整的视频文件，直接下载保存
//   merge  —— 画面和声音分开的两个文件（B站），下载后用 ffmpeg 合成 mp4
//   hls    —— m3u8 播放列表，下载所有分片后拼接并转成 mp4

const $ = (id) => document.getElementById(id);
// 这个文件也被批量下载页（batch.html）引用，只有在单个任务页里才自动开始执行
const IS_JOB_PAGE = location.pathname.endsWith('/job.html');
const ui = {
  title: (t) => {
    $('title').textContent = t;
    if (IS_JOB_PAGE) document.title = t;
  },
  status: (t, cls) => {
    $('status').textContent = t;
    $('status').className = cls || '';
  },
  progress: (ratio, detail) => {
    if (ratio != null) $('bar').style.width = `${Math.max(0, Math.min(1, ratio)) * 100}%`;
    if (detail != null) $('detail').textContent = detail;
  },
  log: (t) => {
    const el = $('log');
    el.hidden = false;
    el.textContent += t + '\n';
    el.scrollTop = el.scrollHeight;
  },
};

const mb = (n) => (n / 1048576).toFixed(1) + ' MB';
const send = (msg) => chrome.runtime.sendMessage(msg);

// ---------- 带进度的下载 ----------
// 下载是先放进内存再保存的，单个文件超过这个大小就不下了，免得把浏览器撑爆
const MAX_BYTES = 1.8 * 1073741824;

async function fetchBytes(urls, onProgress) {
  let lastErr;
  let tooBig = null;
  for (const url of [].concat(urls)) {
    try {
      const res = await fetch(url, { credentials: 'include' });
      if (!res.ok) throw new Error(`服务器返回 ${res.status}`);
      const total = Number(res.headers.get('content-length')) || 0;
      if (total > MAX_BYTES) {
        tooBig = new Error(`文件太大（${(total / 1073741824).toFixed(1)} GB），超出了浏览器内存能处理的范围。请换一个低一点的清晰度。`);
        break;
      }
      const reader = res.body.getReader();
      const chunks = [];
      let got = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        got += value.length;
        if (onProgress) onProgress(got, total);
      }
      const out = new Uint8Array(got);
      let off = 0;
      for (const c of chunks) {
        out.set(c, off);
        off += c.length;
      }
      return out;
    } catch (e) {
      lastErr = e;
    }
  }
  throw tooBig || lastErr || new Error('下载失败');
}

async function withRetry(fn, times = 3) {
  let err;
  for (let i = 0; i < times; i++) {
    try {
      return await fn();
    } catch (e) {
      err = e;
      await new Promise((r) => setTimeout(r, 500 * (i + 1)));
    }
  }
  throw err;
}

// ---------- 保存到“下载”文件夹 ----------
async function saveBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  if (!chrome.downloads) {
    // 在后台隐藏页面里：把文件地址交给后台，由它存进“下载”文件夹
    const r = await chrome.runtime.sendMessage({ type: 'saveBlobUrl', url, filename });
    URL.revokeObjectURL(url);
    if (!r || r.error) throw new Error('保存失败：' + ((r && r.error) || '没有回应'));
    return;
  }
  const id = await chrome.downloads.download({ url, filename, saveAs: false });
  await new Promise((resolve, reject) => {
    const onChanged = (d) => {
      if (d.id !== id || !d.state) return;
      if (d.state.current === 'complete') {
        chrome.downloads.onChanged.removeListener(onChanged);
        resolve();
      } else if (d.state.current === 'interrupted') {
        chrome.downloads.onChanged.removeListener(onChanged);
        reject(new Error('保存被中断：' + ((d.error && d.error.current) || '')));
      }
    };
    chrome.downloads.onChanged.addListener(onChanged);
    // 小文件可能在监听前就完成了，补查一次
    chrome.downloads.search({ id }).then(([d]) => {
      if (d && d.state === 'complete') {
        chrome.downloads.onChanged.removeListener(onChanged);
        resolve();
      }
    });
  });
  URL.revokeObjectURL(url);
}

// ---------- ffmpeg（网页版）----------
let ffmpegLog = [];
async function loadFFmpeg() {
  ui.status('正在加载合并组件…');
  const ff = new FFmpegWASM.FFmpeg();
  ff.on('log', ({ message }) => {
    ffmpegLog.push(message);
    if (ffmpegLog.length > 200) ffmpegLog.shift();
  });
  await ff.load({
    coreURL: chrome.runtime.getURL('lib/ffmpeg/ffmpeg-core.js'),
    wasmURL: chrome.runtime.getURL('lib/ffmpeg/ffmpeg-core.wasm'),
  });
  return ff;
}

// inputs: [{name, data}]，输出 mp4 的 Uint8Array；失败返回 null
async function remuxToMp4(inputs) {
  const ff = await loadFFmpeg();
  ui.status('正在合并成 mp4…');
  const args = [];
  for (const f of inputs) {
    await ff.writeFile(f.name, f.data);
    args.push('-i', f.name);
  }
  if (inputs.length > 1) args.push('-map', '0:v:0', '-map', '1:a:0');
  args.push('-c', 'copy', 'out.mp4');
  const code = await ff.exec(args);
  if (code !== 0) {
    ff.terminate();
    return null;
  }
  const out = await ff.readFile('out.mp4');
  ff.terminate();
  return out;
}

// ---------- 任务：直接下载 ----------
function extOf(url, fallback) {
  try {
    const m = new URL(url).pathname.match(/\.(mp4|webm|mov|m4v|flv|mkv|mp3|m4a|aac|ogg|opus|wav|flac)$/i);
    if (m) return '.' + m[1].toLowerCase();
  } catch {}
  return fallback;
}

async function runDirect(job) {
  ui.status('正在下载…');
  const data = await fetchBytes(job.urls, (got, total) =>
    ui.progress(total ? got / total : null, total ? `${mb(got)} / ${mb(total)}` : mb(got))
  );
  const ext = job.ext || extOf(job.urls[0], '.mp4');
  ui.status('正在保存…');
  // 必须写明文件类型，否则 Chrome 会自己猜，可能把扩展名改成 .txt
  const MIME = { '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm', '.flv': 'video/x-flv', '.mkv': 'video/x-matroska', '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.ogg': 'audio/ogg', '.opus': 'audio/ogg', '.wav': 'audio/wav', '.flac': 'audio/flac' };
  await saveBlob(new Blob([data], { type: MIME[ext] || 'application/octet-stream' }), job.filename + ext);
  return job.filename + ext;
}

// ---------- 任务：音画合并（B站）----------
async function runMerge(job) {
  let vGot = 0,
    vTotal = 0,
    aGot = 0,
    aTotal = 0;
  const show = () => {
    const got = vGot + aGot;
    const total = vTotal + aTotal;
    ui.progress(total ? got / total : null, total ? `${mb(got)} / ${mb(total)}` : mb(got));
  };
  ui.status('正在下载画面和声音…');
  const [video, audio] = await Promise.all([
    fetchBytes(job.videoUrls, (g, t) => {
      vGot = g;
      vTotal = t;
      show();
    }),
    fetchBytes(job.audioUrls, (g, t) => {
      aGot = g;
      aTotal = t;
      show();
    }),
  ]);
  const out = await remuxToMp4([
    { name: 'video.m4s', data: video },
    { name: 'audio.m4s', data: audio },
  ]);
  if (!out) throw new Error('合并失败');
  ui.status('正在保存…');
  await saveBlob(new Blob([out], { type: 'video/mp4' }), job.filename + '.mp4');
  return job.filename + '.mp4';
}

// ---------- 任务：m3u8 ----------
function parseAttrs(s) {
  const out = {};
  const re = /([A-Z0-9-]+)=("[^"]*"|[^,]*)/g;
  let m;
  while ((m = re.exec(s))) out[m[1]] = m[2].replace(/^"|"$/g, '');
  return out;
}

async function fetchText(url) {
  const res = await fetch(url, { credentials: 'include' });
  if (!res.ok) throw new Error(`播放列表获取失败（${res.status}）`);
  return await res.text();
}

function parseMaster(text, baseUrl) {
  const lines = text.split(/\r?\n/).map((l) => l.trim());
  const variants = [];
  const audios = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (l.startsWith('#EXT-X-STREAM-INF:')) {
      const a = parseAttrs(l.slice(18));
      let j = i + 1;
      while (j < lines.length && (!lines[j] || lines[j].startsWith('#'))) j++;
      if (lines[j]) {
        variants.push({
          url: new URL(lines[j], baseUrl).href,
          bandwidth: Number(a.BANDWIDTH) || 0,
          resolution: a.RESOLUTION || '',
          audioGroup: a.AUDIO || '',
        });
      }
    } else if (l.startsWith('#EXT-X-MEDIA:')) {
      const a = parseAttrs(l.slice(13));
      if (a.TYPE === 'AUDIO' && a.URI) {
        audios.push({ group: a['GROUP-ID'], url: new URL(a.URI, baseUrl).href, isDefault: a.DEFAULT === 'YES' });
      }
    }
  }
  return { variants, audios };
}

function parseMedia(text, baseUrl) {
  const lines = text.split(/\r?\n/).map((l) => l.trim());
  const segments = [];
  let key = null;
  let map = null;
  let seq = 0;
  let ended = false;
  for (const l of lines) {
    if (!l) continue;
    if (l.startsWith('#EXT-X-MEDIA-SEQUENCE:')) seq = Number(l.split(':')[1]) || 0;
    else if (l.startsWith('#EXT-X-KEY:')) {
      const a = parseAttrs(l.slice(11));
      if (a.METHOD === 'NONE') key = null;
      else key = { method: a.METHOD, uri: a.URI ? new URL(a.URI, baseUrl).href : '', iv: a.IV || '' };
    } else if (l.startsWith('#EXT-X-MAP:')) {
      const a = parseAttrs(l.slice(11));
      if (a.BYTERANGE) throw new Error('暂不支持这种分片格式（BYTERANGE）');
      if (a.URI) map = new URL(a.URI, baseUrl).href;
    } else if (l.startsWith('#EXT-X-BYTERANGE')) {
      throw new Error('暂不支持这种分片格式（BYTERANGE）');
    } else if (l.startsWith('#EXT-X-ENDLIST')) ended = true;
    else if (!l.startsWith('#')) {
      segments.push({ url: new URL(l, baseUrl).href, key, seq });
      seq++;
    }
  }
  return { segments, map, ended };
}

const keyCache = new Map();
async function decryptSegment(data, seg) {
  const k = seg.key;
  if (!k) return data;
  if (k.method !== 'AES-128') throw new Error(`这个视频有加密保护（${k.method}），无法下载`);
  if (!keyCache.has(k.uri)) {
    keyCache.set(
      k.uri,
      fetchBytes(k.uri).then((raw) => crypto.subtle.importKey('raw', raw, 'AES-CBC', false, ['decrypt']))
    );
  }
  const cryptoKey = await keyCache.get(k.uri);
  const iv = new Uint8Array(16);
  if (k.iv) {
    const hex = k.iv.replace(/^0x/i, '').padStart(32, '0');
    for (let i = 0; i < 16; i++) iv[i] = parseInt(hex.substr(i * 2, 2), 16);
  } else {
    new DataView(iv.buffer).setUint32(12, seg.seq);
  }
  return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-CBC', iv }, cryptoKey, data));
}

async function downloadPlaylist(url, label, onProgress) {
  const pl = parseMedia(await fetchText(url), url);
  if (!pl.segments.length) throw new Error('播放列表里没有找到视频分片');
  if (!pl.ended) throw new Error('这是直播流（没有结束标记），暂不支持下载');
  const parts = new Array(pl.segments.length);
  let done = 0;
  let bytes = 0;
  let next = 0;
  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= pl.segments.length) return;
      const seg = pl.segments[i];
      parts[i] = await withRetry(async () => decryptSegment(await fetchBytes(seg.url), seg));
      done++;
      bytes += parts[i].length;
      onProgress(done, pl.segments.length, bytes, label);
    }
  };
  await Promise.all(Array.from({ length: 6 }, worker));
  const init = pl.map ? await withRetry(() => fetchBytes(pl.map)) : null;
  const total = (init ? init.length : 0) + parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  if (init) {
    out.set(init, 0);
    off = init.length;
  }
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return { data: out, fmp4: !!pl.map };
}

async function runHls(job) {
  ui.status('正在读取播放列表…');
  let url = job.urls[0];
  let audioUrl = '';
  const text = await fetchText(url);
  if (text.includes('#EXT-X-STREAM-INF')) {
    const { variants, audios } = parseMaster(text, url);
    if (!variants.length) throw new Error('播放列表里没有找到可用的清晰度');
    variants.sort((a, b) => b.bandwidth - a.bandwidth);
    const best = variants[0];
    ui.log(`选择最高清晰度：${best.resolution || ''} ${Math.round(best.bandwidth / 1000)}kbps`);
    url = best.url;
    const group = audios.filter((a) => a.group === best.audioGroup);
    const au = group.find((a) => a.isDefault) || group[0];
    if (au) audioUrl = au.url;
  }
  ui.status('正在下载分片…');
  const onProgress = (done, total, bytes, label) =>
    ui.progress(done / total, `${label} ${done} / ${total} 个分片，已下载 ${mb(bytes)}`);
  const video = await downloadPlaylist(url, '画面', onProgress);
  const audio = audioUrl ? await downloadPlaylist(audioUrl, '声音', onProgress) : null;

  const inputs = [{ name: video.fmp4 ? 'video.mp4' : 'video.ts', data: video.data.slice() }];
  if (audio) inputs.push({ name: audio.fmp4 ? 'audio.mp4' : 'audio.ts', data: audio.data.slice() });
  let out = null;
  try {
    out = await remuxToMp4(inputs);
  } catch (e) {
    ui.log('转 mp4 出错：' + e.message);
  }
  ui.status('正在保存…');
  if (out) {
    await saveBlob(new Blob([out], { type: 'video/mp4' }), job.filename + '.mp4');
    return job.filename + '.mp4';
  }
  // 转换失败就保存原始拼接文件，大多数播放器也能直接播
  const ext = video.fmp4 ? '.mp4' : '.ts';
  ui.log('转 mp4 失败，已保存原始格式');
  await saveBlob(new Blob([video.data], { type: video.fmp4 ? 'video/mp4' : 'video/mp2t' }), job.filename + ext);
  return job.filename + ext;
}

// ---------- 任务：一组图片（小红书图文）----------
function imageExt(d) {
  if (d[0] === 0xff && d[1] === 0xd8) return '.jpg';
  if (d[0] === 0x89 && d[1] === 0x50) return '.png';
  if (d[0] === 0x47 && d[1] === 0x49) return '.gif';
  if (d[8] === 0x57 && d[9] === 0x45 && d[10] === 0x42 && d[11] === 0x50) return '.webp';
  const brand = String.fromCharCode(d[8], d[9], d[10], d[11]);
  if (/avif|avis/.test(brand)) return '.avif';
  if (/heic|heix|mif1/.test(brand)) return '.heic';
  return '.jpg';
}
const IMAGE_MIME = { '.jpg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif', '.webp': 'image/webp', '.avif': 'image/avif', '.heic': 'image/heic' };

async function toJpeg(data, ext) {
  const bmp = await createImageBitmap(new Blob([data], { type: IMAGE_MIME[ext] }));
  const canvas = new OffscreenCanvas(bmp.width, bmp.height);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff'; // 透明底的图转 JPG 时垫白色
  ctx.fillRect(0, 0, bmp.width, bmp.height);
  ctx.drawImage(bmp, 0, 0);
  return await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.95 });
}

async function runImages(job) {
  const total = job.items.length;
  let n = 0;
  let saved = 0;
  for (const it of job.items) {
    ui.status(`正在下载第 ${saved + 1} / ${total} 个文件…`);
    const data = await withRetry(() => fetchBytes(it.url));
    if (!it.video) n++;
    const base = `${job.filename}/${String(n).padStart(2, '0')}`;
    if (it.video) {
      await saveBlob(new Blob([data], { type: 'video/mp4' }), `${base}_实况.mp4`);
    } else {
      let ext = imageExt(data);
      let blob = new Blob([data], { type: IMAGE_MIME[ext] });
      if (job.toJpg && ext !== '.jpg' && ext !== '.gif') {
        try {
          blob = await toJpeg(data, ext);
          ext = '.jpg';
        } catch (e) {
          ui.log(`第 ${n} 张转 JPG 失败，按原格式保存`);
        }
      }
      await saveBlob(blob, base + ext);
    }
    saved++;
    ui.progress(saved / total, `${saved} / ${total}`);
  }
  return `“${job.filename}”文件夹（${saved} 个文件）`;
}

// ---------- 入口 ----------
(async () => {
  if (!IS_JOB_PAGE) return;
  const id = new URLSearchParams(location.search).get('id');
  let job;
  try {
    job = await send({ type: 'getJob', id });
    if (!job || job.error) throw new Error('任务不存在或已过期');
    ui.title(job.filename);
    let saved;
    if (job.kind === 'merge') saved = await runMerge(job);
    else if (job.kind === 'hls') saved = await runHls(job);
    else if (job.kind === 'images') saved = await runImages(job);
    else saved = await runDirect(job);
    ui.progress(1);
    ui.status(`已保存到“下载”文件夹：${saved}`, 'ok');
    document.title = '✅ ' + job.filename;
    setTimeout(() => send({ type: 'closeMe' }), 4000);
  } catch (e) {
    ui.status('下载失败：' + ((e && e.message) || e), 'err');
    document.title = '❌ 下载失败';
    if (ffmpegLog.length) ui.log(ffmpegLog.slice(-15).join('\n'));
    send({ type: 'focusMe' });
  }
})();
