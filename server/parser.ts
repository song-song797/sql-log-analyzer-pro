import fs from 'fs';
import readline from 'readline';
import crypto from 'crypto';

// ===================== Types =====================

export interface CleaningRules {
  removeSet: boolean;          // 移除 SET 变量语句
  removeCommit: boolean;       // 移除 COMMIT 显式提交
  normalize: boolean;          // 参数模版化
  filterDriverInit: boolean;   // 过滤驱动初始化 (SELECT @@...)
  filterConnectionMeta: boolean; // 过滤连接元语句 (USE/SELECT DATABASE...)
  filterClientMeta: boolean;   // 过滤客户端元查询 (SHOW DATABASES/WARNINGS...)
  filterUdalOps: boolean;      // 过滤 UDAL/运维指令
  filterTransaction: boolean;  // 过滤事务控制 (BEGIN/ROLLBACK...)
  filterHeartbeat: boolean;    // 过滤探活语句 (SELECT 1)
  correlateRequests: boolean;  // 请求响应关联合并
  filterEndRequest: boolean;   // 过滤 END_REQUEST 响应行
}

export interface ParsedSql {
  rawSql: string;
  normalizedSql: string;
  fingerprint: string;
  sqlType: string;
  responseTimeMs?: number;
  requestId?: string;
}

export interface ClusterResult {
  fingerprint: string;
  sql_template: string;
  exec_count: number;
  timed_exec_count: number;
  avg_time_ms: number;
  total_time_ms: number;
  max_time_ms: number;
  min_time_ms: number;
  sql_type: string;
}

export const DEFAULT_RULES: CleaningRules = {
  removeSet: true,
  removeCommit: true,
  normalize: true,
  filterDriverInit: true,
  filterConnectionMeta: true,
  filterClientMeta: true,
  filterUdalOps: true,
  filterTransaction: true,
  filterHeartbeat: true,
  correlateRequests: true,
  filterEndRequest: true,
};

// ===================== SQL Type detection =====================

function stripLeadingSqlComments(sql: string): string {
  let cleaned = sql.trimStart();

  while (true) {
    const next = cleaned
      .replace(/^\/\*[\s\S]*?\*\/\s*/u, '')
      .replace(/^--[^\n]*(?:\n\s*)?/u, '')
      .trimStart();
    if (next === cleaned) {
      return cleaned;
    }
    cleaned = next;
  }
}

function detectSqlType(sql: string): string {
  const upper = stripLeadingSqlComments(sql).toUpperCase();
  if (upper.startsWith('SELECT')) return 'READ';
  if (upper.startsWith('INSERT')) return 'APPEND';
  if (upper.startsWith('UPDATE')) return 'WRITE';
  if (upper.startsWith('DELETE')) return 'DELETE';
  if (upper.startsWith('CREATE')) return 'DDL';
  if (upper.startsWith('ALTER')) return 'DDL';
  if (upper.startsWith('DROP')) return 'DDL';
  if (upper.startsWith('TRUNCATE')) return 'DDL';
  if (upper.startsWith('REPLACE')) return 'WRITE';
  if (upper.startsWith('MERGE')) return 'WRITE';
  if (upper.startsWith('CALL')) return 'CALL';
  if (upper.startsWith('SHOW')) return 'ADMIN';
  if (upper.startsWith('DESCRIBE') || upper.startsWith('DESC ')) return 'ADMIN';
  if (upper.startsWith('EXPLAIN')) return 'ADMIN';
  return 'OTHER';
}

// ===================== Cleaning Filters =====================

function shouldFilter(sql: string, rules: CleaningRules): boolean {
  const candidate = stripLeadingSqlComments(sql);
  const upper = candidate.toUpperCase();

  if (rules.removeSet && upper.startsWith('SET ')) return true;
  if (rules.removeCommit && upper.startsWith('COMMIT')) return true;

  if (rules.filterDriverInit) {
    if (/^SELECT\s+@@/i.test(candidate)) return true;
    if (/^SELECT\s+.*@@\w+/i.test(candidate)) return true;
    // Common JDBC driver init queries
    if (/^SELECT\s+VERSION\s*\(\s*\)/i.test(candidate)) return true;
    if (/^SELECT\s+USER\s*\(\s*\)/i.test(candidate)) return true;
  }

  if (rules.filterConnectionMeta) {
    if (/^SELECT\s+DATABASE\s*\(\s*\)/i.test(candidate)) return true;
    if (/^SELECT\s+(CURRENT_(?:SCHEMA|DATABASE)|SCHEMA)\s*\(\s*\)/i.test(candidate)) return true;
    if (upper.startsWith('USE ')) return true;
  }

  if (rules.filterClientMeta) {
    if (upper.startsWith('SHOW ')) return true;
  }

  if (rules.filterUdalOps) {
    if (upper.startsWith('UDAL ') || upper.startsWith('UDAL_')) return true;
  }

  if (rules.filterTransaction) {
    if (upper.startsWith('BEGIN')) return true;
    if (upper.startsWith('ROLLBACK')) return true;
    if (upper.startsWith('START TRANSACTION')) return true;
    if (upper === 'COMMIT') return true;
  }

  if (rules.filterHeartbeat) {
    if (/^SELECT\s+1\s*$/i.test(sql.trim())) return true;
    if (/^SELECT\s+1\s+AS\s+\w+\s*$/i.test(sql.trim())) return true;
    if (/^\/\*.*\*\/\s*SELECT\s+1\s*$/i.test(sql.trim())) return true;
  }

  return false;
}

// ===================== SQL Normalization =====================

function normalizeSql(sql: string): string {
  let normalized = sql;

  // Remove inline comments /* ... */
  normalized = normalized.replace(/\/\*.*?\*\//gs, '');

  // Remove line comments -- ...
  normalized = normalized.replace(/--[^\n]*/g, '');

  // Replace quoted strings with ?
  normalized = normalized.replace(/'(?:[^'\\]|\\.)*'/g, '?');
  normalized = normalized.replace(/"(?:[^"\\]|\\.)*"/g, '?');

  // Replace numeric values with ?
  normalized = normalized.replace(/\b\d+\.?\d*\b/g, '?');

  // Replace IN (...) lists with IN (?)
  normalized = normalized.replace(/\bIN\s*\(\s*\?(?:\s*,\s*\?)*\s*\)/gi, 'IN (?)');

  // Replace VALUES (...) tuples
  normalized = normalized.replace(/VALUES\s*\(\s*\?(?:\s*,\s*\?)*\s*\)/gi, 'VALUES (?)');

  // Collapse whitespace
  normalized = normalized.replace(/\s+/g, ' ').trim();

  return normalized;
}

function generateFingerprint(normalizedSql: string): string {
  return crypto.createHash('md5').update(normalizedSql.toLowerCase()).digest('hex').substring(0, 16);
}

// ===================== UDAL Log Parsing =====================

/**
 * UDAL log format patterns:
 * - SQL statements usually appear after a request header line
 * - Common patterns:
 *   [timestamp] [level] [requestId] SQL: <sql statement>
 *   [timestamp] [level] [requestId] sql=<sql statement> time=<ms>
 *   Plain SQL statements (one per line or multi-line with semicolons)
 */

interface UdalLogEntry {
  sql: string;
  requestId?: string;
  responseTimeMs?: number;
  correlationKey?: string;
  entryType?: 'sql' | 'end_request' | 'duration_only';
}

function parseUdalLogLine(line: string): UdalLogEntry | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('//')) return null;

  // Pattern 0: JSON audit log format
  // e.g: 2026-02-27 00:00:01 {"schema":"CUSDBX","requestId":123,"eventType":"RECEIVE_REQUEST","user":"crmtest@...","sql":"SELECT * FROM t"}
  // Also handles END_REQUEST lines (cost-only, no sql) — skip those.
  const jsonStart = trimmed.indexOf('{');
  if (jsonStart !== -1) {
    const jsonStr = trimmed.slice(jsonStart);
    try {
      const obj = JSON.parse(jsonStr);
      if (obj && typeof obj === 'object') {
        // Mark END_REQUEST lines (no SQL, only cost info)
        if (obj.eventType === 'END_REQUEST') {
          return {
            sql: '__END_REQUEST__',
            requestId: obj.requestId ? String(obj.requestId) : undefined,
            responseTimeMs: typeof obj.cost === 'number' ? obj.cost : undefined,
            entryType: 'end_request',
          };
        }
        // Skip lines without sql field
        if (!obj.sql || (typeof obj.sql === 'string' && obj.sql.trim() === '')) {
          return null;
        }
        const sql = String(obj.sql).trim();
        const entry: UdalLogEntry = { sql };
        if (typeof obj.cost === 'number') {
          entry.responseTimeMs = obj.cost;
        }
        if (obj.requestId) {
          entry.requestId = String(obj.requestId);
        }
        entry.entryType = 'sql';
        return entry;
      }
    } catch {
      // Not valid JSON, fall through to other patterns
    }
  }

  // Pattern 1: key=value format (common in UDAL middleware logs)
  // e.g: [2023-10-24 10:30:12] [INFO] [req-123] sql=SELECT * FROM users time=12ms
  const kvMatch = trimmed.match(/sql[=:]\s*(.+?)(?:\s+time[=:]\s*([\d.]+)\s*(?:ms)?)?$/i);
  if (kvMatch) {
    return {
      sql: kvMatch[1].replace(/;?\s*$/, '').trim(),
      responseTimeMs: kvMatch[2] ? parseFloat(kvMatch[2]) : undefined,
      entryType: 'sql',
    };
  }

  // Pattern 2: SQL: prefix format
  // e.g: [2023-10-24 10:30:12] [INFO] SQL: SELECT * FROM users WHERE id = 1
  const sqlPrefixMatch = trimmed.match(/\bSQL:\s*(.+)$/i);
  if (sqlPrefixMatch) {
    const requestIdMatch = trimmed.match(/\[([a-zA-Z0-9_-]+)\]/g);
    return {
      sql: sqlPrefixMatch[1].replace(/;?\s*$/, '').trim(),
      requestId: requestIdMatch?.[requestIdMatch.length - 1]?.replace(/[\[\]]/g, ''),
      entryType: 'sql',
    };
  }

  // Pattern 3: Lines with response time info
  // e.g: cost=45ms, SELECT * FROM session_tokens
  const costMatch = trimmed.match(/cost[=:]\s*([\d.]+)\s*(?:ms)?\s*[,;]?\s*(.+)/i);
  if (costMatch) {
    const sql = costMatch[2].trim();
    if (looksLikeSql(sql)) {
      return {
        sql: sql.replace(/;?\s*$/, ''),
        responseTimeMs: parseFloat(costMatch[1]),
        entryType: 'sql',
      };
    }
  }

  // Pattern 4: Plain SQL statement (direct SQL line)
  if (looksLikeSql(trimmed)) {
    return {
      sql: trimmed.replace(/;?\s*$/, '').trim(),
      entryType: 'sql',
    };
  }

  return null;
}

function looksLikeSql(s: string): boolean {
  const upper = s.trimStart().toUpperCase();
  return /^(SELECT|INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|REPLACE|MERGE|TRUNCATE|CALL|SET|BEGIN|COMMIT|ROLLBACK|START\s+TRANSACTION|SHOW|DESCRIBE|DESC |EXPLAIN|WITH|DO|COPY|VACUUM|ANALYZE|REINDEX|CLUSTER|REFRESH|NOTIFY|LISTEN|PREPARE|EXECUTE|DEALLOCATE)\b/.test(upper);
}

// ===================== PostgreSQL Log Parsing =====================

/**
 * PostgreSQL log format patterns:
 * - 2023-10-24 10:00:01.123 UTC [12345] LOG:  statement: SELECT * FROM users
 * - 2023-10-24 10:00:01.123 UTC [12345] LOG:  duration: 0.123 ms  statement: SELECT * FROM users
 * - CSV log format: timestamp,user,dbname,pid,client,session_id,line_num,cmd_tag,session_start,vxid,txid,error_severity,sqlstate,message,...
 * - Plain SQL statements
 */

function parsePostgresLogLine(line: string): UdalLogEntry | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('//')) return null;
  const correlationKey = extractPostgresCorrelationKey(trimmed);

  // Pattern 1: PostgreSQL standard log format with duration + statement
  // e.g: 2023-10-24 10:00:01.123 UTC [12345] LOG:  duration: 0.456 ms  statement: SELECT * FROM users
  const durationStmtMatch = trimmed.match(
    /LOG:\s+duration:\s+([\d.]+)\s*ms\s+statement:\s*(.+)$/i
  );
  if (durationStmtMatch) {
    return {
      sql: durationStmtMatch[2].replace(/;?\s*$/, '').trim(),
      responseTimeMs: parseFloat(durationStmtMatch[1]),
      correlationKey,
      entryType: 'sql',
    };
  }

  // Pattern 2: PostgreSQL LOG: statement: ...
  // e.g: 2023-10-24 10:00:01.123 UTC [12345] LOG:  statement: SELECT * FROM users
  const stmtMatch = trimmed.match(/LOG:\s+statement:\s*(.+)$/i);
  if (stmtMatch) {
    return {
      sql: stmtMatch[1].replace(/;?\s*$/, '').trim(),
      correlationKey,
      entryType: 'sql',
    };
  }

  // Pattern 3: PostgreSQL LOG: execute <name>: ...
  // e.g: LOG:  execute <unnamed>: SELECT * FROM users WHERE id = $1
  const execMatch = trimmed.match(/LOG:\s+execute\s+\S+:\s*(.+)$/i);
  if (execMatch) {
    return {
      sql: execMatch[1].replace(/;?\s*$/, '').trim(),
      correlationKey,
      entryType: 'sql',
    };
  }

  // Pattern 4: PostgreSQL duration only (link to previous statement)
  // e.g: LOG:  duration: 0.456 ms
  const durationOnlyMatch = trimmed.match(/LOG:\s+duration:\s+([\d.]+)\s*ms\s*$/i);
  if (durationOnlyMatch) {
    return {
      sql: '__DURATION_ONLY__',
      responseTimeMs: parseFloat(durationOnlyMatch[1]),
      correlationKey,
      entryType: 'duration_only',
    };
  }

  // Pattern 5: pgBadger / CSV log format
  // Fields: timestamp,user,db,pid,...,LOG,00000,"statement: SELECT..."
  const csvMatch = trimmed.match(/"statement:\s*(.+?)"\s*$/i);
  if (csvMatch) {
    return {
      sql: csvMatch[1].replace(/;?\s*$/, '').trim(),
      correlationKey,
      entryType: 'sql',
    };
  }

  // Pattern 6: Simple "query: ..." format from some PG middleware
  const queryMatch = trimmed.match(/query[=:]\s*(.+?)(?:\s+duration[=:]\s*([\d.]+)\s*(?:ms)?)?$/i);
  if (queryMatch) {
    return {
      sql: queryMatch[1].replace(/;?\s*$/, '').trim(),
      responseTimeMs: queryMatch[2] ? parseFloat(queryMatch[2]) : undefined,
      correlationKey,
      entryType: 'sql',
    };
  }

  // Pattern 7: Plain SQL statement
  if (looksLikeSql(trimmed)) {
    return {
      sql: trimmed.replace(/;?\s*$/, '').trim(),
      correlationKey,
      entryType: 'sql',
    };
  }

  return null;
}

function extractPostgresCorrelationKey(line: string): string | undefined {
  const pidMatch = line.match(/\[(\d+)\]/);
  return pidMatch?.[1];
}

// Generic parser function that picks the right line parser based on engine.
// Falls back to the other engine's parser if the primary one returns null.
function parseLogLine(line: string, engine: string): UdalLogEntry | null {
  if (engine === 'postgresql') {
    const result = parsePostgresLogLine(line);
    if (result) return result;
    // Fallback: try UDAL parser
    return parseUdalLogLine(line);
  }
  const result = parseUdalLogLine(line);
  if (result) return result;
  // Fallback: try PostgreSQL parser
  return parsePostgresLogLine(line);
}

// ===================== Main Parse Function =====================

export interface ParseProgress {
  totalLines: number;
  cleanedCount: number;
  clusterCount: number;
}

export interface UnparseableLine {
  lineNumber: number;
  content: string;
}

export async function parseLogFile(
  filePath: string,
  rules: CleaningRules,
  engine: string = 'udal',
  onProgress?: (progress: ParseProgress) => void
): Promise<{ clusters: ClusterResult[]; totalLines: number; cleanedCount: number; warnings: UnparseableLine[] }> {
  const clusters = new Map<string, {
    fingerprint: string;
    sql_template: string;
    exec_count: number;
    timed_exec_count: number;
    total_time_ms: number;
    max_time_ms: number;
    min_time_ms: number;
    sql_type: string;
  }>();

  let totalLines = 0;
  let cleanedCount = 0;
  const warnings: UnparseableLine[] = [];
  const pendingUdalRequests = new Map<string, UdalLogEntry>();
  const pendingPgStatements = new Map<string, UdalLogEntry>();

  const fileStream = fs.createReadStream(filePath, { encoding: 'utf-8' });
  const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });

  let multiLineBuffer = '';
  let multiLineStartLine = 0;

  // Helper: check if a PG log line is non-SQL infrastructure (skip these)
  function isPgInfraLine(line: string): boolean {
    if (/\bFATAL:\s/.test(line)) return true;
    if (/\bDETAIL:\s/.test(line)) return true;
    if (/\bERROR:\s/.test(line)) return true;
    if (/\bWARNING:\s/.test(line)) return true;
    if (/\bHINT:\s/.test(line)) return true;
    if (/\bCONTEXT:\s/.test(line)) return true;
    if (/\bNOTICE:\s/.test(line)) return true;
    if (/\bSTATEMENT:\s/.test(line)) return true;  // PG error context: shows the SQL that caused the error
    if (/LOG:\s+connection\s+(received|authorized|authenticated)/.test(line)) return true;
    if (/LOG:\s+disconnection:/.test(line)) return true;
    if (/LOG:\s+received\s+SIG/.test(line)) return true;
    if (/LOG:\s+parameter\s+"/.test(line)) return true;
    if (/LOG:\s+checkpoint\s+/.test(line)) return true;
    if (/LOG:\s+duration:\s+[\d.]+\s*ms\s*$/.test(line)) return true; // standalone duration
    if (/LOG:\s+automatic\s+/.test(line)) return true; // autovacuum
    if (/LOG:\s+could\s+not\s+/.test(line)) return true; // error messages
    if (/LOG:\s+database\s+system\s+/.test(line)) return true; // startup/shutdown messages
    if (/LOG:\s+redo\s+/.test(line)) return true; // WAL recovery
    if (/LOG:\s+listening\s+on\s+/.test(line)) return true; // server listening
    if (/LOG:\s+started\s+streaming\s+/.test(line)) return true; // replication
    if (/LOG:\s+incomplete\s+startup\s+/.test(line)) return true;
    return false;
  }

  function addClusterEntry(entry: UdalLogEntry) {
    // Apply cleaning rules
    if (shouldFilter(entry.sql, rules)) {
      cleanedCount++;
      return;
    }

    // Normalize if enabled
    const normalizedSql = rules.normalize ? normalizeSql(entry.sql) : entry.sql;
    const fingerprint = generateFingerprint(normalizedSql);
    const sqlType = detectSqlType(entry.sql);

    cleanedCount++;

    // Aggregate into clusters
    const hasTiming = typeof entry.responseTimeMs === 'number' && Number.isFinite(entry.responseTimeMs);
    const timeMs = hasTiming ? entry.responseTimeMs! : 0;
    const existing = clusters.get(fingerprint);
    if (existing) {
      existing.exec_count++;
      if (hasTiming) {
        existing.timed_exec_count++;
        existing.total_time_ms += timeMs;
        if (existing.timed_exec_count === 1 || timeMs > existing.max_time_ms) existing.max_time_ms = timeMs;
        if (existing.timed_exec_count === 1 || timeMs < existing.min_time_ms) existing.min_time_ms = timeMs;
      }
    } else {
      clusters.set(fingerprint, {
        fingerprint,
        sql_template: normalizedSql,
        exec_count: 1,
        timed_exec_count: hasTiming ? 1 : 0,
        total_time_ms: hasTiming ? timeMs : 0,
        max_time_ms: hasTiming ? timeMs : 0,
        min_time_ms: hasTiming ? timeMs : 0,
        sql_type: sqlType,
      });
    }
  }

  function flushPendingEntry(entry: UdalLogEntry, responseTimeMs?: number) {
    addClusterEntry({
      ...entry,
      responseTimeMs: responseTimeMs ?? entry.responseTimeMs,
      entryType: 'sql',
    });
  }

  // Process a completed line (possibly multi-line)
  function processLine(fullLine: string, lineNum: number) {
    const entry = parseLogLine(fullLine, engine);
    if (!entry) {
      // Silently skip lines that neither parser can recognize
      return;
    }

    if (entry.entryType === 'end_request') {
      if (rules.correlateRequests && entry.requestId && pendingUdalRequests.has(entry.requestId)) {
        const pending = pendingUdalRequests.get(entry.requestId)!;
        pendingUdalRequests.delete(entry.requestId);
        flushPendingEntry(pending, entry.responseTimeMs);
        return;
      }
      if (rules.filterEndRequest) {
        cleanedCount++;
      }
      return;
    }

    if (entry.entryType === 'duration_only') {
      if (rules.correlateRequests && entry.correlationKey && pendingPgStatements.has(entry.correlationKey)) {
        const pending = pendingPgStatements.get(entry.correlationKey)!;
        pendingPgStatements.delete(entry.correlationKey);
        flushPendingEntry(pending, entry.responseTimeMs);
      }
      return;
    }

    if (rules.correlateRequests && entry.entryType === 'sql') {
      if (entry.requestId && entry.responseTimeMs === undefined) {
        const existingPending = pendingUdalRequests.get(entry.requestId);
        if (existingPending) {
          flushPendingEntry(existingPending);
        }
        pendingUdalRequests.set(entry.requestId, entry);
        return;
      }

      if (entry.correlationKey && entry.responseTimeMs === undefined) {
        const existingPending = pendingPgStatements.get(entry.correlationKey);
        if (existingPending) {
          flushPendingEntry(existingPending);
        }
        pendingPgStatements.set(entry.correlationKey, entry);
        return;
      }
    }

    addClusterEntry(entry);
  }

  for await (const line of rl) {
    totalLines++;

    // PostgreSQL multi-line handling: continuation lines start with \t
    if (engine === 'postgresql') {
      if (line.startsWith('\t')) {
        // Continuation of previous line
        if (multiLineBuffer) {
          multiLineBuffer += ' ' + line.trim();
        }
        continue;
      } else {
        // New line - process the buffered one first
        if (multiLineBuffer) {
          processLine(multiLineBuffer, multiLineStartLine);
          multiLineBuffer = '';
        }
        multiLineBuffer = line;
        multiLineStartLine = totalLines;
        continue;
      }
    }

    // UDAL: Handle multi-line SQL (lines ending with \)
    if (line.trimEnd().endsWith('\\')) {
      multiLineBuffer += line.trimEnd().slice(0, -1) + ' ';
      if (!multiLineStartLine) multiLineStartLine = totalLines;
      continue;
    }

    const fullLine = multiLineBuffer ? multiLineBuffer + line : line;
    const lineNum = multiLineStartLine || totalLines;
    multiLineBuffer = '';
    multiLineStartLine = 0;

    processLine(fullLine, lineNum);

    // Emit progress every 10000 lines
    if (totalLines % 10000 === 0 && onProgress) {
      onProgress({ totalLines, cleanedCount, clusterCount: clusters.size });
    }
  }

  // Process any remaining buffered line (PostgreSQL)
  if (multiLineBuffer) {
    processLine(multiLineBuffer, multiLineStartLine);
  }

  for (const pending of pendingUdalRequests.values()) {
    flushPendingEntry(pending);
  }

  for (const pending of pendingPgStatements.values()) {
    flushPendingEntry(pending);
  }

  // Convert map to array and compute averages
  const result: ClusterResult[] = Array.from(clusters.values()).map(c => ({
    fingerprint: c.fingerprint,
    sql_template: c.sql_template,
    exec_count: c.exec_count,
    timed_exec_count: c.timed_exec_count,
    avg_time_ms: c.timed_exec_count > 0 ? Math.round((c.total_time_ms / c.timed_exec_count) * 100) / 100 : 0,
    total_time_ms: c.total_time_ms,
    max_time_ms: c.max_time_ms,
    min_time_ms: c.min_time_ms,
    sql_type: c.sql_type,
  }));

  // Sort by exec_count DESC
  result.sort((a, b) => b.exec_count - a.exec_count);

  return { clusters: result, totalLines, cleanedCount, warnings };
}

// ===================== Export Report =====================

export function generateReport(
  originalFilename: string,
  clusters: ClusterResult[],
  totalLines: number,
  cleanedCount: number,
  clusterCount: number
): string {
  const lines: string[] = [];
  const now = new Date().toLocaleString('zh-CN');
  const formatTiming = (cluster: ClusterResult, value: number) => cluster.timed_exec_count > 0 ? `${value}ms` : 'N/A';

  lines.push('='.repeat(70));
  lines.push('  SQL 日志聚类分析报告');
  lines.push('='.repeat(70));
  lines.push('');
  lines.push(`源文件:        ${originalFilename}`);
  lines.push(`生成时间:      ${now}`);
  lines.push(`解析总行数:    ${totalLines.toLocaleString()}`);
  lines.push(`已处理 SQL 数: ${cleanedCount.toLocaleString()}`);
  lines.push(`唯一 SQL 聚类: ${clusterCount.toLocaleString()}`);
  lines.push('');

  // Helper: right-align a label to a fixed width
  const field = (label: string, value: string | number) => {
    return `${label.padStart(14)}: ${value}`;
  };

  const top = clusters.slice(0, 100);
  top.forEach((c, idx) => {
    const rowNum = `${idx + 1}. row`;
    const pad = Math.max(0, Math.floor((50 - rowNum.length) / 2));
    const separator = '*'.repeat(pad) + ` ${rowNum} ` + '*'.repeat(pad);
    lines.push(separator);
    lines.push(field('Statement', c.sql_template));
    lines.push(field('Count', c.exec_count.toLocaleString()));
    lines.push(field('Type', c.sql_type));
    lines.push(field('Total time', formatTiming(c, c.total_time_ms)));
    lines.push(field('Avg time', formatTiming(c, c.avg_time_ms)));
    lines.push(field('Max time', formatTiming(c, c.max_time_ms)));
    lines.push(field('Min time', formatTiming(c, c.min_time_ms)));
    lines.push('');
  });

  lines.push('*'.repeat(50));
  lines.push(`  共 ${clusterCount} 个聚类，以上显示前 ${Math.min(100, clusterCount)} 个`);
  lines.push('*'.repeat(50));

  return lines.join('\n');
}

/**
 * Generate CSV format report.
 */
export function generateCsvReport(
  clusters: ClusterResult[],
  totalLines: number,
  cleanedCount: number,
  clusterCount: number
): string {
  const rows: string[] = [];
  const formatTiming = (cluster: ClusterResult) => cluster.timed_exec_count > 0 ? String(cluster.avg_time_ms) : 'N/A';
  // BOM for Excel UTF-8 compatibility
  rows.push('\uFEFF排名,SQL类型,SQL模版,执行次数,平均耗时(ms)');
  clusters.slice(0, 100).forEach((c, idx) => {
    const escapedSql = '"' + c.sql_template.replace(/"/g, '""') + '"';
    rows.push(`${idx + 1},${c.sql_type},${escapedSql},${c.exec_count},${formatTiming(c)}`);
  });
  return rows.join('\n');
}

/**
 * Generate a meaningful filename for the export report.
 * Format: [原始文件名]_聚类报告_[日期].[ext]
 */
export function generateReportFilename(originalFilename: string, format: 'txt' | 'csv' = 'txt'): string {
  const basename = originalFilename.replace(/\.[^.]+$/, '');
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  return `${basename}_聚类报告_${date}.${format}`;
}
