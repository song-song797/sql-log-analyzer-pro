import { Pool } from 'pg';

const DEFAULT_DATABASE_URL = 'postgres://postgres:postgres@127.0.0.1:5432/sql_log_analyzer';

let pool: Pool | null = null;
let initPromise: Promise<void> | null = null;

export interface UserRecord {
  id: number;
  email: string;
  display_name: string;
  created_at: string;
}

type ClusterInsert = {
  fingerprint: string;
  sql_template: string;
  exec_count: number;
  timed_exec_count: number;
  avg_time_ms: number;
  total_time_ms: number;
  max_time_ms: number;
  min_time_ms: number;
  sql_type: string;
};

function getDatabaseUrl() {
  return process.env.DATABASE_URL || DEFAULT_DATABASE_URL;
}

function ensurePool() {
  if (!pool) {
    pool = new Pool({
      connectionString: getDatabaseUrl(),
    });
  }
  return pool;
}

async function initSchema() {
  const db = ensurePool();

  await db.query(`
    CREATE TABLE IF NOT EXISTS users (
      id BIGSERIAL PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      password_salt TEXT NOT NULL,
      display_name TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id BIGSERIAL PRIMARY KEY,
      user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token TEXT NOT NULL UNIQUE,
      expires_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_used_at TIMESTAMPTZ
    );

    CREATE TABLE IF NOT EXISTS tasks (
      id BIGSERIAL PRIMARY KEY,
      user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      original_filename TEXT NOT NULL,
      file_path TEXT NOT NULL,
      engine TEXT NOT NULL DEFAULT 'udal',
      status TEXT NOT NULL DEFAULT 'pending',
      total_lines INTEGER NOT NULL DEFAULT 0,
      cleaned_count INTEGER NOT NULL DEFAULT 0,
      cluster_count INTEGER NOT NULL DEFAULT 0,
      cleaning_rules JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      finished_at TIMESTAMPTZ
    );

    CREATE TABLE IF NOT EXISTS sql_clusters (
      id BIGSERIAL PRIMARY KEY,
      task_id BIGINT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      fingerprint TEXT NOT NULL,
      sql_template TEXT NOT NULL,
      exec_count INTEGER NOT NULL DEFAULT 0,
      timed_exec_count INTEGER NOT NULL DEFAULT 0,
      avg_time_ms DOUBLE PRECISION NOT NULL DEFAULT 0,
      total_time_ms DOUBLE PRECISION NOT NULL DEFAULT 0,
      max_time_ms DOUBLE PRECISION NOT NULL DEFAULT 0,
      min_time_ms DOUBLE PRECISION NOT NULL DEFAULT 0,
      sql_type TEXT NOT NULL DEFAULT 'UNKNOWN'
    );

    CREATE TABLE IF NOT EXISTS recent_files (
      id BIGSERIAL PRIMARY KEY,
      user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      task_id BIGINT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      filename TEXT NOT NULL,
      engine TEXT NOT NULL DEFAULT 'udal',
      total_lines INTEGER NOT NULL DEFAULT 0,
      cluster_count INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
    CREATE INDEX IF NOT EXISTS idx_sessions_token ON sessions(token);
    CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
    CREATE INDEX IF NOT EXISTS idx_tasks_user ON tasks(user_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_clusters_task ON sql_clusters(task_id);
    CREATE INDEX IF NOT EXISTS idx_clusters_count ON sql_clusters(task_id, exec_count DESC);
    CREATE INDEX IF NOT EXISTS idx_clusters_fingerprint ON sql_clusters(task_id, fingerprint);
    CREATE INDEX IF NOT EXISTS idx_recent_user ON recent_files(user_id, created_at DESC);
  `);

  await db.query(`
    DELETE FROM recent_files rf
    WHERE EXISTS (
      SELECT 1
      FROM recent_files newer
      WHERE newer.user_id = rf.user_id
        AND newer.filename = rf.filename
        AND newer.id > rf.id
    )
  `);
}

export async function getDb(): Promise<Pool> {
  const db = ensurePool();
  if (!initPromise) {
    initPromise = initSchema();
  }
  await initPromise;
  return db;
}

// ===================== User & Session =====================

export async function createUser(
  email: string,
  passwordHash: string,
  passwordSalt: string,
  displayName: string
): Promise<UserRecord> {
  const db = await getDb();
  const result = await db.query<UserRecord>(
    `INSERT INTO users (email, password_hash, password_salt, display_name)
     VALUES ($1, $2, $3, $4)
     RETURNING id, email, display_name, created_at::text`,
    [email, passwordHash, passwordSalt, displayName]
  );
  return result.rows[0];
}

export async function getUserByEmail(email: string) {
  const db = await getDb();
  const result = await db.query<UserRecord & { password_hash: string; password_salt: string }>(
    `SELECT id, email, display_name, created_at::text, password_hash, password_salt
     FROM users
     WHERE email = $1`,
    [email]
  );
  return result.rows[0];
}

export async function getUserById(userId: number) {
  const db = await getDb();
  const result = await db.query<UserRecord>(
    `SELECT id, email, display_name, created_at::text
     FROM users
     WHERE id = $1`,
    [userId]
  );
  return result.rows[0];
}

export async function createSession(userId: number, token: string, expiresAt: string) {
  const db = await getDb();
  await db.query(
    `INSERT INTO sessions (user_id, token, expires_at, last_used_at)
     VALUES ($1, $2, $3::timestamptz, NOW())`,
    [userId, token, expiresAt]
  );
}

export async function getSessionUser(token: string) {
  const db = await getDb();
  const result = await db.query<{
    session_id: number;
    user_id: number;
    expires_at: string;
    email: string;
    display_name: string;
    created_at: string;
  }>(
    `SELECT s.id AS session_id,
            s.user_id,
            s.expires_at::text,
            u.email,
            u.display_name,
            u.created_at::text
     FROM sessions s
     INNER JOIN users u ON u.id = s.user_id
     WHERE s.token = $1`,
    [token]
  );

  const row = result.rows[0];
  if (!row) return undefined;
  if (Date.parse(row.expires_at) <= Date.now()) {
    await deleteSession(token);
    return undefined;
  }

  await db.query(`UPDATE sessions SET last_used_at = NOW() WHERE token = $1`, [token]);

  return {
    sessionId: row.session_id,
    user: {
      id: row.user_id,
      email: row.email,
      display_name: row.display_name,
      created_at: row.created_at,
    } satisfies UserRecord,
  };
}

export async function deleteSession(token: string) {
  const db = await getDb();
  await db.query(`DELETE FROM sessions WHERE token = $1`, [token]);
}

// ===================== Task CRUD =====================

export async function createTask(
  userId: number,
  originalFilename: string,
  filePath: string,
  engine: string,
  cleaningRules: Record<string, boolean>
): Promise<number> {
  const db = await getDb();
  const result = await db.query<{ id: number }>(
    `INSERT INTO tasks (user_id, original_filename, file_path, engine, cleaning_rules)
     VALUES ($1, $2, $3, $4, $5::jsonb)
     RETURNING id`,
    [userId, originalFilename, filePath, engine, JSON.stringify(cleaningRules)]
  );
  return result.rows[0].id;
}

export async function updateTaskStatus(
  taskId: number,
  status: string,
  totalLines: number,
  cleanedCount: number,
  clusterCount: number
) {
  const db = await getDb();
  await db.query(
    `UPDATE tasks
     SET status = $1,
         total_lines = $2,
         cleaned_count = $3,
         cluster_count = $4,
         finished_at = NOW()
     WHERE id = $5`,
    [status, totalLines, cleanedCount, clusterCount, taskId]
  );
}

export async function getTask(taskId: number, userId: number) {
  const db = await getDb();
  const result = await db.query(
    `SELECT *
     FROM tasks
     WHERE id = $1 AND user_id = $2`,
    [taskId, userId]
  );
  return result.rows[0];
}

// ===================== SQL Clusters =====================

export async function insertClusters(taskId: number, clusters: ClusterInsert[]) {
  if (clusters.length === 0) return;
  const db = await getDb();
  const client = await db.connect();

  try {
    await client.query('BEGIN');
    const text = `
      INSERT INTO sql_clusters (
        task_id,
        fingerprint,
        sql_template,
        exec_count,
        timed_exec_count,
        avg_time_ms,
        total_time_ms,
        max_time_ms,
        min_time_ms,
        sql_type
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
    `;

    for (const cluster of clusters) {
      await client.query(text, [
        taskId,
        cluster.fingerprint,
        cluster.sql_template,
        cluster.exec_count,
        cluster.timed_exec_count,
        cluster.avg_time_ms,
        cluster.total_time_ms,
        cluster.max_time_ms,
        cluster.min_time_ms,
        cluster.sql_type,
      ]);
    }

    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export interface ClusterQueryOptions {
  taskId: number;
  page: number;
  pageSize: number;
  search?: string;
  sortBy?: 'exec_count' | 'avg_time_ms';
  sortOrder?: 'asc' | 'desc';
}

export async function queryClusters(options: ClusterQueryOptions) {
  const db = await getDb();
  const { taskId, page, pageSize, search, sortBy = 'exec_count', sortOrder = 'desc' } = options;
  const offset = (page - 1) * pageSize;

  const whereParts = ['task_id = $1'];
  const params: Array<number | string> = [taskId];

  if (search && search.trim()) {
    const like = `%${search.trim()}%`;
    params.push(like, like, like);
    whereParts.push(`(sql_template ILIKE $${params.length - 2} OR fingerprint ILIKE $${params.length - 1} OR sql_type ILIKE $${params.length})`);
  }

  const whereClause = `WHERE ${whereParts.join(' AND ')}`;
  const allowedSort = new Set(['exec_count', 'avg_time_ms']);
  const column = allowedSort.has(sortBy) ? sortBy : 'exec_count';
  const direction = sortOrder === 'asc' ? 'ASC' : 'DESC';

  const countRow = await db.query<{ total: string }>(
    `SELECT COUNT(*)::text AS total FROM sql_clusters ${whereClause}`,
    params
  );
  const total = Number(countRow.rows[0]?.total || 0);

  const listParams = [...params, pageSize, offset];
  const rows = await db.query(
    `SELECT *
     FROM sql_clusters
     ${whereClause}
     ORDER BY ${column} ${direction}
     LIMIT $${listParams.length - 1} OFFSET $${listParams.length}`,
    listParams
  );

  const sumRow = await db.query<{ total_exec_count: string }>(
    `SELECT COALESCE(SUM(exec_count), 0)::text AS total_exec_count
     FROM sql_clusters
     ${whereClause}`,
    params
  );

  return {
    items: rows.rows,
    total,
    page,
    pageSize,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
    totalExecCount: Number(sumRow.rows[0]?.total_exec_count || 0),
  };
}

// ===================== Recent Files =====================

export async function addRecentFile(
  userId: number,
  taskId: number,
  filename: string,
  engine: string,
  totalLines: number,
  clusterCount: number
) {
  const db = await getDb();
  await db.query(`DELETE FROM recent_files WHERE user_id = $1 AND filename = $2`, [userId, filename]);
  await db.query(
    `INSERT INTO recent_files (user_id, task_id, filename, engine, total_lines, cluster_count)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [userId, taskId, filename, engine, totalLines, clusterCount]
  );
  await db.query(
    `DELETE FROM recent_files
     WHERE user_id = $1
       AND id NOT IN (
         SELECT id
         FROM recent_files
         WHERE user_id = $1
         ORDER BY created_at DESC, id DESC
         LIMIT 20
       )`,
    [userId]
  );
}

export async function getRecentFiles(userId: number, limit = 10) {
  const db = await getDb();
  const result = await db.query(
    `SELECT rf.*, t.status
     FROM recent_files rf
     LEFT JOIN tasks t ON rf.task_id = t.id
     WHERE rf.user_id = $1
     ORDER BY rf.created_at DESC
     LIMIT $2`,
    [userId, limit]
  );
  return result.rows;
}

export async function deleteTask(taskId: number, userId: number) {
  const db = await getDb();
  await db.query(`DELETE FROM tasks WHERE id = $1 AND user_id = $2`, [taskId, userId]);
}

export async function closeDb() {
  if (!pool) return;
  const activePool = pool;
  pool = null;
  initPromise = null;
  await activePool.end();
}
