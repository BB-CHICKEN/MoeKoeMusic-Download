(function () {
    'use strict';

    console.log('MoeKoe 美化版下载管理器已加载 (RPC版)');

    // ==================== 日志系统 ====================
    const logger = {
        log: (...args) => console.log(`[MoeKoe下载]`, ...args),
        error: (...args) => console.error(`\x1B[31m[MoeKoe下载]\x1B[0m`, ...args),
        warn: (...args) => console.warn(`\x1B[33m[MoeKoe下载]\x1B[0m`, ...args)
    };

    // ==================== 配置管理（存储于 BB-Ji.rpc） ====================
    class ConfigManager {
        static get CONFIG_KEY() { return 'BB-Ji'; }

        static getDefaultConfig() {
            return {
                rpcUrl: 'http://127.0.0.1:16800/jsonrpc',
                secret: '',
                enabled: true,
                autoStart: true,
                downloadImage: false,
                downloadDir: ''
            };
        }

        static load() {
            const config = this.getDefaultConfig();
            try {
                const raw = localStorage.getItem(this.CONFIG_KEY);
                if (raw) {
                    const data = JSON.parse(raw);
                    if (data && typeof data === 'object' && data.rpc) {
                        Object.assign(config, data.rpc);
                    }
                }
            } catch (e) {
                logger.warn('读取配置失败，使用默认配置', e);
            }

            // 迁移旧版 moekoe_motrix_secret
            try {
                const oldSecret = localStorage.getItem('moekoe_motrix_secret');
                if (oldSecret !== null) {
                    config.secret = oldSecret;
                    localStorage.removeItem('moekoe_motrix_secret');
                    logger.log('已迁移旧版RPC密钥到 BB-Ji.rpc');
                }
            } catch (e) { }

            // 迁移旧下载历史（始终检查，保存到 BB-Ji.history）
            try {
                const existing = ConfigManager.getHistory();
                if (existing.length === 0) {
                    const oldHistory = localStorage.getItem('moekoe_download_history');
                    if (oldHistory) {
                        const parsed = JSON.parse(oldHistory);
                        if (Array.isArray(parsed) && parsed.length > 0) {
                            ConfigManager.saveHistory(parsed);
                            logger.log('已迁移旧下载历史', parsed.length, '条');
                        }
                        localStorage.removeItem('moekoe_download_history');
                    }
                }
            } catch (e) {
                localStorage.removeItem('moekoe_download_history');
            }

            return config;
        }

        static save(config) {
            try {
                let data = {};
                const raw = localStorage.getItem(this.CONFIG_KEY);
                if (raw) {
                    try { data = JSON.parse(raw); } catch (e) { /* 忽略 */ }
                }
                // 只更新 rpc 子对象，不影响其他字段
                data.rpc = config;
                localStorage.setItem(this.CONFIG_KEY, JSON.stringify(data));
            } catch (e) {
                logger.error('保存配置失败', e);
            }
        }

        static get(key) {
            const config = this.load();
            return config[key];
        }

        static set(key, value) {
            const config = this.load();
            config[key] = value;
            this.save(config);
        }

        static getHistory() {
            try {
                const raw = localStorage.getItem(this.CONFIG_KEY);
                if (raw) {
                    const data = JSON.parse(raw);
                    if (data && Array.isArray(data.history)) {
                        return data.history;
                    }
                }
            } catch (e) { }
            return [];
        }

        static saveHistory(history) {
            try {
                let data = {};
                const raw = localStorage.getItem(this.CONFIG_KEY);
                if (raw) {
                    try { data = JSON.parse(raw); } catch (e) { /* 忽略 */ }
                }
                data.history = history;
                localStorage.setItem(this.CONFIG_KEY, JSON.stringify(data));
            } catch (e) {
                logger.error('保存下载历史失败', e);
            }
        }
    }

    // ==================== RPC 客户端（HTTP + token参数认证） ====================
    class MotrixRPCClient {
        constructor() {
            this.config = ConfigManager.load();
            this.rpcUrl = this.config.rpcUrl;
            this.secret = this.config.secret;
            this.isConnected = false;
        }

        reloadConfig() {
            this.config = ConfigManager.load();
            this.rpcUrl = this.config.rpcUrl;
            this.secret = this.config.secret;
        }

        // 通用 RPC 调用（增强错误信息）
        async call(method, params = [], timeout = 5000) {
            let finalParams = params;
            if (this.secret) {
                finalParams = [`token:${this.secret}`, ...params];
            }

            const payload = {
                jsonrpc: '2.0',
                id: Date.now().toString(),
                method: method,
                params: finalParams
            };

            // 可选：打印请求体（调试时可取消注释）
            // console.log('[RPC] 请求:', JSON.stringify(payload));

            const headers = { 'Content-Type': 'application/json' };
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), timeout);

            try {
                const response = await fetch(this.rpcUrl, {
                    method: 'POST',
                    headers: headers,
                    body: JSON.stringify(payload),
                    signal: controller.signal
                });

                clearTimeout(timer);

                if (!response.ok) {
                    // 读取错误响应体，便于排查
                    let errorText = '';
                    try {
                        errorText = await response.text();
                    } catch (_) { }
                    throw new Error(`HTTP ${response.status}${errorText ? ' - ' + errorText : ''}`);
                }

                const data = await response.json();
                if (data.error) {
                    throw new Error(`RPC错误: ${data.error.message}`);
                }
                return data.result;
            } catch (error) {
                clearTimeout(timer);
                if (error.name === 'AbortError') {
                    throw new Error('连接超时，请检查Motrix是否运行且RPC地址正确');
                }
                throw error;
            }
        }

        async ping(timeout = 5000) {
            try {
                await this.call('aria2.getVersion', [], timeout);
                this.isConnected = true;
                return true;
            } catch (e) {
                this.isConnected = false;
                return false;
            }
        }

        launchMotrix() {
            try {
                const link = document.createElement('a');
                link.href = 'motrixnext://';
                link.style.display = 'none';
                document.body.appendChild(link);
                link.click();
                document.body.removeChild(link);
                logger.log('已尝试通过motrixnext://协议启动Motrix');
                return true;
            } catch (e) {
                logger.error('启动Motrix失败:', e);
                return false;
            }
        }

        async ensureRunning(maxRetries = 5, retryDelay = 2000) {
            if (!this.config.enabled) {
                throw new Error('RPC已禁用，请在设置中启用');
            }

            if (await this.ping()) {
                return true;
            }

            if (this.config.autoStart) {
                this.launchMotrix();
            } else {
                throw new Error('Motrix未运行，且自动启动已关闭');
            }

            for (let i = 0; i < maxRetries; i++) {
                logger.log(`等待Motrix启动... (${i + 1}/${maxRetries})`);
                await this.sleep(retryDelay);
                if (await this.ping()) {
                    logger.log('Motrix已成功连接');
                    return true;
                }
            }
            throw new Error('无法连接到Motrix，请确保Motrix已运行');
        }

        sleep(ms) {
            return new Promise(resolve => setTimeout(resolve, ms));
        }

        // ★★★ 修复 addDownload：将 url 包装为数组，并清洗 header ★★★
        async addDownload(url, options = {}) {
            const {
                filename = '',
                dir = '',
                headers = {},
                referer = window.location.origin
            } = options;

            const cleanUrl = String(url).replace(/[`"']/g, '').trim();

            const optionsObj = {};
            if (filename) optionsObj.out = filename;
            if (dir) optionsObj.dir = dir;
            if (Object.keys(headers).length > 0) {
                // 清洗 header，去除无效条目和多余换行
                const headerStr = Object.entries(headers)
                    .filter(([k, v]) => k && v)
                    .map(([k, v]) => `${k.trim()}: ${v.trim()}`)
                    .join('\r\n')
                    .replace(/\r?\n/g, '\r\n');
                if (headerStr) optionsObj.header = headerStr;
            }
            if (referer) optionsObj.referer = referer;
            optionsObj['user-agent'] = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';

            try {
                // ★ 关键修复：第一个参数必须是数组 ★
                const result = await this.call('aria2.addUri', [[cleanUrl], optionsObj]);
                logger.log('下载任务已添加, GID:', result);
                return result;
            } catch (error) {
                logger.error('添加下载任务失败:', error);
                throw error;
            }
        }

        async addDownloads(tasks) {
            const results = [];
            for (const task of tasks) {
                try {
                    const gid = await this.addDownload(task.url, task.options);
                    results.push({ success: true, gid, ...task });
                } catch (error) {
                    results.push({ success: false, error: error.message, ...task });
                }
            }
            return results;
        }

        async getTaskStatus(gid) {
            try {
                return await this.call('aria2.tellStatus', [gid]);
            } catch (e) {
                return null;
            }
        }
    }

    // ==================== 下载管理器主类 ====================
    class DownloadManager {
        constructor() {
            this.isDownloading = false;
            this.rpcClient = new MotrixRPCClient();
            this.currentDownloads = [];
            this.downloadProgress = {};
            this.batchTotal = 0;
            this.batchCompleted = 0;
            this.isBatchDownloading = false;
            this.abortController = null;
            this.init();
        }

        init() {
            this.injectCSS();
            this.setupGlobalListeners();
            setTimeout(() => this.injectDownloadButton(), 1500);
        }

        // ==================== CSS样式（保持不变） ====================
        injectCSS() {
            const style = document.createElement('style');
            style.id = 'moekoe-download-styles';
            style.textContent = `
                :root {
                    --primary-color: #ff6b6b;
                    --primary-color-rgb: 255, 107, 107;
                    --secondary-color: #FFB6C1;
                    --background-color: #FFF0F5;
                    --background-color-secondary: #FFE6EC;
                    --color-primary: #f36868;
                    --color-primary-light: rgba(255, 107, 107, 0.1);
                    --border-color: #FFDCE3;
                    --hover-color: #FFE9EF;
                    --color-secondary-bg-for-transparent: rgba(209, 209, 214, 0.28);
                    --color-box-shadow: rgba(255, 105, 180, 0.2);
                    --side-navigation-width: 226px;
                }
                .moekoe-download-btn {
                    position: relative;
                    transition: all 0.2s ease;
                }
                .moekoe-download-btn:hover {
                    transform: scale(1.1);
                    color: var(--color-primary);
                }
                .moekoe-download-btn.downloading {
                    animation: pulse 1s infinite;
                    color: var(--color-primary);
                }
                .moekoe-download-btn.disabled {
                    opacity: 0.5;
                    cursor: not-allowed;
                }
                @keyframes pulse {
                    0% { opacity: 1; }
                    50% { opacity: 0.5; }
                    100% { opacity: 1; }
                }
                /* 进度条容器 - 下载按钮右侧内联 */
                .moekoe-progress-container {
                    display: none;
                    position: absolute;
                    left: 100%;
                    top: 50%;
                    transform: translateY(-50%);
                    margin-left: 8px;
                    width: clamp(120px, 15vw, 200px);
                    height: 4px;
                    border-radius: 2px;
                    overflow: hidden;
                    background: rgba(255, 255, 255, 0.12);
                }
                .moekoe-progress-container.active {
                    display: block;
                }
                /* 进度轨道 - 波浪条纹动画 */
                .moekoe-progress-track {
                    height: 100%;
                    width: 0%;
                    border-radius: 4px;
                    background: repeating-linear-gradient(
                        45deg,
                        var(--color-primary) 0px,
                        var(--color-primary) 10px,
                        var(--secondary-color) 10px,
                        var(--secondary-color) 20px
                    );
                    background-size: 28px 28px;
                    transition: width 0.4s cubic-bezier(0.4, 0, 0.2, 1);
                    position: relative;
                }
                /* 波浪流动动画 */
                .moekoe-progress-track.wave {
                    animation: waveFlow 1.2s linear infinite;
}
                .moekoe-progress-track.indeterminate {
                    width: 100%;
                    animation: moekoe-progress-indeterminate 1.5s cubic-bezier(0.4, 0, 0.2, 1) infinite;
                    transform-origin: 0% 50%;
                }
                @keyframes moekoe-progress-indeterminate {
                    0% { transform: translateX(-100%) scaleX(0.3); }
                    50% { transform: translateX(0%) scaleX(0.6); }
                    100% { transform: translateX(100%) scaleX(0.3); }
                }
                .moekoe-notification {
                    animation: slideIn 0.3s ease-out;
                }
                @keyframes slideIn {
                    from { transform: translateX(100%); opacity: 0; }
                    to { transform: translateX(0); opacity: 1; }
                }
                .moekoe-download-menu {
                    animation: fadeIn 0.15s ease-out;
                }
                @keyframes fadeIn {
                    from { opacity: 0; transform: scale(0.95); }
                    to { opacity: 1; transform: scale(1); }
                }
                .menu-item {
                    cursor: pointer;
                    transition: background-color 0.2s ease;
                }
                .menu-item:hover {
                    background-color: rgba(255, 255, 255, 0.1);
                }
                /* 弹窗通用样式 */
                .moekoe-overlay {
                    position: fixed;
                    top: 0;
                    left: 0;
                    right: 0;
                    bottom: 0;
                    background: rgba(0, 0, 0, 0.7);
                    z-index: 10001;
                    opacity: 0;
                    transition: opacity 0.3s ease;
                    backdrop-filter: blur(3px);
                }
                .moekoe-panel {
                    position: fixed;
                    top: 50%;
                    left: 50%;
                    transform: translate(-50%, -50%) scale(0.95);
                    background: rgba(30, 30, 35, 0.98);
                    color: white;
                    border-radius: 16px;
                    padding: 24px;
                    z-index: 10002;
                    width: 480px;
                    max-width: 92vw;
                    max-height: 80vh;
                    display: flex;
                    flex-direction: column;
                    backdrop-filter: blur(10px);
                    border: 1px solid rgba(255, 255, 255, 0.08);
                    box-shadow: 0 24px 80px rgba(0, 0, 0, 0.6);
                    opacity: 0;
                    transition: opacity 0.3s ease, transform 0.3s ease;
                }
                .moekoe-panel.active {
                    opacity: 1;
                    transform: translate(-50%, -50%) scale(1);
                }
                .moekoe-panel-header {
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                    margin-bottom: 16px;
                    flex-shrink: 0;
                }
                .moekoe-panel-header h3 {
                    margin: 0;
                    color: var(--color-primary);
                    font-size: 18px;
                    font-weight: 600;
                }
                .moekoe-panel-close {
                    background: rgba(255, 255, 255, 0.08);
                    border: none;
                    color: white;
                    font-size: 22px;
                    cursor: pointer;
                    border-radius: 50%;
                    width: 32px;
                    height: 32px;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    transition: background-color 0.2s ease;
                }
                .moekoe-panel-close:hover {
                    background: rgba(255, 255, 255, 0.18);
                }
                .moekoe-panel-body {
                    flex: 1;
                    overflow-y: auto;
                    margin-bottom: 16px;
                }
                .moekoe-panel-footer {
                    display: flex;
                    justify-content: flex-end;
                    gap: 10px;
                    flex-shrink: 0;
                    padding-top: 12px;
                    border-top: 1px solid rgba(255, 255, 255, 0.06);
                }
                .moekoe-btn {
                    padding: 8px 20px;
                    border-radius: 8px;
                    border: none;
                    font-size: 13px;
                    font-weight: 500;
                    cursor: pointer;
                    transition: all 0.2s ease;
                    outline: none;
                }
                .moekoe-btn:focus-visible {
                    box-shadow: 0 0 0 2px var(--color-primary-light);
                }
                .moekoe-btn-primary {
                    background: var(--color-primary);
                    color: white;
                }
                .moekoe-btn-primary:hover {
                    background: var(--secondary-color);
                    transform: scale(1.02);
                }
                @keyframes waveFlow {
                    0% { background-position: 0 0; }
                    100% { background-position: 28px 0; }
                }

                .moekoe-btn-secondary {
                    background: rgba(255, 255, 255, 0.08);
                    color: white;
                }
                .moekoe-btn-secondary:hover {
                    background: rgba(255, 255, 255, 0.15);
                }
                .moekoe-btn-danger {
                    background: rgba(244, 67, 54, 0.2);
                    color: #f44336;
                }
                .moekoe-btn-danger:hover {
                    background: rgba(244, 67, 54, 0.3);
                }
                .moekoe-form-group {
                    margin-bottom: 16px;
                }
                .moekoe-form-group label {
                    display: block;
                    font-size: 13px;
                    color: rgba(255, 255, 255, 0.6);
                    margin-bottom: 4px;
                }
                .moekoe-form-group input[type="text"],
                .moekoe-form-group input[type="password"] {
                    width: 100%;
                    padding: 8px 12px;
                    border-radius: 8px;
                    border: 1px solid rgba(255, 255, 255, 0.12);
                    background: rgba(255, 255, 255, 0.06);
                    color: white;
                    font-size: 14px;
                    outline: none;
                    transition: border-color 0.2s ease;
                    box-sizing: border-box;
                }
                .moekoe-form-group input:focus {
                    border-color: var(--color-primary);
                }
                .moekoe-form-group input[type="checkbox"] {
                    width: 18px;
                    height: 18px;
                    accent-color: var(--color-primary);
                    cursor: pointer;
                }
                .moekoe-form-group .checkbox-label {
                    display: flex;
                    align-items: center;
                    gap: 8px;
                    font-size: 14px;
                    color: rgba(255, 255, 255, 0.8);
                    cursor: pointer;
                }
                .moekoe-form-hint {
                    font-size: 12px;
                    color: rgba(255, 255, 255, 0.3);
                    margin-top: 4px;
                }
                .moekoe-test-result {
                    margin-top: 8px;
                    font-size: 13px;
                    padding: 6px 12px;
                    border-radius: 6px;
                }
                .moekoe-test-result.success {
                    background: rgba(29, 185, 84, 0.15);
                    color: #1db954;
                }
                .moekoe-test-result.error {
                    background: rgba(244, 67, 54, 0.15);
                    color: #f44336;
                }
                /* 播放列表专用（无搜索） */
                .moekoe-playlist-list {
                    flex: 1;
                    overflow-y: auto;
                    margin-bottom: 16px;
                    min-height: 0;
                }
                .moekoe-playlist-list::-webkit-scrollbar {
                    width: 4px;
                }
                .moekoe-playlist-list::-webkit-scrollbar-track {
                    background: rgba(255, 255, 255, 0.05);
                    border-radius: 2px;
                }
                .moekoe-playlist-list::-webkit-scrollbar-thumb {
                    background: rgba(255, 255, 255, 0.2);
                    border-radius: 2px;
                }
                .moekoe-playlist-item {
                    display: flex;
                    align-items: center;
                    padding: 8px 12px;
                    border-radius: 8px;
                    cursor: pointer;
                    transition: background-color 0.15s ease;
                    gap: 12px;
                    user-select: none;
                }
                .moekoe-playlist-item:hover {
                    background: rgba(255, 255, 255, 0.06);
                }
                .moekoe-playlist-item.selected {
                    background: rgba(29, 185, 84, 0.15);
                }
                .moekoe-playlist-item-checkbox {
                    width: 18px;
                    height: 18px;
                    border-radius: 4px;
                    border: 2px solid rgba(255, 255, 255, 0.25);
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    flex-shrink: 0;
                    transition: all 0.2s ease;
                    color: transparent;
                    font-size: 12px;
                }
                .moekoe-playlist-item.selected .moekoe-playlist-item-checkbox {
                    background: #1db954;
                    border-color: #1db954;
                    color: white;
                }
                .moekoe-playlist-item-info {
                    flex: 1;
                    min-width: 0;
                }
                .moekoe-playlist-item-name {
                    font-size: 14px;
                    font-weight: 500;
                    white-space: nowrap;
                    overflow: hidden;
                    text-overflow: ellipsis;
                }
                .moekoe-playlist-item-artist {
                    font-size: 12px;
                    color: rgba(255, 255, 255, 0.5);
                    white-space: nowrap;
                    overflow: hidden;
                    text-overflow: ellipsis;
                }
                .moekoe-playlist-item-index {
                    font-size: 12px;
                    color: rgba(255, 255, 255, 0.25);
                    flex-shrink: 0;
                    width: 24px;
                    text-align: right;
                }
                .moekoe-playlist-footer {
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                    flex-shrink: 0;
                    padding-top: 12px;
                    border-top: 1px solid rgba(255, 255, 255, 0.06);
                }
                .moekoe-playlist-stats {
                    font-size: 13px;
                    color: rgba(255, 255, 255, 0.5);
                }
                .moekoe-playlist-select-all {
                    font-size: 13px;
                    color: rgba(255, 255, 255, 0.5);
                    cursor: pointer;
                    transition: color 0.2s ease;
                    background: none;
                    border: none;
                    padding: 0;
                }
                .moekoe-playlist-select-all:hover {
                    color: white;
                }
                .moekoe-playlist-item.drag-hover {
                    background: rgba(255, 107, 107, 0.12);
                }
                .moekoe-playlist-item.drag-hover {
                    background: rgba(255, 107, 107, 0.12);
                }
                .moekoe-playlist-empty {
                    text-align: center;
                    color: rgba(255, 255, 255, 0.3);
                    padding: 40px 0;
                    font-size: 14px;
                }
                .moekoe-btn-wrapper {
                    position: relative;
                    display: inline-flex;
                    align-items: center;
                }
            `;
            document.head.appendChild(style);
        }

        // ==================== 全局监听 ====================
        setupGlobalListeners() {
            window.addEventListener('beforeunload', () => {
                if (this.isDownloading) {
                    this.cancelCurrentDownload();
                }
            });
        }

        // ==================== 从页面提取音乐信息 ====================
        extractMusicInfo() {
            try {
                const playerBar = document.querySelector('.player-bar');
                if (!playerBar) {
                    logger.warn('未找到播放器栏');
                    return null;
                }

                const titleElem = playerBar.querySelector('.song-title');
                const artistElem = playerBar.querySelector('.artist');

                if (!titleElem || !artistElem) {
                    logger.warn('未找到音乐信息元素');
                    return null;
                }

                const title = titleElem.textContent.trim();
                const artist = artistElem.textContent.trim();

                let hash = null;
                let img = null;
                try {
                    const songData = JSON.parse(localStorage.getItem('current_song') || '{}');
                    if (songData && songData.hash) {
                        hash = songData.hash;
                    }
                    if (songData && songData.img) {
                        img = this.cleanUrl(songData.img);
                    }
                } catch (e) { }

                if (!hash) {
                    const hashElem = document.querySelector('[data-hash]');
                    if (hashElem) {
                        hash = hashElem.getAttribute('data-hash');
                    }
                }

                const audioUrl = this.getAudioUrl();

                return {
                    title,
                    artist,
                    hash: hash,
                    img: img,
                    url: audioUrl,
                    timestamp: Date.now()
                };
            } catch (error) {
                logger.error('提取音乐信息失败:', error);
                return null;
            }
        }

        getAudioUrl() {
            let audioUrl = null;
            const audioElement = document.querySelector('audio');
            if (audioElement && audioElement.src && audioElement.src.startsWith('http')) {
                audioUrl = audioElement.src;
                logger.log('从audio元素获取URL:', audioUrl);
            }
            if (!audioUrl) {
                try {
                    const currentSong = JSON.parse(localStorage.getItem('current_song') || '{}');
                    if (currentSong && currentSong.url) {
                        audioUrl = this.cleanUrl(currentSong.url);
                        logger.log('从localStorage获取URL:', audioUrl);
                    }
                } catch (e) { }
            }
            if (!audioUrl) {
                audioUrl = this.extractAudioUrlFromPage();
            }
            return audioUrl;
        }

        extractAudioUrlFromPage() {
            try {
                const scripts = document.querySelectorAll('script');
                for (const script of scripts) {
                    const content = script.textContent || script.innerText;
                    const urlPatterns = [
                        /https?:\/\/[^"'\s]+\.(mp3|m4a|flac|wav|aac|ogg)[^"'\s]*/gi,
                        /audioUrl\s*[:=]\s*["']([^"']+)["']/i,
                        /src\s*[:=]\s*["']([^"']+\.(mp3|m4a|flac|wav|aac|ogg)[^"']*)["']/i
                    ];
                    for (const pattern of urlPatterns) {
                        const matches = content.match(pattern);
                        if (matches && matches[0]) {
                            const url = matches[0].replace(/["']/g, '');
                            logger.log('从脚本中提取到音频URL:', url);
                            return url;
                        }
                    }
                }
            } catch (error) {
                logger.warn('从页面脚本提取音频URL失败:', error);
            }
            return null;
        }

        // ==================== 通过Hash获取歌曲URL ====================
        async fetchSongUrlByHash(hash, quality = 'high') {
            try {
                // 【修改】强制注册设备，失败则抛出错误
                await this.registerDevice();
                const url = `http://127.0.0.1:6521/song/url?hash=${hash}&quality=${quality}&ppage_id=356753938`;
                logger.log(`获取歌曲URL: ${url}`);

                const authHeader = this.getAuthHeader(); // 需要实现此方法

                const response = await fetch(url, {
                    method: 'GET',
                    headers: {
                        'Accept': 'application/json',
                        'Referer': window.location.origin,
                        'Origin': window.location.origin,
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                        // ★★★ 添加 Authorization 头 ★★★
                        'Authorization': authHeader
                    }
                });

                if (!response.ok) {
                    const text = await response.text();
                    throw new Error(`HTTP ${response.status} - ${text.substring(0, 100)}`);
                }

                const data = await response.json();

                // ★★★ 核心修复：处理 url 为数组的情况 ★★★
                let downloadUrl = null;
                if (data.url) {
                    if (Array.isArray(data.url) && data.url.length > 0) {
                        downloadUrl = data.url[0];      // 取第一个镜像
                    } else if (typeof data.url === 'string') {
                        downloadUrl = data.url;
                    }
                }
                // 兼容 backupUrl
                if (!downloadUrl && data.backupUrl && Array.isArray(data.backupUrl) && data.backupUrl.length > 0) {
                    downloadUrl = data.backupUrl[0];
                }
                // 兜底：如果 data 本身是字符串 URL
                if (!downloadUrl && typeof data === 'string' && data.startsWith('http')) {
                    downloadUrl = data;
                }

                if (downloadUrl) {
                    logger.log('成功获取下载链接:', downloadUrl);
                    return downloadUrl;
                }

                throw new Error('响应中没有可用的 URL');
            } catch (error) {
                logger.error(`获取歌曲URL失败 (hash: ${hash}):`, error);
                throw error;
            }
        }

        async registerDevice() {
            try {
                const response = await fetch('http://127.0.0.1:6521/register/dev', {
                    method: 'GET',
                    headers: { 'Accept': 'application/json' }
                });
                if (!response.ok) {
                    throw new Error(`注册设备失败 HTTP ${response.status}`);
                }
                const data = await response.json();
                logger.log('设备注册成功:', data);
                return data;
            } catch (e) {
                logger.error('设备注册失败:', e);
                // 修改：抛出异常，不再返回 null
                throw new Error('设备注册失败: ' + e.message);
            }
        }
        // 自动从 localStorage 中提取认证信息
        // 从 MoeData 中获取认证头
        getAuthHeader() {
            try {
                const raw = localStorage.getItem('MoeData');
                if (!raw) {
                    logger.warn('未找到 MoeData');
                    return '';
                }
                const data = JSON.parse(raw);
                const token = data.UserInfo?.token || '';
                const userid = data.UserInfo?.userid || data.UserInfo?.uid || '';
                const dfid = data.Device?.dfid || '';
                if (token && userid && dfid) {
                    return `token=${token};userid=${userid};dfid=${dfid}`;
                } else {
                    logger.warn('MoeData 中认证信息不全', { token: !!token, userid: !!userid, dfid: !!dfid });
                    return '';
                }
            } catch (e) {
                logger.error('解析 MoeData 失败:', e);
                return '';
            }
        }
        // ==================== 工具函数 ====================
        sanitizeFilename(name) {
            if (!name) return 'unknown';
            return name
                .replace(/[<>:"/\\|?*]/g, '_')
                .replace(/[\x00-\x1F\x7F]/g, '_')
                .replace(/^\.+|\.+$/g, '_')
                .replace(/^CON$|^PRN$|^AUX$|^NUL$|^COM[1-9]$|^LPT[1-9]$/gi, '_');
        }

        cleanUrl(url) {
            if (!url) return url;
            return String(url).replace(/[`"']/g, '').trim();
        }

        isAbsolutePath(path) {
            if (!path || !path.trim()) return false;
            const trimmed = path.trim();
            return /^[A-Za-z]:[/\\]/.test(trimmed) || trimmed.startsWith('/');
        }

        getImageExtension(url) {
            if (!url) return 'jpg';
            const urlWithoutParams = url.split('?')[0];
            const extMatch = urlWithoutParams.match(/\.([a-zA-Z0-9]+)$/);
            if (extMatch) {
                const ext = extMatch[1].toLowerCase();
                if (['jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp'].includes(ext)) {
                    return ext;
                }
            }
            return 'jpg';
        }

        getFileExtension(url) {
            if (!url) return 'mp3';
            const urlWithoutParams = url.split('?')[0];
            const extMatch = urlWithoutParams.match(/\.([a-zA-Z0-9]+)$/);
            if (extMatch) {
                const ext = extMatch[1].toLowerCase();
                if (['mp3', 'm4a', 'flac', 'wav', 'ogg', 'aac'].includes(ext)) {
                    return ext;
                }
            }
            if (url.includes('m4a') || url.includes('aac')) return 'm4a';
            if (url.includes('flac')) return 'flac';
            if (url.includes('wav')) return 'wav';
            if (url.includes('ogg')) return 'ogg';
            return 'mp3';
        }

        generateFileName(musicInfo) {
            const safeTitle = this.sanitizeFilename(musicInfo.title);
            const safeArtist = this.sanitizeFilename(musicInfo.artist);
            const extension = this.getFileExtension(musicInfo.url);

            let fileName;
            if (safeArtist && safeArtist !== '未知艺术家' && safeArtist !== '') {
                fileName = `${safeArtist} - ${safeTitle}`;
            } else {
                fileName = safeTitle;
            }
            if (fileName.length > 200) {
                fileName = fileName.substring(0, 200);
            }
            return `${fileName}.${extension}`;
        }

        sleep(ms) {
            return new Promise(resolve => setTimeout(resolve, ms));
        }

        // ==================== 下载历史 ====================
        saveDownloadHistory(musicInfo, fileName, rpcGid = null) {
            try {
                const history = ConfigManager.getHistory();
                const record = {
                    title: musicInfo.title,
                    artist: musicInfo.artist,
                    hash: musicInfo.hash || null,
                    url: musicInfo.url,
                    fileName: fileName,
                    rpcGid: rpcGid,
                    downloadedAt: new Date().toISOString(),
                    source: 'rpc'
                };
                history.unshift(record);
                if (history.length > 100) history.length = 100;
                ConfigManager.saveHistory(history);
                logger.log('下载历史已保存');
            } catch (error) {
                logger.warn('保存下载历史失败:', error);
            }
        }

        // ==================== 单曲下载 ====================
        async downloadCurrentSong() {
            if (this.isDownloading) {
                this.showNotification('当前正在下载中，请稍候...', 'warning');
                return;
            }

            this.isDownloading = true;
            this.updateDownloadButtonState(true);

            try {
                const musicInfo = this.extractMusicInfo();
                if (!musicInfo) throw new Error('无法获取音乐信息');

                if (!musicInfo.url && musicInfo.hash) {
                    this.showNotification('正在获取歌曲链接...', 'downloading');
                    musicInfo.url = await this.fetchSongUrlByHash(musicInfo.hash);
                }

                if (!musicInfo.url) throw new Error('无法获取音频链接');

                logger.log('开始下载:', musicInfo);
                const fileName = this.generateFileName(musicInfo);

                this.showNotification('正在连接Motrix...', 'downloading');
                await this.rpcClient.ensureRunning();

                const downloadDir = ConfigManager.get('downloadDir');
                console.log('[MoeKoe] downloadDir:', JSON.stringify(downloadDir));
                const validDir = this.isAbsolutePath(downloadDir) ? downloadDir : undefined;
                console.log('[MoeKoe] validDir:', JSON.stringify(validDir));
                if (downloadDir && !validDir) {
                    this.showNotification('下载目录不是绝对路径，将使用默认目录', 'warning');
                }
                const gid = await this.rpcClient.addDownload(musicInfo.url, {
                    filename: fileName,
                    dir: validDir,
                    referer: window.location.origin,
                    headers: {
                        'Referer': window.location.origin,
                        'Origin': window.location.origin
                    }
                });

                this.saveDownloadHistory(musicInfo, fileName, gid);

                let msg = `已添加到Motrix: ${fileName}`;
                if (ConfigManager.get('downloadImage') && musicInfo.img) {
                    const imgExt = this.getImageExtension(musicInfo.img);
                    const imgFileName = fileName.replace(/\.[^.]+$/, '') + '.' + imgExt;
                    try {
                        await this.rpcClient.addDownload(musicInfo.img, {
                            filename: imgFileName,
                            dir: validDir,
                            referer: window.location.origin,
                            headers: {
                                'Referer': window.location.origin,
                                'Origin': window.location.origin
                            }
                        });
                        msg += ' + 封面图片';
                    } catch (imgErr) {
                        logger.warn('下载封面图片失败:', imgErr);
                    }
                }
                this.showNotification(msg, 'success');

            } catch (error) {
                logger.error('下载失败:', error);
                this.showNotification(`下载失败: ${error.message}`, 'error');
            } finally {
                this.isDownloading = false;
                this.updateDownloadButtonState(false);
            }
        }

        // ==================== 播放列表批量下载 ====================
        async downloadPlaylist() {
            let queueData = [];
            try {
                const raw = localStorage.getItem('MusicQueue');
                if (!raw) {
                    this.showNotification('播放列表为空 (MusicQueue)', 'warning');
                    return;
                }
                const parsed = JSON.parse(raw);
                if (parsed && parsed.queue && Array.isArray(parsed.queue)) {
                    queueData = parsed.queue;
                } else if (Array.isArray(parsed)) {
                    queueData = parsed;
                } else {
                    throw new Error('无法解析播放列表数据');
                }
            } catch (e) {
                logger.error('读取MusicQueue失败:', e);
                this.showNotification('读取播放列表失败: ' + e.message, 'error');
                return;
            }

            if (queueData.length === 0) {
                this.showNotification('播放列表为空', 'warning');
                return;
            }

            this.showPlaylistSelector(queueData);
        }

        // ==================== 播放列表选择弹窗（无搜索、全选正常） ====================
        // ==================== 播放列表选择弹窗（修复版） ====================
        showPlaylistSelector(queueData) {
            // 移除旧弹窗
            const oldOverlay = document.querySelector('.moekoe-overlay');
            if (oldOverlay) oldOverlay.remove();

            const overlay = document.createElement('div');
            overlay.className = 'moekoe-overlay';

            const panel = document.createElement('div');
            panel.className = 'moekoe-panel';
            panel.style.width = '640px';

            // 存储选中索引的 Set（默认全选）
            const allSelected = new Set(queueData.map((_, i) => i));

            // ---------- 渲染列表 ----------
            const renderList = () => {
                if (queueData.length === 0) {
                    listContainer.innerHTML = '<div class="moekoe-playlist-empty">没有歌曲</div>';
                    updateUI();
                    return;
                }

                let html = '';
                queueData.forEach((item, index) => {
                    const isSelected = allSelected.has(index);
                    html += `
                        <div class="moekoe-playlist-item ${isSelected ? 'selected' : ''}" data-index="${index}">
                            <div class="moekoe-playlist-item-checkbox">${isSelected ? '✓' : ''}</div>
                            <div class="moekoe-playlist-item-info">
                                <div class="moekoe-playlist-item-name">${this.escapeHtml(item.name || '未知歌曲')}</div>
                                <div class="moekoe-playlist-item-artist">${this.escapeHtml(item.author || '未知艺术家')}</div>
                            </div>
                            <div class="moekoe-playlist-item-index">#${index + 1}</div>
                        </div>
                    `;
                });
                listContainer.innerHTML = html;
                updateUI();
            };

            // ---------- 更新 UI（关键修复：使用 Array.from） ----------
            const updateUI = () => {
                const items = listContainer.querySelectorAll('.moekoe-playlist-item');
                // 转为数组才能使用 filter / every
                const itemsArray = Array.from(items);
                const selectedCount = itemsArray.filter(el => el.classList.contains('selected')).length;
                statsEl.textContent = `已选 ${selectedCount} / ${queueData.length} 首`;
                downloadBtn.textContent = `下载选中 (${selectedCount})`;
                downloadBtn.disabled = selectedCount === 0;

                const allChecked = itemsArray.length > 0 && itemsArray.every(el => el.classList.contains('selected'));
                selectAllBtn.textContent = allChecked ? '取消全选' : '全选';
            };

            // ---------- 构建面板 HTML（无搜索框） ----------
            panel.innerHTML = `
                <div class="moekoe-panel-header">
                    <h3>📋 选择要下载的歌曲</h3>
                    <button class="moekoe-panel-close" id="playlist-close">×</button>
                </div>
                <div class="moekoe-playlist-list" id="playlist-list"></div>
                <div class="moekoe-playlist-footer">
                    <div style="display:flex;align-items:center;gap:12px;">
                        <span class="moekoe-playlist-stats" id="playlist-stats">已选 0 / ${queueData.length} 首</span>
                        <button class="moekoe-playlist-select-all" id="playlist-select-all">全选</button>
                    </div>
                    <div class="moekoe-playlist-actions">
                        <button class="moekoe-btn moekoe-btn-secondary" id="playlist-cancel">取消</button>
                        <button class="moekoe-btn moekoe-btn-primary" id="playlist-download">下载选中 (0)</button>
                    </div>
                </div>
            `;

            overlay.appendChild(panel);
            document.body.appendChild(overlay);

            // 显示动画
            setTimeout(() => {
                overlay.style.opacity = '1';
                panel.classList.add('active');
            }, 10);

            // 获取 DOM 引用
            const listContainer = panel.querySelector('#playlist-list');
            const statsEl = panel.querySelector('#playlist-stats');
            const downloadBtn = panel.querySelector('#playlist-download');
            const selectAllBtn = panel.querySelector('#playlist-select-all');

            // ---------- 初始渲染 ----------
            renderList();

            // ---------- 事件：点击歌曲项（事件委托） ----------
            listContainer.addEventListener('click', function (e) {
                const item = e.target.closest('.moekoe-playlist-item');
                if (!item) return;
                const index = parseInt(item.dataset.index);
                if (isNaN(index)) return;

                if (allSelected.has(index)) {
                    allSelected.delete(index);
                    item.classList.remove('selected');
                    item.querySelector('.moekoe-playlist-item-checkbox').textContent = '';
                } else {
                    allSelected.add(index);
                    item.classList.add('selected');
                    item.querySelector('.moekoe-playlist-item-checkbox').textContent = '✓';
                }
                updateUI();
            });

            // ---------- 拖拽滑动选取（边缘持续滚动 + 全body拖拽） ----------
            let isDragging = false;
            let dragAnchorIndex = -1;
            let dragSelectMode = null;
            const dragToggled = new Set();
            let autoScrollTimer = null;
            let lastMouseX = 0;
            let lastMouseY = 0;
            let lastContainerRect = null;

            const EDGE_THRESHOLD = 50;
            const BASE_SCROLL_SPEED = 4;
            const MAX_SCROLL_SPEED = 15;

            const getScrollInfo = function () {
                if (!lastContainerRect) return { dir: 0, speed: 0 };
                const distFromTop = lastMouseY - lastContainerRect.top;
                const distFromBottom = lastContainerRect.bottom - lastMouseY;
                if (distFromTop < EDGE_THRESHOLD && distFromTop > 0 && listContainer.scrollTop > 0) {
                    return { dir: -1, speed: Math.max(BASE_SCROLL_SPEED, MAX_SCROLL_SPEED * (1 - distFromTop / EDGE_THRESHOLD)) };
                }
                if (distFromBottom < EDGE_THRESHOLD && distFromBottom > 0 && listContainer.scrollTop < listContainer.scrollHeight - listContainer.clientHeight) {
                    return { dir: 1, speed: Math.max(BASE_SCROLL_SPEED, MAX_SCROLL_SPEED * (1 - distFromBottom / EDGE_THRESHOLD)) };
                }
                return { dir: 0, speed: 0 };
            };

            const startAutoScroll = function () {
                if (autoScrollTimer) return;
                autoScrollTimer = setInterval(() => {
                    if (!isDragging) { stopAutoScroll(); return; }
                    const info = getScrollInfo();
                    if (info.dir === 0) return;
                    listContainer.scrollTop += info.dir * info.speed;
                    const elem = document.elementFromPoint(lastMouseX, lastMouseY);
                    if (elem) {
                        const item = elem.closest('.moekoe-playlist-item');
                        if (item) {
                            const index = parseInt(item.dataset.index);
                            if (!isNaN(index) && !dragToggled.has(index)) {
                                dragToggled.add(index);
                                if (dragSelectMode) {
                                    allSelected.add(index);
                                    item.classList.add('selected');
                                    item.querySelector('.moekoe-playlist-item-checkbox').textContent = '✓';
                                } else {
                                    allSelected.delete(index);
                                    item.classList.remove('selected');
                                    item.querySelector('.moekoe-playlist-item-checkbox').textContent = '';
                                }
                                updateUI();
                            }
                        }
                    }
                }, 16);
            };

            const stopAutoScroll = function () {
                if (autoScrollTimer) {
                    clearInterval(autoScrollTimer);
                    autoScrollTimer = null;
                }
            };

            listContainer.addEventListener('mousedown', function (e) {
                const item = e.target.closest('.moekoe-playlist-item');
                if (!item) return;
                e.preventDefault();
                const index = parseInt(item.dataset.index);
                if (isNaN(index)) return;

                isDragging = true;
                dragAnchorIndex = index;
                dragToggled.clear();
                lastMouseX = e.clientX;
                lastMouseY = e.clientY;
                lastContainerRect = listContainer.getBoundingClientRect();

                if (allSelected.has(index)) {
                    dragSelectMode = false;
                    allSelected.delete(index);
                    item.classList.remove('selected');
                    item.querySelector('.moekoe-playlist-item-checkbox').textContent = '';
                } else {
                    dragSelectMode = true;
                    allSelected.add(index);
                    item.classList.add('selected');
                    item.querySelector('.moekoe-playlist-item-checkbox').textContent = '✓';
                }
                dragToggled.add(index);
                updateUI();
                startAutoScroll();
            });

            document.addEventListener('mousemove', function (e) {
                if (!isDragging) return;
                lastMouseX = e.clientX;
                lastMouseY = e.clientY;
                lastContainerRect = listContainer.getBoundingClientRect();

                const item = e.target.closest('.moekoe-playlist-item');
                if (!item) return;
                const index = parseInt(item.dataset.index);
                if (isNaN(index) || dragToggled.has(index)) return;

                dragToggled.add(index);

                if (dragSelectMode) {
                    allSelected.add(index);
                    item.classList.add('selected');
                    item.querySelector('.moekoe-playlist-item-checkbox').textContent = '✓';
                } else {
                    allSelected.delete(index);
                    item.classList.remove('selected');
                    item.querySelector('.moekoe-playlist-item-checkbox').textContent = '';
                }
                updateUI();
            });

            const stopDrag = function () {
                if (isDragging) {
                    isDragging = false;
                    dragAnchorIndex = -1;
                    dragSelectMode = null;
                    dragToggled.clear();
                    stopAutoScroll();
                }
            };

            document.addEventListener('mouseup', stopDrag);

            // ---------- 全选/取消全选 ----------
            selectAllBtn.addEventListener('click', function () {
                const items = listContainer.querySelectorAll('.moekoe-playlist-item');
                const itemsArray = Array.from(items);
                if (itemsArray.length === 0) return;
                const allChecked = itemsArray.every(el => el.classList.contains('selected'));

                if (allChecked) {
                    // 全部取消
                    allSelected.clear();
                    itemsArray.forEach(el => {
                        el.classList.remove('selected');
                        el.querySelector('.moekoe-playlist-item-checkbox').textContent = '';
                    });
                } else {
                    // 全部选中
                    itemsArray.forEach(el => {
                        const idx = parseInt(el.dataset.index);
                        allSelected.add(idx);
                        el.classList.add('selected');
                        el.querySelector('.moekoe-playlist-item-checkbox').textContent = '✓';
                    });
                }
                updateUI();
            });

            // ---------- 下载 ----------
            downloadBtn.addEventListener('click', async () => {
                const selectedIndices = [];
                listContainer.querySelectorAll('.moekoe-playlist-item.selected').forEach(el => {
                    selectedIndices.push(parseInt(el.dataset.index));
                });

                if (selectedIndices.length === 0) {
                    this.showNotification('请至少选择一首歌曲', 'warning');
                    return;
                }

                const selectedSongs = selectedIndices.map(i => queueData[i]);
                closePanel();
                await this.batchDownloadSongs(selectedSongs);
            });

            // ---------- 关闭面板 ----------
            const closePanel = () => {
                overlay.style.opacity = '0';
                panel.classList.remove('active');
                setTimeout(() => {
                    if (overlay.parentNode) overlay.remove();
                }, 300);
                document.removeEventListener('keydown', escHandler);
            };

            const escHandler = (e) => {
                if (e.key === 'Escape') closePanel();
            };
            document.addEventListener('keydown', escHandler);

            panel.querySelector('#playlist-close').addEventListener('click', closePanel);
            panel.querySelector('#playlist-cancel').addEventListener('click', closePanel);
            overlay.addEventListener('click', (e) => {
                if (e.target === overlay) closePanel();
            });

            updateUI();
        }
        escapeHtml(str) {
            if (!str) return '';
            const div = document.createElement('div');
            div.textContent = str;
            return div.innerHTML;
        }

        // ==================== 批量下载歌曲 ====================
        async batchDownloadSongs(songs) {
            if (this.isBatchDownloading) {
                this.showNotification('批量下载正在进行中...', 'warning');
                return;
            }

            this.isBatchDownloading = true;
            this.batchTotal = songs.length;
            this.batchCompleted = 0;
            this.downloadProgress = {};
            this.showProgressBar(true, 0);

            this.showNotification(`开始批量下载 ${songs.length} 首歌曲...`, 'downloading');

            try {
                await this.rpcClient.ensureRunning();
            } catch (error) {
                this.showNotification(`RPC连接失败: ${error.message}`, 'error');
                this.isBatchDownloading = false;
                this.showProgressBar(false);
                return;
            }

            const results = [];
            for (let i = 0; i < songs.length; i++) {
                const song = songs[i];
                try {
                    this.updateProgress(i / songs.length, `获取 ${song.name || '歌曲'} 的链接...`);

                    let url = null;
                    if (song.hash) {
                        try {
                            url = await this.fetchSongUrlByHash(song.hash);
                        } catch (e) {
                            logger.warn(`获取歌曲URL失败 (${song.name}):`, e);
                        }
                    }

                    if (!url) {
                        const currentInfo = this.extractMusicInfo();
                        if (currentInfo && currentInfo.hash === song.hash) {
                            url = currentInfo.url;
                        }
                    }

                    if (!url) {
                        throw new Error(`无法获取歌曲链接: ${song.name}`);
                    }

                    const fileName = this.generateFileName({
                        title: song.name || '未知歌曲',
                        artist: song.author || '未知艺术家',
                        url: url
                    });

                    const downloadDir = ConfigManager.get('downloadDir');
                    const validDir = this.isAbsolutePath(downloadDir) ? downloadDir : undefined;
                    if (downloadDir && !validDir) {
                        this.showNotification('下载目录不是绝对路径，将使用默认目录', 'warning');
                    }
                    const gid = await this.rpcClient.addDownload(url, {
                        filename: fileName,
                        dir: validDir,
                        referer: window.location.origin,
                        headers: {
                            'Referer': window.location.origin,
                            'Origin': window.location.origin
                        }
                    });

                    this.saveDownloadHistory({
                        title: song.name || '未知歌曲',
                        artist: song.author || '未知艺术家',
                        hash: song.hash,
                        url: url
                    }, fileName, gid);

                    if (ConfigManager.get('downloadImage') && song.img) {
                        const cleanImg = this.cleanUrl(song.img);
                        const imgExt = this.getImageExtension(cleanImg);
                        const imgFileName = fileName.replace(/\.[^.]+$/, '') + '.' + imgExt;
                        try {
                            await this.rpcClient.addDownload(cleanImg, {
                                filename: imgFileName,
                                dir: validDir,
                                referer: window.location.origin,
                                headers: {
                                    'Referer': window.location.origin,
                                    'Origin': window.location.origin
                                }
                            });
                        } catch (imgErr) {
                            logger.warn('下载封面图片失败:', imgErr);
                        }
                    }

                    this.batchCompleted++;
                    this.updateProgress((i + 1) / songs.length, `已完成 ${this.batchCompleted}/${songs.length}`);

                    results.push({ success: true, song, gid });

                    if (i < songs.length - 1) {
                        await this.sleep(500 + Math.random() * 1000);
                    }

                } catch (error) {
                    logger.error(`下载歌曲失败 (${song.name}):`, error);
                    results.push({ success: false, song, error: error.message });
                    this.batchCompleted++;
                }
            }

            this.isBatchDownloading = false;
            this.showProgressBar(false);

            const successCount = results.filter(r => r.success).length;
            const failCount = results.filter(r => !r.success).length;

            if (failCount === 0) {
                this.showNotification(`✅ 全部 ${successCount} 首歌曲已添加到Motrix`, 'success');
            } else {
                this.showNotification(`⚠️ ${successCount} 首成功，${failCount} 首失败`, 'warning');
            }

            logger.log('批量下载完成:', results);
        }

        // ==================== 进度条 ====================
        showProgressBar(show, progress = 0, label = '') {
            const container = document.querySelector('.moekoe-progress-container');
            if (!container) return;

            const track = container.querySelector('.moekoe-progress-track');

            if (!show) {
                container.classList.remove('active');
                if (track) {
                    track.style.width = '0%';
                    track.classList.remove('wave');
                }
                if (this._hideTimer) {
                    clearTimeout(this._hideTimer);
                    this._hideTimer = null;
                }
                return;
            }

            container.classList.add('active');
            if (track) {
                const pct = Math.min(100, Math.max(0, progress * 100));
                track.style.width = pct + '%';
                if (pct < 100) {
                    track.classList.add('wave');
                } else {
                    track.classList.remove('wave');
                }
            }
        }

        updateProgress(progress, label = '') {
            this.showProgressBar(true, progress);
            const container = document.querySelector('.moekoe-progress-container');
            if (container && label) {
                container.title = label;
            }
            // 当进度达到 100% 时，启动延迟隐藏
            if (progress >= 1) {
                if (this._hideTimer) {
                    clearTimeout(this._hideTimer);
                }
                this._hideTimer = setTimeout(() => {
                    this.showProgressBar(false);
                    this._hideTimer = null;
                }, 3000); // 停留 3 秒后消失
            } else {
                // 如果进度未完成但之前有定时器，取消
                if (this._hideTimer) {
                    clearTimeout(this._hideTimer);
                    this._hideTimer = null;
                }
            }
        }

        // ==================== 按钮注入 ====================
        injectDownloadButton() {
            const checkInterval = setInterval(() => {
                const extraControls = document.querySelector('.player-bar .extra-controls');
                if (extraControls) {
                    clearInterval(checkInterval);

                    const existingBtn = document.querySelector('.moekoe-download-btn');
                    if (existingBtn) {
                        const wrapper = existingBtn.closest('.moekoe-btn-wrapper');
                        if (wrapper) wrapper.remove();
                        else existingBtn.remove();
                    }

                    const shareBtn = extraControls.querySelector('button.extra-btn[title="分享歌曲"]');
                    if (shareBtn) {
                        shareBtn.remove();
                        logger.log('已删除分享按钮');
                    }

                    const wrapper = document.createElement('span');
                    wrapper.className = 'moekoe-btn-wrapper';

                    const downloadBtn = document.createElement('button');
                    downloadBtn.className = 'extra-btn moekoe-download-btn';
                    downloadBtn.title = '下载当前歌曲 (RPC)';
                    downloadBtn.innerHTML = '<i class="fas fa-download"></i>';

                    downloadBtn.addEventListener('click', (e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        this.downloadCurrentSong();
                    });

                    downloadBtn.addEventListener('contextmenu', (e) => {
                        e.preventDefault();
                        this.showDownloadOptionsStable(e);
                    });

                    wrapper.appendChild(downloadBtn);

                    const progressContainer = document.createElement('div');
                    progressContainer.className = 'moekoe-progress-container';
                    progressContainer.innerHTML = `<div class="moekoe-progress-track"></div>`;
                    wrapper.appendChild(progressContainer);

                    const volumeControl = extraControls.querySelector('.volume-control');
                    if (volumeControl) {
                        volumeControl.parentNode.insertBefore(wrapper, volumeControl.nextSibling);
                    } else {
                        extraControls.appendChild(wrapper);
                    }

                    logger.log('下载按钮注入成功（带进度条）');
                }
            }, 500);

            setTimeout(() => {
                clearInterval(checkInterval);
            }, 10000);
        }

        // ==================== 右键菜单 ====================
        showDownloadOptionsStable(event) {
            event.preventDefault();
            event.stopPropagation();

            const existingMenu = document.querySelector('.moekoe-download-menu');
            if (existingMenu) existingMenu.remove();

            const musicInfo = this.extractMusicInfo();
            const fileName = musicInfo ? this.generateFileName(musicInfo) : '未知文件';
            const shortFileName = fileName.length > 35 ? fileName.substring(0, 32) + '...' : fileName;

            let playlistCount = 0;
            try {
                const raw = localStorage.getItem('MusicQueue');
                if (raw) {
                    const parsed = JSON.parse(raw);
                    if (parsed && parsed.queue) {
                        playlistCount = parsed.queue.length;
                    } else if (Array.isArray(parsed)) {
                        playlistCount = parsed.length;
                    }
                }
            } catch (e) { }

            // 测量菜单尺寸
            const hiddenMenu = document.createElement('div');
            hiddenMenu.style.cssText = `
                position: fixed;
                visibility: hidden;
                opacity: 0;
                top: -1000px;
                left: -1000px;
                background: rgba(0, 0, 0, 0.95);
                color: white;
                border-radius: 8px;
                padding: 8px 0;
                min-width: 200px;
                backdrop-filter: blur(10px);
                border: 1px solid rgba(255, 255, 255, 0.1);
                box-shadow: 0 8px 32px rgba(0, 0, 0, 0.3);
                z-index: -1;
            `;
            hiddenMenu.innerHTML = `
                <div style="padding:8px 16px;font-size:13px;display:flex;align-items:center;gap:8px;white-space:nowrap;">
                    <i class="fas fa-download" style="width:16px;text-align:center;"></i>
                    <span>下载: ${shortFileName}</span>
                </div>
                <div style="height:1px;background:rgba(255,255,255,0.1);margin:4px 0;"></div>
                <div style="padding:8px 16px;font-size:13px;display:flex;align-items:center;gap:8px;white-space:nowrap;">
                    <i class="fas fa-list" style="width:16px;text-align:center;"></i>
                    <span>下载播放列表 (${playlistCount}首)</span>
                </div>
                <div style="height:1px;background:rgba(255,255,255,0.1);margin:4px 0;"></div>
                <div style="padding:8px 16px;font-size:13px;display:flex;align-items:center;gap:8px;white-space:nowrap;">
                    <i class="fas fa-copy" style="width:16px;text-align:center;"></i>
                    <span>复制歌曲信息</span>
                </div>
                <div style="height:1px;background:rgba(255,255,255,0.1);margin:4px 0;"></div>
                <div style="padding:8px 16px;font-size:13px;display:flex;align-items:center;gap:8px;white-space:nowrap;">
                    <i class="fas fa-link" style="width:16px;text-align:center;"></i>
                    <span>复制下载链接</span>
                </div>
                <div style="height:1px;background:rgba(255,255,255,0.1);margin:4px 0;"></div>
                <div style="padding:8px 16px;font-size:13px;display:flex;align-items:center;gap:8px;white-space:nowrap;">
                    <i class="fas fa-history" style="width:16px;text-align:center;"></i>
                    <span>查看下载历史</span>
                </div>
                <div style="height:1px;background:rgba(255,255,255,0.1);margin:4px 0;"></div>
                <div style="padding:8px 16px;font-size:13px;display:flex;align-items:center;gap:8px;white-space:nowrap;">
                    <i class="fas fa-cog" style="width:16px;text-align:center;"></i>
                    <span>修改RPC设置</span>
                </div>
            `;

            document.body.appendChild(hiddenMenu);
            const menuWidth = hiddenMenu.offsetWidth;
            const menuHeight = hiddenMenu.offsetHeight;
            document.body.removeChild(hiddenMenu);

            const viewportWidth = window.innerWidth;
            const viewportHeight = window.innerHeight;

            let left = event.clientX;
            let top = event.clientY - menuHeight - 10;
            if (top < 10) top = event.clientY + 10;
            if (left + menuWidth > viewportWidth) left = viewportWidth - menuWidth - 10;
            if (left < 10) left = 10;
            if (top + menuHeight > viewportHeight) top = viewportHeight - menuHeight - 10;

            const menu = document.createElement('div');
            menu.className = 'moekoe-download-menu';
            menu.style.cssText = `
                position: fixed;
                top: ${top}px;
                left: ${left}px;
                background: rgba(0, 0, 0, 0.95);
                color: white;
                border-radius: 8px;
                padding: 8px 0;
                min-width: 200px;
                z-index: 10001;
                backdrop-filter: blur(10px);
                border: 1px solid rgba(255, 255, 255, 0.1);
                box-shadow: 0 8px 32px rgba(0, 0, 0, 0.3);
                opacity: 0;
                transform: scale(0.95);
            `;

            const menuItems = [
                {
                    text: `下载: ${shortFileName}`,
                    icon: 'download',
                    handler: () => { menu.remove(); this.downloadCurrentSong(); }
                },
                { type: 'separator' },
                {
                    text: `下载播放列表 (${playlistCount}首)`,
                    icon: 'list',
                    handler: () => { menu.remove(); this.downloadPlaylist(); }
                },
                { type: 'separator' },
                {
                    text: '复制歌曲信息',
                    icon: 'copy',
                    handler: () => { menu.remove(); this.copySongInfo(); }
                },
                { type: 'separator' },
                {
                    text: '复制下载链接',
                    icon: 'link',
                    handler: () => { menu.remove(); this.copyDownloadUrl(); }
                },
                { type: 'separator' },
                {
                    text: '查看下载历史',
                    icon: 'history',
                    handler: () => { menu.remove(); this.showDownloadHistory(); }
                },
                { type: 'separator' },
                {
                    text: '修改RPC设置',
                    icon: 'cog',
                    handler: () => { menu.remove(); this.showSettings(); }
                }
            ];

            menuItems.forEach(item => {
                if (item.type === 'separator') {
                    const sep = document.createElement('div');
                    sep.style.cssText = 'height:1px;background:rgba(255,255,255,0.1);margin:4px 0;';
                    menu.appendChild(sep);
                } else {
                    const menuItem = document.createElement('div');
                    menuItem.className = 'menu-item';
                    menuItem.style.cssText = 'padding:8px 16px;font-size:13px;display:flex;align-items:center;gap:8px;white-space:nowrap;';
                    menuItem.innerHTML = `
                        <i class="fas fa-${item.icon}" style="width:16px;text-align:center;"></i>
                        <span>${item.text}</span>
                    `;
                    menuItem.addEventListener('click', (e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        if (item.handler) item.handler();
                    });
                    menu.appendChild(menuItem);
                }
            });

            document.body.appendChild(menu);

            setTimeout(() => {
                menu.style.transition = 'opacity 0.15s ease, transform 0.15s ease';
                menu.style.opacity = '1';
                menu.style.transform = 'scale(1)';
            }, 10);

            const closeMenuHandler = (e) => {
                if (menu && !menu.contains(e.target) && e.target !== event.target) {
                    menu.style.opacity = '0';
                    menu.style.transform = 'scale(0.95)';
                    setTimeout(() => { if (menu.parentNode) menu.remove(); }, 150);
                    document.removeEventListener('click', closeMenuHandler);
                    document.removeEventListener('contextmenu', closeMenuHandler);
                }
            };

            const escHandler = (e) => {
                if (e.key === 'Escape') {
                    menu.style.opacity = '0';
                    menu.style.transform = 'scale(0.95)';
                    setTimeout(() => { if (menu.parentNode) menu.remove(); }, 150);
                    document.removeEventListener('keydown', escHandler);
                }
            };

            setTimeout(() => {
                document.addEventListener('click', closeMenuHandler);
                document.addEventListener('contextmenu', closeMenuHandler);
                document.addEventListener('keydown', escHandler);
            }, 50);
        }

        // ==================== RPC 设置弹窗 ====================
        showSettings() {
            const config = ConfigManager.load();

            const oldOverlay = document.querySelector('.moekoe-overlay');
            if (oldOverlay) oldOverlay.remove();

            const overlay = document.createElement('div');
            overlay.className = 'moekoe-overlay';

            const panel = document.createElement('div');
            panel.className = 'moekoe-panel';
            panel.style.width = '480px';

            panel.innerHTML = `
                <div class="moekoe-panel-header">
                    <h3>⚙️ RPC 设置</h3>
                    <button class="moekoe-panel-close" id="settings-close">×</button>
                </div>
                <div class="moekoe-panel-body">
                    <div class="moekoe-form-group">
                        <label>RPC 地址</label>
                        <input type="text" id="rpc-url" value="${this.escapeHtml(config.rpcUrl)}" placeholder="http://127.0.0.1:16800/jsonrpc" />
                        <div class="moekoe-form-hint">Motrix RPC 服务地址</div>
                    </div>
                    <div class="moekoe-form-group">
                        <label>RPC 密钥 (可选)</label>
                        <input type="password" id="rpc-secret" value="${this.escapeHtml(config.secret)}" placeholder="如果设置了密钥请填写" />
                        <div class="moekoe-form-hint">Motrix 偏好设置中的 RPC 密钥</div>
                    </div>
                    <div class="moekoe-form-group">
                        <label class="checkbox-label">
                            <input type="checkbox" id="rpc-enabled" ${config.enabled ? 'checked' : ''} />
                            启用 RPC
                        </label>
                        <div class="moekoe-form-hint">关闭后将无法使用下载功能</div>
                    </div>
                    <div class="moekoe-form-group">
                        <label class="checkbox-label">
                            <input type="checkbox" id="rpc-autostart" ${config.autoStart ? 'checked' : ''} />
                            自动启动 Motrix
                        </label>
                        <div class="moekoe-form-hint">未运行时通过 motrixnext:// 协议尝试启动</div>
                    </div>
                    <div class="moekoe-form-group">
                        <label>下载目录 (可选)</label>
                        <input type="text" id="download-dir" value="${this.escapeHtml(config.downloadDir || '')}" placeholder="例如: C:/Users/xxx/Music 或 /home/xxx/Music" />
                        <div class="moekoe-form-hint">必须输入完整绝对路径，留空使用 Motrix 默认目录</div>
                    </div>
                    <div class="moekoe-form-group">
                        <label class="checkbox-label">
                            <input type="checkbox" id="download-image" ${config.downloadImage ? 'checked' : ''} />
                            同时下载封面图片
                        </label>
                        <div class="moekoe-form-hint">图片文件名与音乐文件名保持一致</div>
                    </div>
                    <div class="moekoe-form-group">
                        <button class="moekoe-btn moekoe-btn-primary" id="test-connection" style="width:100%;">测试连接</button>
                        <div id="test-result"></div>
                    </div>
                </div>
                <div class="moekoe-panel-footer">
                    <button class="moekoe-btn moekoe-btn-secondary" id="settings-cancel">取消</button>
                    <button class="moekoe-btn moekoe-btn-primary" id="settings-save">保存设置</button>
                </div>
            `;

            overlay.appendChild(panel);
            document.body.appendChild(overlay);

            setTimeout(() => {
                overlay.style.opacity = '1';
                panel.classList.add('active');
            }, 10);

            const closePanel = () => {
                overlay.style.opacity = '0';
                panel.classList.remove('active');
                setTimeout(() => overlay.remove(), 300);
                document.removeEventListener('keydown', escHandler);
            };

            const escHandler = (e) => {
                if (e.key === 'Escape') closePanel();
            };
            document.addEventListener('keydown', escHandler);

            panel.querySelector('#settings-close').addEventListener('click', closePanel);
            panel.querySelector('#settings-cancel').addEventListener('click', closePanel);
            overlay.addEventListener('click', (e) => {
                if (e.target === overlay) closePanel();
            });

            // 测试连接（带超时）
            const testBtn = panel.querySelector('#test-connection');
            const testResult = panel.querySelector('#test-result');
            testBtn.addEventListener('click', async () => {
                const url = panel.querySelector('#rpc-url').value.trim();
                const secret = panel.querySelector('#rpc-secret').value;
                const enabled = panel.querySelector('#rpc-enabled').checked;

                if (!enabled) {
                    testResult.innerHTML = '<div class="moekoe-test-result error">RPC 已禁用，无法测试</div>';
                    return;
                }

                testResult.innerHTML = '<div class="moekoe-test-result" style="color:rgba(255,255,255,0.6);">连接中（超时5秒）...</div>';
                testBtn.disabled = true;

                try {
                    const tempClient = new MotrixRPCClient();
                    tempClient.rpcUrl = url;
                    tempClient.secret = secret;
                    const ok = await tempClient.ping(5000);
                    if (ok) {
                        testResult.innerHTML = '<div class="moekoe-test-result success">✅ 连接成功！Motrix 正在运行</div>';
                    } else {
                        testResult.innerHTML = '<div class="moekoe-test-result error">❌ 连接失败，请检查地址和密钥</div>';
                    }
                } catch (e) {
                    testResult.innerHTML = `<div class="moekoe-test-result error">❌ 错误: ${this.escapeHtml(e.message)}</div>`;
                } finally {
                    testBtn.disabled = false;
                }
            });

            // 保存设置
            const saveBtn = panel.querySelector('#settings-save');
            saveBtn.addEventListener('click', () => {
                const url = panel.querySelector('#rpc-url').value.trim();
                const secret = panel.querySelector('#rpc-secret').value;
                const enabled = panel.querySelector('#rpc-enabled').checked;
                const autoStart = panel.querySelector('#rpc-autostart').checked;

                if (!url) {
                    this.showNotification('RPC 地址不能为空', 'error');
                    return;
                }

                const downloadDir = panel.querySelector('#download-dir').value.replace(/[\u200B-\u200F\u202A-\u202E\uFEFF]/g, '').trim();
                const downloadImage = panel.querySelector('#download-image').checked;
                const newConfig = { rpcUrl: url, secret, enabled, autoStart, downloadDir, downloadImage };
                ConfigManager.save(newConfig);
                this.rpcClient.reloadConfig();
                this.showNotification('RPC 设置已保存', 'success');
                closePanel();
            });

            panel.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') {
                    saveBtn.click();
                }
            });
        }

        // ==================== 其他功能 ====================
        copySongInfo() {
            const musicInfo = this.extractMusicInfo();
            if (musicInfo) {
                const text = `${musicInfo.artist} - ${musicInfo.title}`;
                navigator.clipboard.writeText(text).then(() => {
                    this.showNotification('已复制歌曲信息到剪贴板', 'success');
                }).catch(() => {
                    this.fallbackCopy(text);
                });
            }
        }

        copyDownloadUrl() {
            const musicInfo = this.extractMusicInfo();
            if (musicInfo && musicInfo.url) {
                navigator.clipboard.writeText(musicInfo.url).then(() => {
                    this.showNotification('已复制下载链接到剪贴板', 'success');
                }).catch(() => {
                    this.fallbackCopy(musicInfo.url);
                });
            } else {
                this.showNotification('无法获取下载链接', 'error');
            }
        }

        fallbackCopy(text) {
            const textarea = document.createElement('textarea');
            textarea.value = text;
            textarea.style.position = 'fixed';
            textarea.style.opacity = '0';
            document.body.appendChild(textarea);
            textarea.select();
            try {
                document.execCommand('copy');
                this.showNotification('已复制到剪贴板', 'success');
            } catch (e) {
                this.showNotification('复制失败，请手动复制', 'error');
            }
            document.body.removeChild(textarea);
        }

        // ==================== 下载历史弹窗 ====================
        showDownloadHistory() {
            try {
                const history = ConfigManager.getHistory();
                if (history.length === 0) {
                    this.showNotification('暂无下载历史', 'downloading');
                    return;
                }

                const existingPanel = document.querySelector('.moekoe-history-panel');
                const existingOverlay = document.querySelector('.moekoe-history-overlay');
                if (existingPanel) existingPanel.remove();
                if (existingOverlay) existingOverlay.remove();

                const originalBodyOverflow = document.body.style.overflow;
                document.body.style.overflow = 'hidden';

                const overlay = document.createElement('div');
                overlay.className = 'moekoe-history-overlay';
                overlay.style.cssText = `
                    position: fixed;
                    top: 0; left: 0; right: 0; bottom: 0;
                    background: rgba(0, 0, 0, 0.7);
                    z-index: 10001;
                    opacity: 0;
                    transition: opacity 0.3s ease;
                    backdrop-filter: blur(3px);
                `;

                const panel = document.createElement('div');
                panel.className = 'moekoe-history-panel';
                panel.style.cssText = `
                    position: fixed;
                    top: 50%; left: 50%;
                    transform: translate(-50%, -50%) scale(0.95);
                    background: rgba(30, 30, 35, 0.98);
                    color: white;
                    border-radius: 12px;
                    padding: 20px;
                    z-index: 10002;
                    width: 600px;
                    max-width: 90vw;
                    max-height: 80vh;
                    overflow-y: auto;
                    backdrop-filter: blur(10px);
                    border: 1px solid rgba(255, 255, 255, 0.08);
                    box-shadow: 0 20px 60px rgba(0, 0, 0, 0.5);
                    opacity: 0;
                    transition: opacity 0.3s ease, transform 0.3s ease;
                `;

                let html = `
                    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:20px;flex-shrink:0;">
                        <h3 style="margin:0;color:var(--color-primary);">下载历史 (最近${history.length}条)</h3>
                        <button id="close-history" style="background:rgba(255,255,255,0.08);border:none;color:white;font-size:20px;cursor:pointer;border-radius:50%;width:30px;height:30px;display:flex;align-items:center;justify-content:center;transition:background-color 0.2s ease;">×</button>
                    </div>
                    <div style="display:flex;flex-direction:column;gap:10px;">
                `;

                history.forEach((item, index) => {
                    const date = new Date(item.downloadedAt).toLocaleString();
                    const displayName = item.fileName || `${item.artist} - ${item.title}`;
                    const sourceTag = item.source === 'rpc' ? '🔗 RPC' : '📥 直链';
                    html += `
                        <div class="history-item" data-index="${index}" style="background:rgba(255,255,255,0.04);border-radius:8px;padding:12px;border-left:4px solid var(--color-primary);cursor:pointer;transition:all 0.2s ease;position:relative;">
                            <div style="font-weight:500;margin-bottom:4px;color:var(--color-primary);display:flex;justify-content:space-between;align-items:center;">
                                <span style="font-size:14px;">${this.escapeHtml(displayName)}</span>
                                <span style="font-size:11px;color:rgba(255,255,255,0.3);">${sourceTag}</span>
                            </div>
                            <div style="font-size:12px;color:rgba(255,255,255,0.4);display:flex;justify-content:space-between;align-items:center;">
                                <span>${date}</span>
                                <span style="font-size:11px;color:rgba(255,255,255,0.25);">点击复制</span>
                            </div>
                            <div style="font-size:12px;color:rgba(255,255,255,0.3);margin-top:4px;">${this.escapeHtml(item.artist)} - ${this.escapeHtml(item.title)}</div>
                            ${item.rpcGid ? `<div style="font-size:10px;color:rgba(255,255,255,0.15);margin-top:4px;">GID: ${item.rpcGid}</div>` : ''}
                        </div>
                    `;
                });

                html += '</div>';

                if (history.length > 0) {
                    html += `
                        <div style="margin-top:20px;display:flex;justify-content:flex-end;flex-shrink:0;">
                            <button id="clear-history" style="background:rgba(244,67,54,0.15);color:#f44336;border:1px solid rgba(244,67,54,0.2);padding:8px 16px;border-radius:6px;cursor:pointer;font-size:12px;transition:background-color 0.2s ease;">清除所有历史记录</button>
                        </div>
                    `;
                }

                panel.innerHTML = html;

                overlay.appendChild(panel);
                document.body.appendChild(overlay);

                setTimeout(() => {
                    overlay.style.opacity = '1';
                    panel.style.opacity = '1';
                    panel.style.transform = 'translate(-50%, -50%) scale(1)';
                }, 10);

                const closePanel = () => {
                    overlay.style.opacity = '0';
                    panel.style.opacity = '0';
                    panel.style.transform = 'translate(-50%, -50%) scale(0.95)';
                    document.body.style.overflow = originalBodyOverflow;
                    setTimeout(() => {
                        if (overlay.parentNode) overlay.remove();
                        if (panel.parentNode) panel.remove();
                    }, 300);
                    document.removeEventListener('keydown', escHandler);
                };

                overlay.addEventListener('click', (e) => {
                    if (e.target === overlay) closePanel();
                });

                panel.querySelector('#close-history').addEventListener('click', closePanel);

                const clearBtn = panel.querySelector('#clear-history');
                if (clearBtn) {
                    clearBtn.addEventListener('click', () => {
                        if (confirm('确定要清除所有下载历史记录吗？')) {
                            ConfigManager.saveHistory([]);
                            this.showNotification('已清除所有下载历史', 'success');
                            closePanel();
                        }
                    });
                }

                panel.querySelectorAll('.history-item').forEach(el => {
                    el.addEventListener('click', () => {
                        const idx = parseInt(el.dataset.index);
                        if (history[idx]) {
                            const text = `${history[idx].artist} - ${history[idx].title}`;
                            navigator.clipboard.writeText(text).then(() => {
                                this.showNotification(`已复制: ${text}`, 'success');
                            }).catch(() => {
                                this.fallbackCopy(text);
                            });
                        }
                    });
                });

                const escHandler = (e) => {
                    if (e.key === 'Escape') closePanel();
                };
                document.addEventListener('keydown', escHandler);

            } catch (error) {
                logger.error('显示下载历史失败:', error);
                this.showNotification('无法显示下载历史', 'error');
                document.body.style.overflow = '';
            }
        }

        // ==================== 通知系统 ====================
        showNotification(message, type = 'downloading') {
            const existing = document.querySelector('.moekoe-notification');
            if (existing) existing.remove();

            const colors = {
                downloading: '#4CAF50',
                success: '#4CAF50',
                error: '#F44336',
                warning: '#FF9800'
            };
            const icons = {
                downloading: '✓',
                success: '✓',
                error: '✗',
                warning: '⚠'
            };

            const notification = document.createElement('div');
            notification.className = 'moekoe-notification';
            notification.style.cssText = `
                position: fixed;
                top: 20px;
                right: 20px;
                background: ${colors[type] || '#4CAF50'};
                color: white;
                padding: 12px 20px;
                border-radius: 8px;
                z-index: 10000;
                font-family: Arial, sans-serif;
                font-size: 14px;
                box-shadow: 0 4px 12px rgba(0,0,0,0.15);
                display: flex;
                align-items: center;
                gap: 10px;
                max-width: 400px;
                word-break: break-word;
            `;
            notification.innerHTML = `
                <span style="font-size:16px;font-weight:bold;">${icons[type] || '✓'}</span>
                <span>${message}</span>
            `;

            document.body.appendChild(notification);

            const duration = { downloading: 2500, success: 3000, error: 4000, warning: 3500 }[type] || 3000;
            setTimeout(() => {
                if (notification.parentNode) {
                    notification.style.opacity = '0';
                    notification.style.transform = 'translateX(100%)';
                    setTimeout(() => { if (notification.parentNode) notification.remove(); }, 300);
                }
            }, duration);
        }

        // ==================== 按钮状态 ====================
        updateDownloadButtonState(isDownloading) {
            const downloadBtn = document.querySelector('.moekoe-download-btn');
            if (downloadBtn) {
                if (isDownloading) {
                    downloadBtn.classList.add('downloading');
                    downloadBtn.classList.add('disabled');
                    downloadBtn.title = '下载中...';
                } else {
                    downloadBtn.classList.remove('downloading');
                    downloadBtn.classList.remove('disabled');
                    downloadBtn.title = '下载当前歌曲 (RPC)';
                }
            }
        }

        cancelCurrentDownload() {
            this.isDownloading = false;
            this.updateDownloadButtonState(false);
            this.showNotification('下载已取消', 'warning');
        }
    }

    // ==================== 初始化 ====================
    function initDownloadManager() {
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', () => {
                setTimeout(initialize, 500 + Math.random() * 1000);
            });
        } else {
            setTimeout(initialize, 500 + Math.random() * 1000);
        }

        function initialize() {
            try {
                const downloadManager = new DownloadManager();

                const observer = new MutationObserver(() => {
                    const downloadBtn = document.querySelector('.moekoe-download-btn');
                    const extraControls = document.querySelector('.player-bar .extra-controls');
                    if (extraControls && !downloadBtn) {
                        downloadManager.injectDownloadButton();
                    }
                });
                observer.observe(document.body, {
                    childList: true,
                    subtree: true
                });

                window.moekoeDownloadManager = downloadManager;
                logger.log('MoeKoe下载管理器初始化完成 (RPC版)');

            } catch (error) {
                logger.error('下载管理器初始化失败:', error);
            }
        }
    }

    initDownloadManager();
})();