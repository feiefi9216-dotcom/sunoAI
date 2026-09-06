import express from 'express';
import fetch from 'node-fetch';

const app = express();
const PORT = process.env.PORT || 3000;

// 1. 真实音频管道代理（支持 Range 进度条拖动与分段缓冲，杜绝 403 与 0:00 假死）
app.get('/api/audio-stream', async (req, res) => {
  const { url: audioUrl, name } = req.query;
  if (!audioUrl) return res.status(400).send('缺少音频链接');

  try {
    const upstreamHeaders = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      'Accept': '*/*'
    };
    if (req.headers.range) {
      upstreamHeaders['Range'] = req.headers.range;
    }

    let upstreamRes = await fetch(audioUrl, { headers: upstreamHeaders });

    // 若 cdn1 报错，自动降级至 cdn2
    if (!upstreamRes.ok && audioUrl.includes('cdn1.suno.ai')) {
      const fallbackUrl = audioUrl.replace('cdn1.suno.ai', 'cdn2.suno.ai');
      upstreamRes = await fetch(fallbackUrl, { headers: upstreamHeaders });
    }

    if (!upstreamRes.ok) {
      throw new Error(`上游响应失败: ${upstreamRes.status} (${audioUrl})`);
    }

    const safeName = (name || 'suno_track').replace(/[\r\n"\\\/]/g, '_');
    
    // 透传音频状态码与 Content-Range（支持播放器计算总时长与快进）
    res.status(upstreamRes.status);
    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Access-Control-Allow-Origin', '*');

    if (upstreamRes.headers.get('content-range')) {
      res.setHeader('Content-Range', upstreamRes.headers.get('content-range'));
    }
    if (upstreamRes.headers.get('content-length')) {
      res.setHeader('Content-Length', upstreamRes.headers.get('content-length'));
    }
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(safeName)}.mp3`);

    upstreamRes.body.pipe(res);
  } catch (err) {
    console.error('Audio stream error:', err.message);
    res.status(500).send('音频提取失败: ' + err.message);
  }
});

// 2. 歌曲元数据解析接口（支持短链重定向精准提取真实歌曲 ID）
app.get('/api/parse', async (req, res) => {
  const { url: inputUrl } = req.query;
  if (!inputUrl) return res.status(400).json({ error: '请提供 Suno 链接' });

  try {
    const target = inputUrl.trim();
    const pageRes = await fetch(target, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
      },
      redirect: 'follow'
    });

    const finalUrl = pageRes.url;
    const html = await pageRes.text();

    // 优先顺序提取真正的歌曲 ID，避免误抓作者 ID 或其他组件 ID
    let songId = null;

    // 规则 1：从最终重定向后的 URL 提取（例如 /song/xxxx）
    const finalUrlMatch = finalUrl.match(/\/song\/([0-9a-fA-F-]{36})/);
    if (finalUrlMatch) songId = finalUrlMatch[1];

    // 规则 2：从页面的 canonical 或 og:url 提取
    if (!songId) {
      const ogUrlMatch = html.match(/<meta[^>]+property=["']og:url["'][^>]+content=["']([^"']+)["']/i)
                      || html.match(/<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)["']/i);
      if (ogUrlMatch) {
        const idMatch = ogUrlMatch[1].match(/([0-9a-fA-F-]{36})/);
        if (idMatch) songId = idMatch[1];
      }
    }

    // 规则 3：从页面内音频或视频 CDN 资源直链中提取
    if (!songId) {
      const cdnMatch = html.match(/cdn[12]\.suno\.ai\/([0-9a-fA-F-]{36})\.(mp3|mp4)/i);
      if (cdnMatch) songId = cdnMatch[1];
    }

    // 规则 4：兜底输入链接自身
    if (!songId) {
      const directMatch = target.match(/([0-9a-fA-F-]{36})/);
      if (directMatch) songId = directMatch[1];
    }

    if (!songId) {
      throw new Error('无法从当前链接提取到有效的歌曲 ID，请确认链接是否公开。');
    }

    // 提取歌名
    const titleMatch = html.match(/<meta property="og:title" content="(.*?)"/i) 
                    || html.match(/<title>(.*?)<\/title>/i);
    let title = titleMatch ? titleMatch[1].replace(' | Suno', '').trim() : 'Suno 音乐';

    // 提取封面
    const imgMatch = html.match(/<meta property="og:image" content="(.*?)"/i);
    const cover = imgMatch ? imgMatch[1] : `https://cdn2.suno.ai/image_large_${songId}.jpeg`;

    const cdnAudioUrl = `https://cdn1.suno.ai/${songId}.mp3`;
    const streamProxyUrl = `/api/audio-stream?url=${encodeURIComponent(cdnAudioUrl)}&name=${encodeURIComponent(title)}`;

    res.json({
      id: songId,
      title,
      cover,
      audio_url: cdnAudioUrl,
      stream_url: streamProxyUrl
    });
  } catch (e) {
    console.error('Parse error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// 3. 前端单页应用
app.get('*', (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Suno 专属歌曲下载器</title>
  <style>
    * { box-sizing: border-box; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
    body { background: #f8fafc; display: flex; justify-content: center; padding: 40px 16px; margin: 0; min-height: 100vh; }
    .card { background: #fff; width: 100%; max-width: 660px; border-radius: 16px; padding: 36px 30px; box-shadow: 0 4px 25px rgba(0,0,0,0.05); border: 1px solid #edf2f7; }
    h1 { margin: 0 0 6px; font-size: 26px; color: #0f172a; text-align: center; }
    p.sub { color: #64748b; font-size: 13px; margin: 0 0 24px; text-align: center; }
    .input-box { display: flex; gap: 10px; margin-bottom: 12px; }
    input { flex: 1; padding: 12px 16px; border: 1px solid #cbd5e1; border-radius: 10px; font-size: 14px; outline: none; }
    input:focus { border-color: #6366f1; }
    button.btn-parse { background: #4f46e5; color: #fff; border: none; padding: 12px 24px; border-radius: 10px; font-weight: 600; cursor: pointer; white-space: nowrap; font-size: 14px; }
    button.btn-parse:hover { background: #4338ca; }
    #msg { font-size: 13px; margin-bottom: 16px; min-height: 20px; text-align: center; }
    .res-box { display: none; background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 14px; padding: 20px; margin-bottom: 24px; }
    .info { display: flex; gap: 16px; align-items: center; margin-bottom: 16px; }
    img#cover { width: 84px; height: 84px; border-radius: 10px; object-fit: cover; background: #e2e8f0; flex-shrink: 0; }
    .info-text { flex: 1; min-width: 0; }
    .title-row { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
    .title { font-weight: 700; font-size: 16px; color: #0f172a; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .badge { font-size: 11px; background: #dcfce7; color: #15803d; padding: 2px 8px; border-radius: 20px; font-weight: 500; }
    audio { width: 100%; height: 36px; }
    .btn-group { display: flex; gap: 10px; border-top: 1px solid #e2e8f0; padding-top: 16px; }
    .btn-dl { flex: 1; text-align: center; padding: 12px 0; border-radius: 10px; font-weight: 600; font-size: 13px; text-decoration: none; cursor: pointer; border: none; transition: 0.2s; }
    .btn-mp3 { background: #6366f1; color: white; }
    .btn-mp3:hover { background: #4f46e5; }
    .btn-wav { background: #0f172a; color: white; }
    .btn-wav:hover { background: #1e293b; }
    .docs { margin-top: 30px; border-top: 1px dashed #cbd5e1; padding-top: 20px; }
    .docs h3 { font-size: 14px; color: #334155; margin: 0 0 10px; font-weight: 700; }
    .docs ul { margin: 0; padding-left: 20px; font-size: 12px; color: #64748b; line-height: 1.8; }
  </style>
</head>
<body>
  <div class="card">
    <h1>Suno 歌曲下载器</h1>
    <p class="sub">独立云节点直通，支持 MP3 原声保存与 WAV 纯本地无损转码</p>

    <div class="input-box">
      <input type="text" id="urlInput" placeholder="在此粘贴 Suno 歌曲链接（短链/长链均支持）...">
      <button class="btn-parse" id="parseBtn" onclick="runParse()">✦ 解析歌曲</button>
    </div>

    <div id="msg"></div>

    <div class="res-box" id="resBox">
      <div class="info">
        <img id="cover" src="" alt="封面">
        <div class="info-text">
          <div class="title-row">
            <div class="title" id="songTitle">未知歌曲</div>
            <span class="badge">解析成功</span>
          </div>
          <audio id="audioPlayer" controls preload="metadata"></audio>
        </div>
      </div>
      <div class="btn-group">
        <a id="btnMp3" class="btn-dl btn-mp3" href="#">⇩ 下载 MP3 音频</a>
        <button id="btnWav" class="btn-dl btn-wav" onclick="runWav()">⇩ 下载 WAV 音频</button>
      </div>
    </div>

    <div class="docs">
      <h3>📌 使用说明</h3>
      <ul>
        <li>支持短链（如 <code>suno.com/s/...</code>）与常规播放链接。</li>
        <li>音频数据由专属服务器流式代理，自动处理反盗链与分段缓冲。</li>
      </ul>
    </div>
  </div>

  <script>
    let activeStreamUrl = '';
    let currentFileName = 'suno_audio';

    async function runParse() {
      const input = document.getElementById('urlInput').value.trim();
      const msg = document.getElementById('msg');
      const resBox = document.getElementById('resBox');
      const parseBtn = document.getElementById('parseBtn');

      if (!input) {
        msg.style.color = '#ef4444';
        msg.innerText = '请先粘贴 Suno 歌曲链接！';
        return;
      }

      msg.style.color = '#6366f1';
      msg.innerText = '云端正全力调取原声流，请稍候...';
      resBox.style.display = 'none';
      parseBtn.disabled = true;

      try {
        const res = await fetch('/api/parse?url=' + encodeURIComponent(input));
        const data = await res.json();
        if (data.error) throw new Error(data.error);

        activeStreamUrl = data.stream_url;
        currentFileName = (data.title || 'suno_audio').replace(/[\\\\/:*?"<>|]/g, '_');

        document.getElementById('cover').src = data.cover;
        document.getElementById('songTitle').innerText = data.title;
        
        const player = document.getElementById('audioPlayer');
        // 播放器直接载入流地址
        player.src = activeStreamUrl;
        player.load();

        const btnMp3 = document.getElementById('btnMp3');
        btnMp3.href = activeStreamUrl;
        btnMp3.setAttribute('download', currentFileName + '.mp3');

        msg.style.color = '#10b981';
        msg.innerText = '✓ 解析成功！';
        resBox.style.display = 'block';
      } catch (err) {
        msg.style.color = '#ef4444';
        msg.innerText = '解析失败：' + err.message;
      } finally {
        parseBtn.disabled = false;
      }
    }

    async function runWav() {
      if (!activeStreamUrl) return;
      const btn = document.getElementById('btnWav');
      const oldText = btn.innerText;
      try {
        btn.disabled = true;
        btn.innerText = '本地转码中...';

        const r = await fetch(activeStreamUrl);
        const buf = await r.arrayBuffer();
        const ctx = new (window.AudioContext || window.webkitAudioContext)();
        const decoded = await ctx.decodeAudioData(buf);

        const wavBlob = bufferToWav(decoded);
        const url = URL.createObjectURL(wavBlob);
        const a = document.createElement('a');
        a.href = url;
        a.download = currentFileName + '.wav';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);

        btn.innerText = '✓ WAV 已下载';
        setTimeout(() => { btn.innerText = oldText; btn.disabled = false; }, 2000);
      } catch (e) {
        alert('WAV 转码失败：' + e.message);
        btn.innerText = oldText;
        btn.disabled = false;
      }
    }

    function bufferToWav(abuffer) {
      const numOfChan = abuffer.numberOfChannels;
      const length = abuffer.length * numOfChan * 2 + 44;
      const out = new DataView(new ArrayBuffer(length));
      let offset = 0, pos = 0;
      function setUint16(d) { out.setUint16(pos, d, true); pos += 2; }
      function setUint32(d) { out.setUint32(pos, d, true); pos += 4; }
      setUint32(0x46464952); setUint32(length - 8); setUint32(0x45564157); setUint32(0x20746d66);
      setUint32(16); setUint16(1); setUint16(numOfChan);
      setUint32(abuffer.sampleRate); setUint32(abuffer.sampleRate * 2 * numOfChan);
      setUint16(numOfChan * 2); setUint16(16); setUint32(0x61746164); setUint32(length - pos - 4);
      const channels = [];
      for (let i = 0; i < numOfChan; i++) channels.push(abuffer.getChannelData(i));
      while (pos < length) {
        for (let i = 0; i < numOfChan; i++) {
          let s = Math.max(-1, Math.min(1, channels[i][offset]));
          s = (0.5 + s < 0 ? s * 32768 : s * 32767) | 0;
          out.setInt16(pos, s, true);
          pos += 2;
        }
        offset++;
      }
      return new Blob([out], { type: 'audio/wav' });
    }
  </script>
</body>
</html>`);
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
