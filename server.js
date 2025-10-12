require('dotenv').config();

// server(1).js
const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs').promises;
const crypto = require('crypto');
const cookieParser = require('cookie-parser');
const app = express();
const port = process.env.PORT || 3000; // 从环境变量读取端口
const AdmZip = require('adm-zip');
const sharp = require('sharp');
// --- 🆕 数据库依赖 ---
const { Pool } = require('pg');
const redis = require('redis');
// --- 🆕 数据库连接 ---
const pgPool = new Pool({
    user: process.env.PG_USER,
    host: process.env.PG_HOST,
    database: process.env.PG_DATABASE,
    password: process.env.PG_PASSWORD,
    port: process.env.PG_PORT || 5432,
});
// 添加连接验证
if (!process.env.PG_USER || !process.env.PG_HOST || !process.env.PG_DATABASE || !process.env.PG_PASSWORD) {
    console.error('❌ 错误：数据库环境变量未完整设置');
    process.exit(1);
}
// 测试 PostgreSQL 连接
pgPool.query('SELECT NOW()', (err, res) => {
    if (err) {
        console.error('❌ PostgreSQL 连接失败:', err.stack);
    } else {
        console.log('✅ PostgreSQL 连接成功:', res.rows[0]);
    }
});
// --- 🆕 Redis 连接 ---
let redisClient;
(async () => {
    redisClient = redis.createClient({
        url: process.env.REDIS_URL
    });
    redisClient.on('error', (err) => console.error('❌ Redis Client Error', err));
    await redisClient.connect();
    console.log('✅ Redis 连接成功');
})();

// 从环境变量获取管理员密码
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
if (!ADMIN_PASSWORD) {
    console.error('❌ 错误：ADMIN_PASSWORD 环境变量未设置');
    process.exit(1);
}
const DEFAULT_COVER_PATH = 'manga/covers/default-cover.jpg';

// 获取项目根目录
const rootDir = process.cwd();

// 创建必要的文件夹
async function createDirectories() {
    const dirs = ['manga', 'manga/covers', 'manga/files', 'manga/extracted', 'logs', 'manga/chapters', 'manga/carousel'];
    for (const dir of dirs) {
        const fullPath = path.join(rootDir, dir);
        try {
            await fs.access(fullPath);
        } catch {
            await fs.mkdir(fullPath, { recursive: true });
        }
    }
    // 确保默认封面存在
    const defaultCoverPath = path.join(rootDir, DEFAULT_COVER_PATH);
    try {
        await fs.access(defaultCoverPath);
    } catch {
        // 创建简单的默认封面
        try {
            await fs.writeFile(defaultCoverPath, '');
        } catch (error) {
            console.log('创建默认封面失败:', error);
        }
    }
}

// --- 🆕 会话验证 (Redis) ---
async function validateSession(sessionId) {
    if (!sessionId) return false;
    try {
        const sessionData = await redisClient.get(`session:${sessionId}`);
        if (!sessionData) {
            return false;
        }
        const session = JSON.parse(sessionData);
        if (Date.now() - session.timestamp > 24 * 60 * 60 * 1000) {
            await redisClient.del(`session:${sessionId}`);
            return false;
        }
        return true;
    } catch (error) {
        console.error('验证会话失败:', error);
        return false;
    }
}

// 生成会话ID
function generateSessionId() {
    return crypto.randomBytes(32).toString('hex');
}

// 验证登录中间件
function requireAuth(req, res, next) {
    const authHeader = req.headers.authorization;
    if (!authHeader) {
        return res.status(401).json({ error: '未授权访问，请先登录' });
    }
    const sessionId = authHeader.replace('Bearer ', '');
    validateSession(sessionId)
    .then(isValid => {
        if (!isValid) {
            return res.status(401).json({ error: '会话已过期，请重新登录' });
        }
        next();
    })
    .catch(error => {
        console.error('会话验证中间件错误:', error);
        return res.status(500).json({ error: '服务器内部错误' });
    });
}

// 配置文件上传
const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        let dir;
        if (file.fieldname === 'cover') {
            dir = path.join(rootDir, 'manga/covers/');
        } else if (file.fieldname === 'chapterFile') {
            dir = path.join(rootDir, 'manga/chapters/');
        } else if (file.fieldname === 'image') {
            // 为轮播图图片创建专门的目录
            dir = path.join(rootDir, 'manga/carousel/');
        } else {
            dir = path.join(rootDir, 'manga/files/');
        }
        cb(null, dir);
    },
    filename: function (req, file, cb) {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, file.fieldname + '-' + uniqueSuffix + path.extname(file.originalname));
    }
});

const upload = multer({
    storage: storage,
    limits: {
        fileSize: 200 * 1024 * 1024
    },
    fileFilter: function (req, file, cb) {
        if (file.fieldname === 'cover' || file.fieldname === 'image') {
            const allowedTypes = ['image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp'];
            if (allowedTypes.includes(file.mimetype)) {
                cb(null, true);
            } else {
                cb(new Error('只允许上传图片文件'));
            }
        } else if (file.fieldname === 'chapterFile') {
            const allowedExtensions = ['.zip', '.cbz'];
            const ext = path.extname(file.originalname).toLowerCase();
            if (allowedExtensions.includes(ext)) {
                cb(null, true);
            } else {
                cb(new Error('只允许上传 ZIP, CBZ 格式的章节文件'));
            }
        } else {
            const allowedExtensions = ['.zip', '.rar', '.cbz', '.cbr'];
            const ext = path.extname(file.originalname).toLowerCase();
            if (allowedExtensions.includes(ext)) {
                cb(null, true);
            } else {
                cb(new Error('只允许上传 CBZ, CBR, ZIP, RAR 格式的漫画文件'));
            }
        }
    }
});

// 中间件
app.use(express.json());
app.use(cookieParser());

// 记录访问 (使用 Redis with Cookie-based tracking)
async function recordVisit(req, res) {
    try {
        const path = req.url || req.originalUrl || '/';
        if (path !== '/' && path !== '/index' && path !== '/index.html') {
            return;
        }
        // 尝试从 Cookie 获取访客 ID
        let visitorId = req.cookies.visitor_id;

        // 如果 Cookie 中没有访客 ID，则生成一个新的
        if (!visitorId) {
            const clientIp = req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
            req.connection.remoteAddress ||
            req.socket.remoteAddress ||
            (req.connection.socket ? req.connection.socket.remoteAddress : null) ||
            'unknown';
    const userAgent = req.headers['user-agent'] || 'unknown';
    visitorId = crypto.createHash('md5').update(clientIp + userAgent).digest('hex');

    // 设置访客 ID Cookie，有效期为30天
    res.cookie('visitor_id', visitorId, {
        maxAge: 30 * 24 * 60 * 60 * 1000, // 30天
        httpOnly: true,
        sameSite: 'lax'  // 限制跨站请求
    });
        }

        // 检查是否为当日首次访问
        const today = new Date().toISOString().split('T')[0];
        const todayKey = `visits:${today}`;
        const isNewVisitor = await redisClient.sAdd(`${todayKey}:unique`, visitorId);

        if (isNewVisitor) {
            await redisClient.incr(`${todayKey}:count`);
            await redisClient.incr('visit_stats:total');
            console.log(`[首页访问] 新访客ID=${visitorId}`);
        } else {
            console.log(`[首页访问] 回访访客ID=${visitorId}`);
        }
    } catch (error) {
        console.error('记录访问失败:', error);
    }
}

app.get(['/', '/index', '/index.html'], (req, res, next) => {
    recordVisit(req, res);
    next();
});

app.use(express.static('.'));

// --- 重定向旧页面到新集成页面 ---
app.get(['/search.html', '/tag.html'], (req, res) => {
    // 重定向到带有参数的首页，以显示相应的标签或搜索页面
    if (req.path.includes('search')) {
        res.redirect('/?page=search');
    } else if (req.path.includes('tag')) {
        res.redirect('/?page=tag');
    } else {
        res.redirect('/');
    }
});

// --- 🆕 数据库交互函数 (PostgreSQL) ---
// 从 PostgreSQL 读取所有漫画及其章节
async function readMangaData() {
    const client = await pgPool.connect();
    try {
        const query = `
        SELECT
        m.*,
        COALESCE(json_agg(c.*) FILTER (WHERE c.id IS NOT NULL), '[]') AS chapters,
        COALESCE(
            (SELECT json_agg(t.*)
            FROM manga_tags mt
            JOIN tags t ON mt.tag_id = t.id
            WHERE mt.manga_id = m.id),
            '[]'
        ) AS tags
        FROM mangas m
        LEFT JOIN chapters c ON m.id = c.manga_id
        GROUP BY m.id
        ORDER BY m.upload_time DESC;
        `;
        const result = await client.query(query);
        return result.rows;
    } finally {
        client.release();
    }
}

// 获取单个漫画
async function getMangaById(mangaId) {
    const client = await pgPool.connect();
    try {
        const query = `
        SELECT
        m.*,
        COALESCE(json_agg(c.* ORDER BY c.number) FILTER (WHERE c.id IS NOT NULL), '[]') AS chapters,
        COALESCE(
            (SELECT json_agg(t.*)
            FROM manga_tags mt
            JOIN tags t ON mt.tag_id = t.id
            WHERE mt.manga_id = m.id),
            '[]'
        ) AS tags
        FROM mangas m
        LEFT JOIN chapters c ON m.id = c.manga_id
        WHERE m.id = $1
        GROUP BY m.id;
        `;
        const result = await client.query(query, [mangaId]);
        return result.rows[0] || null;
    } finally {
        client.release();
    }
}

// 插入新漫画
async function insertManga(manga) {
    const client = await pgPool.connect();
    try {
        const query = `
        INSERT INTO mangas (id, title, author, description, cover_path, file_path, file_name, file_size, upload_time)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        `;
        const values = [
            manga.id, manga.title, manga.author, manga.description,
            manga.coverPath, manga.filePath, manga.fileName, manga.fileSize, manga.uploadTime
        ];
        await client.query(query, values);
    } finally {
        client.release();
    }
}

// 插入新章节
async function insertChapter(chapter) {
    const client = await pgPool.connect();
    try {
        const query = `
        INSERT INTO chapters (id, manga_id, title, number, file_path, file_name, file_size, upload_time, image_list, image_id_map)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
        `;
        const values = [
            chapter.id, chapter.manga_id, chapter.title, chapter.number,
            chapter.filePath, chapter.fileName, chapter.fileSize, chapter.uploadTime,
            JSON.stringify(chapter.imageList || []), JSON.stringify(chapter.imageIdMap || {})
        ];
        await client.query(query, values);
    } finally {
        client.release();
    }
}

// 更新章节
async function updateChapter(mangaId, chapterId, updateData) {
    const client = await pgPool.connect();
    try {
        let setClause = '';
        const values = [];
        let paramIndex = 1;
        if (updateData.title !== undefined) {
            setClause += `title = $${paramIndex++}, `;
            values.push(updateData.title);
        }
        if (updateData.number !== undefined) {
            setClause += `number = $${paramIndex++}, `;
            values.push(updateData.number);
        }
        if (setClause === '') {
            return; // 没有需要更新的字段
        }
        setClause = setClause.slice(0, -2); // 移除最后的逗号和空格
        values.push(chapterId, mangaId); // WHERE 条件的参数
        const query = `
        UPDATE chapters
        SET ${setClause}
        WHERE id = $${paramIndex} AND manga_id = $${paramIndex + 1}
        `;
        await client.query(query, values);
    } finally {
        client.release();
    }
}

// 删除章节
async function deleteChapter(chapterId) {
    const client = await pgPool.connect();
    try {
        const query = `DELETE FROM chapters WHERE id = $1`;
        await client.query(query, [chapterId]);
    } finally {
        client.release();
    }
}

// 删除漫画 (会自动删除关联章节和标签关联)
async function deleteManga(mangaId) {
    const client = await pgPool.connect();
    try {
        // 删除漫画标签关联
        await client.query('DELETE FROM manga_tags WHERE manga_id = $1', [mangaId]);
        // 删除漫画
        const query = `DELETE FROM mangas WHERE id = $1`;
        await client.query(query, [mangaId]);
    } finally {
        client.release();
    }
}

// 转换图片为WebP格式
async function convertToWebP(inputBuffer, outputPath) {
    try {
        await fs.mkdir(path.dirname(outputPath), { recursive: true });
        await sharp(inputBuffer)
        .resize(300, 400)
        .webp({ quality: 80 })
        .toFile(outputPath);
        console.log(`✅ 图片已转换为WebP格式: ${outputPath}`);
        return true;
    } catch (error) {
        console.error('图片转换失败:', error);
        return false;
    }
}

// 从CBZ提取封面
async function extractCoverFromCBZ(cbzPath, mangaId) {
    try {
        const zip = new AdmZip(cbzPath);
        const zipEntries = zip.getEntries();
        const imageEntries = zipEntries.filter(entry => {
            if (entry.isDirectory) return false;
            const ext = path.extname(entry.entryName).toLowerCase();
            return ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp'].includes(ext);
        });

        imageEntries.sort((a, b) => {
            const aIsCover = a.entryName.toLowerCase().includes('cover');
            const bIsCover = b.entryName.toLowerCase().includes('cover');
            if (aIsCover && !bIsCover) return -1;
            if (!aIsCover && bIsCover) return 1;
            return a.entryName.localeCompare(b.entryName);
        });

        if (imageEntries.length > 0) {
            const firstImage = imageEntries[0];
            const coverFilename = `cover-${mangaId}.webp`;
            const coverOutputPath = path.join(rootDir, 'manga', 'covers', coverFilename);
            await fs.mkdir(path.dirname(coverOutputPath), { recursive: true });
            const imageData = zip.readFile(firstImage);
            if (imageData) {
                const conversionSuccess = await convertToWebP(imageData, coverOutputPath);
                if (conversionSuccess) {
                    return coverOutputPath;
                } else {
                    const originalExt = path.extname(firstImage.entryName);
                    const originalCoverPath = path.join(rootDir, 'manga', 'covers', `cover-${mangaId}${originalExt}`);
                    await fs.writeFile(originalCoverPath, imageData);
                    return originalCoverPath;
                }
            }
        }
        return null;
    } catch (extractError) {
        console.error('从CBZ提取封面失败:', extractError);
        return null;
    }
}

// 判断是否为图片文件
function isImageFile(filename) {
    const imageExtensions = ['.jpg', '.jpeg', '.png', '.gif', '.webp'];
    return imageExtensions.some(ext => filename.toLowerCase().endsWith(ext));
}

// 解析漫画ZIP
async function parseMangaZip(zipFilePath, originalName) {
    try {
        const zip = new AdmZip(zipFilePath);
        const zipEntries = zip.getEntries();
        const chapterFolders = zipEntries.filter(entry =>
        entry.isDirectory && /^\d+$/.test(entry.entryName.replace(/\/$/, ''))
        );

        const chapters = [];
        if (chapterFolders.length > 0) {
            for (const folder of chapterFolders) {
                const chapterNumber = parseInt(folder.entryName.replace(/\/$/, ''));
                const chapterFiles = zipEntries.filter(entry =>
                !entry.isDirectory &&
                entry.entryName.startsWith(folder.entryName) &&
                isImageFile(entry.entryName)
                );

                if (chapterFiles.length > 0) {
                    chapters.push({
                        number: chapterNumber,
                        title: `第${chapterNumber}章`,
                        fileCount: chapterFiles.length,
                        originalFolder: folder.entryName,
                        filePath: zipFilePath
                    });
                }
            }
        } else {
            const allImages = zipEntries.filter(entry =>
            !entry.isDirectory && isImageFile(entry.entryName)
            );
            if (allImages.length > 0) {
                chapters.push({
                    number: 1,
                    title: `第1章`,
                    fileCount: allImages.length,
                    originalFolder: '',
                    filePath: zipFilePath
                });
            }
        }

        return chapters;
    } catch (error) {
        console.error('解析漫画ZIP失败:', error);
        return [];
    }
}

// --- 🆕 标签系统数据库交互函数 ---
// 初始化标签系统表
async function initializeTagSystem() {
    const client = await pgPool.connect();
    try {
        // 创建标签分类表
        await client.query(`
        CREATE TABLE IF NOT EXISTS tag_namespaces (
            id SERIAL PRIMARY KEY,
            name VARCHAR(50) UNIQUE NOT NULL,
                                                   display_name VARCHAR(100) NOT NULL,
                                                   description TEXT
        );
        `);

        // 创建标签表
        await client.query(`
        CREATE TABLE IF NOT EXISTS tags (
            id SERIAL PRIMARY KEY,
            namespace_id INTEGER REFERENCES tag_namespaces(id) ON DELETE CASCADE,
                                         name VARCHAR(100) NOT NULL,
                                         slug VARCHAR(100) UNIQUE NOT NULL,
                                         description TEXT,
                                         created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                                         UNIQUE(namespace_id, name)
        );
        `);

        // 创建漫画-标签关联表
        await client.query(`
        CREATE TABLE IF NOT EXISTS manga_tags (
            id SERIAL PRIMARY KEY,
            manga_id VARCHAR(50) REFERENCES mangas(id) ON DELETE CASCADE,
                                               tag_id INTEGER REFERENCES tags(id) ON DELETE CASCADE,
                                               created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                                               UNIQUE(manga_id, tag_id)
        );
        `);

        console.log('✅ 标签系统表已创建或已存在');

        // 检查是否已有标签分类，如果没有则插入默认分类
        const namespaceCount = await client.query('SELECT COUNT(*) FROM tag_namespaces');
        if (parseInt(namespaceCount.rows[0].count) === 0) {
            const defaultNamespaces = [
                { name: 'type', display_name: '创作类型', description: '漫画的创作类型，如同人、连载、短篇、长篇等' },
                { name: 'artist', display_name: '作者', description: '漫画的作者或创作者' },
                { name: 'character', display_name: '角色', description: '漫画中的主要角色' },
                { name: 'main', display_name: '主类型', description: '漫画的主要类型标签，1-3个' },
                { name: 'sub', display_name: '详细标签', description: '漫画的详细标签，副标签' }
            ];

            for (const ns of defaultNamespaces) {
                await client.query(
                    'INSERT INTO tag_namespaces (name, display_name, description) VALUES ($1, $2, $3)',
                                   [ns.name, ns.display_name, ns.description]
                );
            }

            console.log('✅ 默认标签分类已插入');
        }
    } catch (error) {
        console.error('初始化标签系统失败:', error);
    } finally {
        client.release();
    }
}

// 获取所有标签分类
async function getTagNamespaces() {
    const client = await pgPool.connect();
    try {
        const result = await client.query(`
        SELECT id, name, display_name, description
        FROM tag_namespaces
        ORDER BY id
        `);
        return result.rows;
    } finally {
        client.release();
    }
}

// 获取所有标签，可按命名空间筛选
async function getTags(namespaceName = null) {
    const client = await pgPool.connect();
    try {
        let query = `
        SELECT
        t.id,
        t.namespace_id,
        tn.name as namespace_name,
        tn.display_name as namespace_display_name,
        t.name,
        t.slug,
        t.description,
        COALESCE(mtc.count, 0) as count
        FROM tags t
        JOIN tag_namespaces tn ON t.namespace_id = tn.id
        LEFT JOIN (
            SELECT tag_id, COUNT(*) as count
            FROM manga_tags
            GROUP BY tag_id
        ) mtc ON t.id = mtc.tag_id
        `;
        const params = [];

        if (namespaceName) {
            query += ' WHERE tn.name = $1';
            params.push(namespaceName);
        }

        query += ' ORDER BY tn.id, t.name';

        const result = await client.query(query, params);
        return result.rows;
    } finally {
        client.release();
    }
}

// 搜索标签
async function searchTags(query) {
    const client = await pgPool.connect();
    try {
        const searchQuery = `%${query}%`;
        const result = await client.query(`
        SELECT
        t.id,
        t.namespace_id,
        tn.name as namespace_name,
        tn.display_name as namespace_display_name,
        t.name,
        t.slug,
        t.description,
        COALESCE(mtc.count, 0) as count
        FROM tags t
        JOIN tag_namespaces tn ON t.namespace_id = tn.id
        LEFT JOIN (
            SELECT tag_id, COUNT(*) as count
            FROM manga_tags
            GROUP BY tag_id
        ) mtc ON t.id = mtc.tag_id
        WHERE t.name ILIKE $1 OR t.slug ILIKE $1
        ORDER BY tn.id, t.name
        `, [searchQuery]);
        return result.rows;
    } finally {
        client.release();
    }
}

// 获取带有特定标签的漫画
async function getMangaByTag(tagId) {
    const client = await pgPool.connect();
    try {
        const result = await client.query(`
        SELECT
        m.*,
        COALESCE(json_agg(c.*) FILTER (WHERE c.id IS NOT NULL), '[]') AS chapters,
                                          COALESCE(
                                              (SELECT json_agg(t.*)
                                              FROM manga_tags mt2
                                              JOIN tags t ON mt2.tag_id = t.id
                                              WHERE mt2.manga_id = m.id),
                                              '[]'
                                          ) AS tags
                                          FROM mangas m
                                          LEFT JOIN chapters c ON m.id = c.manga_id
                                          JOIN manga_tags mt ON m.id = mt.manga_id
                                          WHERE mt.tag_id = $1
                                          GROUP BY m.id
                                          ORDER BY m.upload_time DESC
                                          `, [tagId]);
        return result.rows;
    } finally {
        client.release();
    }
}

// 搜索漫画（支持标签搜索）
// 搜索漫画（支持标签搜索）
async function searchMangaByTagOrTitle(query, searchType = 'title') {
    const client = await pgPool.connect();
    try {
        const searchQuery = `%${query}%`;
        
        if (searchType === 'title') {
            // 只搜索标题
            const sqlQuery = `
                SELECT
                m.id,
                m.title,
                m.author,
                m.description,
                m.cover_path,
                m.file_path,
                m.file_name,
                m.file_size,
                m.upload_time,
                COALESCE(json_agg(c.*) FILTER (WHERE c.id IS NOT NULL), '[]') AS chapters,
                COALESCE(
                    (SELECT json_agg(t.*)
                    FROM manga_tags mt2
                    JOIN tags t ON mt2.tag_id = t.id
                    WHERE mt2.manga_id = m.id),
                    '[]'
                ) AS tags
                FROM mangas m
                LEFT JOIN chapters c ON m.id = c.manga_id
                WHERE m.title ILIKE $1
                GROUP BY m.id
                ORDER BY m.upload_time DESC
            `;
            const result = await client.query(sqlQuery, [searchQuery]);
            return result.rows;
        } else if (searchType === 'author') {
            // 只搜索作者
            const sqlQuery = `
                SELECT
                m.id,
                m.title,
                m.author,
                m.description,
                m.cover_path,
                m.file_path,
                m.file_name,
                m.file_size,
                m.upload_time,
                COALESCE(json_agg(c.*) FILTER (WHERE c.id IS NOT NULL), '[]') AS chapters,
                COALESCE(
                    (SELECT json_agg(t.*)
                    FROM manga_tags mt2
                    JOIN tags t ON mt2.tag_id = t.id
                    WHERE mt2.manga_id = m.id),
                    '[]'
                ) AS tags
                FROM mangas m
                LEFT JOIN chapters c ON m.id = c.manga_id
                WHERE m.author ILIKE $1
                GROUP BY m.id
                ORDER BY m.upload_time DESC
            `;
            const result = await client.query(sqlQuery, [searchQuery]);
            return result.rows;
        } else if (searchType === 'tag') {
            // 只搜索标签
            const sqlQuery = `
                SELECT
                m.id,
                m.title,
                m.author,
                m.description,
                m.cover_path,
                m.file_path,
                m.file_name,
                m.file_size,
                m.upload_time,
                COALESCE(json_agg(c.*) FILTER (WHERE c.id IS NOT NULL), '[]') AS chapters,
                COALESCE(
                    (SELECT json_agg(t.*)
                    FROM manga_tags mt2
                    JOIN tags t ON mt2.tag_id = t.id
                    WHERE mt2.manga_id = m.id),
                    '[]'
                ) AS tags
                FROM mangas m
                LEFT JOIN chapters c ON m.id = c.manga_id
                JOIN manga_tags mt ON m.id = mt.manga_id
                JOIN tags t ON mt.tag_id = t.id
                WHERE t.name ILIKE $1
                GROUP BY m.id
                ORDER BY m.upload_time DESC
            `;
            const result = await client.query(sqlQuery, [searchQuery]);
            return result.rows;
        } else {
            // 默认搜索标题（如果提供了无效的搜索类型）
            const sqlQuery = `
                SELECT
                m.id,
                m.title,
                m.author,
                m.description,
                m.cover_path,
                m.file_path,
                m.file_name,
                m.file_size,
                m.upload_time,
                COALESCE(json_agg(c.*) FILTER (WHERE c.id IS NOT NULL), '[]') AS chapters,
                COALESCE(
                    (SELECT json_agg(t.*)
                    FROM manga_tags mt2
                    JOIN tags t ON mt2.tag_id = t.id
                    WHERE mt2.manga_id = m.id),
                    '[]'
                ) AS tags
                FROM mangas m
                LEFT JOIN chapters c ON m.id = c.manga_id
                WHERE m.title ILIKE $1
                GROUP BY m.id
                ORDER BY m.upload_time DESC
            `;
            const result = await client.query(sqlQuery, [searchQuery]);
            return result.rows;
        }
    } finally {
        client.release();
    }
}
// 添加轮播图表
async function initializeCarouselTable() {
    const client = await pgPool.connect();
    try {
        // 检查表是否已存在
        const tableCheck = await client.query(`
            SELECT EXISTS (
                SELECT FROM information_schema.tables 
                WHERE table_schema = 'public' 
                AND table_name = 'carousel_images'
            );
        `);
        
        if (!tableCheck.rows[0].exists) {
            // 如果表不存在，创建新表
            await client.query(`
            CREATE TABLE carousel_images (
                id SERIAL PRIMARY KEY,
                title VARCHAR(255),
                link_url VARCHAR(500),
                image_path VARCHAR(1000) NOT NULL,
                sort_order INTEGER DEFAULT 0,
                is_active BOOLEAN DEFAULT true,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
            `);
            console.log('✅ 轮播图表已创建');
        } else {
            // 如果表已存在，检查并更新image_path字段长度
            try {
                await client.query(`
                ALTER TABLE carousel_images ALTER COLUMN image_path TYPE VARCHAR(1000);
                `);
                console.log('✅ 轮播图image_path字段已更新为VARCHAR(1000)');
            } catch (alterError) {
                console.log('ℹ️ 尝试更新image_path字段长度时出现提示: ', alterError.message);
                // 如果上面的失败，尝试使用 USING 子句
                try {
                    await client.query(`
                    ALTER TABLE carousel_images ALTER COLUMN image_path TYPE VARCHAR(1000) USING image_path::VARCHAR(1000);
                    `);
                    console.log('✅ 轮播图image_path字段已使用USING子句更新');
                } catch (secondAlterError) {
                    console.log('ℹ️ 使用USING子句更新失败: ', secondAlterError.message);
                }
            }
        }
        
        console.log('✅ 轮播图表检查/创建完成');
    } catch (error) {
        console.error('初始化轮播图表失败:', error);
    } finally {
        client.release();
    }
}

// 验证管理员权限的中间件
function authenticateToken(req, res, next) {
    const authHeader = req.headers.authorization;
    if (!authHeader) {
        return res.status(401).json({ error: '未授权访问，请先登录' });
    }
    const sessionId = authHeader.replace('Bearer ', '');
    validateSession(sessionId)
    .then(isValid => {
        if (!isValid) {
            return res.status(401).json({ error: '会话已过期，请重新登录' });
        }
        next();
    })
    .catch(error => {
        console.error('会话验证中间件错误:', error);
        return res.status(500).json({ error: '服务器内部错误' });
    });
}


// API路由

// 获取访问统计 (从 Redis)
app.get('/api/stats', async (req, res) => {
    try {
        const today = new Date().toISOString().split('T')[0];
        const todayKey = `visits:${today}`;
        const [todayCount, totalCount] = await Promise.all([
            redisClient.get(`${todayKey}:count`) || 0,
                                                           redisClient.get('visit_stats:total') || 0
        ]);

        res.json({
            totalVisits: parseInt(totalCount),
                 todayVisits: parseInt(todayCount),
                 uniqueVisitors: 0, // 如需精确统计，需额外设计
                 lastVisitDate: today
        });
    } catch (error) {
        console.error('获取统计信息失败:', error);
        res.status(500).json({ error: '获取统计信息失败' });
    }
});

// 登录路由
app.post('/api/login', async (req, res) => {
    try {
        const { password } = req.body;
        if (!password) {
            return res.status(400).json({ error: '请输入密码' });
        }

        if (password === ADMIN_PASSWORD) {
            const sessionId = generateSessionId();
            const sessionData = {
                timestamp: Date.now(),
         user: 'admin'
            };
            await redisClient.setEx(`session:${sessionId}`, 24 * 60 * 60, JSON.stringify(sessionData));
            res.json({
                success: true,
                sessionId: sessionId,
                message: '登录成功'
            });
        } else {
            res.status(401).json({ error: '密码错误' });
        }
    } catch (error) {
        console.error('登录失败:', error);
        res.status(500).json({ error: '登录失败' });
    }
});

// 登出路由
app.post('/api/logout', async (req, res) => {
    try {
        const authHeader = req.headers.authorization;
        const sessionId = authHeader ? authHeader.replace('Bearer ', '') : null;
        if (sessionId) {
            await redisClient.del(`session:${sessionId}`);
        }
        res.json({ success: true, message: '登出成功' });
    } catch (error) {
        console.error('登出失败:', error);
        res.status(500).json({ error: '登出失败' });
    }
});

// 检查登录状态
app.get('/api/auth/check', async (req, res) => {
    try {
        const authHeader = req.headers.authorization;
        if (!authHeader) {
            return res.status(401).json({ authenticated: false });
        }
        const sessionId = authHeader.replace('Bearer ', '');
        const isAuthenticated = await validateSession(sessionId);
        res.json({ authenticated: isAuthenticated });
    } catch (error) {
        console.error('检查登录状态失败:', error);
        res.status(500).json({ error: '检查失败' });
    }
});

// 获取所有漫画（支持标签 + 分页）
app.get('/api/manga', async (req, res) => {
    try {
        const { tag, page = 1, limit = 21 } = req.query;
        const pageNum = parseInt(page, 10) || 1;
        const limitNum = parseInt(limit, 10) || 21;
        const offset = (pageNum - 1) * limitNum;

        let mangaData = [];
        let total = 0;

        if (tag) {
            // 带标签的分页查询
            const client = await pgPool.connect();
            try {
                // 获取总数
                const countRes = await client.query(`
                SELECT COUNT(*) FROM mangas m
                JOIN manga_tags mt ON m.id = mt.manga_id
                WHERE mt.tag_id = $1
                `, [tag]);
                total = parseInt(countRes.rows[0].count);

                // 获取分页数据
                const dataRes = await client.query(`
                SELECT
                m.*,
                COALESCE(json_agg(c.*) FILTER (WHERE c.id IS NOT NULL), '[]') AS chapters,
                                                   COALESCE(
                                                       (SELECT json_agg(t.*)
                                                       FROM manga_tags mt2
                                                       JOIN tags t ON mt2.tag_id = t.id
                                                       WHERE mt2.manga_id = m.id),
                                                       '[]'
                                                   ) AS tags
                                                   FROM mangas m
                                                   LEFT JOIN chapters c ON m.id = c.manga_id
                                                   JOIN manga_tags mt ON m.id = mt.manga_id
                                                   WHERE mt.tag_id = $1
                                                   GROUP BY m.id
                                                   ORDER BY m.upload_time DESC
                                                   LIMIT $2 OFFSET $3
                                                   `, [tag, limitNum, offset]);
                mangaData = dataRes.rows;
            } finally {
                client.release();
            }
        } else {
            // 全部漫画分页
            const client = await pgPool.connect();
            try {
                const countRes = await client.query('SELECT COUNT(*) FROM mangas');
                total = parseInt(countRes.rows[0].count);

                const dataRes = await client.query(`
                SELECT
                m.*,
                COALESCE(json_agg(c.*) FILTER (WHERE c.id IS NOT NULL), '[]') AS chapters,
                                                   COALESCE(
                                                       (SELECT json_agg(t.*)
                                                       FROM manga_tags mt2
                                                       JOIN tags t ON mt2.tag_id = t.id
                                                       WHERE mt2.manga_id = m.id),
                                                       '[]'
                                                   ) AS tags
                                                   FROM mangas m
                                                   LEFT JOIN chapters c ON m.id = c.manga_id
                                                   GROUP BY m.id
                                                   ORDER BY m.upload_time DESC
                                                   LIMIT $1 OFFSET $2
                                                   `, [limitNum, offset]);
                mangaData = dataRes.rows;
            } finally {
                client.release();
            }
        }

        res.json({
            data: mangaData,
            total,
            page: pageNum,
            limit: limitNum,
            totalPages: Math.ceil(total / limitNum)
        });
    } catch (error) {
        console.error('获取漫画列表失败:', error);
        res.status(500).json({ error: '获取漫画数据失败' });
    }
});
// ========== 轮播图 API 路由 ==========
// 获取所有启用的轮播图
app.get('/api/carousel', async (req, res) => {
    try {
        const client = await pgPool.connect();
        const result = await client.query(`
        SELECT id, title, link_url, image_path, sort_order, is_active, created_at
        FROM carousel_images
        WHERE is_active = true
        ORDER BY sort_order ASC, created_at DESC
        `);
        client.release();
        res.json(result.rows);
    } catch (error) {
        console.error('获取轮播图失败:', error);
        res.status(500).json({ error: '获取轮播图失败' });
    }
});

// 上传轮播图
app.post('/api/carousel', authenticateToken, upload.single('image'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ error: '请上传图片文件' });
        }

        const { title = '', linkUrl = '', sortOrder = 0 } = req.body;

        // 使用相对路径而不是绝对路径，避免路径过长问题
        const imagePath = path.relative(rootDir, req.file.path).replace(/\\/g, '/');

        const client = await pgPool.connect();
        const result = await client.query(`
        INSERT INTO carousel_images (title, link_url, image_path, sort_order, is_active)
        VALUES ($1, $2, $3, $4, $5)
        RETURNING id
        `, [title || '', linkUrl || '', imagePath, parseInt(sortOrder) || 0, true]);
        client.release();

        res.json({
            success: true,
            id: result.rows[0].id,
            message: '轮播图上传成功'
        });
    } catch (error) {
        console.error('上传轮播图失败:', error);
        res.status(500).json({ error: '上传轮播图失败: ' + error.message });
    }
});

// 获取轮播图图片
app.get('/api/carousel/:id/image', async (req, res) => {
    try {
        const { id } = req.params;
        
        // 验证ID是否为有效数字
        if (!id || isNaN(id) || parseInt(id) <= 0) {
            return res.status(400).json({ error: '无效的ID参数' });
        }
        
        const client = await pgPool.connect();
        try {
            const result = await client.query(
                'SELECT image_path FROM carousel_images WHERE id = $1',
                [parseInt(id)]
            );
            
            if (result.rows.length === 0) {
                return res.status(404).json({ error: '图片不存在' });
            }

            const imagePath = result.rows[0].image_path;
            if (!imagePath) {
                return res.status(404).json({ error: '图片路径未定义' });
            }
            
            // 构造完整的文件路径
            let fullPath;
            if (path.isAbsolute(imagePath)) {
                fullPath = imagePath;
            } else {
                fullPath = path.join(rootDir, imagePath);
            }
            
            // 标准化路径并确保安全性（防止路径遍历）
            fullPath = path.resolve(fullPath);
            const rootDirResolved = path.resolve(rootDir);
            
            // 确保文件路径在项目目录内
            if (!fullPath.startsWith(rootDirResolved)) {
                console.error(`安全错误：尝试访问项目目录外的文件: ${fullPath}`);
                return res.status(400).json({ error: '无效的文件路径' });
            }
            
            try {
                await fs.access(fullPath);
                res.sendFile(fullPath);
            } catch {
                console.error(`轮播图文件不存在: ${fullPath}`);
                res.status(404).json({ error: '图片文件不存在' });
            }
        } finally {
            client.release();
        }
    } catch (error) {
        console.error('获取轮播图图片失败:', error);
        res.status(500).json({ error: '获取图片失败: ' + error.message });
    }
});

// 获取单个轮播图信息
app.get('/api/carousel/:id', async (req, res) => {
    try {
        const { id } = req.params;
        
        // 验证ID是否为有效数字
        if (!id || isNaN(id) || parseInt(id) <= 0) {
            return res.status(400).json({ error: '无效的ID参数' });
        }
        
        const client = await pgPool.connect();
        try {
            const result = await client.query(
                'SELECT id, title, link_url, image_path, sort_order, is_active, created_at FROM carousel_images WHERE id = $1',
                [parseInt(id)]
            );
            
            if (result.rows.length === 0) {
                return res.status(404).json({ error: '轮播图不存在' });
            }

            res.json(result.rows[0]);
        } finally {
            client.release();
        }
    } catch (error) {
        console.error('获取轮播图信息失败:', error);
        res.status(500).json({ error: '获取轮播图信息失败: ' + error.message });
    }
});

// 更新轮播图
app.put('/api/carousel/:id', authenticateToken, upload.single('image'), async (req, res) => {
    try {
        const { id } = req.params;
        const { title, linkUrl, sortOrder, isActive } = req.body;

        // 检查轮播图是否存在
        const client = await pgPool.connect();
        let currentCarousel;
        try {
            const checkResult = await client.query(
                'SELECT * FROM carousel_images WHERE id = $1',
                [parseInt(id)]
            );
            
            if (checkResult.rows.length === 0) {
                return res.status(404).json({ error: '轮播图不存在' });
            }
            currentCarousel = checkResult.rows[0];
        } finally {
            client.release();
        }

        let newImagePath = currentCarousel.image_path;

        // 如果有新图片上传
        if (req.file) {
            const allowedImageTypes = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
            if (!allowedImageTypes.includes(req.file.mimetype)) {
                return res.status(400).json({ error: '图片只支持 JPG、PNG、GIF、WebP 格式！' });
            }

            if (req.file.size > 10 * 1024 * 1024) { // 10MB
                return res.status(400).json({ error: '图片大小不能超过 10MB！' });
            }

            // 使用相对路径而不是绝对路径
            newImagePath = path.relative(rootDir, req.file.path).replace(/\\/g, '/');

            // 删除旧图片文件（如果不是默认图片）
            if (currentCarousel.image_path && !currentCarousel.image_path.includes('default')) {
                try {
                    const oldImagePath = path.resolve(rootDir, currentCarousel.image_path);
                    await fs.access(oldImagePath);
                    await fs.unlink(oldImagePath);
                    console.log(`✅ 旧轮播图图片已删除: ${oldImagePath}`);
                } catch (accessError) {
                    console.log(`⚠️ 旧轮播图图片不存在或无法访问: ${currentCarousel.image_path}`);
                }
            }
        }

        const updates = [];
        const values = [];
        let paramIndex = 1;

        if (title !== undefined) {
            updates.push(`title = $${paramIndex}`);
            values.push(title || '');
            paramIndex++;
        }
        if (linkUrl !== undefined) {
            updates.push(`link_url = $${paramIndex}`);
            values.push(linkUrl || '');
            paramIndex++;
        }
        if (sortOrder !== undefined) {
            updates.push(`sort_order = $${paramIndex}`);
            values.push(parseInt(sortOrder) || 0);
            paramIndex++;
        }
        if (isActive !== undefined) {
            updates.push(`is_active = $${paramIndex}`);
            values.push(isActive === 'true' || isActive === true);
            paramIndex++;
        }
        // 如果有新图片，更新图片路径
        if (req.file) {
            updates.push(`image_path = $${paramIndex}`);
            values.push(newImagePath);
            paramIndex++;
        }

        if (updates.length === 0) {
            return res.status(400).json({ error: '没有提供更新内容' });
        }

        values.push(id);
        const query = `UPDATE carousel_images SET ${updates.join(', ')} WHERE id = $${paramIndex}`;

        const updateClient = await pgPool.connect();
        try {
            await updateClient.query(query, values);
            res.json({ success: true, message: '轮播图更新成功' });
        } finally {
            updateClient.release();
        }
    } catch (error) {
        console.error('更新轮播图失败:', error);
        res.status(500).json({ error: '更新轮播图失败: ' + error.message });
    }
});

// 删除轮播图
app.delete('/api/carousel/:id', authenticateToken, async (req, res) => {
    try {
        const { id } = req.params;

        // 先获取图片路径以便删除文件
        const client = await pgPool.connect();
        const result = await client.query(
            'SELECT image_path FROM carousel_images WHERE id = $1',
            [id]
        );

        if (result.rows.length > 0) {
            // 删除文件
            const imagePath = result.rows[0].image_path;
            try {
                await fs.access(imagePath);
                await fs.unlink(imagePath);
            } catch (accessError) {
                // 文件可能已经不存在，记录但不报错
                console.log(`文件不存在或无法删除: ${imagePath}`, accessError.message);
            }
        }

        // 删除数据库记录
        await client.query('DELETE FROM carousel_images WHERE id = $1', [id]);
        client.release();
        res.json({ success: true, message: '轮播图删除成功' });
    } catch (error) {
        console.error('删除轮播图失败:', error);
        res.status(500).json({ error: '删除轮播图失败' });
    }
});




// --- 🆕 修复：带搜索功能的漫画获取API，支持分页 ---
app.get('/api/manga/search', async (req, res) => {
    try {
        const { q, page = 1, limit = 21, searchType = 'title' } = req.query; // 从查询参数获取搜索关键词、分页参数和搜索类型
        const pageNum = parseInt(page, 10) || 1;
        const limitNum = parseInt(limit, 10) || 21;
        const offset = (pageNum - 1) * limitNum;

        let mangaData = [];
        let total = 0;

        if (q && q.trim() !== '') {
            // 搜索漫画标题、作者或标签，根据搜索类型
            const allSearchResults = await searchMangaByTagOrTitle(q.trim(), searchType);
            total = allSearchResults.length;
            mangaData = allSearchResults.slice(offset, offset + limitNum);
        } else {
            // 如果没有搜索词，返回所有数据（也进行分页）
            const allManga = await readMangaData();
            total = allManga.length;
            mangaData = allManga.slice(offset, offset + limitNum);
        }

        res.json({
            data: mangaData,
            total: total,
            page: pageNum,
            limit: limitNum,
            totalPages: Math.ceil(total / limitNum)
        });
    } catch (error) {
        console.error('搜索漫画失败:', error);
        res.status(500).json({ error: '搜索失败' });
    }
});
// --- 🆕 修复结束 ---

// 获取单个漫画
app.get('/api/manga/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const manga = await getMangaById(id);
        if (!manga) {
            return res.status(404).json({ error: '漫画不存在' });
        }
        res.json(manga);
    } catch (error) {
        console.error('获取漫画信息失败:', error);
        res.status(500).json({ error: '获取漫画信息失败' });
    }
});

// 上传漫画
app.post('/api/manga', requireAuth, upload.fields([
    { name: 'cover', maxCount: 1 },
    { name: 'file', maxCount: 1 }
]), async (req, res) => {
    try {
        const { title, author, description } = req.body; // 移除 type
        if (!title || !author || !req.files.file) {
            return res.status(400).json({ error: '缺少必要字段' });
        }

        const mangaId = Date.now().toString();
        let coverPath = null;

        if (req.files.cover && req.files.cover[0]) {
            const userCoverBuffer = await fs.readFile(req.files.cover[0].path);
            const webpCoverPath = path.join(rootDir, 'manga', 'covers', `cover-${mangaId}.webp`);
            const conversionSuccess = await convertToWebP(userCoverBuffer, webpCoverPath);
            if (conversionSuccess) {
                coverPath = webpCoverPath;
                try {
                    await fs.unlink(req.files.cover[0].path);
                } catch (unlinkError) {
                    console.log('删除用户上传的封面原文件失败:', unlinkError);
                }
            } else {
                coverPath = req.files.cover[0].path;
            }
        } else {
            const extractedCoverPath = await extractCoverFromCBZ(req.files.file[0].path, mangaId);
            if (extractedCoverPath) {
                coverPath = extractedCoverPath;
            } else {
                coverPath = path.join(rootDir, DEFAULT_COVER_PATH);
            }
        }

        const chapters = await parseMangaZip(req.files.file[0].path, req.files.file[0].originalname);

        // 为每个章节生成唯一的ID，并补充完整所有必要字段
        const chaptersWithId = chapters.map(chapter => ({
            ...chapter,
            id: Date.now().toString() + Math.floor(Math.random() * 1000), // 生成唯一ID
                                                        filePath: req.files.file[0].path, // 指向主漫画文件
                                                        fileName: req.files.file[0].originalname, // ✅ 新增：漫画文件的原始名称
                                                        fileSize: req.files.file[0].size, // ✅ 新增：漫画文件的大小
                                                        uploadTime: new Date().toISOString() // ✅ 新增：上传时间
        }));

        const newManga = {
            id: mangaId,
            title,
            author,
            description: description || '',
            coverPath: coverPath,
            filePath: req.files.file[0].path,
            fileName: req.files.file[0].originalname,
            fileSize: req.files.file[0].size,
            uploadTime: new Date().toISOString()
        };

        // 🆕 插入到 PostgreSQL
        await insertManga(newManga);

        // 🆕 插入章节到 PostgreSQL
        for (const chapter of chaptersWithId) {
            chapter.manga_id = mangaId; // 设置外键
            await insertChapter(chapter);
        }

        res.json({ success: true, manga: { ...newManga, chapters: chaptersWithId } });
    } catch (error) {
        console.error('上传漫画失败:', error);
        res.status(500).json({ error: '上传失败: ' + error.message });
    }
});

// 删除漫画
app.delete('/api/manga/:id', requireAuth, async (req, res) => {
    try {
        const { id } = req.params;
        const manga = await getMangaById(id);
        if (!manga) {
            return res.status(404).json({ error: '漫画不存在' });
        }

        // 删除文件
        try {
            if (manga.cover_path && !manga.cover_path.includes('default-cover')) {
                const coverPath = path.resolve(rootDir, manga.cover_path);
                try {
                    await fs.access(coverPath);
                    await fs.unlink(coverPath);
                    console.log(`✅ 封面文件已删除: ${coverPath}`);
                } catch (accessError) {
                    console.log(`⚠️ 封面文件不存在或无法访问: ${coverPath}`);
                }
            }
            const filePath = path.resolve(rootDir, manga.file_path);
            try {
                await fs.access(filePath);
                await fs.unlink(filePath);
                console.log(`✅ 漫画文件已删除: ${filePath}`);
            } catch (accessError) {
                console.log(`⚠️ 漫画文件不存在或无法访问: ${filePath}`);
            }

            if (manga.chapters && manga.chapters.length > 0) {
                for (const chapter of manga.chapters) {
                    if (chapter.file_path) {
                        const chapterPath = path.resolve(rootDir, chapter.file_path);
                        try {
                            await fs.access(chapterPath);
                            await fs.unlink(chapterPath);
                            console.log(`✅ 章节文件已删除: ${chapterPath}`);
                        } catch (accessError) {
                            console.log(`⚠️ 章节文件不存在或无法访问: ${chapterPath}`);
                        }
                    }
                }
            }
        } catch (deleteError) {
            console.log('⚠️ 删除文件时出错:', deleteError);
        }

        // 🆕 从 PostgreSQL 删除
        await deleteManga(id);

        res.json({ success: true, message: '漫画删除成功' });
    } catch (error) {
        console.error('删除漫画失败:', error);
        res.status(500).json({ error: '删除失败: ' + error.message });
    }
});

// 获取漫画文件
app.get('/api/manga/:id/file', async (req, res) => {
    try {
        const { id } = req.params;
        const manga = await getMangaById(id);
        if (!manga) {
            return res.status(404).json({ error: '漫画不存在' });
        }

        const filePath = path.resolve(rootDir, manga.file_path);
        try {
            await fs.access(filePath);
            res.sendFile(filePath);
        } catch (accessError) {
            console.error('漫画文件不存在:', filePath);
            res.status(404).json({ error: '漫画文件不存在' });
        }
    } catch (error) {
        console.error('获取漫画文件失败:', error);
        res.status(500).json({ error: '获取文件失败' });
    }
});

// 获取封面
app.get('/api/manga/:id/cover', async (req, res) => {
    try {
        const { id } = req.params;
        const manga = await getMangaById(id);
        if (!manga) {
            return res.status(404).json({ error: '漫画不存在' });
        }

        let coverPath = path.resolve(rootDir, manga.cover_path);
        try {
            await fs.access(coverPath);
            res.sendFile(coverPath);
        } catch (accessError) {
            console.log(`⚠️ 封面文件不存在，使用默认封面: ${coverPath}`);
            const defaultCoverPath = path.join(rootDir, DEFAULT_COVER_PATH);
            try {
                await fs.access(defaultCoverPath);
                res.sendFile(defaultCoverPath);
            } catch (defaultAccessError) {
                console.error('默认封面也不存在:', defaultCoverPath);
                res.status(404).json({ error: '封面文件不存在' });
            }
        }
    } catch (error) {
        console.error('获取封面失败:', error);
        res.status(500).json({ error: '获取封面失败' });
    }
});

// 添加新章节
app.post('/api/manga/:id/chapters', requireAuth, upload.single('chapterFile'), async (req, res) => {
    try {
        const { id } = req.params;
        const { title, number } = req.body;
        if (!req.file || !title || !number) {
            return res.status(400).json({ error: '缺少必要字段' });
        }

        const manga = await getMangaById(id);
        if (!manga) {
            return res.status(404).json({ error: '漫画不存在' });
        }

        const chapterId = Date.now().toString();
        let imageList = [];
        let imageIdMap = {};

        try {
            const zip = new AdmZip(req.file.path);
            const zipEntries = zip.getEntries();
            zipEntries.forEach(entry => {
                if (!entry.isDirectory) {
                    const ext = path.extname(entry.entryName).toLowerCase();
                    if (['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp'].includes(ext)) {
                        imageList.push(entry.entryName);
                    }
                }
            });
            imageList.sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));
            imageList.forEach((fileName, index) => {
                const imageId = `img-${String(index + 1).padStart(5, '0')}`;
                imageIdMap[imageId] = fileName;
            });
        } catch (parseError) {
            console.error(`⚠️ 预解析章节失败:`, parseError);
        }

        const newChapter = {
            id: chapterId,
            manga_id: id, // 关联到漫画
            title: title,
            number: parseInt(number),
         filePath: req.file.path,
         fileName: req.file.originalname,
         fileSize: req.file.size,
         uploadTime: new Date().toISOString(),
         imageList: imageList,
         imageIdMap: imageIdMap
        };

        // 🆕 插入到 PostgreSQL
        await insertChapter(newChapter);

        res.json({ success: true, chapter: newChapter });
    } catch (error) {
        console.error('添加章节失败:', error);
        res.status(500).json({ error: '添加章节失败: ' + error.message });
    }
});

// 获取漫画章节列表
app.get('/api/manga/:id/chapters', async (req, res) => {
    try {
        const { id } = req.params;
        const manga = await getMangaById(id);
        if (!manga) {
            return res.status(404).json({ error: '漫画不存在' });
        }

        res.json(manga.chapters || []);
    } catch (error) {
        console.error('获取章节列表失败:', error);
        res.status(500).json({ error: '获取章节列表失败' });
    }
});

// 获取章节文件
app.get('/api/manga/:mangaId/chapters/:chapterId/file', async (req, res) => {
    try {
        const { mangaId, chapterId } = req.params;
        const manga = await getMangaById(mangaId);
        if (!manga) {
            return res.status(404).json({ error: '漫画不存在' });
        }

        const chapter = manga.chapters.find(c => c.id === chapterId);
        if (!chapter) {
            return res.status(404).json({ error: '章节不存在' });
        }

        const filePath = path.resolve(rootDir, chapter.file_path);
        try {
            await fs.access(filePath);
            res.sendFile(filePath);
        } catch (accessError) {
            console.error('章节文件不存在:', filePath);
            res.status(404).json({ error: '章节文件不存在' });
        }
    } catch (error) {
        console.error('获取章节文件失败:', error);
        res.status(500).json({ error: '获取文件失败' });
    }
});

// 获取章节的图片文件列表
app.get('/api/manga/:mangaId/chapters/:chapterId/files', async (req, res) => {
    try {
        const { mangaId, chapterId } = req.params;
        const manga = await getMangaById(mangaId);
        if (!manga) {
            return res.status(404).json({ error: '漫画不存在' });
        }

        const chapter = manga.chapters.find(c => c.id === chapterId);
        if (!chapter) {
            return res.status(404).json({ error: '章节不存在' });
        }

        if (chapter.image_list && chapter.image_list.length > 0) {
            return res.json({ files: chapter.image_list });
        }

        console.log(`⚠️ 章节 ${chapterId} 无预解析列表，开始动态解析...`);
        try {
            const zip = new AdmZip(chapter.file_path);
            const zipEntries = zip.getEntries();
            let imageList = [];
            zipEntries.forEach(entry => {
                if (!entry.isDirectory) {
                    const ext = path.extname(entry.entryName).toLowerCase();
                    if (['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp'].includes(ext)) {
                        imageList.push(entry.entryName);
                    }
                }
            });
            imageList.sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));

            // 🆕 更新数据库中的章节记录
            const client = await pgPool.connect();
            try {
                const query = `UPDATE chapters SET image_list = $1 WHERE id = $2`;
                await client.query(query, [JSON.stringify(imageList), chapterId]);
            } finally {
                client.release();
            }

            console.log(`✅ 动态解析并缓存完成`);
            return res.json({ files: imageList });
        } catch (parseError) {
            console.error(`❌ 动态解析章节失败:`, parseError);
            return res.status(500).json({ error: '无法获取文件列表' });
        }
    } catch (error) {
        console.error('获取章节文件列表失败:', error);
        res.status(500).json({ error: '获取文件列表失败' });
    }
});

// 获取章节图片
app.get('/api/manga/:mangaId/chapters/:chapterId/image/:imageIdOrName', async (req, res) => {
    try {
        const { mangaId, chapterId, imageIdOrName } = req.params;
        const manga = await getMangaById(mangaId);
        if (!manga) {
            return res.status(404).json({ error: '漫画不存在' });
        }

        const chapter = manga.chapters.find(c => c.id === chapterId);
        if (!chapter) {
            return res.status(404).json({ error: '章节不存在' });
        }

        const zipFilePath = path.resolve(rootDir, chapter.file_path);
        try {
            await fs.access(zipFilePath);
        } catch (accessError) {
            return res.status(404).json({ error: '章节文件不存在' });
        }

        const zip = new AdmZip(zipFilePath);
        let targetFileName = imageIdOrName;

        // 🆕 从数据库中获取 image_id_map
        if (chapter.image_id_map && chapter.image_id_map[imageIdOrName]) {
            targetFileName = chapter.image_id_map[imageIdOrName];
        } else {
            targetFileName = decodeURIComponent(imageIdOrName);
        }

        const zipEntries = zip.getEntries();
        let targetEntry = zipEntries.find(entry =>
        !entry.isDirectory &&
        (entry.entryName === targetFileName ||
        entry.entryName.endsWith('/' + targetFileName))
        );

        if (!targetEntry) {
            return res.status(404).json({ error: '图片不存在' });
        }

        const imageData = zip.readFile(targetEntry);
        const mimeType = getMimeTypeByExtension(path.extname(targetEntry.entryName));

        res.setHeader('Content-Type', mimeType);
        res.setHeader('Cache-Control', 'public, max-age=31536000');
        res.send(imageData);
    } catch (error) {
        console.error('获取章节图片失败:', error);
        res.status(500).json({ error: '获取图片失败' });
    }
});

function getMimeTypeByExtension(ext) {
    const mimeTypes = {
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.png': 'image/png',
        '.gif': 'image/gif',
        '.webp': 'image/webp',
        '.bmp': 'image/bmp'
    };
    return mimeTypes[ext.toLowerCase()] || 'application/octet-stream';
}

// 更新章节信息
app.put('/api/manga/:mangaId/chapters/:chapterId', requireAuth, async (req, res) => {
    try {
        const { mangaId, chapterId } = req.params;
        const { title, number } = req.body;

        // 🆕 更新 PostgreSQL
        await updateChapter(mangaId, chapterId, { title, number });

        // 重新获取漫画数据以返回更新后的章节
        const updatedManga = await getMangaById(mangaId);
        const updatedChapter = updatedManga.chapters.find(c => c.id === chapterId);

        res.json({ success: true, chapter: updatedChapter });
    } catch (error) {
        console.error('更新章节失败:', error);
        res.status(500).json({ error: '更新章节失败: ' + error.message });
    }
});

// 🆕 新增API：更新漫画元数据（标题、作者、简介、封面）
app.put('/api/manga/:id', requireAuth, upload.single('cover'), async (req, res) => {
    try {
        const { id } = req.params;
        const { title, author, description } = req.body; // 移除 type

        // 从 PostgreSQL 获取当前漫画信息
        const currentManga = await getMangaById(id);
        if (!currentManga) {
            return res.status(404).json({ error: '漫画不存在' });
        }

        let newCoverPath = currentManga.cover_path; // 默认使用旧封面

        // 如果上传了新封面
        if (req.file) {
            const newCoverBuffer = await fs.readFile(req.file.path);
            const newCoverFilename = `cover-${id}-${Date.now()}.webp`;
            const newCoverOutputPath = path.join(rootDir, 'manga', 'covers', newCoverFilename);
            const conversionSuccess = await convertToWebP(newCoverBuffer, newCoverOutputPath);
            if (conversionSuccess) {
                newCoverPath = newCoverOutputPath;

                // 删除旧封面（如果不是默认封面）
                if (currentManga.cover_path && !currentManga.cover_path.includes('default-cover')) {
                    try {
                        const oldCoverPath = path.resolve(rootDir, currentManga.cover_path);
                        await fs.access(oldCoverPath);
                        await fs.unlink(oldCoverPath);
                        console.log(`✅ 旧封面已删除: ${oldCoverPath}`);
                    } catch (err) {
                        console.log(`⚠️ 无法删除旧封面: ${err.message}`);
                    }
                }

                // 删除上传的临时封面文件
                try {
                    await fs.unlink(req.file.path);
                } catch (err) {
                    console.log(`⚠️ 无法删除临时封面文件: ${err.message}`);
                }
            } else {
                // 如果转换失败，回退到旧封面
                console.log('⚠️ 新封面转换失败，保留旧封面');
            }
        }

        // 更新数据库
        const client = await pgPool.connect();
        try {
            const query = `
            UPDATE mangas
            SET title = $1, author = $2, description = $3, cover_path = $4
            WHERE id = $5
            `;
            const values = [
                title || currentManga.title,
                author || currentManga.author,
                description || currentManga.description,
                newCoverPath,
                id
            ];
            await client.query(query, values);
        } finally {
            client.release();
        }

        // 获取更新后的漫画数据
        const updatedManga = await getMangaById(id);
        res.json({
            success: true,
            message: '漫画信息更新成功',
            manga: updatedManga
        });
    } catch (error) {
        console.error('更新漫画信息失败:', error);
        res.status(500).json({ error: '更新失败: ' + error.message });
    }
});

// 删除章节
app.delete('/api/manga/:mangaId/chapters/:chapterId', requireAuth, async (req, res) => {
    try {
        const { mangaId, chapterId } = req.params;
        const manga = await getMangaById(mangaId);
        if (!manga) {
            return res.status(404).json({ error: '漫画不存在' });
        }

        const chapter = manga.chapters.find(c => c.id === chapterId);
        if (!chapter) {
            return res.status(404).json({ error: '章节不存在' });
        }

        try {
            const filePath = path.resolve(rootDir, chapter.file_path);
            await fs.access(filePath);
            await fs.unlink(filePath);
            console.log(`✅ 章节文件已删除: ${filePath}`);
        } catch (accessError) {
            console.log(`⚠️ 章节文件不存在或无法访问: ${chapter.file_path}`);
        }

        // 🆕 从 PostgreSQL 删除
        await deleteChapter(chapterId);

        res.json({ success: true, message: '章节删除成功' });
    } catch (error) {
        console.error('删除章节失败:', error);
        res.status(500).json({ error: '删除章节失败: ' + error.message });
    }
});

// --- 🆕 标签系统API端点 ---
// 获取所有标签分类
app.get('/api/tag/namespaces', async (req, res) => {
    try {
        const namespaces = await getTagNamespaces();
        res.json(namespaces);
    } catch (error) {
        console.error('获取标签分类失败:', error);
        res.status(500).json({ error: '获取标签分类失败' });
    }
});

// 创建标签分类
app.post('/api/tag/namespaces', requireAuth, async (req, res) => {
    try {
        const { name, display_name, description } = req.body;

        if (!name || !display_name) {
            return res.status(400).json({ error: '标签分类名称和显示名称是必需的' });
        }

        const client = await pgPool.connect();
        try {
            const result = await client.query(
                'INSERT INTO tag_namespaces (name, display_name, description) VALUES ($1, $2, $3) RETURNING *',
                                              [name, display_name, description]
            );
            res.json({ success: true, namespace: result.rows[0] });
        } finally {
            client.release();
        }
    } catch (error) {
        console.error('创建标签分类失败:', error);
        res.status(500).json({ error: '创建标签分类失败: ' + error.message });
    }
});

// 删除标签分类
app.delete('/api/tag/namespaces/:id', requireAuth, async (req, res) => {
    try {
        const { id } = req.params;

        const client = await pgPool.connect();
        try {
            await client.query('DELETE FROM tag_namespaces WHERE id = $1', [id]);
            res.json({ success: true, message: '标签分类删除成功' });
        } finally {
            client.release();
        }
    } catch (error) {
        console.error('删除标签分类失败:', error);
        res.status(500).json({ error: '删除标签分类失败: ' + error.message });
    }
});

// 获取所有标签
app.get('/api/tags', async (req, res) => {
    try {
        const { namespace } = req.query; // 可选的命名空间筛选参数
        const tags = await getTags(namespace || null);
        res.json(tags);
    } catch (error) {
        console.error('获取标签失败:', error);
        res.status(500).json({ error: '获取标签失败' });
    }
});

// 搜索标签
app.get('/api/tags/search', async (req, res) => {
    try {
        const { q } = req.query;
        if (!q || q.trim() === '') {
            return res.status(400).json({ error: '搜索关键词不能为空' });
        }
        const tags = await searchTags(q.trim());
        res.json(tags);
    } catch (error) {
        console.error('搜索标签失败:', error);
        res.status(500).json({ error: '搜索标签失败' });
    }
});

// 创建标签
app.post('/api/tags', requireAuth, async (req, res) => {
    try {
        const { namespace_id, name, slug, description } = req.body;

        if (!namespace_id || !name || !slug) {
            return res.status(400).json({ error: '标签分类ID、名称和标识是必需的' });
        }

        const client = await pgPool.connect();
        try {
            const result = await client.query(
                'INSERT INTO tags (namespace_id, name, slug, description) VALUES ($1, $2, $3, $4) RETURNING *',
                                              [namespace_id, name, slug, description]
            );
            res.json({ success: true, tag: result.rows[0] });
        } finally {
            client.release();
        }
    } catch (error) {
        console.error('创建标签失败:', error);
        res.status(500).json({ error: '创建标签失败: ' + error.message });
    }
});

// 删除标签
app.delete('/api/tags/:id', requireAuth, async (req, res) => {
    try {
        const { id } = req.params;

        const client = await pgPool.connect();
        try {
            await client.query('DELETE FROM manga_tags WHERE tag_id = $1', [id]); // 删除关联记录
            await client.query('DELETE FROM tags WHERE id = $1', [id]); // 删除标签
            res.json({ success: true, message: '标签删除成功' });
        } finally {
            client.release();
        }
    } catch (error) {
        console.error('删除标签失败:', error);
        res.status(500).json({ error: '删除标签失败: ' + error.message });
    }
});

// 为漫画分配标签
app.post('/api/manga/:mangaId/tags/:tagId', requireAuth, async (req, res) => {
    try {
        const { mangaId, tagId } = req.params;

        // 检查漫画是否存在
        const manga = await getMangaById(mangaId);
        if (!manga) {
            return res.status(404).json({ error: '漫画不存在' });
        }

        // 检查标签是否存在
        const client = await pgPool.connect();
        try {
            const tagResult = await client.query('SELECT id FROM tags WHERE id = $1', [tagId]);
            if (tagResult.rows.length === 0) {
                return res.status(404).json({ error: '标签不存在' });
            }

            // 插入漫画-标签关联
            await client.query(
                'INSERT INTO manga_tags (manga_id, tag_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
                               [mangaId, tagId]
            );

            res.json({ success: true, message: '标签分配成功' });
        } finally {
            client.release();
        }
    } catch (error) {
        console.error('分配标签失败:', error);
        res.status(500).json({ error: '分配标签失败: ' + error.message });
    }
});

// 从漫画移除标签
app.delete('/api/manga/:mangaId/tags/:tagId', requireAuth, async (req, res) => {
    try {
        const { mangaId, tagId } = req.params;

        const client = await pgPool.connect();
        try {
            await client.query('DELETE FROM manga_tags WHERE manga_id = $1 AND tag_id = $2', [mangaId, tagId]);
            res.json({ success: true, message: '标签移除成功' });
        } finally {
            client.release();
        }
    } catch (error) {
        console.error('移除标签失败:', error);
        res.status(500).json({ error: '移除标签失败: ' + error.message });
    }
});

// 启动服务器
async function startServer() {
    await createDirectories();
    await initializeTagSystem(); // 初始化标签系统
    await initializeCarouselTable(); // 初始化轮播图表
    app.listen(port, () => {
        console.log(`🚀 服务器运行在 http://localhost:${port}`);
        console.log(`🔐 管理员密码: ${ADMIN_PASSWORD}`);
        console.log('请确保所有HTML文件在同一目录下');
        console.log('访问首页: http://localhost:3000');
        console.log('访问登录页: http://localhost:3000/login.html');
        console.log('访问阅读器: http://localhost:3000/reader.html?manga=漫画ID&chapter=章节ID');
        console.log('访问管理后台: http://localhost:3000/admin-dashboard.html (需要登录)');
    });
}

startServer()
