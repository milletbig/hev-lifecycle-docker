'use strict';

/**
 * 混动车全生命周期记录 —— 访问服务
 * 零第三方依赖（仅 Node.js 内置模块），职责：
 *   1. 登录鉴权：服务端会话 + HttpOnly/SameSite Cookie + scrypt 口令校验 + 登录失败锁定；
 *   2. 静态资源托管：未认证请求无法获取页面、脚本、样式与任何数据；
 *   3. 数据持久化：将浏览器 localStorage 中的业务数据镜像到 $DATA_DIR/state.json，
 *      自动滚动备份，容器重启/浏览器清缓存后数据仍可恢复；
 *   4. 安全响应头、CSRF 同源校验、请求限流与大响应体保护。
 */

const http = require('http');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');

// ============================ 配置 ============================
const PORT = parseInt(process.env.PORT || '8080', 10);
const PUBLIC_DIR = path.resolve(process.env.PUBLIC_DIR || '/app/public');
const DATA_DIR = path.resolve(process.env.DATA_DIR || '/data');
const STATE_FILE = path.join(DATA_DIR, 'state.json');
const BACKUP_DIR = path.join(DATA_DIR, 'backups');
const SECRET_FILE = path.join(DATA_DIR, 'session.secret');

const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const ADMIN_PASSWORD_HASH = process.env.ADMIN_PASSWORD_HASH || '';

const SESSION_HOURS = clampInt(process.env.SESSION_HOURS, 12, 1, 168);
// 免登录长效令牌有效期（天）：独立于短会话，避免受 SESSION_HOURS 上限约束
const REMEMBER_DAYS = clampInt(process.env.REMEMBER_DAYS, 30, 1, 90);
const COOKIE_SECURE = String(process.env.COOKIE_SECURE || 'false').toLowerCase() === 'true';
const TRUST_PROXY = String(process.env.TRUST_PROXY || 'false').toLowerCase() === 'true';
const MAX_LOGIN_FAILURES = clampInt(process.env.MAX_LOGIN_FAILURES, 5, 1, 100);
const LOGIN_LOCK_MINUTES = clampInt(process.env.LOGIN_LOCK_MINUTES, 10, 1, 1440);
const MAX_STATE_BYTES = clampInt(process.env.MAX_STATE_BYTES, 16 * 1024 * 1024, 1024, 64 * 1024 * 1024);
const BACKUP_KEEP = clampInt(process.env.BACKUP_KEEP, 30, 1, 500);
const BACKUP_SCHEDULE_FILE = path.join(DATA_DIR, 'backup-schedule.json');
const DEFAULT_BACKUP_INTERVAL_DAYS = 7;
const BACKUP_CHECK_INTERVAL_MS = 10 * 60 * 1000;

const COOKIE_NAME = 'hev_sid';
const SESSION_MAX_AGE = SESSION_HOURS * 3600;
const REMEMBER_MAX_AGE = REMEMBER_DAYS * 86400;

function clampInt(raw, fallback, min, max) {
    const n = parseInt(raw, 10);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, n));
}

// ============================ 口令散列 ============================
const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEYLEN = 64;

function scryptHash(password) {
    const salt = crypto.randomBytes(16);
    const hash = crypto.scryptSync(password, salt, SCRYPT_KEYLEN, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, maxmem: 128 * 1024 * 1024 });
    return ['scrypt', SCRYPT_N, SCRYPT_R, SCRYPT_P, salt.toString('base64url'), hash.toString('base64url')].join(':');
}

function scryptVerify(password, encoded) {
    try {
        const parts = String(encoded).split(':');
        if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
        const N = parseInt(parts[1], 10);
        const r = parseInt(parts[2], 10);
        const p = parseInt(parts[3], 10);
        const salt = Buffer.from(parts[4], 'base64url');
        const expected = Buffer.from(parts[5], 'base64url');
        const actual = crypto.scryptSync(password, salt, expected.length, { N: N, r: r, p: p, maxmem: 128 * 1024 * 1024 });
        return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
    } catch (e) {
        return false;
    }
}

const PASSWORD_HASH = ADMIN_PASSWORD_HASH
    ? ADMIN_PASSWORD_HASH
    : (ADMIN_PASSWORD ? scryptHash(ADMIN_PASSWORD) : '');

const PASSWORD_TAG = PASSWORD_HASH
    ? crypto.createHash('sha256').update(PASSWORD_HASH).digest('hex').slice(0, 16)
    : 'none';

// ============================ 会话密钥 ============================
function loadSessionSecret() {
    if (process.env.SESSION_SECRET && process.env.SESSION_SECRET.length >= 32) {
        return Buffer.from(process.env.SESSION_SECRET, 'utf8');
    }
    try {
        if (fs.existsSync(SECRET_FILE)) {
            const raw = fs.readFileSync(SECRET_FILE, 'utf8').trim();
            if (raw.length >= 32) return Buffer.from(raw, 'utf8');
        }
    } catch (e) { /* 读取失败则重新生成 */ }
    const generated = crypto.randomBytes(48).toString('hex');
    try {
        fs.mkdirSync(DATA_DIR, { recursive: true });
        fs.writeFileSync(SECRET_FILE, generated, { mode: 0o600 });
    } catch (e) {
        console.warn('[warn] 无法持久化会话密钥，重启后需重新登录：' + e.message);
    }
    return Buffer.from(generated, 'utf8');
}

const SESSION_SECRET = loadSessionSecret();

function signSession(payload) {
    const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
    const sig = crypto.createHmac('sha256', SESSION_SECRET).update(body).digest('base64url');
    return body + '.' + sig;
}

function verifySessionToken(token) {
    if (!token || typeof token !== 'string') return null;
    const idx = token.lastIndexOf('.');
    if (idx <= 0) return null;
    const body = token.slice(0, idx);
    const sig = token.slice(idx + 1);
    const expected = crypto.createHmac('sha256', SESSION_SECRET).update(body).digest('base64url');
    const a = Buffer.from(sig, 'utf8');
    const b = Buffer.from(expected, 'utf8');
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    let payload;
    try {
        payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    } catch (e) {
        return null;
    }
    if (!payload || payload.u !== ADMIN_USERNAME) return null;
    if (payload.v !== PASSWORD_TAG) return null;
    if (!Number.isFinite(payload.exp) || payload.exp < Date.now()) return null;
    // 有效期上限校验：防止异常或误签发的超长令牌绕过过期管理
    const maxTtl = (payload.rmb === true ? REMEMBER_MAX_AGE : SESSION_MAX_AGE) * 1000;
    const ttl = payload.exp - (Number.isFinite(payload.iat) ? payload.iat : 0);
    if (ttl <= 0 || ttl > maxTtl) return null;
    return payload;
}

// 签发会话：remember=true 时下发长效令牌（rmb 声明），否则沿用短会话
function issueSession(remember) {
    const now = Date.now();
    const maxAge = remember ? REMEMBER_MAX_AGE : SESSION_MAX_AGE;
    const payload = {
        u: ADMIN_USERNAME,
        v: PASSWORD_TAG,
        iat: now,
        exp: now + maxAge * 1000
    };
    if (remember) payload.rmb = true;
    return { token: signSession(payload), maxAge: maxAge, exp: payload.exp };
}

function parseCookies(header) {
    const out = {};
    if (!header) return out;
    header.split(';').forEach(function (part) {
        const i = part.indexOf('=');
        if (i < 0) return;
        out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
    });
    return out;
}

function sessionCookie(token, maxAge) {
    const parts = [
        COOKIE_NAME + '=' + token,
        'Path=/',
        'HttpOnly',
        'SameSite=Strict',
        'Max-Age=' + maxAge
    ];
    if (COOKIE_SECURE) parts.push('Secure');
    return parts.join('; ');
}

// ============================ 登录失败锁定 ============================
const loginGuard = new Map();

function clientIp(req) {
    if (TRUST_PROXY) {
        const xff = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
        if (xff) return xff;
    }
    return (req.socket && req.socket.remoteAddress) || 'unknown';
}

function getGuard(ip) {
    const now = Date.now();
    let item = loginGuard.get(ip);
    if (!item || (item.lockedUntil && item.lockedUntil < now && now - item.firstAt > LOGIN_LOCK_MINUTES * 60000)) {
        item = { count: 0, firstAt: now, lockedUntil: 0 };
        loginGuard.set(ip, item);
    }
    return item;
}

function guardBlocked(ip) {
    const item = getGuard(ip);
    if (item.lockedUntil && item.lockedUntil > Date.now()) {
        return Math.ceil((item.lockedUntil - Date.now()) / 1000);
    }
    return 0;
}

function guardFail(ip) {
    const item = getGuard(ip);
    const now = Date.now();
    if (now - item.firstAt > LOGIN_LOCK_MINUTES * 60000) {
        item.count = 0;
        item.firstAt = now;
    }
    item.count += 1;
    if (item.count >= MAX_LOGIN_FAILURES) {
        item.lockedUntil = now + LOGIN_LOCK_MINUTES * 60000;
        item.count = 0;
        item.firstAt = now;
    }
}

function guardSuccess(ip) {
    loginGuard.delete(ip);
}

setInterval(function () {
    const now = Date.now();
    for (const [ip, item] of loginGuard) {
        if ((!item.lockedUntil || item.lockedUntil < now) && now - item.firstAt > LOGIN_LOCK_MINUTES * 60000) {
            loginGuard.delete(ip);
        }
    }
}, 60000).unref();

// ============================ 数据持久化 ============================
let state = { rev: 0, updatedAt: null, data: {} };
let lastBackupHash = '';
let backupQueue = Promise.resolve();
let scheduledBackupAt = 0;
let scheduledBackupQueued = false;
let writeQueue = Promise.resolve();
let scheduleWriteQueue = Promise.resolve();

function ensureDirs() {
    fs.mkdirSync(BACKUP_DIR, { recursive: true, mode: 0o700 });
}

function loadStateSync() {
    try {
        if (!fs.existsSync(STATE_FILE)) return;
        const raw = fs.readFileSync(STATE_FILE, 'utf8');
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object' && parsed.data && typeof parsed.data === 'object') {
            state = {
                rev: Number.isFinite(parsed.rev) ? parsed.rev : 0,
                updatedAt: parsed.updatedAt || null,
                data: parsed.data
            };
            lastBackupHash = crypto.createHash('sha256').update(JSON.stringify(state.data)).digest('hex');
            console.log('[info] 已载入数据：' + Object.keys(state.data).length + ' 个键，rev=' + state.rev);
        }
    } catch (e) {
        const broken = STATE_FILE + '.corrupt-' + Date.now();
        try { fs.renameSync(STATE_FILE, broken); } catch (err) { /* ignore */ }
        console.error('[error] state.json 解析失败，已隔离为 ' + broken + '，本次以空数据启动：' + e.message);
    }
}

function validateStatePayload(payload) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        return '请求体必须是 JSON 对象';
    }
    const data = payload.data;
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
        return 'data 必须是对象';
    }
    const allowed = new Set(['hev_vehicles', 'hev_categories', 'hev_records', 'hev_app_settings', 'hev_snapshot_latest', 'hev_op_logs']);
    const clean = {};
    for (const key of Object.keys(data)) {
        if (!allowed.has(key)) continue;
        const val = data[key];
        if (val === null) continue;
        if (typeof val !== 'string') return key + ' 的值必须是字符串';
        clean[key] = val;
    }
    return { clean: clean };
}

async function atomicWrite(file, content) {
    const tmp = file + '.tmp-' + process.pid + '-' + Date.now();
    const fh = await fsp.open(tmp, 'w', 0o600);
    try {
        await fh.writeFile(content, 'utf8');
        await fh.sync();
    } finally {
        await fh.close();
    }
    await fsp.rename(tmp, file);
}

async function rotateBackups() {
    try {
        const files = (await fsp.readdir(BACKUP_DIR)).filter(function (f) { return f.endsWith('.json'); }).sort();
        while (files.length > BACKUP_KEEP) {
            const victim = files.shift();
            await fsp.unlink(path.join(BACKUP_DIR, victim)).catch(function () {});
        }
    } catch (e) { /* 备份轮转失败不影响主流程 */ }
}

function backupFileName(now, rev, tag) {
    const stamp = new Date(now).toISOString().replace(/[:.]/g, '-').replace('T', '_').replace('Z', '');
    return path.join(BACKUP_DIR, 'state-' + stamp + '-rev' + rev + (tag ? '-' + tag : '') + '.json');
}

// 从业务设置中读取自动备份周期（天），默认 7 天，限制 1~365 天
function readBackupIntervalDays() {
    try {
        const raw = state.data && state.data.hev_app_settings;
        if (typeof raw === 'string') {
            const parsed = JSON.parse(raw);
            const days = Number(parsed && parsed.backupIntervalDays);
            if (Number.isFinite(days)) return Math.min(365, Math.max(1, Math.round(days)));
        }
    } catch (e) { /* 设置解析失败时按默认周期 */ }
    return DEFAULT_BACKUP_INTERVAL_DAYS;
}

function persistBackupSchedule() {
    const body = JSON.stringify({
        lastScheduledBackupAt: scheduledBackupAt,
        updatedAt: new Date().toISOString()
    });
    scheduleWriteQueue = scheduleWriteQueue.then(function () {
        return atomicWrite(BACKUP_SCHEDULE_FILE, body);
    }).catch(function (e) {
        console.warn('[warn] 备份周期状态写入失败：' + e.message);
    });
    return scheduleWriteQueue;
}

function loadBackupScheduleSync() {
    try {
        const parsed = JSON.parse(fs.readFileSync(BACKUP_SCHEDULE_FILE, 'utf8'));
        if (parsed && Number.isFinite(parsed.lastScheduledBackupAt)) {
            scheduledBackupAt = parsed.lastScheduledBackupAt;
            return;
        }
    } catch (e) { /* 首次运行或文件损坏，按当前时间起算 */ }
    scheduledBackupAt = Date.now();
    persistBackupSchedule();
}

// 备份采用独立队列异步执行，不阻塞业务请求；快照在入队时固化，保证数据一致
function enqueueBackup(tag) {
    const now = Date.now();
    const rev = state.rev;
    const snapshot = JSON.stringify(state);
    const file = backupFileName(now, rev, tag);
    const label = tag === 'scheduled' ? '周期备份' : '变更备份';
    const task = backupQueue.then(async function () {
        try {
            await atomicWrite(file, snapshot);
            await rotateBackups();
            console.log('[info] 已生成' + label + '：' + path.basename(file));
            return true;
        } catch (e) {
            console.warn('[warn] ' + label + '写入失败：' + e.message);
            return false;
        }
    });
    backupQueue = task;
    return task;
}

function checkScheduledBackup() {
    if (scheduledBackupQueued) return;
    const intervalDays = readBackupIntervalDays();
    const dueAt = scheduledBackupAt + intervalDays * 86400000;
    if (Date.now() < dueAt) return;
    scheduledBackupQueued = true;
    enqueueBackup('scheduled').then(function (ok) {
        scheduledBackupQueued = false;
        if (!ok) return;
        scheduledBackupAt = Date.now();
        persistBackupSchedule();
    });
}

async function persistState(clean) {
    const serialized = JSON.stringify(clean);
    const hash = crypto.createHash('sha256').update(serialized).digest('hex');
    const now = Date.now();
    const nextRev = state.rev + 1;
    const payload = {
        rev: nextRev,
        updatedAt: new Date(now).toISOString(),
        data: clean
    };
    await atomicWrite(STATE_FILE, JSON.stringify(payload));
    state = payload;

    // 内容真实变化时立即触发一次备份（异步执行，不阻塞本次保存响应）
    if (hash !== lastBackupHash) {
        lastBackupHash = hash;
        enqueueBackup('change');
    }
    return payload;
}

// ============================ HTTP 工具 ============================
function securityHeaders(res) {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
    res.setHeader('Content-Security-Policy', [
        "default-src 'self'",
        "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data: blob:",
        "font-src 'self' data:",
        "connect-src 'self'",
        "object-src 'none'",
        "base-uri 'self'",
        "form-action 'self'",
        "frame-ancestors 'none'"
    ].join('; '));
}

function sendJson(res, status, obj) {
    const body = Buffer.from(JSON.stringify(obj), 'utf8');
    res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': body.length,
        'Cache-Control': 'no-store'
    });
    res.end(body);
}

function readBody(req, limit) {
    return new Promise(function (resolve, reject) {
        let size = 0;
        const chunks = [];
        req.on('data', function (chunk) {
            size += chunk.length;
            if (size > limit) {
                reject(Object.assign(new Error('payload too large'), { code: 'TOO_LARGE' }));
                req.destroy();
                return;
            }
            chunks.push(chunk);
        });
        req.on('end', function () { resolve(Buffer.concat(chunks).toString('utf8')); });
        req.on('error', reject);
    });
}

function sameOrigin(req) {
    const origin = req.headers.origin;
    if (!origin) return true;
    try {
        return new URL(origin).host === req.headers.host;
    } catch (e) {
        return false;
    }
}

const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.ico': 'image/x-icon',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.map': 'application/json; charset=utf-8'
};

const gzipCache = new Map();

async function serveFile(req, res, filePath, cacheControl) {
    let stat;
    try {
        stat = await fsp.stat(filePath);
    } catch (e) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end('Not Found');
        return;
    }
    if (!stat.isFile()) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Not Found');
        return;
    }
    const ext = path.extname(filePath).toLowerCase();
    const type = MIME[ext] || 'application/octet-stream';
    const headers = {
        'Content-Type': type,
        'Cache-Control': cacheControl,
        'Last-Modified': stat.mtime.toUTCString()
    };

    const compressible = /^(text\/|application\/(json|javascript))/.test(type);
    const acceptsGzip = String(req.headers['accept-encoding'] || '').indexOf('gzip') !== -1;
    if (compressible && acceptsGzip && stat.size < 8 * 1024 * 1024) {
        const key = filePath + ':' + stat.mtimeMs + ':' + stat.size;
        let cached = gzipCache.get(key);
        if (!cached) {
            const raw = await fsp.readFile(filePath);
            cached = zlib.gzipSync(raw, { level: 6 });
            if (gzipCache.size > 24) gzipCache.clear();
            gzipCache.set(key, cached);
        }
        headers['Content-Encoding'] = 'gzip';
        headers['Content-Length'] = cached.length;
        headers['Vary'] = 'Accept-Encoding';
        res.writeHead(200, headers);
        if (req.method === 'HEAD') return res.end();
        return res.end(cached);
    }

    headers['Content-Length'] = stat.size;
    res.writeHead(200, headers);
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(filePath).pipe(res);
}

// ============================ 路由 ============================
const LOGIN_PAGE_PATH = path.join(__dirname, 'login.html');

function loginPage(res) {
    fsp.readFile(LOGIN_PAGE_PATH).then(function (buf) {
        res.writeHead(200, {
            'Content-Type': 'text/html; charset=utf-8',
            'Content-Length': buf.length,
            'Cache-Control': 'no-store'
        });
        res.end(buf);
    }).catch(function (e) {
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('登录页加载失败');
    });
}

function currentSession(req) {
    const cookies = parseCookies(req.headers.cookie);
    return verifySessionToken(cookies[COOKIE_NAME]);
}

async function handle(req, res) {
    securityHeaders(res);
    const url = new URL(req.url, 'http://localhost');
    const pathname = decodeURIComponent(url.pathname);
    const method = req.method || 'GET';

    if (pathname === '/healthz') {
        return sendJson(res, 200, { status: 'ok', uptime: Math.round(process.uptime()), rev: state.rev });
    }

    if (pathname === '/login') {
        if (method !== 'GET' && method !== 'HEAD') return sendJson(res, 405, { error: 'method_not_allowed' });
        if (currentSession(req)) {
            res.writeHead(302, { Location: '/', 'Cache-Control': 'no-store' });
            return res.end();
        }
        return loginPage(res);
    }

    if (pathname === '/api/login' && method === 'POST') {
        if (!PASSWORD_HASH) {
            return sendJson(res, 503, { error: '服务端未配置登录口令，请检查 ADMIN_PASSWORD / ADMIN_PASSWORD_HASH' });
        }
        if (!sameOrigin(req)) return sendJson(res, 403, { error: '非法来源' });
        const ip = clientIp(req);
        const blocked = guardBlocked(ip);
        if (blocked > 0) {
            return sendJson(res, 429, { error: '登录尝试过于频繁，请在 ' + blocked + ' 秒后重试' });
        }
        let body;
        try {
            body = JSON.parse(await readBody(req, 4096));
        } catch (e) {
            return sendJson(res, 400, { error: '请求格式错误' });
        }
        const username = typeof body.username === 'string' ? body.username.trim() : '';
        const password = typeof body.password === 'string' ? body.password : '';
        if (!username || !password) {
            guardFail(ip);
            return sendJson(res, 400, { error: '请输入账号和密码' });
        }
        const userOk = username.length === ADMIN_USERNAME.length &&
            crypto.timingSafeEqual(Buffer.from(username), Buffer.from(ADMIN_USERNAME));
        const passOk = scryptVerify(password, PASSWORD_HASH);
        if (!userOk || !passOk) {
            guardFail(ip);
            const locked = guardBlocked(ip);
            if (locked > 0) {
                return sendJson(res, 429, { error: '登录失败次数过多，已锁定 ' + locked + ' 秒' });
            }
            const remain = Math.max(0, MAX_LOGIN_FAILURES - (getGuard(ip).count || 0));
            return sendJson(res, 401, { error: '账号或密码错误', remaining: remain });
        }
        guardSuccess(ip);
        const remember = body.remember === true || body.remember === '1' || body.remember === 'true';
        const issued = issueSession(remember);
        res.setHeader('Set-Cookie', sessionCookie(issued.token, issued.maxAge));
        return sendJson(res, 200, {
            ok: true,
            username: ADMIN_USERNAME,
            remember: remember,
            expiresAt: issued.exp
        });
    }

    if (pathname === '/api/logout' && method === 'POST') {
        res.setHeader('Set-Cookie', sessionCookie('', 0));
        return sendJson(res, 200, { ok: true });
    }

    if (pathname === '/api/session' && method === 'GET') {
        const session = currentSession(req);
        if (!session) return sendJson(res, 401, { authenticated: false });
        // 长效令牌滑动续期：剩余有效期不足一半时重新签发，避免长期使用者被动掉线
        if (session.rmb === true && session.exp - Date.now() <= (REMEMBER_MAX_AGE * 1000) / 2) {
            const renewed = issueSession(true);
            res.setHeader('Set-Cookie', sessionCookie(renewed.token, renewed.maxAge));
            return sendJson(res, 200, {
                authenticated: true,
                username: session.u,
                expiresAt: renewed.exp,
                remember: true,
                refreshed: true
            });
        }
        return sendJson(res, 200, {
            authenticated: true,
            username: session.u,
            expiresAt: session.exp,
            remember: session.rmb === true,
            refreshed: false
        });
    }

    // 站点图标：浏览器在登录页也会发起匿名请求，需在鉴权前放行
    if (method === 'GET' || method === 'HEAD') {
        const ICON_FILES = {
            '/favicon.ico': 'favicon.ico',
            '/favicon.svg': 'favicon.svg',
            '/apple-touch-icon.png': 'apple-touch-icon.png'
        };
        const iconFile = ICON_FILES[pathname];
        if (iconFile) return serveFile(req, res, path.join(PUBLIC_DIR, iconFile), 'public, max-age=86400');
    }

    // ---------- 以下所有资源都必须通过鉴权 ----------
    const session = currentSession(req);
    if (!session) {
        if (pathname === '/' || pathname === '/index.html') {
            res.writeHead(302, { Location: '/login?next=' + encodeURIComponent(pathname), 'Cache-Control': 'no-store' });
            return res.end();
        }
        if (pathname.startsWith('/api/')) return sendJson(res, 401, { error: 'unauthorized' });
        res.writeHead(401, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
        return res.end('Unauthorized');
    }

    if (pathname === '/api/status' && method === 'GET') {
        let count = 0;
        let latestAt = null;
        try {
            const files = (await fsp.readdir(BACKUP_DIR)).filter(function (f) { return f.endsWith('.json'); }).sort();
            count = files.length;
            if (files.length) {
                const st = await fsp.stat(path.join(BACKUP_DIR, files[files.length - 1]));
                latestAt = st.mtime.toISOString();
            }
        } catch (e) { /* 备份目录尚未创建时按 0 份处理 */ }
        return sendJson(res, 200, {
            rev: state.rev,
            updatedAt: state.updatedAt,
            backup: { count: count, latestAt: latestAt, keep: BACKUP_KEEP }
        });
    }

    if (pathname === '/api/state') {
        if (method === 'GET') {
            return sendJson(res, 200, { rev: state.rev, updatedAt: state.updatedAt, data: state.data });
        }
        if (method === 'PUT' || method === 'POST') {
            if (!sameOrigin(req)) return sendJson(res, 403, { error: '非法来源' });
            let payload;
            try {
                const raw = await readBody(req, MAX_STATE_BYTES);
                payload = JSON.parse(raw);
            } catch (e) {
                if (e && e.code === 'TOO_LARGE') return sendJson(res, 413, { error: '数据超过大小上限' });
                return sendJson(res, 400, { error: '请求格式错误' });
            }
            const checked = validateStatePayload(payload);
            if (typeof checked === 'string') return sendJson(res, 400, { error: checked });
            const op = writeQueue.then(function () { return persistState(checked.clean); });
            writeQueue = op.catch(function () { /* 保证队列可继续处理后续请求 */ });
            try {
                await op;
                return sendJson(res, 200, { ok: true, rev: state.rev, updatedAt: state.updatedAt });
            } catch (e) {
                console.error('[error] 数据写入失败：' + e.message);
                return sendJson(res, 500, { error: '数据保存失败' });
            }
        }
        return sendJson(res, 405, { error: 'method_not_allowed' });
    }

    if (method !== 'GET' && method !== 'HEAD') {
        return sendJson(res, 404, { error: 'not_found' });
    }

    if (pathname === '/' || pathname === '/index.html') {
        return serveFile(req, res, path.join(PUBLIC_DIR, 'index.html'), 'no-store');
    }

    if (pathname.startsWith('/vendor/')) {
        const rel = pathname.slice('/vendor/'.length);
        const full = path.resolve(PUBLIC_DIR, 'vendor', rel);
        const root = path.resolve(PUBLIC_DIR, 'vendor') + path.sep;
        if (!full.startsWith(root)) return sendJson(res, 404, { error: 'not_found' });
        return serveFile(req, res, full, 'public, max-age=31536000, immutable');
    }

    if (pathname.startsWith('/assets/')) {
        const rel = pathname.slice('/assets/'.length);
        const full = path.resolve(PUBLIC_DIR, 'assets', rel);
        const root = path.resolve(PUBLIC_DIR, 'assets') + path.sep;
        if (!full.startsWith(root)) return sendJson(res, 404, { error: 'not_found' });
        return serveFile(req, res, full, 'no-cache');
    }

    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end('Not Found');
}

// ============================ 启动 ============================
function start() {
    ensureDirs();
    loadStateSync();
    loadBackupScheduleSync();
    rotateBackups();
    checkScheduledBackup();
    setInterval(checkScheduledBackup, BACKUP_CHECK_INTERVAL_MS).unref();

    if (!PASSWORD_HASH) {
        console.error('[fatal] 未配置登录口令。请设置 ADMIN_PASSWORD 或 ADMIN_PASSWORD_HASH 后重启容器。');
        process.exit(1);
    }
    if (ADMIN_PASSWORD && !ADMIN_PASSWORD_HASH) {
        console.warn('[warn] 当前使用明文 ADMIN_PASSWORD 环境变量，建议改用 ADMIN_PASSWORD_HASH（见运维手册）。');
    }

    const server = http.createServer(function (req, res) {
        const startedAt = Date.now();
        res.on('finish', function () {
            const ms = Date.now() - startedAt;
            const safePath = String(req.url || '').split('?')[0];
            console.log('[' + new Date().toISOString() + '] ' + req.method + ' ' + safePath + ' ' + res.statusCode + ' ' + ms + 'ms ip=' + clientIp(req));
        });
        Promise.resolve(handle(req, res)).catch(function (e) {
            console.error('[error] 请求处理异常：' + (e && e.stack ? e.stack : e));
            if (!res.headersSent) sendJson(res, 500, { error: 'internal_error' });
            else res.end();
        });
    });

    server.headersTimeout = 20000;
    server.requestTimeout = 120000;
    server.keepAliveTimeout = 5000;

    server.listen(PORT, '0.0.0.0', function () {
        console.log('[info] 混动车全生命周期记录服务已启动：http://0.0.0.0:' + PORT);
        console.log('[info] 数据目录：' + DATA_DIR + '，配置账号：' + ADMIN_USERNAME + '，会话有效期：' + SESSION_HOURS + ' 小时，免登录有效期：' + REMEMBER_DAYS + ' 天');
    });

    function shutdown(signal) {
        console.log('[info] 收到 ' + signal + '，正在关闭服务…');
        server.close(function () { process.exit(0); });
        setTimeout(function () { process.exit(0); }, 5000).unref();
    }
    process.on('SIGTERM', function () { shutdown('SIGTERM'); });
    process.on('SIGINT', function () { shutdown('SIGINT'); });
}

start();
