(function () {
    'use strict';

    console.log('MoeKoe 美化版下载管理器已加载');

    // 日志系统
    const logger = {
        log: (...args) => console.log(`[MoeKoe下载]`, ...args),
        error: (...args) => console.error(`\x1B[31m[MoeKoe下载]\x1B[0m`, ...args),
        warn: (...args) => console.warn(`\x1B[33m[MoeKoe下载]\x1B[0m`, ...args)
    };

    // 下载管理器
    class DownloadManager {
        constructor() {
            this.isDownloading = false;
            this.init();
        }

        init() {
            this.injectCSS();
            this.setupGlobalListeners();
        }

        // 注入CSS样式
        injectCSS() {
            const style = document.createElement('style');
            style.id = 'moekoe-download-styles';
            style.textContent = `
                .moekoe-download-btn {
                    position: relative;
                    transition: all 0.2s ease;
                }
                
                .moekoe-download-btn:hover {
                    transform: scale(1.1);
                    color: #1db954;
                }
                
                .moekoe-download-btn.downloading {
                    animation: pulse 1s infinite;
                    color: #1db954;
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
                
                .moekoe-notification {
                    animation: slideIn 0.3s ease-out;
                }
                
                .moekoe-download-menu {
                    animation: fadeIn 0.15s ease-out;
                }
                
                @keyframes slideIn {
                    from {
                        transform: translateX(100%);
                        opacity: 0;
                    }
                    to {
                        transform: translateX(0);
                        opacity: 1;
                    }
                }
                
                @keyframes fadeIn {
                    from {
                        opacity: 0;
                        transform: scale(0.95);
                    }
                    to {
                        opacity: 1;
                        transform: scale(1);
                    }
                }
                
                .menu-item {
                    cursor: pointer;
                    transition: background-color 0.2s ease;
                }
                
                .menu-item:hover {
                    background-color: rgba(255, 255, 255, 0.1);
                }
            `;
            document.head.appendChild(style);
        }

        // 设置全局监听器
        setupGlobalListeners() {
            // 监听页面卸载
            window.addEventListener('beforeunload', () => {
                if (this.isDownloading) {
                    this.cancelCurrentDownload();
                }
            });
        }

        // 从页面元素获取音乐信息
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

                // 获取歌曲信息
                const title = titleElem.textContent.trim();
                const artist = artistElem.textContent.trim();

                logger.log('提取到音乐信息:', { title, artist });

                // 尝试从多个来源获取音频URL
                const audioUrl = this.getAudioUrl();

                return {
                    title,
                    artist,
                    url: audioUrl,
                    timestamp: Date.now()
                };
            } catch (error) {
                logger.error('提取音乐信息失败:', error);
                return null;
            }
        }

        // 获取音频URL（多源尝试）
        getAudioUrl() {
            let audioUrl = null;

            // 方法1: 从audio元素获取
            const audioElement = document.querySelector('audio');
            if (audioElement && audioElement.src && audioElement.src.startsWith('http')) {
                audioUrl = audioElement.src;
                logger.log('从audio元素获取URL:', audioUrl);
            }

            // 方法2: 从localStorage获取
            if (!audioUrl) {
                try {
                    const currentSong = JSON.parse(localStorage.getItem('current_song') || '{}');
                    if (currentSong && currentSong.url) {
                        audioUrl = currentSong.url;
                        logger.log('从localStorage获取URL:', audioUrl);
                    }
                } catch (e) {
                    logger.warn('无法从localStorage获取音频URL');
                }
            }

            // 方法3: 从页面脚本中提取
            if (!audioUrl) {
                audioUrl = this.extractAudioUrlFromPage();
            }

            return audioUrl;
        }

        // 从页面脚本中提取音频URL
        extractAudioUrlFromPage() {
            try {
                // 查找所有script标签
                const scripts = document.querySelectorAll('script');
                for (const script of scripts) {
                    const content = script.textContent || script.innerText;

                    // 寻找包含音频URL的脚本
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

        // 清理文件名 - 只移除Windows/Unix文件系统不允许的字符
        sanitizeFilename(name) {
            if (!name) return 'unknown';

            // 只移除真正的非法文件名字符，保留所有其他字符
            return name
                .replace(/[<>:"/\\|?*]/g, '_')  // Windows非法字符
                .replace(/[\x00-\x1F\x7F]/g, '_') // 控制字符
                .replace(/^\.+|\.+$/g, '_')      // 不能以点开头或结尾
                .replace(/^CON$|^PRN$|^AUX$|^NUL$|^COM[1-9]$|^LPT[1-9]$/gi, '_'); // Windows保留名称
        }

        // 确定文件扩展名
        getFileExtension(url) {
            if (!url) return 'mp3';

            const urlWithoutParams = url.split('?')[0];
            const extensionMatch = urlWithoutParams.match(/\.([a-zA-Z0-9]+)$/);

            if (extensionMatch) {
                const ext = extensionMatch[1].toLowerCase();
                // 只返回常见音频格式
                if (['mp3', 'm4a', 'flac', 'wav', 'ogg', 'aac'].includes(ext)) {
                    return ext;
                }
            }

            // 尝试从Content-Type或URL模式推断
            if (url.includes('m4a') || url.includes('aac')) return 'm4a';
            if (url.includes('flac')) return 'flac';
            if (url.includes('wav')) return 'wav';
            if (url.includes('ogg')) return 'ogg';

            return 'mp3'; // 默认格式
        }

        // 执行下载
        async downloadCurrentSong() {
            if (this.isDownloading) {
                this.showNotification('当前正在下载中，请稍候...', 'downloading');
                return;
            }

            this.isDownloading = true;
            this.updateDownloadButtonState(true);

            try {
                // 获取音乐信息
                const musicInfo = this.extractMusicInfo();

                if (!musicInfo) {
                    throw new Error('无法获取音乐信息');
                }

                if (!musicInfo.url) {
                    throw new Error('无法获取音频链接');
                }

                logger.log('开始下载:', musicInfo);

                // 显示下载开始通知 - 绿色带勾图标
                const fileName = this.generateFileName(musicInfo);
                this.showNotification(`开始下载: ${fileName}`, 'downloading');

                // 使用高级下载方法
                await this.downloadWithFetch(musicInfo, fileName);

                // 记录下载历史
                this.saveDownloadHistory(musicInfo, fileName);

                this.showNotification(`下载完成: ${fileName}`, 'success');

            } catch (error) {
                logger.error('下载失败:', error);
                this.showNotification(`下载失败: ${error.message}`, 'error');
            } finally {
                this.isDownloading = false;
                this.updateDownloadButtonState(false);
            }
        }

        // 生成文件名
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

            // 确保文件名不会过长
            if (fileName.length > 200) {
                fileName = fileName.substring(0, 200);
            }

            return `${fileName}.${extension}`;
        }

        // 使用fetch下载
        async downloadWithFetch(musicInfo, fileName) {
            return new Promise(async (resolve, reject) => {
                try {
                    logger.log('尝试下载:', musicInfo.url);

                    // 添加Referer和Origin头部
                    const headers = {
                        'Accept': 'audio/*, */*',
                        'Referer': window.location.origin,
                        'Origin': window.location.origin
                    };

                    // 尝试不同的方法
                    const response = await fetch(musicInfo.url, {
                        method: 'GET',
                        mode: 'cors',
                        credentials: 'include',
                        headers: headers
                    });

                    if (!response.ok) {
                        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
                    }

                    // 获取blob数据
                    const blob = await response.blob();

                    if (blob.size === 0) {
                        throw new Error('文件大小为0');
                    }

                    // 创建下载链接
                    const downloadUrl = URL.createObjectURL(blob);
                    const a = document.createElement('a');
                    a.href = downloadUrl;
                    a.download = fileName;
                    a.style.display = 'none';

                    document.body.appendChild(a);
                    a.click();
                    document.body.removeChild(a);

                    // 释放内存
                    setTimeout(() => {
                        URL.revokeObjectURL(downloadUrl);
                    }, 100);

                    resolve();

                } catch (fetchError) {
                    logger.error('Fetch下载失败，尝试备用方法:', fetchError);

                    // 尝试备用方法：直接创建链接
                    try {
                        await this.downloadWithLink(musicInfo.url, fileName);
                        resolve();
                    } catch (linkError) {
                        reject(new Error(`所有下载方法都失败: ${linkError.message}`));
                    }
                }
            });
        }

        // 备用方法：直接链接下载
        async downloadWithLink(url, fileName) {
            return new Promise((resolve, reject) => {
                try {
                    const a = document.createElement('a');
                    a.href = url;
                    a.download = fileName;

                    // 对于某些浏览器，需要添加到文档中
                    a.style.display = 'none';
                    document.body.appendChild(a);

                    // 触发点击
                    const event = new MouseEvent('click', {
                        view: window,
                        bubbles: true,
                        cancelable: true
                    });

                    a.dispatchEvent(event);

                    // 延迟移除，确保事件处理完成
                    setTimeout(() => {
                        document.body.removeChild(a);
                        resolve();
                    }, 100);

                } catch (error) {
                    reject(error);
                }
            });
        }

        // 保存下载历史
        saveDownloadHistory(musicInfo, fileName) {
            try {
                const history = JSON.parse(localStorage.getItem('moekoe_download_history') || '[]');

                const downloadRecord = {
                    title: musicInfo.title,
                    artist: musicInfo.artist,
                    url: musicInfo.url,
                    fileName: fileName,
                    downloadedAt: new Date().toISOString()
                };

                // 添加到历史记录
                history.unshift(downloadRecord);

                // 只保留最近的50条记录
                if (history.length > 50) {
                    history.length = 50;
                }

                localStorage.setItem('moekoe_download_history', JSON.stringify(history));

                logger.log('下载历史已保存');

            } catch (error) {
                logger.warn('保存下载历史失败:', error);
            }
        }

        // 取消当前下载
        cancelCurrentDownload() {
            this.isDownloading = false;
            this.updateDownloadButtonState(false);
            this.showNotification('下载已取消', 'warning');
        }

        // 更新下载按钮状态
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
                    downloadBtn.title = '下载当前歌曲';
                }
            }
        }

        // 显示通知 - 修改版：绿色框，带√图标
        showNotification(message, type = 'downloading') {
            // 移除现有通知
            const existing = document.querySelector('.moekoe-notification');
            if (existing) existing.remove();

            // 定义颜色和图标
            const colors = {
                downloading: '#4CAF50',  // 绿色
                success: '#4CAF50',      // 绿色
                error: '#F44336',        // 红色
                warning: '#FF9800'       // 橙色
            };

            const icons = {
                downloading: '✓',  // 下载中显示√
                success: '✓',      // 成功显示√
                error: '✗',        // 错误显示×
                warning: '⚠'       // 警告显示⚠
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
                <span style="font-size: 16px; font-weight: bold;">${icons[type] || '✓'}</span>
                <span>${message}</span>
            `;

            document.body.appendChild(notification);

            // 设置自动移除时间（不同类型的通知持续时间不同）
            let duration = 3000;
            if (type === 'downloading') duration = 2500; // 下载中提示短一些
            if (type === 'success') duration = 3000;     // 成功提示3秒
            if (type === 'error') duration = 4000;       // 错误提示4秒
            if (type === 'warning') duration = 3500;     // 警告提示3.5秒

            // 延迟后自动移除
            setTimeout(() => {
                if (notification.parentNode) {
                    notification.style.opacity = '0';
                    notification.style.transform = 'translateX(100%)';
                    setTimeout(() => {
                        if (notification.parentNode) {
                            notification.remove();
                        }
                    }, 300);
                }
            }, duration);
        }

        // 注入下载按钮 - 修改：放到音量调节的右边，并删除分享按钮
        injectDownloadButton() {
            // 等待播放器加载完成
            const checkInterval = setInterval(() => {
                const extraControls = document.querySelector('.player-bar .extra-controls');
                if (extraControls) {
                    clearInterval(checkInterval);

                    // 如果按钮已存在，先移除
                    const existingBtn = document.querySelector('.moekoe-download-btn');
                    if (existingBtn) existingBtn.remove();

                    // 查找并删除分享按钮
                    const shareBtn = extraControls.querySelector('button.extra-btn[title="分享歌曲"]');
                    if (shareBtn) {
                        shareBtn.remove();
                        logger.log('已删除分享按钮');
                    }

                    // 创建下载按钮
                    const downloadBtn = document.createElement('button');
                    downloadBtn.className = 'extra-btn moekoe-download-btn';
                    downloadBtn.title = '下载当前歌曲';
                    downloadBtn.innerHTML = '<i class="fas fa-download"></i>';

                    // 添加点击事件
                    downloadBtn.addEventListener('click', (e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        this.downloadCurrentSong();
                    });

                    // 右键菜单
                    downloadBtn.addEventListener('contextmenu', (e) => {
                        e.preventDefault();
                        this.showDownloadOptionsStable(e);
                    });

                    // 找到音量调节元素
                    const volumeControl = extraControls.querySelector('.volume-control');

                    if (volumeControl) {
                        // 将下载按钮插入到音量调节的右边（在音量调节之后）
                        volumeControl.parentNode.insertBefore(downloadBtn, volumeControl.nextSibling);
                    } else {
                        // 如果找不到音量调节，就放到extra-controls的最后面
                        extraControls.appendChild(downloadBtn);
                    }

                    logger.log('下载按钮注入成功（音量调节右侧）');
                }
            }, 500);

            // 最多等待10秒
            setTimeout(() => {
                clearInterval(checkInterval);
            }, 10000);
        }

        // 显示下载选项菜单 - 稳定版
        showDownloadOptionsStable(event) {
            event.preventDefault();
            event.stopPropagation();

            // 移除现有菜单
            const existingMenu = document.querySelector('.moekoe-download-menu');
            if (existingMenu) existingMenu.remove();

            // 获取音乐信息
            const musicInfo = this.extractMusicInfo();
            const fileName = musicInfo ? this.generateFileName(musicInfo) : '未知文件';
            const shortFileName = fileName.length > 35 ? fileName.substring(0, 32) + '...' : fileName;

            // 创建隐藏的测量菜单
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
                <div style="padding: 8px 16px; font-size: 13px; display: flex; align-items: center; gap: 8px; white-space: nowrap;">
                    <i class="fas fa-download" style="width: 16px; text-align: center;"></i>
                    <span>下载: 文件名示例.mp3</span>
                </div>
                <div style="height: 1px; background: rgba(255, 255, 255, 0.1); margin: 4px 0;"></div>
                <div style="padding: 8px 16px; font-size: 13px; display: flex; align-items: center; gap: 8px; white-space: nowrap;">
                    <i class="fas fa-copy" style="width: 16px; text-align: center;"></i>
                    <span>复制歌曲信息</span>
                </div>
                <div style="height: 1px; background: rgba(255, 255, 255, 0.1); margin: 4px 0;"></div>
                <div style="padding: 8px 16px; font-size: 13px; display: flex; align-items: center; gap: 8px; white-space: nowrap;">
                    <i class="fas fa-link" style="width: 16px; text-align: center;"></i>
                    <span>复制下载链接</span>
                </div>
                <div style="height: 1px; background: rgba(255, 255, 255, 0.1); margin: 4px 0;"></div>
                <div style="padding: 8px 16px; font-size: 13px; display: flex; align-items: center; gap: 8px; white-space: nowrap;">
                    <i class="fas fa-history" style="width: 16px; text-align: center;"></i>
                    <span>查看下载历史</span>
                </div>
            `;

            document.body.appendChild(hiddenMenu);
            const menuWidth = hiddenMenu.offsetWidth;
            const menuHeight = hiddenMenu.offsetHeight;
            document.body.removeChild(hiddenMenu);

            // 获取视口尺寸
            const viewportWidth = window.innerWidth;
            const viewportHeight = window.innerHeight;

            // 计算菜单位置 - 鼠标位置上方显示
            let left = event.clientX;
            let top = event.clientY - menuHeight - 10;

            // 如果上方空间不够，显示在下方
            if (top < 10) {
                top = event.clientY + 10;
            }

            // 检查右边界
            if (left + menuWidth > viewportWidth) {
                left = viewportWidth - menuWidth - 10;
            }

            // 检查左边界
            if (left < 10) {
                left = 10;
            }

            // 检查下边界（如果菜单在下方）
            if (top + menuHeight > viewportHeight) {
                top = viewportHeight - menuHeight - 10;
            }

            // 创建实际菜单
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

            // 创建菜单项
            const menuItems = [
                {
                    text: `下载: ${shortFileName}`,
                    icon: 'download',
                    handler: () => {
                        menu.remove();
                        this.downloadCurrentSong();
                    }
                },
                { type: 'separator' },
                {
                    text: '复制歌曲信息',
                    icon: 'copy',
                    handler: () => {
                        menu.remove();
                        this.copySongInfo();
                    }
                },
                { type: 'separator' },
                {
                    text: '复制下载链接',
                    icon: 'link',
                    handler: () => {
                        menu.remove();
                        this.copyDownloadUrl();
                    }
                },
                { type: 'separator' },
                {
                    text: '查看下载历史',
                    icon: 'history',
                    handler: () => {
                        menu.remove();
                        this.showDownloadHistory();
                    }
                }
            ];

            // 添加菜单项到菜单
            menuItems.forEach(item => {
                if (item.type === 'separator') {
                    const separator = document.createElement('div');
                    separator.style.cssText = 'height: 1px; background: rgba(255, 255, 255, 0.1); margin: 4px 0;';
                    menu.appendChild(separator);
                } else {
                    const menuItem = document.createElement('div');
                    menuItem.className = 'menu-item';
                    menuItem.style.cssText = 'padding: 8px 16px; font-size: 13px; display: flex; align-items: center; gap: 8px; white-space: nowrap;';
                    menuItem.innerHTML = `
                        <i class="fas fa-${item.icon}" style="width: 16px; text-align: center;"></i>
                        <span>${item.text}</span>
                    `;

                    // 直接绑定点击事件
                    menuItem.addEventListener('click', (e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        if (item.handler) {
                            item.handler();
                        }
                    });

                    menu.appendChild(menuItem);
                }
            });

            document.body.appendChild(menu);

            // 触发动画
            setTimeout(() => {
                menu.style.transition = 'opacity 0.15s ease, transform 0.15s ease';
                menu.style.opacity = '1';
                menu.style.transform = 'scale(1)';
            }, 10);

            // 全局点击关闭菜单
            const closeMenuHandler = (e) => {
                if (menu && !menu.contains(e.target) && e.target !== event.target) {
                    menu.style.opacity = '0';
                    menu.style.transform = 'scale(0.95)';
                    setTimeout(() => {
                        if (menu && menu.parentNode) {
                            menu.remove();
                        }
                    }, 150);
                    document.removeEventListener('click', closeMenuHandler);
                    document.removeEventListener('contextmenu', closeMenuHandler);
                }
            };

            // ESC键关闭
            const escHandler = (e) => {
                if (e.key === 'Escape') {
                    menu.style.opacity = '0';
                    menu.style.transform = 'scale(0.95)';
                    setTimeout(() => {
                        if (menu && menu.parentNode) {
                            menu.remove();
                        }
                    }, 150);
                    document.removeEventListener('keydown', escHandler);
                }
            };

            setTimeout(() => {
                document.addEventListener('click', closeMenuHandler);
                document.addEventListener('contextmenu', closeMenuHandler);
                document.addEventListener('keydown', escHandler);
            }, 50);
        }

        // 复制歌曲信息
        copySongInfo() {
            const musicInfo = this.extractMusicInfo();
            if (musicInfo) {
                const text = `${musicInfo.artist} - ${musicInfo.title}`;
                navigator.clipboard.writeText(text).then(() => {
                    this.showNotification('已复制歌曲信息到剪贴板', 'success');
                });
            }
        }

        // 复制下载链接
        copyDownloadUrl() {
            const musicInfo = this.extractMusicInfo();
            if (musicInfo && musicInfo.url) {
                navigator.clipboard.writeText(musicInfo.url).then(() => {
                    this.showNotification('已复制下载链接到剪贴板', 'success');
                });
            } else {
                this.showNotification('无法获取下载链接', 'error');
            }
        }

        // 显示下载历史 - 带有全屏遮罩的居中弹出模式
        showDownloadHistory() {
            try {
                const history = JSON.parse(localStorage.getItem('moekoe_download_history') || '[]');

                if (history.length === 0) {
                    this.showNotification('暂无下载历史', 'downloading');
                    return;
                }

                // 移除现有面板和遮罩
                const existingPanel = document.querySelector('.moekoe-history-panel');
                const existingOverlay = document.querySelector('.moekoe-history-overlay');
                if (existingPanel) existingPanel.remove();
                if (existingOverlay) existingOverlay.remove();

                // 保存原始body样式
                const originalBodyOverflow = document.body.style.overflow;
                const originalBodyHeight = document.body.style.height;

                // 禁止背景滚动
                document.body.style.overflow = 'hidden';
                document.body.style.height = '100vh';

                // 创建全屏遮罩层
                const overlay = document.createElement('div');
                overlay.className = 'moekoe-history-overlay';
                overlay.style.cssText = `
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
                `;

                // 创建历史记录面板
                const panel = document.createElement('div');
                panel.className = 'moekoe-history-panel';
                panel.style.cssText = `
                    position: fixed;
                    top: 50%;
                    left: 50%;
                    transform: translate(-50%, -50%) scale(0.95);
                    background: rgba(0, 0, 0, 0.95);
                    color: white;
                    border-radius: 12px;
                    padding: 20px;
                    z-index: 10002;
                    width: 600px;
                    max-width: 90vw;
                    max-height: 80vh;
                    overflow-y: auto;
                    backdrop-filter: blur(10px);
                    border: 1px solid rgba(255, 255, 255, 0.1);
                    box-shadow: 0 20px 60px rgba(0, 0, 0, 0.5);
                    opacity: 0;
                    transition: opacity 0.3s ease, transform 0.3s ease;
                `;

                let html = `
                    <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px;">
                        <h3 style="margin: 0; color: #4CAF50;">下载历史 (最近${history.length}条)</h3>
                        <button id="close-history" style="background: rgba(255, 255, 255, 0.1); border: none; color: white; font-size: 20px; cursor: pointer; padding: 0; border-radius: 50%; width: 30px; height: 30px; display: flex; align-items: center; justify-content: center; transition: background-color 0.2s ease;">×</button>
                    </div>
                    <div style="display: flex; flex-direction: column; gap: 10px;">
                `;

                history.forEach((item, index) => {
                    const date = new Date(item.downloadedAt).toLocaleString();
                    const displayName = item.fileName || `${item.artist} - ${item.title}`;

                    html += `
                        <div class="history-item" data-index="${index}" style="background: rgba(255, 255, 255, 0.05); border-radius: 8px; padding: 12px; border-left: 4px solid #4CAF50; cursor: pointer; transition: all 0.2s ease; position: relative;">
                            <div style="font-weight: bold; margin-bottom: 5px; color: #4CAF50; display: flex; justify-content: space-between; align-items: center;">
                                <span>${displayName}</span>
                            </div>
                            <div style="font-size: 12px; color: #aaa; display: flex; justify-content: space-between; align-items: center;">
                                <span>${date}</span>
                                <span class="copy-hint" style="font-size: 11px; color: #aaa; display: none;">点击复制歌曲信息</span>
                            </div>
                            <div style="font-size: 12px; color: #888; margin-top: 5px;">${item.artist} - ${item.title}</div>
                            <div class="copy-icon" style="position: absolute; right: 10px; top: 10px; opacity: 0; transition: opacity 0.2s ease;">
                                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#4CAF50" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                                    <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
                                    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
                                </svg>
                            </div>
                        </div>
                    `;
                });

                html += '</div>';

                // 添加清除历史按钮
                if (history.length > 0) {
                    html += `
                        <div style="margin-top: 20px; display: flex; justify-content: flex-end;">
                            <button id="clear-history" style="background: rgba(244, 67, 54, 0.2); color: #f44336; border: 1px solid rgba(244, 67, 54, 0.3); padding: 8px 16px; border-radius: 6px; cursor: pointer; font-size: 12px; transition: background-color 0.2s ease;">清除所有历史记录</button>
                        </div>
                    `;
                }

                panel.innerHTML = html;

                // 先添加遮罩到页面
                document.body.appendChild(overlay);
                // 再将面板添加到遮罩内部
                overlay.appendChild(panel);

                // 淡入遮罩和面板
                setTimeout(() => {
                    overlay.style.opacity = '1';
                    panel.style.opacity = '1';
                    panel.style.transform = 'translate(-50%, -50%) scale(1)';
                }, 10);

                // 定义关闭函数
                const closePanel = () => {
                    // 淡出动画
                    overlay.style.opacity = '0';
                    panel.style.opacity = '0';
                    panel.style.transform = 'translate(-50%, -50%) scale(0.95)';
                    
                    // 恢复body滚动
                    document.body.style.overflow = originalBodyOverflow;
                    document.body.style.height = originalBodyHeight;
                    
                    // 延迟移除元素
                    setTimeout(() => {
                        if (overlay.parentNode) {
                            overlay.remove();
                        }
                        if (panel.parentNode) {
                            panel.remove();
                        }
                    }, 300);

                    // 移除事件监听器
                    document.removeEventListener('keydown', escHandler);
                };

                // 点击遮罩关闭面板
                overlay.addEventListener('click', (e) => {
                    if (e.target === overlay) {
                        closePanel();
                    }
                });

                // 添加关闭按钮事件
                const closeBtn = panel.querySelector('#close-history');
                closeBtn.addEventListener('click', closePanel);

                // 添加鼠标悬停效果到关闭按钮
                closeBtn.addEventListener('mouseenter', () => {
                    closeBtn.style.backgroundColor = 'rgba(255, 255, 255, 0.2)';
                });
                closeBtn.addEventListener('mouseleave', () => {
                    closeBtn.style.backgroundColor = 'rgba(255, 255, 255, 0.1)';
                });

                // 添加清除历史按钮事件
                const clearBtn = panel.querySelector('#clear-history');
                if (clearBtn) {
                    clearBtn.addEventListener('click', () => {
                        if (confirm('确定要清除所有下载历史记录吗？')) {
                            localStorage.removeItem('moekoe_download_history');
                            this.showNotification('已清除所有下载历史', 'success');
                            closePanel();
                        }
                    });

                    // 添加鼠标悬停效果
                    clearBtn.addEventListener('mouseenter', () => {
                        clearBtn.style.backgroundColor = 'rgba(244, 67, 54, 0.3)';
                    });
                    clearBtn.addEventListener('mouseleave', () => {
                        clearBtn.style.backgroundColor = 'rgba(244, 67, 54, 0.2)';
                    });
                }

                // 阻止面板内的滚动事件冒泡
                panel.addEventListener('wheel', (e) => {
                    // 检查是否滚动到顶部或底部
                    const isAtTop = panel.scrollTop === 0;
                    const isAtBottom = panel.scrollTop + panel.clientHeight >= panel.scrollHeight - 1;

                    // 如果在面板顶部向上滚动，或在面板底部向下滚动，阻止默认行为
                    if ((isAtTop && e.deltaY < 0) || (isAtBottom && e.deltaY > 0)) {
                        e.stopPropagation();
                    }
                }, { passive: false });

                // 添加触摸事件处理（移动端）
                panel.addEventListener('touchmove', (e) => {
                    const isAtTop = panel.scrollTop === 0;
                    const isAtBottom = panel.scrollTop + panel.clientHeight >= panel.scrollHeight - 1;

                    // 如果在面板顶部向上滑动，或在面板底部向下滑动，阻止默认行为
                    if ((isAtTop && e.touches[0].clientY > e.touches[0].pageY) ||
                        (isAtBottom && e.touches[0].clientY < e.touches[0].pageY)) {
                        e.stopPropagation();
                    }
                }, { passive: false });

                // 添加Esc键关闭
                const escHandler = (e) => {
                    if (e.key === 'Escape') {
                        closePanel();
                    }
                };

                document.addEventListener('keydown', escHandler);

                // 添加历史项目点击事件 - 复制歌曲信息
                const historyItems = panel.querySelectorAll('.history-item');
                historyItems.forEach(item => {
                    // 鼠标悬停效果
                    item.addEventListener('mouseenter', () => {
                        item.style.backgroundColor = 'rgba(255, 255, 255, 0.1)';
                        const copyHint = item.querySelector('.copy-hint');
                        const copyIcon = item.querySelector('.copy-icon');
                        if (copyHint) copyHint.style.display = 'block';
                        if (copyIcon) copyIcon.style.opacity = '1';
                    });

                    item.addEventListener('mouseleave', () => {
                        item.style.backgroundColor = 'rgba(255, 255, 255, 0.05)';
                        const copyHint = item.querySelector('.copy-hint');
                        const copyIcon = item.querySelector('.copy-icon');
                        if (copyHint) copyHint.style.display = 'none';
                        if (copyIcon) copyIcon.style.opacity = '0';
                    });

                    // 点击复制歌曲信息
                    item.addEventListener('click', (e) => {
                        // 防止事件冒泡到遮罩关闭
                        e.stopPropagation();

                        const index = item.getAttribute('data-index');
                        if (index !== null && history[index]) {
                            const songInfo = `${history[index].artist} - ${history[index].title}`;

                            // 使用现代API复制到剪贴板
                            navigator.clipboard.writeText(songInfo).then(() => {
                                // 显示复制成功反馈
                                const originalBg = item.style.backgroundColor;
                                const originalBorder = item.style.borderLeftColor;

                                item.style.backgroundColor = 'rgba(76, 175, 80, 0.2)';
                                item.style.borderLeftColor = '#4CAF50';

                                // 临时显示成功提示
                                const successText = document.createElement('div');
                                successText.textContent = '✓ 已复制';
                                successText.style.cssText = `
                                    position: absolute;
                                    top: 50%;
                                    left: 50%;
                                    transform: translate(-50%, -50%);
                                    background: rgba(76, 175, 80, 0.9);
                                    color: white;
                                    padding: 4px 8px;
                                    border-radius: 4px;
                                    font-size: 12px;
                                    z-index: 10;
                                    pointer-events: none;
                                    animation: fadeInOut 1.5s ease;
                                `;

                                // 添加动画样式
                                const style = document.createElement('style');
                                style.textContent = `
                                    @keyframes fadeInOut {
                                        0% { opacity: 0; transform: translate(-50%, -50%) scale(0.8); }
                                        20% { opacity: 1; transform: translate(-50%, -50%) scale(1); }
                                        80% { opacity: 1; transform: translate(-50%, -50%) scale(1); }
                                        100% { opacity: 0; transform: translate(-50%, -50%) scale(1.2); }
                                    }
                                `;
                                document.head.appendChild(style);

                                item.appendChild(successText);

                                // 显示通知
                                this.showNotification(`已复制: ${songInfo}`, 'success');

                                // 恢复原始样式
                                setTimeout(() => {
                                    item.style.backgroundColor = originalBg;
                                    item.style.borderLeftColor = originalBorder;
                                    if (successText.parentNode) {
                                        successText.remove();
                                    }
                                    if (style.parentNode) {
                                        style.remove();
                                    }
                                }, 1500);
                            }).catch(err => {
                                console.error('复制失败:', err);
                                this.showNotification('复制失败，请手动复制', 'error');
                            });
                        }
                    });
                });

    } catch (error) {
        logger.error('显示下载历史失败:', error);
        this.showNotification('无法显示下载历史', 'error');

        // 确保body滚动被恢复
        document.body.style.overflow = originalBodyOverflow;
        document.body.style.height = originalBodyHeight;
    }
}
    }

    // 主初始化函数
    function initDownloadManager() {
        // 等待页面加载完成
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', () => {
                setTimeout(initialize, 1000);
            });
        } else {
            setTimeout(initialize, 1000);
        }

        function initialize() {
            try {
                const downloadManager = new DownloadManager();

                // 初始注入按钮
                downloadManager.injectDownloadButton();

                // 监听DOM变化，如果播放器更新则重新注入
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

                // 将管理器暴露给全局（用于调试）
                window.moekoeDownloadManager = downloadManager;

                logger.log('MoeKoe下载管理器初始化完成');

            } catch (error) {
                logger.error('下载管理器初始化失败:', error);
            }
        }

    }

    // 启动下载管理器
    initDownloadManager();
})();