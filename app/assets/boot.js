/*
 * 混动车全生命周期记录 —— 前端启动引导
 * 职责：
 *   1. 启动前校验服务端会话，未登录直接跳转登录页（服务端同时做强制拦截）；
 *   2. 从服务端获取持久化数据并水合到 localStorage，首次登录自动迁移浏览器旧数据；
 *   3. 代理 localStorage 写入，防抖同步到服务端（应用原有逻辑无需改动）；
 *   4. 依次加载本地固化的 Vue / Element Plus / ECharts / app.js；
 *   5. 注入账号状态与退出登录入口。
 * 本文件不修改应用的任何业务逻辑。
 */
(function () {
    'use strict';

    var SYNC_KEYS = [
        'hev_vehicles',
        'hev_categories',
        'hev_records',
        'hev_app_settings',
        'hev_snapshot_latest',
        'hev_op_logs'
    ];

    var loginUrl = '/login?next=' + encodeURIComponent(location.pathname + location.search);
    var syncTimer = null;
    var syncing = false;
    var syncPending = false;
    var loggingOut = false;
    var statusEl = null;

    function collectLocalState() {
        var out = {};
        SYNC_KEYS.forEach(function (k) {
            try {
                var v = localStorage.getItem(k);
                if (v !== null) out[k] = v;
            } catch (e) { /* 忽略单键读取异常 */ }
        });
        return out;
    }

    function setStatus(text, color) {
        if (!statusEl) return;
        var dot = statusEl.querySelector('.hev-dot');
        var label = statusEl.querySelector('.hev-sync-label');
        if (dot) dot.style.background = color;
        if (label) label.textContent = text;
    }

    function redirectToLogin() {
        try { localStorage.removeItem('hev_session_hint'); } catch (e) {}
        location.replace(loginUrl);
    }

    function pushState(useBeacon) {
        if (loggingOut) return;
        var payload = JSON.stringify({ data: collectLocalState() });
        if (useBeacon && navigator.sendBeacon) {
            try {
                navigator.sendBeacon('/api/state', new Blob([payload], { type: 'application/json' }));
                return;
            } catch (e) { /* 回退到 fetch */ }
        }
        syncing = true;
        setStatus('同步中…', '#e6a23c');
        fetch('/api/state', {
            method: 'PUT',
            credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json' },
            body: payload
        }).then(function (res) {
            if (res.status === 401) { redirectToLogin(); return null; }
            if (!res.ok) throw new Error('HTTP ' + res.status);
            return res.json();
        }).then(function (data) {
            if (!data) return;
            setStatus('已保存', '#67c23a');
            window.__hevLastSavedAt = Date.now();
        }).catch(function () {
            setStatus('同步失败，将重试', '#f56c6c');
            var retry = setTimeout(function () { scheduleSync(); }, 3000);
            if (retry) { /* 保持定时器引用，避免被回收 */ }
        }).then(function () {
            syncing = false;
            if (syncPending) { syncPending = false; scheduleSync(); }
        });
    }

    function scheduleSync() {
        if (loggingOut) return;
        if (syncing) { syncPending = true; return; }
        clearTimeout(syncTimer);
        syncTimer = setTimeout(function () {
            pushState(false);
        }, 800);
    }

    function installSyncHook() {
        var originalSetItem = Storage.prototype.setItem;
        var originalRemoveItem = Storage.prototype.removeItem;

        Storage.prototype.setItem = function (key, value) {
            var result = originalSetItem.apply(this, arguments);
            if (this === window.localStorage && SYNC_KEYS.indexOf(String(key)) !== -1) {
                scheduleSync();
            }
            return result;
        };

        Storage.prototype.removeItem = function (key) {
            var result = originalRemoveItem.apply(this, arguments);
            if (this === window.localStorage && SYNC_KEYS.indexOf(String(key)) !== -1) {
                scheduleSync();
            }
            return result;
        };

        window.addEventListener('pagehide', function () { pushState(true); });
        document.addEventListener('visibilitychange', function () {
            if (document.visibilityState === 'hidden') pushState(true);
        });
    }

    function loadScript(src) {
        return new Promise(function (resolve, reject) {
            var s = document.createElement('script');
            s.src = src;
            s.async = false;
            s.onload = resolve;
            s.onerror = function () { reject(new Error('资源加载失败：' + src)); };
            document.body.appendChild(s);
        });
    }

    function createStatusWidget(username) {
        // 窄屏下缩小悬浮状态条，避免遮挡页面底部内容
        if (!document.getElementById('hev-auth-ui-style')) {
            var style = document.createElement('style');
            style.id = 'hev-auth-ui-style';
            style.textContent = '@media (max-width: 480px){[data-hev-auth-ui]{right:8px!important;bottom:8px!important;padding:6px 9px!important;gap:7px!important;font-size:11.5px!important;border-radius:16px!important}[data-hev-auth-ui] button{padding:3px 8px!important;font-size:11.5px!important}}';
            document.head.appendChild(style);
        }
        var wrap = document.createElement('div');
        wrap.setAttribute('data-hev-auth-ui', '1');
        wrap.style.cssText = [
            'position:fixed', 'right:16px', 'bottom:16px', 'z-index:99999',
            'display:flex', 'align-items:center', 'gap:10px',
            'padding:8px 12px', 'border-radius:20px',
            'background:rgba(255,255,255,.96)', 'box-shadow:0 2px 12px rgba(0,0,0,.15)',
            'font:12.5px/1.4 "Helvetica Neue",Helvetica,"PingFang SC","Microsoft YaHei",Arial,sans-serif',
            'color:#606266', 'border:1px solid #ebeef5', 'user-select:none'
        ].join(';');

        var dot = document.createElement('span');
        dot.className = 'hev-dot';
        dot.style.cssText = 'width:8px;height:8px;border-radius:50%;background:#67c23a;display:inline-block;flex:0 0 auto;';

        var user = document.createElement('span');
        user.textContent = username || '已登录';
        user.style.cssText = 'font-weight:600;color:#303133;';

        var label = document.createElement('span');
        label.className = 'hev-sync-label';
        label.textContent = '已保存';
        label.style.cssText = 'color:#909399;';

        var btn = document.createElement('button');
        btn.type = 'button';
        btn.textContent = '退出登录';
        btn.style.cssText = 'border:none;background:#f2f3f5;color:#606266;border-radius:12px;padding:4px 10px;cursor:pointer;font-size:12px;';
        btn.onmouseenter = function () { btn.style.background = '#fde2e2'; btn.style.color = '#f56c6c'; };
        btn.onmouseleave = function () { btn.style.background = '#f2f3f5'; btn.style.color = '#606266'; };
        btn.onclick = function () {
            btn.disabled = true;
            btn.textContent = '退出中…';
            loggingOut = true;
            clearTimeout(syncTimer);
            try { SYNC_KEYS.forEach(function (k) { localStorage.removeItem(k); }); } catch (e) {}
            fetch('/api/logout', {
                method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: '{}'
            }).then(function () { location.replace('/login?logout=1'); })
              .catch(function () { location.replace('/login?logout=1'); });
        };

        wrap.appendChild(dot);
        wrap.appendChild(user);
        wrap.appendChild(label);
        wrap.appendChild(btn);
        document.body.appendChild(wrap);
        statusEl = wrap;
        setStatus('已保存', '#67c23a');
    }

    function showFatal(message) {
        var box = document.createElement('div');
        box.style.cssText = 'position:fixed;inset:0;background:#f5f7fa;display:flex;align-items:center;justify-content:center;z-index:100000;padding:20px;';
        var card = document.createElement('div');
        card.style.cssText = 'max-width:420px;background:#fff;border:1px solid #ebeef5;border-radius:8px;padding:24px;text-align:center;font:14px/1.7 "PingFang SC","Microsoft YaHei",Arial,sans-serif;color:#606266;box-shadow:0 2px 12px rgba(0,0,0,.08);';
        var title = document.createElement('div');
        title.textContent = '页面加载失败';
        title.style.cssText = 'font-size:16px;font-weight:600;color:#303133;margin-bottom:8px;';
        var desc = document.createElement('div');
        desc.textContent = message;
        var btn = document.createElement('button');
        btn.textContent = '重新加载';
        btn.style.cssText = 'margin-top:16px;border:none;background:#409eff;color:#fff;border-radius:4px;padding:8px 18px;cursor:pointer;font-size:14px;';
        btn.onclick = function () { location.reload(); };
        card.appendChild(title);
        card.appendChild(desc);
        card.appendChild(btn);
        box.appendChild(card);
        document.body.appendChild(box);
    }

    function bootstrap() {
        fetch('/api/session', { credentials: 'same-origin', headers: { 'Accept': 'application/json' } })
            .then(function (res) {
                if (res.status === 401) { redirectToLogin(); return null; }
                if (!res.ok) throw new Error('会话校验失败（HTTP ' + res.status + '）');
                return res.json();
            })
            .then(function (session) {
                if (!session) return null;
                return fetch('/api/state', { credentials: 'same-origin', headers: { 'Accept': 'application/json' } })
                    .then(function (res) {
                        if (res.status === 401) { redirectToLogin(); return null; }
                        if (!res.ok) throw new Error('数据加载失败（HTTP ' + res.status + '）');
                        return res.json();
                    })
                    .then(function (state) {
                        var remote = (state && state.data) || {};
                        var keys = Object.keys(remote);
                        if (keys.length > 0) {
                            SYNC_KEYS.forEach(function (k) {
                                try {
                                    if (typeof remote[k] === 'string') localStorage.setItem(k, remote[k]);
                                    else localStorage.removeItem(k);
                                } catch (e) { /* 忽略单键异常 */ }
                            });
                        } else {
                            var local = collectLocalState();
                            if (Object.keys(local).length > 0) {
                                fetch('/api/state', {
                                    method: 'PUT',
                                    credentials: 'same-origin',
                                    headers: { 'Content-Type': 'application/json' },
                                    body: JSON.stringify({ data: local })
                                }).catch(function () {});
                            }
                        }
                        installSyncHook();
                        return loadScript('/vendor/vue.global.js')
                            .then(function () { return loadScript('/vendor/element-plus.js'); })
                            .then(function () { return loadScript('/vendor/echarts.min.js'); })
                            .then(function () { return loadScript('/assets/app.js'); })
                            .then(function () { createStatusWidget(session.username); });
                    });
            })
            .catch(function (err) {
                if (err && String(err.message).indexOf('资源加载失败') === 0) {
                    showFatal(err.message + '，请检查容器状态后重试。');
                } else {
                    showFatal((err && err.message) || '无法连接服务端，请稍后重试。');
                }
            });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', bootstrap);
    } else {
        bootstrap();
    }
})();
