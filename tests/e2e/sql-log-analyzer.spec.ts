import { expect, request, test, type APIRequestContext, type Page } from '@playwright/test';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '../..');
const TEST_DATA_DIR = path.join(ROOT_DIR, 'test_data');
const TEST_RUNTIME_DIR = path.join(ROOT_DIR, 'test-results', 'e2e-fixtures');
const BACKEND_URL = 'http://127.0.0.1:4399';
const TOKEN_STORAGE_KEY = 'sql-log-analyzer-token';
const UDAL_FIXTURE_NAME = 'sample_udal.log';
const POSTGRES_FIXTURE_NAME = 'sample_postgresql.log';

const createdTaskIds = new Set<number>();
const createdUploadPaths = new Set<string>();

let authToken = '';
let authEmail = '';
let authPassword = 'password123';
let cleanupVerified = false;
let baselineRecentTaskIds: number[] = [];

type UploadResponse = {
  filename: string;
  path: string;
  size: number;
};

type AnalyzeResponse = {
  taskId?: number;
  status?: string;
  totalLines?: number;
  cleanedCount?: number;
  clusterCount?: number;
  warningCount?: number;
  error?: string;
};

function createAuthHeaders() {
  return { Authorization: `Bearer ${authToken}` };
}

async function createApiContext() {
  return request.newContext({
    baseURL: BACKEND_URL,
    extraHTTPHeaders: createAuthHeaders(),
  });
}

async function registerSmokeUser() {
  const apiContext = await request.newContext({ baseURL: BACKEND_URL });
  try {
    authEmail = `playwright-${Date.now()}@example.com`;
    const response = await apiContext.post('/api/auth/register', {
      data: {
        email: authEmail,
        password: authPassword,
        displayName: 'Playwright Smoke',
      },
    });
    expect(response.ok()).toBeTruthy();
    const payload = await response.json();
    authToken = payload.token;
    expect(authToken).toBeTruthy();
  } finally {
    await apiContext.dispose();
  }
}

async function prepareFixtures() {
  await fs.mkdir(TEST_RUNTIME_DIR, { recursive: true });
  await fs.copyFile(path.join(TEST_DATA_DIR, '审计日志1.log'), path.join(TEST_RUNTIME_DIR, UDAL_FIXTURE_NAME));
  await fs.copyFile(path.join(TEST_DATA_DIR, 'postgresql_0933_0939.log'), path.join(TEST_RUNTIME_DIR, POSTGRES_FIXTURE_NAME));
}

async function getRecentTaskIds(): Promise<number[]> {
  const apiContext = await createApiContext();
  try {
    const response = await apiContext.get('/api/recent');
    expect(response.ok()).toBeTruthy();
    const payload = await response.json();
    return (payload.files ?? [])
      .map((file: { task_id?: number; taskId?: number }) => Number(file.task_id ?? file.taskId))
      .sort((a: number, b: number) => a - b);
  } finally {
    await apiContext.dispose();
  }
}

async function cleanupTrackedArtifacts() {
  const apiContext = await createApiContext();

  try {
    for (const taskId of [...createdTaskIds].reverse()) {
      const response = await apiContext.delete(`/api/recent/${taskId}`);
      expect.soft(response.ok(), `failed to delete task ${taskId}`).toBeTruthy();
      createdTaskIds.delete(taskId);
    }
  } finally {
    await apiContext.dispose();
  }

  for (const uploadPath of [...createdUploadPaths]) {
    await fs.rm(uploadPath, { force: true });
    createdUploadPaths.delete(uploadPath);
  }
}

async function primeAuth(page: Page) {
  await page.addInitScript(
    ({ token, tokenKey }) => {
      window.localStorage.setItem(tokenKey, token);
    },
    { token: authToken, tokenKey: TOKEN_STORAGE_KEY }
  );
}

async function uploadLog(page: Page, filename: string): Promise<UploadResponse> {
  const [response] = await Promise.all([
    page.waitForResponse((res) => res.url().includes('/api/upload') && res.request().method() === 'POST'),
    page.getByTestId('file-input').setInputFiles(path.join(TEST_RUNTIME_DIR, filename)),
  ]);

  expect(response.ok()).toBeTruthy();
  const payload = await response.json() as UploadResponse;
  createdUploadPaths.add(payload.path);
  return payload;
}

async function analyzeCurrentUpload(page: Page): Promise<AnalyzeResponse> {
  const [response] = await Promise.all([
    page.waitForResponse((res) => res.url().includes('/api/analyze') && res.request().method() === 'POST'),
    page.getByTestId('analyze-button').click(),
  ]);

  const payload = await response.json() as AnalyzeResponse;
  if (response.ok() && payload.taskId) {
    createdTaskIds.add(payload.taskId);
  }
  return payload;
}

test.describe.serial('SQL Log Analyzer E2E', () => {
  test.beforeAll(async () => {
    await prepareFixtures();
    await registerSmokeUser();
    baselineRecentTaskIds = await getRecentTaskIds();
  });

  test.beforeEach(async ({ page }) => {
    await primeAuth(page);
  });

  test.afterAll(async () => {
    if (!cleanupVerified) {
      await cleanupTrackedArtifacts();
    }
  });

  test('loads the homepage and shows the idle state', async ({ page }) => {
    await page.goto('/');

    await expect(page.getByTestId('app-shell')).toBeVisible();
    await expect(page.getByTestId('engine-udal')).toBeVisible();
    await expect(page.getByTestId('engine-postgresql')).toBeVisible();
    await expect(page.getByTestId('upload-dropzone')).toBeVisible();
    await expect(page.getByTestId('search-input')).toBeVisible();
    await expect(page.getByTestId('export-button')).toBeDisabled();
    await expect(page.getByTestId('analyze-button')).toBeDisabled();
    await expect(page.getByTestId('empty-state-idle')).toContainText('上传日志文件并点击"开始解析"查看结果');
  });

  test('runs the UDAL flow including search, export, recent load, and recent delete', async ({ page }, testInfo) => {
    await page.goto('/');
    await uploadLog(page, UDAL_FIXTURE_NAME);

    await expect(page.getByTestId('analyze-button')).toBeEnabled();
    const analyzePayload = await analyzeCurrentUpload(page);
    expect(analyzePayload.taskId).toBeTruthy();
    expect(analyzePayload.clusterCount ?? 0).toBeGreaterThan(0);

    const udalTaskId = analyzePayload.taskId!;
    await expect(page.getByTestId('current-task-name')).toHaveText(UDAL_FIXTURE_NAME);
    await expect(page.getByTestId('metric-total-lines')).not.toContainText('0');
    await expect(page.getByTestId('metric-cluster-count')).not.toContainText('0');
    await expect(page.getByTestId('results-table')).toBeVisible();
    await expect(page.getByTestId(`recent-item-${udalTaskId}`)).toBeVisible();

    await page.getByTestId('search-input').fill('definitely-no-match');
    await page.getByTestId('search-button').click();
    await expect(page.getByTestId('empty-state-search')).toContainText('未找到匹配的 SQL 聚类');

    await page.getByTestId('search-input').fill('');
    await page.getByTestId('search-button').click();
    await expect(page.getByTestId('results-table')).toBeVisible();

    await page.getByTestId('engine-postgresql').click();
    await expect(page.getByTestId('analysis-dirty-hint')).toContainText('配置已修改');
    await expect(page.getByTestId('analyze-button')).toContainText('应用规则并重新分析');
    await expect(page.getByTestId('current-task-name')).toHaveText(UDAL_FIXTURE_NAME);
    await page.getByTestId('engine-udal').click();
    await expect(page.getByTestId('analysis-dirty-hint')).toContainText('配置已修改');

    await page.getByTestId('export-format').selectOption('txt');
    const txtDownloadPromise = page.waitForEvent('download');
    await page.getByTestId('export-button').click();
    const txtDownload = await txtDownloadPromise;
    expect(txtDownload.suggestedFilename()).toMatch(/sample_udal_聚类报告_\d{8}\.txt$/);
    const txtPath = testInfo.outputPath('sample-udal-report.txt');
    await txtDownload.saveAs(txtPath);
    const txtContent = await fs.readFile(txtPath, 'utf8');
    expect(txtContent.length).toBeGreaterThan(0);
    expect(txtContent).toMatch(/Total time:\s+(?!0(?:\.0+)?ms)\d/);
    expect(txtContent).toMatch(/Avg time:\s+(?!0(?:\.0+)?ms)\d/);

    await page.getByTestId('export-format').selectOption('csv');
    const csvDownloadPromise = page.waitForEvent('download');
    await page.getByTestId('export-button').click();
    const csvDownload = await csvDownloadPromise;
    expect(csvDownload.suggestedFilename()).toMatch(/sample_udal_聚类报告_\d{8}\.csv$/);
    const csvPath = testInfo.outputPath('sample-udal-report.csv');
    await csvDownload.saveAs(csvPath);
    const csvContent = await fs.readFile(csvPath, 'utf8');
    expect(csvContent.length).toBeGreaterThan(0);

    await page.reload();
    await expect(page.getByTestId('empty-state-idle')).toBeVisible();
    await page.getByTestId(`recent-item-${udalTaskId}`).click();
    await expect(page.getByTestId('current-task-name')).toHaveText(UDAL_FIXTURE_NAME);

    await page.getByTestId(`recent-item-${udalTaskId}`).hover();
    await page.getByTestId(`recent-delete-${udalTaskId}`).click({ force: true });
    await expect(page.getByTestId(`recent-item-${udalTaskId}`)).toHaveCount(0);
    await expect(page.getByTestId('empty-state-idle')).toBeVisible();
    createdTaskIds.delete(udalTaskId);
  });

  test('runs the PostgreSQL flow', async ({ page }) => {
    await page.goto('/');
    await page.getByTestId('engine-postgresql').click();
    await uploadLog(page, POSTGRES_FIXTURE_NAME);

    const analyzePayload = await analyzeCurrentUpload(page);
    expect(analyzePayload.taskId).toBeTruthy();
    expect(analyzePayload.clusterCount ?? 0).toBeGreaterThan(0);

    await expect(page.getByTestId('current-task-name')).toHaveText(POSTGRES_FIXTURE_NAME);
    await expect(page.getByTestId('results-table')).toBeVisible();
  });

  test('shows backend analysis errors to the user', async ({ page }) => {
    await page.goto('/');
    await uploadLog(page, UDAL_FIXTURE_NAME);

    await page.route('**/api/analyze', async (route) => {
      await route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ error: '模拟解析失败' }),
      });
    });

    const payload = await analyzeCurrentUpload(page);
    expect(payload.taskId).toBeFalsy();
    await expect(page.getByTestId('error-banner')).toContainText('解析失败: 模拟解析失败');
    await page.unroute('**/api/analyze');
  });

  test('cleans up tracked uploads and tasks back to baseline', async () => {
    await cleanupTrackedArtifacts();
    cleanupVerified = true;

    expect(await getRecentTaskIds()).toEqual(baselineRecentTaskIds);
    expect(createdUploadPaths.size).toBe(0);
    expect(createdTaskIds.size).toBe(0);
  });
});
