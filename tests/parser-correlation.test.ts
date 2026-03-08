import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { DEFAULT_RULES, generateReport, parseLogFile } from '../server/parser';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

test('UDAL request/response correlation preserves non-zero timings', async () => {
  const filePath = path.join(rootDir, 'test_data', '审计日志1.log');
  const { clusters } = await parseLogFile(filePath, DEFAULT_RULES, 'udal');
  const topCluster = clusters.find((cluster) => cluster.exec_count >= 50);

  assert.ok(topCluster, 'expected a high-frequency UDAL cluster');
  assert.ok(topCluster.timed_exec_count > 0, 'expected timed UDAL samples');
  assert.ok(topCluster.total_time_ms > 0, 'expected non-zero total time');
  assert.ok(topCluster.avg_time_ms > 0, 'expected non-zero average time');
  assert.ok(topCluster.max_time_ms > 0, 'expected non-zero max time');

  const report = generateReport('审计日志1.log', clusters, 0, 0, clusters.length);
  assert.match(report, /Total time:\s+(?!0(?:\.0+)?ms)\d/);
  assert.match(report, /Avg time:\s+(?!0(?:\.0+)?ms)\d/);
});

test('PostgreSQL statement/duration correlation preserves non-zero timings', async () => {
  const filePath = path.join(rootDir, 'test_data', 'tmp-postgresql-correlation.log');
  await fs.writeFile(filePath, [
    '2026-03-08 10:00:01 UTC [12345] LOG:  statement: SELECT * FROM pg_catalog.pg_class WHERE oid = 1',
    '2026-03-08 10:00:01 UTC [12345] LOG:  duration: 0.456 ms',
    '2026-03-08 10:00:02 UTC [12345] LOG:  execute <unnamed>: SELECT * FROM pg_catalog.pg_class WHERE oid = 2',
    '2026-03-08 10:00:02 UTC [12345] LOG:  duration: 0.789 ms',
  ].join('\n'));

  try {
    const { clusters } = await parseLogFile(filePath, DEFAULT_RULES, 'postgresql');
    const timedCluster = clusters.find((cluster) => cluster.sql_template.includes('SELECT * FROM pg_catalog.pg_class WHERE oid = ?'));

    assert.ok(timedCluster, 'expected parsed PostgreSQL cluster');
    assert.equal(timedCluster.exec_count, 2);
    assert.equal(timedCluster.timed_exec_count, 2);
    assert.ok(timedCluster.total_time_ms > 0, 'expected non-zero total time');
    assert.ok(timedCluster.avg_time_ms > 0, 'expected non-zero average time');
  } finally {
    await fs.rm(filePath, { force: true });
  }
});

test('PostgreSQL timing correlation still works when analyzed with the wrong engine selection', async () => {
  const filePath = path.join(rootDir, 'test_data', 'tmp-postgresql-fallback.log');
  await fs.writeFile(filePath, [
    '2026-03-08 10:00:01 UTC [12345] LOG:  statement: SELECT * FROM pg_catalog.pg_class WHERE oid = 1',
    '2026-03-08 10:00:01 UTC [12345] LOG:  duration: 0.456 ms',
    '2026-03-08 10:00:02 UTC [12345] LOG:  execute <unnamed>: SELECT * FROM pg_catalog.pg_class WHERE oid = 2',
    '2026-03-08 10:00:02 UTC [12345] LOG:  duration: 0.789 ms',
  ].join('\n'));

  try {
    const { clusters } = await parseLogFile(filePath, DEFAULT_RULES, 'udal');
    const timedCluster = clusters.find((cluster) => cluster.sql_template.includes('SELECT * FROM pg_catalog.pg_class WHERE oid = ?'));

    assert.ok(timedCluster, 'expected parsed PostgreSQL cluster via fallback parser');
    assert.equal(timedCluster.exec_count, 2);
    assert.equal(timedCluster.timed_exec_count, 2);
    assert.ok(timedCluster.total_time_ms > 0, 'expected non-zero total time even with wrong engine selection');
  } finally {
    await fs.rm(filePath, { force: true });
  }
});

test('report shows N/A when no timing data exists for a cluster', async () => {
  const filePath = path.join(rootDir, 'test_data', 'postgresql_0933_0939.log');
  const { clusters } = await parseLogFile(filePath, DEFAULT_RULES, 'udal');
  const report = generateReport('postgresql_0933_0939.log', clusters, 0, 0, clusters.length);

  assert.match(report, /Total time:\s+N\/A/);
  assert.match(report, /Avg time:\s+N\/A/);
});

test('UDAL cleaning rules remove SHOW, USE, and SELECT DATABASE metadata queries', async () => {
  const filePath = path.join(rootDir, 'test_data', 'tmp-udal-filter-check.log');
  await fs.writeFile(filePath, [
    '2026-02-27 01:00:00 {"requestId":1,"eventType":"RECEIVE_REQUEST","sql":"SHOW WARNINGS"}',
    '2026-02-27 01:00:00 {"requestId":2,"eventType":"RECEIVE_REQUEST","sql":"SHOW DATABASES"}',
    '2026-02-27 01:00:00 {"requestId":3,"eventType":"RECEIVE_REQUEST","sql":"/* ApplicationName=DBeaver 25.3.4 - Main */ SELECT DATABASE()"}',
    '2026-02-27 01:00:00 {"requestId":4,"eventType":"RECEIVE_REQUEST","sql":"use CUSDB"}',
    '2026-02-27 01:00:00 {"requestId":5,"eventType":"RECEIVE_REQUEST","sql":"SELECT * FROM customer WHERE cust_id = 1"}',
  ].join('\n'));

  try {
    const { clusters } = await parseLogFile(filePath, DEFAULT_RULES, 'udal');

    assert.equal(clusters.length, 1);
    assert.equal(clusters[0].sql_template, 'SELECT * FROM customer WHERE cust_id = ?');
  } finally {
    await fs.rm(filePath, { force: true });
  }
});

test('UDAL metadata filters can be disabled independently', async () => {
  const filePath = path.join(rootDir, 'test_data', 'tmp-udal-filter-switches.log');
  await fs.writeFile(filePath, [
    '2026-02-27 01:00:00 {"requestId":1,"eventType":"RECEIVE_REQUEST","sql":"SHOW DATABASES"}',
    '2026-02-27 01:00:00 {"requestId":2,"eventType":"RECEIVE_REQUEST","sql":"/* ApplicationName=DBeaver */ SELECT DATABASE()"}',
    '2026-02-27 01:00:00 {"requestId":3,"eventType":"RECEIVE_REQUEST","sql":"USE CUSDB"}',
  ].join('\n'));

  try {
    const { clusters } = await parseLogFile(filePath, {
      ...DEFAULT_RULES,
      filterConnectionMeta: false,
      filterClientMeta: false,
    }, 'udal');

    const templates = clusters.map((cluster) => cluster.sql_template);
    assert.ok(templates.includes('SHOW DATABASES'));
    assert.ok(templates.includes('SELECT DATABASE()'));
    assert.ok(templates.includes('USE CUSDB'));
  } finally {
    await fs.rm(filePath, { force: true });
  }
});
