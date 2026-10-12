// AtCoder用ローカルジャッジ(Java版) バックエンド
// Windowsでそのまま動かす(WSLは使わない)。依存パッケージなし。Node.js 18以上で動作。
//   起動: node backend/server.js  →  http://localhost:2436
'use strict';

const http = require('http');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');

const HOST = '127.0.0.1'; // ループバックのみで待ち受け(外部公開しない)
const PORT = Number(process.env.PORT) || 2436; // JS版(2434)・C/C++版(2435)と同時に起動できるよう別ポート
const FRONTEND_DIR = path.join(__dirname, '..', 'frontend');

const LIMITS = {
  bodyBytes: 20 * 1024 * 1024, // リクエスト全体
  codeBytes: 512 * 1024,       // ソースコード(AtCoderと同じ512KiB)
  cases: 100,
  timeMsMin: 100,
  timeMsMax: 20000,
  compileMs: 30000,            // コンパイルの制限時間
  stdoutBytes: 32 * 1024 * 1024,
  stderrBytes: 64 * 1024,
  compileMsgBytes: 256 * 1024,
};

/* ---------- JDKの設定 ---------- */

// JAVA_HOME があればその中の javac / java を使い、なければ PATH から探す
const EXE = process.platform === 'win32' ? '.exe' : '';
const JAVA_HOME = process.env.JAVA_HOME;
const JAVAC = JAVA_HOME ? path.join(JAVA_HOME, 'bin', 'javac' + EXE) : 'javac';
const JAVA = JAVA_HOME ? path.join(JAVA_HOME, 'bin', 'java' + EXE) : 'java';

// 日本語版Windowsでは、パイプにつないだときの標準出力がShift_JIS(MS932)になって
// 日本語が文字化けするので、入出力をすべてUTF-8にそろえる
const UTF8_PROPS = ['-Dfile.encoding=UTF-8', '-Dstdout.encoding=UTF-8', '-Dstderr.encoding=UTF-8'];

const JAVAC_ARGS = ['-encoding', 'UTF-8', ...UTF8_PROPS.map((p) => '-J' + p)];
// スタックを広げて深い再帰でもStackOverflowErrorにならないようにする(AtCoderも大きめに設定している)
const JAVA_ARGS = ['-Xss512m', '-Xmx1024m', '-XX:+UseSerialGC', ...UTF8_PROPS];

// 子プロセスに渡す環境変数。Windowsでは SystemRoot などがないとJavaが起動できないことがある
function childEnv() {
  const keep = ['PATH', 'SystemRoot', 'SYSTEMROOT', 'TEMP', 'TMP', 'JAVA_HOME', 'LANG', 'HOME', 'USERPROFILE'];
  const env = {};
  for (const k of keep) if (process.env[k] !== undefined) env[k] = process.env[k];
  return env;
}

// 「openjdk version "21.0.2" 2024-01-16」の1行目からバージョンを取り出す
function detectVersion(cmd) {
  try {
    const r = spawnSync(cmd, ['-version'], { encoding: 'utf8', env: childEnv() });
    if (r.error) return null;
    const out = `${r.stderr}\n${r.stdout}`;
    const line = out.split(/\r?\n/).find((l) => /version|javac \d/.test(l));
    if (!line) return 'unknown';
    const m = line.match(/"([^"]+)"/) ?? line.match(/javac\s+(\S+)/);
    const vendor = /openjdk/i.test(line) ? 'OpenJDK' : 'Java';
    return m ? `${vendor} ${m[1]}` : line.trim();
  } catch {
    return null;
  }
}

const JAVA_VERSION = detectVersion(JAVA);
const JAVAC_FOUND = detectVersion(JAVAC) !== null;

function runtimeLabel() {
  return JAVA_VERSION ?? 'Java';
}

/* ---------- 判定 ---------- */

// 行末の空白と末尾の空行を無視して比較(AtCoderの判定に近い挙動)
function normalize(s) {
  const lines = s.replace(/\r\n?/g, '\n').split('\n').map((l) => l.trimEnd());
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines.join('\n');
}

/* ---------- コンパイル ---------- */

function compile(dir, ctl) {
  return new Promise((resolve) => {
    const start = process.hrtime.bigint();
    const child = spawn(JAVAC, [...JAVAC_ARGS, '-d', '.', 'Main.java'], {
      cwd: dir,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: childEnv(),
    });
    ctl.kill = () => child.kill('SIGKILL');

    let message = '';
    let truncated = false;
    let timedOut = false;
    const collect = (chunk) => {
      if (message.length < LIMITS.compileMsgBytes) message += chunk.toString('utf8');
      else truncated = true;
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, LIMITS.compileMs);

    let settled = false;
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        ok: false,
        message: `javac を起動できませんでした: ${err.message}\nJDKの bin フォルダが PATH に入っているか(または JAVA_HOME が設定されているか)確認してください。`,
        timeMs: 0,
      });
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const timeMs = Math.round(Number(process.hrtime.bigint() - start) / 1e6);
      if (truncated) message = message.slice(0, LIMITS.compileMsgBytes) + '\n…(長すぎるので以降は省略)';
      if (timedOut) message += `\nコンパイルが${LIMITS.compileMs / 1000}秒以内に終わりませんでした。`;
      // 実行に必要な Main.class ができたか
      const ok = code === 0 && !timedOut && fs.existsSync(path.join(dir, 'Main.class'));
      if (code === 0 && !ok && !timedOut) {
        message += '\nMain.class ができませんでした。クラス名は Main にしてください(AtCoderと同じ)。';
      }
      resolve({ ok, message, timeMs });
    });
  });
}

// 直前にコンパイルしたクラスファイル。同じコードならコンパイルを省略する
let cache = null; // { key, dir, message }

async function getBinary(code, ctl) {
  const key = crypto.createHash('sha256').update(code).digest('hex');
  if (cache?.key === key) {
    return { ok: true, message: cache.message, timeMs: 0, cached: true, dir: cache.dir };
  }

  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'atcoder-judge-java-'));
  await fsp.writeFile(path.join(dir, 'Main.java'), code, 'utf8');
  const r = await compile(dir, ctl);
  if (!r.ok || ctl.aborted) {
    await fsp.rm(dir, { recursive: true, force: true });
    return { ...r, ok: r.ok && !ctl.aborted, cached: false };
  }

  const old = cache;
  cache = { key, dir, message: r.message };
  if (old) await fsp.rm(old.dir, { recursive: true, force: true });
  return { ...r, cached: false, dir };
}

/* ---------- 1ケース実行 ---------- */

function runOne(dir, input, timeLimitMs, ctl) {
  return new Promise((resolve) => {
    const start = process.hrtime.bigint();
    const child = spawn(JAVA, [...JAVA_ARGS, '-cp', '.', 'Main'], {
      cwd: dir,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: childEnv(), // 親の環境変数は最低限しか渡さない
    });
    // ブラウザ側が途中で切断したとき、実行中のプロセスを止められるようにする
    ctl.kill = () => child.kill('SIGKILL');

    let stdout = '';
    let stderr = '';
    let stdoutBytes = 0;
    let outputLimitExceeded = false;
    let killedByTimer = false;

    // TLEでもどれくらい遅いか分かるよう、制限の2倍(最大+5秒)まで待ってから強制終了
    const hardKillMs = Math.min(timeLimitMs * 2, timeLimitMs + 5000);
    const timer = setTimeout(() => {
      killedByTimer = true;
      child.kill('SIGKILL');
    }, hardKillMs);

    child.stdout.on('data', (chunk) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > LIMITS.stdoutBytes) {
        outputLimitExceeded = true;
        child.kill('SIGKILL');
        return;
      }
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk) => {
      if (stderr.length < LIMITS.stderrBytes) stderr += chunk.toString('utf8');
    });

    // 入力を読まずに終了するコードだとEPIPEになるので握りつぶす
    child.stdin.on('error', () => {});
    child.stdin.end(input);

    let settled = false;
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ error: `プロセスを起動できませんでした: ${err.message}` });
    });

    child.on('close', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const timeMs = Number(process.hrtime.bigint() - start) / 1e6;
      resolve({
        stdout,
        stderr: stderr.slice(0, LIMITS.stderrBytes),
        exitCode: code,
        signal,
        timeMs: Math.round(timeMs),
        killedByTimer,
        outputLimitExceeded,
      });
    });
  });
}

/* ---------- 全ケース実行 ---------- */

function decide(r, tc, timeLimitMs) {
  if (r.error) return 'IE';
  if (r.outputLimitExceeded) return 'OLE';
  if (r.killedByTimer || r.timeMs > timeLimitMs) return 'TLE';
  if (r.exitCode !== 0 || r.signal) return 'RE';
  if (tc.expected.trim() === '') return 'DONE'; // 期待出力なし=実行のみ
  return normalize(r.stdout) === normalize(tc.expected) ? 'AC' : 'WA';
}

function summarize(results) {
  const judged = results.filter((r) => r.status !== 'DONE');
  const priority = ['IE', 'RE', 'OLE', 'TLE', 'WA'];
  const overall =
    judged.length === 0
      ? 'DONE'
      : priority.find((p) => judged.some((r) => r.status === p)) ?? 'AC';
  return {
    overall,
    maxTimeMs: Math.max(0, ...results.map((r) => r.timeMs ?? 0)),
    runtime: runtimeLabel(),
  };
}

// 送る行の種類:
//   { type: 'compile', ok, message, timeMs, cached }  … 最初に1回
//   { type: 'summary', summary }                      … コンパイルエラーのときだけ
//   { type: 'case', index, result, summary? }         … 1ケースごと。最後のケースに総合判定が付く
async function judge({ code, testCases, timeLimitMs }, send, ctl) {
  const bin = await getBinary(code, ctl);
  if (ctl.aborted) return;
  send({ type: 'compile', ok: bin.ok, message: bin.message, timeMs: bin.timeMs, cached: bin.cached });
  if (!bin.ok) {
    send({ type: 'summary', summary: { overall: 'CE', maxTimeMs: 0, runtime: runtimeLabel() } });
    return;
  }

  // 実行時間を正確に測るため、並列ではなく1ケースずつ順番に実行
  const results = [];
  for (let i = 0; i < testCases.length; i++) {
    if (ctl.aborted) return;
    const tc = testCases[i];
    const r = await runOne(bin.dir, tc.input, timeLimitMs, ctl);
    if (ctl.aborted) return;

    const result = {
      status: decide(r, tc, timeLimitMs),
      timeMs: r.timeMs ?? null,
      stdout: r.stdout ?? '',
      stderr: r.error ?? r.stderr ?? '',
      exitCode: r.exitCode ?? null,
      signal: r.signal ?? null,
    };
    results.push(result);

    const line = { type: 'case', index: i, result };
    if (i === testCases.length - 1) line.summary = summarize(results);
    send(line);
  }
}

/* ---------- 入力検証 ---------- */

function validate(body) {
  if (typeof body !== 'object' || body === null) return 'JSONの形式が不正です';
  const { code, testCases, timeLimitMs } = body;
  if (typeof code !== 'string' || code.trim() === '') return 'コードが空です';
  if (Buffer.byteLength(code) > LIMITS.codeBytes) return 'コードが512KiBを超えています';
  if (!Array.isArray(testCases) || testCases.length === 0) return 'テストケースが1つもありません';
  if (testCases.length > LIMITS.cases) return `テストケースは${LIMITS.cases}個までです`;
  for (const tc of testCases) {
    if (typeof tc?.input !== 'string' || typeof tc?.expected !== 'string') {
      return 'テストケースの形式が不正です';
    }
  }
  if (!Number.isFinite(timeLimitMs) || timeLimitMs < LIMITS.timeMsMin || timeLimitMs > LIMITS.timeMsMax) {
    return `実行時間制限は${LIMITS.timeMsMin}〜${LIMITS.timeMsMax}msで指定してください`;
  }
  return null;
}

/* ---------- HTTP ---------- */

// DNSリバインディング対策: Hostヘッダがlocalhost系以外なら拒否
function isLocalHost(hostHeader) {
  if (!hostHeader) return false;
  const host = hostHeader.replace(/:\d+$/, '');
  return host === 'localhost' || host === '127.0.0.1' || host === '[::1]';
}

// 他サイトのページからコード実行APIを叩かれないようOriginを確認
function isAllowedOrigin(origin) {
  if (!origin) return true; // curl等
  try {
    const u = new URL(origin);
    return u.hostname === 'localhost' || u.hostname === '127.0.0.1';
  } catch {
    return false;
  }
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
};

function serveStatic(req, res) {
  let urlPath;
  try {
    urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  } catch {
    res.writeHead(400).end();
    return;
  }
  const rel = urlPath === '/' ? 'index.html' : urlPath.slice(1);
  const filePath = path.join(FRONTEND_DIR, rel);
  // ディレクトリトラバーサル防止
  if (!filePath.startsWith(FRONTEND_DIR + path.sep)) {
    res.writeHead(403).end();
    return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] ?? 'application/octet-stream' });
    res.end(data);
  });
}

let busy = false; // 同時実行はしない(計測がぶれるため)

const server = http.createServer((req, res) => {
  if (!isLocalHost(req.headers.host)) {
    res.writeHead(403).end('Forbidden');
    return;
  }

  if (req.method === 'GET' && req.url === '/api/info') {
    sendJson(res, 200, { java: JAVA_VERSION, javac: JAVAC_FOUND });
    return;
  }

  if (req.method === 'POST' && req.url === '/api/run') {
    if (!isAllowedOrigin(req.headers.origin)) {
      sendJson(res, 403, { error: '許可されていないOriginです' });
      return;
    }
    if (busy) {
      sendJson(res, 409, { error: '別の実行が進行中です。終わってから再実行してください' });
      return;
    }

    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > LIMITS.bodyBytes) {
        sendJson(res, 413, { error: 'リクエストが大きすぎます' });
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', async () => {
      if (res.writableEnded) return;
      let body;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        sendJson(res, 400, { error: 'JSONを解析できませんでした' });
        return;
      }
      const problem = validate(body);
      if (problem) {
        sendJson(res, 400, { error: problem });
        return;
      }

      // ここから先は NDJSON(1行に1つのJSON)で、段階が進むたびに1行ずつ送る
      res.writeHead(200, {
        'Content-Type': 'application/x-ndjson; charset=utf-8',
        'Cache-Control': 'no-cache',
        'X-Content-Type-Options': 'nosniff',
      });
      res.flushHeaders();
      const sendLine = (obj) => {
        if (!res.writableEnded) res.write(JSON.stringify(obj) + '\n');
      };

      // ブラウザを閉じた・再読み込みしたなどで接続が切れたら、残りは実行しない
      const ctl = { aborted: false, kill: null };
      res.on('close', () => {
        if (!res.writableFinished) {
          ctl.aborted = true;
          ctl.kill?.();
        }
      });

      busy = true;
      try {
        await judge(body, sendLine, ctl);
      } catch (e) {
        sendLine({ type: 'error', error: `内部エラー: ${e.message}` });
      } finally {
        busy = false;
        res.end();
      }
    });
    return;
  }

  if (req.method === 'GET') {
    serveStatic(req, res);
    return;
  }

  res.writeHead(405).end();
});

// 前回の起動で残った作業フォルダを片付ける
for (const name of fs.readdirSync(os.tmpdir())) {
  if (name.startsWith('atcoder-judge-java-')) {
    try { fs.rmSync(path.join(os.tmpdir(), name), { recursive: true, force: true }); } catch { /* 無視 */ }
  }
}

// 終了時にコンパイル済みファイルを片付ける
function cleanup() {
  if (cache) {
    try { fs.rmSync(cache.dir, { recursive: true, force: true }); } catch { /* 無視 */ }
  }
}
process.on('SIGINT', () => { cleanup(); process.exit(0); });
process.on('SIGTERM', () => { cleanup(); process.exit(0); });

server.listen(PORT, HOST, () => {
  console.log(`ローカルジャッジ(Java)起動: http://localhost:${PORT}  (Node ${process.version})`);
  console.log(`  java : ${JAVA_VERSION ?? `${JAVA} が見つかりません`}`);
  console.log(`  javac: ${JAVAC_FOUND ? 'OK' : `${JAVAC} が見つかりません(JREではなくJDKが必要です)`}`);
  if (!JAVA_VERSION || !JAVAC_FOUND) {
    console.log('  → JDKの bin フォルダを PATH に追加するか、JAVA_HOME を設定してください');
  }
});
