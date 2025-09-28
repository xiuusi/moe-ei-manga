const adminState = {
    sessionId: null,
    startTime: Date.now(),
    mangaData: [],
    tags: [],
    namespaces: []
};
let currentMangaId = null;
let currentSelectedTags = []; // 上传漫画时的标签

// 分页相关变量
let currentPage = 1;
let itemsPerPage = 10;
let totalPages = 1;
let totalItems = 0;
let currentSearch = '';

// 显示通知消息
function showNotification(message, type) {
    const notification = document.getElementById('notification');
    if (notification) {
        notification.textContent = message;
        notification.className = `notification ${type} show`;
        setTimeout(() => {
            notification.classList.remove('show');
        }, 3000);
    }
}

// 显示错误信息
function showError(elementId, message) {
    const element = document.getElementById(elementId);
    if (element) {
        element.textContent = message;
        element.style.display = 'block';
    }
}

// 隐藏错误信息
function hideError(elementId) {
    const element = document.getElementById(elementId);
    if (element) {
        element.style.display = 'none';
    }
}

// 页面加载完成后初始化
document.addEventListener('DOMContentLoaded', function() {
    checkLoginStatus();
    const uploadForm = document.getElementById('uploadForm');
    if (uploadForm) {
        uploadForm.addEventListener('submit', function(e) {
            e.preventDefault();
            uploadManga();
        });
    }
    setupFileInputs();
    setupDragAndDrop();
    loadTagNamespaces();
    loadAllTags();

    // 初始化分页
    setTimeout(() => {
        if (document.getElementById('manga').classList.contains('active')) {
            loadMangaList(currentPage, currentSearch);
        }
    }, 100);

    // 👇 新增：使用事件委托统一处理漫画管理页的操作按钮点击事件
    const mangaListContainer = document.getElementById('mangaList');
    if (mangaListContainer) {
        mangaListContainer.addEventListener('click', function(e) {
            const btn = e.target.closest('button');
            if (!btn) return;

            const mangaId = btn.dataset.mangaId;
            if (!mangaId) return;

            if (btn.classList.contains('btn-info')) {
                openEditMangaModal(mangaId);
            } else if (btn.classList.contains('btn-warning')) {
                const mangaTitle = btn.dataset.mangaTitle || '未知漫画';
                openChapterModal(mangaId, mangaTitle);
            } else if (btn.classList.contains('btn-danger')) {
                deleteManga(mangaId);
            }
        });
    }
});

// 检查登录状态
async function checkLoginStatus() {
    try {
        const sessionId = localStorage.getItem('admin_session_id');
        if (!sessionId) {
            window.location.href = '/login.html';
            return false;
        }
        const response = await fetch('/api/auth/check', {
            headers: {
                'Authorization': `Bearer ${sessionId}`
            }
        });
        const result = await response.json();
        if (response.ok && result.authenticated) {
            adminState.sessionId = sessionId;
            showAdminDashboard();
            return true;
        } else {
            localStorage.removeItem('admin_session_id');
            window.location.href = '/login.html';
            return false;
        }
    } catch (error) {
        console.error('检查登录状态失败:', error);
        showNotification('检查登录状态失败', 'error');
        localStorage.removeItem('admin_session_id');
        window.location.href = '/login.html';
        return false;
    }
}

// 显示管理后台
function showAdminDashboard() {
    loadDashboardData();
    loadMangaList(currentPage, currentSearch);
}

// 加载仪表板数据
async function loadDashboardData() {
    try {
        // 获取漫画总数
        const mangaCountResponse = await fetch('/api/manga?page=1&pageSize=1');
        const mangaCountData = await mangaCountResponse.json();
        const totalMangaCount = mangaCountData.total || 0;

        // 获取一些漫画数据用于最近活动
        const mangaResponse = await fetch('/api/manga?page=1&pageSize=5');
        const mangaData = await mangaResponse.json();
        const mangaList = mangaData.data || [];

        const statsResponse = await fetch('/api/stats');
        const statsData = await statsResponse.json();

        // 更新统计
        updateStatistics(totalMangaCount, statsData);
        updateRecentActivity(mangaList);
    } catch (error) {
        console.error('加载仪表板数据失败:', error);
        showNotification('加载仪表板数据失败', 'error');
    }
}

// 更新统计信息函数
function updateStatistics(totalMangaCount, statsData) {
    if (!statsData || typeof statsData !== 'object') statsData = {};

    // 更新漫画总数
    const totalManga = document.getElementById('totalManga');
    if (totalManga) totalManga.textContent = totalMangaCount;

    // 更新访问者数量
    const totalVisitors = document.getElementById('totalVisitors');
    if (totalVisitors) {
        const visits = statsData.totalVisits || 0;
        totalVisitors.textContent = visits;
    }
}

// 更新最近活动
function updateRecentActivity(mangaData) {
    const recentActivities = document.getElementById('recentActivities');
    if (!recentActivities) return;
    recentActivities.innerHTML = '';

    const sortedManga = [...mangaData].sort((a, b) => new Date(b.uploadTime) - new Date(a.uploadTime));
    const recentManga = sortedManga.slice(0, 5);

    if (recentManga.length === 0) {
        recentActivities.innerHTML = '<tr><td colspan="3" class="loading">暂无活动</td></tr>';
        return;
    }

    recentManga.forEach(manga => {
        const row = document.createElement('tr');
        const uploadTime = manga.uploadTime ? new Date(manga.uploadTime).toLocaleString() : '未知';
        row.innerHTML = `
        <td>上传漫画</td>
        <td>《${manga.title}》</td>
        <td>${uploadTime}</td>
        `;
        recentActivities.appendChild(row);
    });
}

// 设置文件输入事件
function setupFileInputs() {
    const coverInput = document.getElementById('cover');
    const fileInput = document.getElementById('file');
    if (coverInput) {
        coverInput.addEventListener('change', function(e) {
            if (e.target.files[0]) {
                const file = e.target.files[0];
                const fileInfo = document.getElementById('coverInfo');
                if (fileInfo) {
                    fileInfo.innerHTML = `
                    <strong>已选择文件：</strong>${file.name}<br>
                    <strong>文件大小：</strong>${(file.size / 1024).toFixed(2)} KB
                    `;
                    fileInfo.style.display = 'block';
                }
                hideError('uploadError');
            }
        });
    }
    if (fileInput) {
        fileInput.addEventListener('change', function(e) {
            if (e.target.files[0]) {
                const file = e.target.files[0];
                const fileInfo = document.getElementById('fileInfo');
                if (fileInfo) {
                    fileInfo.innerHTML = `
                    <strong>已选择文件：</strong>${file.name}<br>
                    <strong>文件大小：</strong>${(file.size / (1024 * 1024)).toFixed(2)} MB
                    `;
                    fileInfo.style.display = 'block';
                }
                hideError('uploadError');
            }
        });
    }
}

// 设置拖拽上传
function setupDragAndDrop() {
    const coverUploadArea = document.getElementById('coverUploadArea');
    const fileUploadArea = document.getElementById('fileUploadArea');

    [coverUploadArea, fileUploadArea].forEach(area => {
        if (!area) return;
        area.addEventListener('dragover', e => {
            e.preventDefault();
            area.classList.add('dragover');
        });
        area.addEventListener('dragleave', e => {
            e.preventDefault();
            area.classList.remove('dragover');
        });
    });

    if (coverUploadArea) {
        coverUploadArea.addEventListener('drop', function(e) {
            e.preventDefault();
            this.classList.remove('dragover');
            const files = e.dataTransfer.files;
            if (files.length > 0 && files[0].type.startsWith('image/')) {
                const coverInput = document.getElementById('cover');
                if (coverInput) {
                    const dt = new DataTransfer();
                    dt.items.add(files[0]);
                    coverInput.files = dt.files;
                    coverInput.dispatchEvent(new Event('change'));
                }
            } else {
                showError('uploadError', '请上传 JPG、PNG、GIF 或 WebP 格式的图片文件！');
                showNotification('文件格式不支持！', 'error');
            }
        });
    }

    if (fileUploadArea) {
        fileUploadArea.addEventListener('drop', function(e) {
            e.preventDefault();
            this.classList.remove('dragover');
            const files = e.dataTransfer.files;
            if (files.length > 0) {
                const file = files[0];
                const allowed = ['.zip', '.rar', '.cbz', '.cbr'];
                const ext = '.' + file.name.split('.').pop().toLowerCase();
                if (allowed.includes(ext)) {
                    const fileInput = document.getElementById('file');
                    if (fileInput) {
                        const dt = new DataTransfer();
                        dt.items.add(file);
                        fileInput.files = dt.files;
                        fileInput.dispatchEvent(new Event('change'));
                    }
                } else {
                    showError('uploadError', '请上传 CBZ、CBR、ZIP 或 RAR 格式的漫画文件！');
                    showNotification('文件格式不支持！', 'error');
                }
            }
        });
    }
}

// 切换标签页
function switchTab(tabId, clickedElement) {
    document.querySelectorAll('.tab-content').forEach(tab => tab.classList.remove('active'));
    document.querySelectorAll('.admin-nav a').forEach(link => link.classList.remove('active'));
    const targetTab = document.getElementById(tabId);
    if (targetTab) targetTab.classList.add('active');
    if (clickedElement) clickedElement.classList.add('active');
    if (tabId === 'dashboard') loadDashboardData();
    if (tabId === 'manga') loadMangaList(currentPage, currentSearch);
    if (tabId === 'tags') loadTagNamespaces();
}

// 上传漫画
async function uploadManga() {
    const title = document.getElementById('mangaTitle').value;
    const author = document.getElementById('mangaAuthor').value;
    const description = document.getElementById('mangaDescription').value;
    const coverFile = document.getElementById('cover').files[0];
    const mangaFile = document.getElementById('file').files[0];

    if (!title || !author) {
        showError('uploadError', '请填写漫画名称和作者！');
        showNotification('请填写必填字段！', 'error');
        return;
    }
    if (!mangaFile) {
        showError('uploadError', '请选择漫画文件！');
        showNotification('请选择漫画文件！', 'error');
        return;
    }

    const allowedExtensions = ['.zip', '.rar', '.cbz', '.cbr'];
    const fileExtension = '.' + mangaFile.name.split('.').pop().toLowerCase();
    if (!allowedExtensions.includes(fileExtension)) {
        showError('uploadError', '漫画文件只支持 CBZ、CBR、ZIP、RAR 格式！');
        showNotification('漫画文件格式不支持！', 'error');
        return;
    }

    if (mangaFile.size > 200 * 1024 * 1024) {
        showError('uploadError', '漫画文件大小不能超过 200MB！');
        showNotification('漫画文件过大！', 'error');
        return;
    }

    if (coverFile) {
        const allowedImageTypes = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
        if (!allowedImageTypes.includes(coverFile.type)) {
            showError('uploadError', '封面图片只支持 JPG、PNG、GIF、WebP 格式！');
            showNotification('封面图片格式不支持！', 'error');
            return;
        }
        if (coverFile.size > 5 * 1024 * 1024) {
            showError('uploadError', '封面图片大小不能超过 5MB！');
            showNotification('封面图片过大！', 'error');
            return;
        }
    }

    hideError('uploadError');
    const uploadBtn = document.getElementById('uploadBtn');
    const progressBar = document.getElementById('uploadProgress');
    const progressFill = document.getElementById('progressFill');
    if (uploadBtn) uploadBtn.disabled = true;
    if (progressBar) progressBar.style.display = 'block';

    try {
        const formData = new FormData();
        formData.append('title', title);
        formData.append('author', author);
        formData.append('description', description || '');
        if (coverFile) formData.append('cover', coverFile);
        formData.append('file', mangaFile);

        const response = await fetch('/api/manga', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${adminState.sessionId}`
            },
            body: formData
        });
        const result = await response.json();

        if (response.ok && result.success) {
            showNotification('漫画上传成功！', 'success');

            // 将标签与新上传的漫画关联
            if (currentSelectedTags.length > 0) {
                await assignTagsToManga(result.manga.id, currentSelectedTags);
            }

            resetForm();
            // 上传成功后跳转到第一页
            currentPage = 1;
            loadMangaList(currentPage, currentSearch);
            loadDashboardData();
        } else {
            const errorMessage = result.error || '上传失败';
            showError('uploadError', '上传失败: ' + errorMessage);
            showNotification('上传失败: ' + errorMessage, 'error');
        }
    } catch (error) {
        console.error('上传失败:', error);
        showError('uploadError', '上传失败: ' + error.message);
        showNotification('上传失败: ' + error.message, 'error');
    } finally {
        if (uploadBtn) uploadBtn.disabled = false;
        if (progressBar) progressBar.style.display = 'none';
        if (progressFill) progressFill.style.width = '0%';
    }
}

// 加载漫画列表（使用分页API）
async function loadMangaList(page = 1, search = '') {
    try {
        showLoading('mangaList');

        // 构建查询参数
        const params = new URLSearchParams({
            page: page.toString(),
                                           pageSize: itemsPerPage.toString()
        });

        if (search) {
            params.append('search', search);
        }

        const response = await fetch(`/api/manga?${params.toString()}`);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);

        const result = await response.json();

        // 假设API返回格式为 { data: [], total: 100, page: 1, pageSize: 10 }
        const mangaData = result.data || [];
        totalItems = result.total || 0;
        currentPage = result.page || 1;
        totalPages = Math.ceil(totalItems / itemsPerPage);

        renderMangaTable(mangaData);
        updatePaginationControls();
        hideError('manageError');

    } catch (error) {
        console.error('加载漫画列表失败:', error);
        showError('mangaList', '加载失败: ' + error.message);
        showNotification('加载失败: ' + error.message, 'error');
    }
}

// 显示加载状态
function showLoading(containerId) {
    const container = document.getElementById(containerId);
    if (container) {
        container.innerHTML = '<tr><td colspan="7" class="loading">加载中...</td></tr>';
    }
}

// 渲染漫画表格
function renderMangaTable(mangaList) {
    const el = document.getElementById('mangaList');
    if (!el) return;

    if (mangaList.length === 0) {
        el.innerHTML = '<tr><td colspan="7" class="loading">暂无漫画数据</td></tr>';
        return;
    }

    el.innerHTML = '';
    mangaList.forEach(manga => {
        const row = document.createElement('tr');

        const uploadTime = manga.uploadTime ? new Date(manga.uploadTime).toLocaleDateString() : '未知';
        const fileSize = manga.fileSize ? formatFileSize(manga.fileSize) : '未知';
        const tagsHtml = manga.tags ? manga.tags.map(tag =>
        `<span class="manga-tag" data-tag-id="${tag.id}">${tag.name}</span>`
        ).join(' ') : '';

        row.innerHTML = `
        <td>
        <img src="/api/manga/${manga.id}/cover"
        width="50" height="70"
        style="object-fit: cover; border-radius: 4px;"
        onerror="this.src='https://placehold.co/50x70/eee/999?text=封面'">
        </td>
        <td>
        <div style="font-weight: bold; margin-bottom: 4px;">${manga.title}</div>
        <div style="font-size: 12px; color: #666;">${manga.description || '暂无描述'}</div>
        </td>
        <td>${manga.author}</td>
        <td>${uploadTime}</td>
        <td>${fileSize}</td>
        <td><div class="manga-tags">${tagsHtml}</div></td>
        <td>
        <div class="admin-action-buttons">
        <button class="btn btn-info" data-manga-id="${manga.id}">编辑</button>
        <button class="btn btn-warning" data-manga-id="${manga.id}" data-manga-title="${manga.title}">章节</button>
        <button class="btn btn-danger" data-manga-id="${manga.id}">删除</button>
        </div>
        </td>
        `;
        el.appendChild(row);
    });
}

// 格式化文件大小
function formatFileSize(bytes) {
    if (!bytes) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB'];
    let size = parseInt(bytes);
    let unitIndex = 0;

    while (size >= 1024 && unitIndex < units.length - 1) {
        size /= 1024;
        unitIndex++;
    }

    return `${size.toFixed(1)} ${units[unitIndex]}`;
}

// 转义引号（用于JavaScript字符串）
function escapeQuote(str) {
    return str.replace(/'/g, "\\'");
}

// 分页控制函数
function goToPage(page) {
    page = Math.max(1, Math.min(page, totalPages));
    currentPage = page;
    loadMangaList(currentPage, currentSearch);
}

function previousPage() {
    goToPage(currentPage - 1);
}

function nextPage() {
    goToPage(currentPage + 1);
}

function changePageSize(size) {
    itemsPerPage = size;
    currentPage = 1;
    loadMangaList(currentPage, currentSearch);
}

function updatePaginationControls() {
    // 更新页码输入框
    const pageInput = document.getElementById('currentPageInput');
    if (pageInput) {
        pageInput.value = currentPage;
        pageInput.max = totalPages;
    }

    // 更新按钮状态
    const prevBtn = document.getElementById('prevPage');
    const nextBtn = document.getElementById('nextPage');
    const firstBtn = document.getElementById('firstPage');
    const lastBtn = document.getElementById('lastPage');

    if (prevBtn) prevBtn.disabled = currentPage <= 1;
    if (nextBtn) nextBtn.disabled = currentPage >= totalPages;
    if (firstBtn) firstBtn.disabled = currentPage <= 1;
    if (lastBtn) lastBtn.disabled = currentPage >= totalPages;

    // 更新分页信息
    const startItem = (currentPage - 1) * itemsPerPage + 1;
    const endItem = Math.min(currentPage * itemsPerPage, totalItems);
    const infoEl = document.getElementById('paginationInfo');
    if (infoEl) {
        infoEl.textContent = `显示 ${startItem}-${endItem} 条，共 ${totalItems} 条`;
        if (currentSearch) {
            infoEl.textContent += ` (搜索: "${currentSearch}")`;
        }
    }
}

// 搜索功能
function searchManga() {
    const searchTerm = document.getElementById('searchInput').value.trim();
    currentSearch = searchTerm;
    currentPage = 1;
    loadMangaList(currentPage, currentSearch);
}

function resetSearch() {
    document.getElementById('searchInput').value = '';
    currentSearch = '';
    currentPage = 1;
    loadMangaList(currentPage, '');
}

async function deleteManga(mangaId) {
    if (!confirm('确定要删除这个漫画吗？此操作不可恢复！')) return;

    try {
        const response = await fetch(`/api/manga/${mangaId}`, {
            method: 'DELETE',
            headers: {
                'Authorization': `Bearer ${adminState.sessionId}`
            }
        });

        const result = await response.json();
        if (response.ok && result.success) {
            showNotification('漫画删除成功！', 'success');
            // 重新加载当前页数据
            loadMangaList(currentPage, currentSearch);
            loadDashboardData();
        } else {
            const errorMessage = result.error || '删除失败';
            showError('manageError', '删除失败: ' + errorMessage);
            showNotification('删除失败: ' + errorMessage, 'error');
        }
    } catch (error) {
        console.error('删除失败:', error);
        showError('manageError', '删除失败: ' + error.message);
        showNotification('删除失败: ' + error.message, 'error');
    }
}

function openChapterModal(mangaId, mangaTitle) {
    currentMangaId = mangaId;
    document.getElementById('mangaTitle').textContent = mangaTitle;
    document.getElementById('chapterModal').style.display = 'block';
    loadChapters(mangaId);
}

function closeChapterModal() {
    document.getElementById('chapterModal').style.display = 'none';
    document.getElementById('chapterTitle').value = '';
    document.getElementById('chapterNumber').value = '';
    document.getElementById('chapterFile').value = '';
}

function loadChapters(mangaId) {
    fetch(`/api/manga/${mangaId}/chapters`)
    .then(response => response.json())
    .then(chapters => {
        const container = document.getElementById('chapterList');
        container.innerHTML = '';
        if (chapters.length === 0) {
            container.innerHTML = '<p>暂无章节</p>';
            return;
        }

        // 按章节编号排序
        const sortedChapters = chapters.sort((a, b) => a.number - b.number);

        sortedChapters.forEach(chapter => {
            const item = document.createElement('div');
            item.className = 'chapter-item';
            item.innerHTML = `
            <div class="chapter-info">
            <strong>${chapter.title}</strong> (第${chapter.number}章)
            <br><small>${new Date(chapter.uploadTime).toLocaleDateString()}</small>
            </div>
            <div class="chapter-actions">
            <button class="btn btn-warning" onclick="openEditChapterModal('${chapter.id}', '${chapter.title}', ${chapter.number})">编辑</button>
            <button class="btn btn-danger" onclick="deleteChapter('${chapter.id}')">删除</button>
            </div>
            `;
            container.appendChild(item);
        });
    })
    .catch(error => {
        console.error('加载章节失败:', error);
        showNotification('加载章节失败', 'error');
    });
}

function addChapter() {
    const title = document.getElementById('chapterTitle').value;
    const number = document.getElementById('chapterNumber').value;
    const file = document.getElementById('chapterFile').files[0];
    if (!title || !number || !file) {
        showNotification('请填写所有必填字段', 'error');
        return;
    }
    const formData = new FormData();
    formData.append('title', title);
    formData.append('number', number);
    formData.append('chapterFile', file);
    fetch(`/api/manga/${currentMangaId}/chapters`, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${adminState.sessionId}`
        },
        body: formData
    })
    .then(response => response.json())
    .then(data => {
        if (data.success) {
            showNotification('章节添加成功', 'success');
            document.getElementById('chapterTitle').value = '';
            document.getElementById('chapterNumber').value = '';
            document.getElementById('chapterFile').value = '';
            loadChapters(currentMangaId);
            loadMangaList(currentPage, currentSearch);
            loadDashboardData();
        } else {
            showNotification(data.error || '添加失败', 'error');
        }
    })
    .catch(error => {
        console.error('添加章节失败:', error);
        showNotification('添加章节失败: ' + error.message, 'error');
    });
}

function openEditChapterModal(chapterId, title, number) {
    document.getElementById('editChapterId').value = chapterId;
    document.getElementById('editChapterTitle').value = title;
    document.getElementById('editChapterNumber').value = number;
    document.getElementById('editChapterModal').style.display = 'block';
}

function closeEditChapterModal() {
    document.getElementById('editChapterModal').style.display = 'none';
}

function updateChapter() {
    const chapterId = document.getElementById('editChapterId').value;
    const title = document.getElementById('editChapterTitle').value;
    const number = document.getElementById('editChapterNumber').value;
    if (!title || !number) {
        showNotification('请填写所有必填字段', 'error');
        return;
    }
    fetch(`/api/manga/${currentMangaId}/chapters/${chapterId}`, {
        method: 'PUT',
        headers: {
            'Authorization': `Bearer ${adminState.sessionId}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({ title, number })
    })
    .then(response => response.json())
    .then(data => {
        if (data.success) {
            showNotification('章节更新成功', 'success');
            closeEditChapterModal();
            loadChapters(currentMangaId);
            loadMangaList(currentPage, currentSearch);
            loadDashboardData();
        } else {
            showNotification(data.error || '更新失败', 'error');
        }
    })
    .catch(error => {
        console.error('更新章节失败:', error);
        showNotification('更新章节失败: ' + error.message, 'error');
    });
}

function deleteChapter(chapterId) {
    if (!confirm('确定要删除这个章节吗？此操作不可恢复！')) return;
    fetch(`/api/manga/${currentMangaId}/chapters/${chapterId}`, {
        method: 'DELETE',
        headers: {
            'Authorization': `Bearer ${adminState.sessionId}`
        }
    })
    .then(response => response.json())
    .then(data => {
        if (data.success) {
            showNotification('章节删除成功', 'success');
            loadChapters(currentMangaId);
            loadMangaList(currentPage, currentSearch);
            loadDashboardData();
        } else {
            showNotification(data.error || '删除失败', 'error');
        }
    })
    .catch(error => {
        console.error('删除章节失败:', error);
        showNotification('删除章节失败: ' + error.message, 'error');
    });
}

function resetForm() {
    const form = document.getElementById('uploadForm');
    if (form) form.reset();
    ['coverInfo', 'fileInfo'].forEach(id => {
        const el = document.getElementById(id);
        if (el) {
            el.style.display = 'none';
            el.innerHTML = '';
        }
    });
    hideError('uploadError');
    ['coverUploadArea', 'fileUploadArea'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.classList.remove('dragover');
    });
        // 重置标签选择
        currentSelectedTags = [];
        const selectedTagsContainer = document.getElementById('selectedTags');
        if (selectedTagsContainer) selectedTagsContainer.innerHTML = '';
        loadAllTags(); // 重新加载标签选择器
}

async function logout() {
    if (!confirm('确定要登出吗？')) return;
    try {
        const response = await fetch('/api/logout', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${adminState.sessionId}`
            }
        });
        const result = await response.json();
        if (response.ok && result.success) {
            localStorage.removeItem('admin_session_id');
            window.location.href = '/login.html';
        } else {
            showNotification('登出失败: ' + (result.error || '未知错误'), 'error');
        }
    } catch (error) {
        console.error('登出失败:', error);
        showNotification('登出失败: ' + error.message, 'error');
    }
}

async function openEditMangaModal(mangaId) {
    try {
        const response = await fetch(`/api/manga/${mangaId}`);
        const manga = await response.json();
        if (!response.ok) throw new Error(manga.error || '获取漫画信息失败');
        document.getElementById('editMangaId').value = manga.id;
        document.getElementById('editMangaTitle').value = manga.title;
        document.getElementById('editMangaAuthor').value = manga.author;
        document.getElementById('editMangaDescription').value = manga.description || '';
        document.getElementById('editMangaCover').value = '';

        // 填充编辑漫画时的标签
        const editTagContainer = document.getElementById('editMangaTags');
        if (editTagContainer) {
            editTagContainer.innerHTML = '';
            if (manga.tags && manga.tags.length > 0) {
                manga.tags.forEach(tag => {
                    const tagElement = document.createElement('span');
                    tagElement.className = 'manga-tag';
                    tagElement.innerHTML = `${tag.name} <span class="remove-tag" onclick="removeTagFromManga('${manga.id}', ${tag.id})">×</span>`;
                    tagElement.setAttribute('data-tag-id', tag.id);
                    editTagContainer.appendChild(tagElement);
                });
            }
        }

        document.getElementById('editMangaModal').style.display = 'block';
        loadAllTags(); // 加载所有标签以供选择
    } catch (error) {
        console.error('打开编辑模态框失败:', error);
        showNotification('加载失败: ' + error.message, 'error');
    }
}

function closeEditMangaModal() {
    document.getElementById('editMangaModal').style.display = 'none';
}

async function updateManga() {
    const mangaId = document.getElementById('editMangaId').value;
    const title = document.getElementById('editMangaTitle').value;
    const author = document.getElementById('editMangaAuthor').value;
    const description = document.getElementById('editMangaDescription').value;
    const coverFile = document.getElementById('editMangaCover').files[0];

    if (!title || !author) {
        showNotification('请填写漫画名称和作者！', 'error');
        return;
    }

    const formData = new FormData();
    formData.append('title', title);
    formData.append('author', author);
    formData.append('description', description);
    if (coverFile) formData.append('cover', coverFile);

    try {
        const response = await fetch(`/api/manga/${mangaId}`, {
            method: 'PUT',
            headers: {
                'Authorization': `Bearer ${adminState.sessionId}`
            },
            body: formData
        });
        const result = await response.json();
        if (response.ok && result.success) {
            showNotification('漫画信息更新成功！', 'success');
            closeEditMangaModal();
            loadMangaList(currentPage, currentSearch);
            loadDashboardData();
        } else {
            showNotification('更新失败: ' + (result.error || '未知错误'), 'error');
        }
    } catch (error) {
        console.error('更新漫画失败:', error);
        showNotification('更新失败: ' + error.message, 'error');
    }
}

// 点击模态框外部关闭
window.onclick = function(event) {
    const modals = ['chapterModal', 'editChapterModal', 'editMangaModal', 'namespaceModal'];
    modals.forEach(id => {
        const modal = document.getElementById(id);
        if (event.target === modal) {
            if (id === 'chapterModal') closeChapterModal();
            else if (id === 'editChapterModal') closeEditChapterModal();
            else if (id === 'editMangaModal') closeEditMangaModal();
            else if (id === 'namespaceModal') closeNamespaceModal();
        }
    });
};

// 标签系统功能
async function loadTagNamespaces() {
    try {
        const response = await fetch('/api/tag/namespaces');
        if (!response.ok) throw new Error('加载标签分类失败');
        const namespaces = await response.json();
        adminState.namespaces = namespaces;

        const namespaceSelect = document.getElementById('namespaceSelect');
        if (namespaceSelect) {
            namespaceSelect.innerHTML = '<option value="">选择分类...</option>';
            namespaces.forEach(ns => {
                const option = document.createElement('option');
                option.value = ns.id;
                option.textContent = ns.display_name;
                namespaceSelect.appendChild(option);
            });
        }

        const tagSelect = document.getElementById('tagSelect');
        if (tagSelect) {
            tagSelect.innerHTML = '<option value="">选择标签...</option>';
            namespaces.forEach(ns => {
                const optgroup = document.createElement('optgroup');
                optgroup.label = ns.display_name;
                tagSelect.appendChild(optgroup);
            });
        }

        const editTagSelect = document.getElementById('editTagSelect');
        if (editTagSelect) {
            editTagSelect.innerHTML = '<option value="">选择标签...</option>';
            namespaces.forEach(ns => {
                const optgroup = document.createElement('optgroup');
                optgroup.label = ns.display_name;
                editTagSelect.appendChild(optgroup);
            });
        }

        loadAllTags();
    } catch (error) {
        console.error('加载标签分类失败:', error);
        showNotification('加载标签分类失败: ' + error.message, 'error');
    }
}

async function loadAllTags() {
    try {
        const response = await fetch('/api/tags');
        if (!response.ok) throw new Error('加载标签失败');
        const tags = await response.json();
        adminState.tags = tags;

        const tagSelect = document.getElementById('tagSelect');
        if (tagSelect) {
            // 清空现有的选项组
            Array.from(tagSelect.children).forEach(child => {
                if (child.tagName === 'OPTGROUP') {
                    child.innerHTML = '';
                }
            });

            tags.forEach(tag => {
                const namespaceOptgroup = Array.from(tagSelect.children).find(optgroup =>
                optgroup.tagName === 'OPTGROUP' &&
                optgroup.label === adminState.namespaces.find(ns => ns.id === tag.namespace_id)?.display_name
                );

                if (namespaceOptgroup) {
                    const option = document.createElement('option');
                    option.value = tag.id;
                    option.textContent = tag.name;
                    namespaceOptgroup.appendChild(option);
                }
            });
        }

        const editTagSelect = document.getElementById('editTagSelect');
        if (editTagSelect) {
            // 清空现有的选项组
            Array.from(editTagSelect.children).forEach(child => {
                if (child.tagName === 'OPTGROUP') {
                    child.innerHTML = '';
                }
            });

            tags.forEach(tag => {
                const namespaceOptgroup = Array.from(editTagSelect.children).find(optgroup =>
                optgroup.tagName === 'OPTGROUP' &&
                optgroup.label === adminState.namespaces.find(ns => ns.id === tag.namespace_id)?.display_name
                );

                if (namespaceOptgroup) {
                    const option = document.createElement('option');
                    option.value = tag.id;
                    option.textContent = tag.name;
                    namespaceOptgroup.appendChild(option);
                }
            });
        }
    } catch (error) {
        console.error('加载标签失败:', error);
        showNotification('加载标签失败: ' + error.message, 'error');
    }
}

async function loadTags() {
    const namespaceId = document.getElementById('namespaceSelect').value;
    try {
        let url = '/api/tags';
        if (namespaceId) {
            const namespace = adminState.namespaces.find(ns => ns.id === parseInt(namespaceId));
            if (namespace) {
                url += `?namespace=${namespace.name}`;
            }
        }

        const response = await fetch(url);
        if (!response.ok) throw new Error('加载标签失败');
        const tags = await response.json();

        const container = document.getElementById('tagList');
        if (!container) return;
        container.innerHTML = '';

        if (tags.length === 0) {
            container.innerHTML = '<p>暂无标签</p>';
            return;
        }

        tags.forEach(tag => {
            const item = document.createElement('div');
            item.className = 'tag-item';
            const namespace = adminState.namespaces.find(ns => ns.id === tag.namespace_id);
            item.innerHTML = `
            <div class="tag-info">
            <strong>${tag.name}</strong>
            <small>(${namespace?.display_name || '未分类'})</small>
            <br><small>${tag.description || '无描述'}</small>
            </div>
            <div class="tag-actions">
            <button class="btn btn-danger" onclick="deleteTag(${tag.id})">删除</button>
            </div>
            `;
            container.appendChild(item);
        });
    } catch (error) {
        console.error('加载标签失败:', error);
        showNotification('加载标签失败: ' + error.message, 'error');
    }
}

async function createTag() {
    const namespaceId = document.getElementById('namespaceSelect').value;
    const name = document.getElementById('tagName').value;
    const slug = document.getElementById('tagSlug').value;
    const description = document.getElementById('tagDescription').value;

    if (!namespaceId || !name || !slug) {
        showNotification('请填写必填字段！', 'error');
        return;
    }

    try {
        const response = await fetch('/api/tags', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${adminState.sessionId}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ namespace_id: parseInt(namespaceId), name, slug, description })
        });

        const result = await response.json();
        if (response.ok && result.success) {
            showNotification('标签创建成功！', 'success');
            document.getElementById('tagName').value = '';
            document.getElementById('tagSlug').value = '';
            document.getElementById('tagDescription').value = '';
            loadTags(); // 重新加载当前分类的标签
            loadAllTags(); // 更新所有标签
        } else {
            showNotification('创建失败: ' + (result.error || '未知错误'), 'error');
        }
    } catch (error) {
        console.error('创建标签失败:', error);
        showNotification('创建标签失败: ' + error.message, 'error');
    }
}

async function createNamespace() {
    document.getElementById('namespaceModal').style.display = 'block';
}

function closeNamespaceModal() {
    document.getElementById('namespaceModal').style.display = 'none';
    document.getElementById('namespaceName').value = '';
    document.getElementById('namespaceDisplayName').value = '';
    document.getElementById('namespaceDescription').value = '';
}

async function createNamespaceFromModal() {
    const name = document.getElementById('namespaceName').value;
    const displayName = document.getElementById('namespaceDisplayName').value;
    const description = document.getElementById('namespaceDescription').value;

    if (!name || !displayName) {
        showNotification('请填写分类名称和显示名称！', 'error');
        return;
    }

    try {
        const response = await fetch('/api/tag/namespaces', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${adminState.sessionId}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ name, display_name: displayName, description })
        });

        const result = await response.json();
        if (response.ok && result.success) {
            showNotification('标签分类创建成功！', 'success');
            closeNamespaceModal();
            loadTagNamespaces(); // 重新加载分类
        } else {
            showNotification('创建失败: ' + (result.error || '未知错误'), 'error');
        }
    } catch (error) {
        console.error('创建标签分类失败:', error);
        showNotification('创建标签分类失败: ' + error.message, 'error');
    }
}

async function deleteTag(tagId) {
    if (!confirm('确定要删除这个标签吗？此操作不可恢复！')) return;
    try {
        const response = await fetch(`/api/tags/${tagId}`, {
            method: 'DELETE',
            headers: {
                'Authorization': `Bearer ${adminState.sessionId}`
            }
        });

        const result = await response.json();
        if (response.ok && result.success) {
            showNotification('标签删除成功！', 'success');
            loadTags(); // 重新加载标签
            loadAllTags(); // 更新所有标签
            loadMangaList(currentPage, currentSearch); // 更新漫画列表
        } else {
            showNotification('删除失败: ' + (result.error || '未知错误'), 'error');
        }
    } catch (error) {
        console.error('删除标签失败:', error);
        showNotification('删除标签失败: ' + error.message, 'error');
    }
}

function addTagToManga() {
    const tagSelect = document.getElementById('tagSelect');
    const tagId = parseInt(tagSelect.value);
    if (!tagId) {
        showNotification('请选择一个标签！', 'error');
        return;
    }

    const tag = adminState.tags.find(t => t.id === tagId);
    if (!tag) {
        showNotification('标签不存在！', 'error');
        return;
    }

    // 检查是否已添加该标签
    if (currentSelectedTags.includes(tagId)) {
        showNotification('该标签已添加！', 'error');
        return;
    }

    // 添加到当前选择的标签列表
    currentSelectedTags.push(tagId);

    // 在UI中显示标签
    const selectedTagsContainer = document.getElementById('selectedTags');
    const tagElement = document.createElement('span');
    tagElement.className = 'manga-tag';
    tagElement.innerHTML = `${tag.name} <span class="remove-tag" onclick="removeTagFromCurrentList(${tagId})">×</span>`;
    tagElement.setAttribute('data-tag-id', tagId);
    selectedTagsContainer.appendChild(tagElement);
}

function removeTagFromCurrentList(tagId) {
    // 从当前选择的标签列表中移除
    currentSelectedTags = currentSelectedTags.filter(id => id !== tagId);

    // 从UI中移除标签元素
    const selectedTagsContainer = document.getElementById('selectedTags');
    const tagElement = selectedTagsContainer.querySelector(`[data-tag-id="${tagId}"]`);
    if (tagElement) {
        selectedTagsContainer.removeChild(tagElement);
    }
}

async function assignTagsToManga(mangaId, tagIds) {
    try {
        const promises = tagIds.map(tagId =>
        fetch(`/api/manga/${mangaId}/tags/${tagId}`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${adminState.sessionId}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({})
        })
        );

        const responses = await Promise.all(promises);
        const results = await Promise.all(responses.map(r => r.json()));

        const hasError = results.some(result => !result.success);
        if (hasError) {
            showNotification('部分标签分配失败！', 'error');
        } else {
            showNotification('标签分配成功！', 'success');
        }
    } catch (error) {
        console.error('分配标签失败:', error);
        showNotification('分配标签失败: ' + error.message, 'error');
    }
}

function addTagToEditManga() {
    const tagSelect = document.getElementById('editTagSelect');
    const tagId = parseInt(tagSelect.value);
    if (!tagId) {
        showNotification('请选择一个标签！', 'error');
        return;
    }

    const tag = adminState.tags.find(t => t.id === tagId);
    if (!tag) {
        showNotification('标签不存在！', 'error');
        return;
    }

    // 在UI中显示标签
    const editTagContainer = document.getElementById('editMangaTags');
    const existingTag = editTagContainer.querySelector(`[data-tag-id="${tagId}"]`);
    if (existingTag) {
        showNotification('该标签已存在！', 'error');
        return;
    }

    const tagElement = document.createElement('span');
    tagElement.className = 'manga-tag';
    tagElement.innerHTML = `${tag.name} <span class="remove-tag" onclick="removeTagFromManga('${document.getElementById('editMangaId').value}', ${tagId})">×</span>`;
    tagElement.setAttribute('data-tag-id', tagId);
    editTagContainer.appendChild(tagElement);

    // 添加标签到漫画
    assignTagToManga(document.getElementById('editMangaId').value, tagId);
}

async function removeTagFromManga(mangaId, tagId) {
    try {
        const response = await fetch(`/api/manga/${mangaId}/tags/${tagId}`, {
            method: 'DELETE',
            headers: {
                'Authorization': `Bearer ${adminState.sessionId}`
            }
        });

        const result = await response.json();
        if (response.ok && result.success) {
            showNotification('标签移除成功！', 'success');
            // 从UI中移除标签
            const editTagContainer = document.getElementById('editMangaTags');
            const tagElement = editTagContainer.querySelector(`[data-tag-id="${tagId}"]`);
            if (tagElement) {
                editTagContainer.removeChild(tagElement);
            }
            loadMangaList(currentPage, currentSearch); // 更新漫画列表
        } else {
            showNotification('移除失败: ' + (result.error || '未知错误'), 'error');
        }
    } catch (error) {
        console.error('移除标签失败:', error);
        showNotification('移除标签失败: ' + error.message, 'error');
    }
}

async function assignTagToManga(mangaId, tagId) {
    try {
        const response = await fetch(`/api/manga/${mangaId}/tags/${tagId}`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${adminState.sessionId}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({})
        });

        const result = await response.json();
        if (!response.ok || !result.success) {
            showNotification('添加标签失败: ' + (result.error || '未知错误'), 'error');
        }
    } catch (error) {
        console.error('添加标签失败:', error);
        showNotification('添加标签失败: ' + error.message, 'error');
    }
}
