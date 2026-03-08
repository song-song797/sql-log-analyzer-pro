import express from 'express';
import multer from 'multer';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import {
  getDb,
  createTask,
  updateTaskStatus,
  getTask,
  insertClusters,
  queryClusters,
  addRecentFile,
  getRecentFiles,
  deleteTask,
  closeDb,
  type ClusterQueryOptions,
  createUser,
  getUserByEmail,
  createSession,
  getSessionUser,
  deleteSession,
} from './database';
import {
  parseLogFile,
  generateReport,
  generateCsvReport,
  generateReportFilename,
  type CleaningRules,
  DEFAULT_RULES,
} from './parser';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.SERVER_PORT ? parseInt(process.env.SERVER_PORT, 10) : 4399;
const HOST = process.env.SERVER_HOST || '127.0.0.1';
const SESSION_TTL_DAYS = Number(process.env.SESSION_TTL_DAYS || 14);
const UPLOAD_DIR = path.resolve(process.env.UPLOAD_ROOT || path.resolve(__dirname, '../uploads'));

type AuthenticatedRequest = express.Request & {
  authUser?: {
    id: number;
    email: string;
    display_name: string;
    created_at: string;
  };
  authToken?: string;
};

function publicUser(user: AuthenticatedRequest['authUser']) {
  if (!user) return null;
  return {
    id: user.id,
    email: user.email,
    displayName: user.display_name,
    createdAt: user.created_at,
  };
}

function hashPassword(password: string, salt: string) {
  return crypto.pbkdf2Sync(password, salt, 120000, 64, 'sha512').toString('hex');
}

function createPasswordRecord(password: string) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = hashPassword(password, salt);
  return { salt, hash };
}

function getBearerToken(req: express.Request) {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) return null;
  return header.slice('Bearer '.length).trim();
}

async function requireAuth(req: AuthenticatedRequest, res: express.Response, next: express.NextFunction) {
  try {
    const token = getBearerToken(req);
    if (!token) {
      return res.status(401).json({ error: '未登录或会话已失效' });
    }
    const session = await getSessionUser(token);
    if (!session) {
      return res.status(401).json({ error: '未登录或会话已失效' });
    }
    req.authToken = token;
    req.authUser = session.user;
    next();
  } catch (error: any) {
    res.status(500).json({ error: error.message || '认证失败' });
  }
}

function validateUserPayload(email: string, password: string, displayName?: string) {
  const normalizedEmail = String(email || '').trim().toLowerCase();
  const normalizedDisplayName = String(displayName || '').trim();

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) {
    throw new Error('请输入有效的邮箱地址');
  }
  if (String(password || '').length < 8) {
    throw new Error('密码至少需要 8 位');
  }
  if (displayName !== undefined && normalizedDisplayName.length < 2) {
    throw new Error('昵称至少需要 2 个字符');
  }

  return {
    email: normalizedEmail,
    password: String(password),
    displayName: normalizedDisplayName || normalizedEmail.split('@')[0],
  };
}

app.use(cors({
  exposedHeaders: ['Content-Disposition'],
}));
app.use(express.json({ limit: '2mb' }));

if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

app.get('/healthz', async (_req, res) => {
  try {
    await getDb();
    res.json({ ok: true });
  } catch (error: any) {
    res.status(500).json({ ok: false, error: error.message || 'database unavailable' });
  }
});

function getUserUploadDir(userId: number) {
  return path.join(UPLOAD_DIR, `user-${userId}`);
}

function ensureUserUploadDir(userId: number) {
  const userDir = getUserUploadDir(userId);
  if (!fs.existsSync(userDir)) {
    fs.mkdirSync(userDir, { recursive: true });
  }
  return userDir;
}

function isPathInside(parentDir: string, childPath: string) {
  const relative = path.relative(parentDir, childPath);
  return !relative.startsWith('..') && !path.isAbsolute(relative);
}

const storage = multer.diskStorage({
  destination: (req, _file, cb) => {
    const userId = (req as AuthenticatedRequest).authUser?.id;
    if (!userId) {
      return cb(new Error('未登录或会话已失效'), UPLOAD_DIR);
    }
    cb(null, ensureUserUploadDir(userId));
  },
  filename: (_req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
    const ext = path.extname(file.originalname);
    cb(null, `upload-${uniqueSuffix}${ext}`);
  },
});

const upload = multer({ storage });

app.post('/api/auth/register', async (req: any, res: any) => {
  try {
    const { email, password, displayName } = validateUserPayload(req.body?.email, req.body?.password, req.body?.displayName);
    if (await getUserByEmail(email)) {
      return res.status(409).json({ error: '该邮箱已注册' });
    }

    const { salt, hash } = createPasswordRecord(password);
    const user = await createUser(email, hash, salt, displayName);
    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + SESSION_TTL_DAYS * 24 * 60 * 60 * 1000).toISOString();
    await createSession(user.id, token, expiresAt);

    res.status(201).json({ token, user: publicUser(user) });
  } catch (err: any) {
    res.status(400).json({ error: err.message || '注册失败' });
  }
});

app.post('/api/auth/login', async (req: any, res: any) => {
  try {
    const { email, password } = validateUserPayload(req.body?.email, req.body?.password, req.body?.displayName);
    const user = await getUserByEmail(email);
    if (!user) {
      return res.status(401).json({ error: '邮箱或密码错误' });
    }

    const hash = hashPassword(password, user.password_salt);
    if (hash !== user.password_hash) {
      return res.status(401).json({ error: '邮箱或密码错误' });
    }

    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + SESSION_TTL_DAYS * 24 * 60 * 60 * 1000).toISOString();
    await createSession(user.id, token, expiresAt);

    res.json({
      token,
      user: publicUser({
        id: user.id,
        email: user.email,
        display_name: user.display_name,
        created_at: user.created_at,
      }),
    });
  } catch (err: any) {
    res.status(400).json({ error: err.message || '登录失败' });
  }
});

app.get('/api/auth/me', requireAuth, async (req: AuthenticatedRequest, res: any) => {
  res.json({ user: publicUser(req.authUser) });
});

app.post('/api/auth/logout', requireAuth, async (req: AuthenticatedRequest, res: any) => {
  try {
    if (req.authToken) {
      await deleteSession(req.authToken);
    }
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message || '退出失败' });
  }
});

app.post('/api/upload', requireAuth, upload.single('logfile'), (req: AuthenticatedRequest & { file?: Express.Multer.File }, res: any) => {
  if (!req.file) {
    return res.status(400).json({ error: '未上传文件' });
  }

  const originalName = Buffer.from(req.file.originalname, 'latin1').toString('utf8');
  res.json({
    filename: originalName,
    path: req.file.path,
    size: req.file.size,
  });
});

app.post('/api/analyze', requireAuth, async (req: AuthenticatedRequest, res: any) => {
  try {
    const { filePath, originalFilename, engine = 'udal', cleaningRules } = req.body;
    const authUser = req.authUser!;

    if (!filePath || !originalFilename) {
      return res.status(400).json({ error: '缺少必要参数: filePath, originalFilename' });
    }

    const userDir = ensureUserUploadDir(authUser.id);
    const resolvedPath = path.resolve(filePath);
    if (!isPathInside(userDir, resolvedPath)) {
      return res.status(403).json({ error: '无权访问该文件' });
    }

    if (!fs.existsSync(resolvedPath)) {
      return res.status(400).json({ error: '文件不存在' });
    }

    const rules: CleaningRules = { ...DEFAULT_RULES, ...cleaningRules };
    const taskId = await createTask(authUser.id, originalFilename, resolvedPath, engine, rules as any);
    const { clusters, totalLines, cleanedCount, warnings } = await parseLogFile(resolvedPath, rules, engine);

    if (clusters.length > 0) {
      await insertClusters(taskId, clusters);
    }

    await updateTaskStatus(taskId, 'completed', totalLines, cleanedCount, clusters.length);
    await addRecentFile(authUser.id, taskId, originalFilename, engine, totalLines, clusters.length);

    res.json({
      taskId,
      status: 'completed',
      totalLines,
      cleanedCount,
      clusterCount: clusters.length,
      warnings: warnings.length > 0 ? warnings : undefined,
      warningCount: warnings.length,
    });
  } catch (err: any) {
    console.error('Analysis error:', err);
    res.status(500).json({ error: '解析失败: ' + (err.message || '未知错误') });
  }
});

app.get('/api/results/:taskId', requireAuth, async (req: AuthenticatedRequest, res: any) => {
  try {
    const taskId = parseInt(req.params.taskId, 10);
    if (isNaN(taskId)) {
      return res.status(400).json({ error: '无效的任务 ID' });
    }

    const task = await getTask(taskId, req.authUser!.id);
    if (!task) {
      return res.status(404).json({ error: '任务不存在' });
    }

    const page = Math.max(1, parseInt(req.query.page as string, 10) || 1);
    const pageSize = Math.min(100, Math.max(1, parseInt(req.query.pageSize as string, 10) || 10));
    const search = (req.query.search as string) || '';
    const sortBy = (req.query.sortBy as 'exec_count' | 'avg_time_ms') || 'exec_count';
    const sortOrder = (req.query.sortOrder as 'asc' | 'desc') || 'desc';

    const options: ClusterQueryOptions = { taskId, page, pageSize, search, sortBy, sortOrder };
    const clusters = await queryClusters(options);

    res.json({
      task: {
        id: task.id,
        originalFilename: task.original_filename,
        filePath: task.file_path,
        engine: task.engine,
        status: task.status,
        totalLines: task.total_lines,
        cleanedCount: task.cleaned_count,
        clusterCount: task.cluster_count,
        createdAt: task.created_at,
        finishedAt: task.finished_at,
      },
      clusters,
    });
  } catch (err: any) {
    console.error('Results query error:', err);
    res.status(500).json({ error: '查询失败: ' + (err.message || '未知错误') });
  }
});

app.delete('/api/recent/:taskId', requireAuth, async (req: AuthenticatedRequest, res: any) => {
  try {
    const taskId = parseInt(req.params.taskId, 10);
    if (isNaN(taskId)) {
      return res.status(400).json({ error: '无效的 taskId' });
    }

    await deleteTask(taskId, req.authUser!.id);
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message || '删除失败' });
  }
});

app.get('/api/export/:taskId', requireAuth, async (req: AuthenticatedRequest, res: any) => {
  try {
    const taskId = parseInt(req.params.taskId, 10);
    if (isNaN(taskId)) {
      return res.status(400).json({ error: '无效的任务 ID' });
    }

    const task = await getTask(taskId, req.authUser!.id);
    if (!task) {
      return res.status(404).json({ error: '任务不存在' });
    }

    const format = (req.query.format === 'csv' ? 'csv' : 'txt') as 'txt' | 'csv';
    const allClusters = await queryClusters({
      taskId,
      page: 1,
      pageSize: 10000,
      sortBy: 'exec_count',
      sortOrder: 'desc',
    });

    const reportContent = format === 'csv'
      ? generateCsvReport(allClusters.items as any, task.total_lines, task.cleaned_count, task.cluster_count)
      : generateReport(task.original_filename, allClusters.items as any, task.total_lines, task.cleaned_count, task.cluster_count);

    const reportFilename = generateReportFilename(task.original_filename, format);
    const contentType = format === 'csv' ? 'text/csv; charset=utf-8' : 'text/plain; charset=utf-8';
    const asciiFilename = `report.${format}`;

    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${asciiFilename}"; filename*=UTF-8''${encodeURIComponent(reportFilename)}`);
    res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition');
    res.send(reportContent);
  } catch (err: any) {
    console.error('Export error:', err);
    res.status(500).json({ error: '导出失败: ' + (err.message || '未知错误') });
  }
});

app.get('/api/recent', requireAuth, async (req: AuthenticatedRequest, res: any) => {
  try {
    const recent = await getRecentFiles(req.authUser!.id, 10);
    res.json({ files: recent });
  } catch (err: any) {
    console.error('Recent files error:', err);
    res.status(500).json({ error: '获取最近文件失败: ' + (err.message || '未知错误') });
  }
});

async function shutdown(code = 0) {
  try {
    await closeDb();
  } finally {
    process.exit(code);
  }
}

process.on('SIGINT', () => {
  void shutdown(0);
});

process.on('SIGTERM', () => {
  void shutdown(0);
});

function tryListen(port: number = 4399, maxAttempts = 20) {
  const server = app.listen(port, HOST, () => {
    const actualPort = (server.address() as any).port;
    console.log(`🚀 SQL Log Analyzer API 运行在 http://${HOST}:${actualPort}`);
    fs.writeFileSync(path.resolve(__dirname, '../.server-port'), String(actualPort));
  });

  server.on('error', (err: any) => {
    if (err.code === 'EADDRINUSE' && maxAttempts > 1) {
      console.log(`⚠️ 端口 ${port} 被占用，尝试 ${port + 1}...`);
      tryListen(port + 1, maxAttempts - 1);
    } else {
      console.error('❌ 无法启动服务器:', err.message);
      process.exit(1);
    }
  });
}

void getDb()
  .then(() => {
    tryListen(Number(PORT));
  })
  .catch((error) => {
    console.error('❌ 无法连接 PostgreSQL:', error.message);
    process.exit(1);
  });
