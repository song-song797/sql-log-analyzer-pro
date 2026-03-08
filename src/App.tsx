import React from 'react';
import { apiFetch, clearStoredToken, setStoredToken } from './lib/api';

// ===================== Types =====================
interface CleaningRules {
  removeSet: boolean;
  removeCommit: boolean;
  normalize: boolean;
  filterDriverInit: boolean;
  filterConnectionMeta: boolean;
  filterClientMeta: boolean;
  filterUdalOps: boolean;
  filterTransaction: boolean;
  filterHeartbeat: boolean;
  correlateRequests: boolean;
  filterEndRequest: boolean;
}

interface TaskInfo {
  id: number;
  originalFilename: string;
  filePath: string;
  engine: string;
  status: string;
  totalLines: number;
  cleanedCount: number;
  clusterCount: number;
  createdAt: string;
}

interface SqlCluster {
  id: number;
  fingerprint: string;
  sql_template: string;
  exec_count: number;
  timed_exec_count: number;
  avg_time_ms: number;
  sql_type: string;
}

interface RecentFile {
  id: number;
  task_id: number;
  filename: string;
  engine: string;
  total_lines: number;
  cluster_count: number;
  created_at: string;
  status: string;
}

interface AuthUser {
  id: number;
  email: string;
  displayName: string;
  createdAt: string;
}

// ===================== App =====================
export default function App() {
  const [authUser, setAuthUser] = React.useState<AuthUser | null>(null);
  const [authLoading, setAuthLoading] = React.useState(true);
  const [taskId, setTaskId] = React.useState<number | null>(null);
  const [taskInfo, setTaskInfo] = React.useState<TaskInfo | null>(null);
  const [engine, setEngine] = React.useState<'udal' | 'postgresql'>('udal');
  const [clusters, setClusters] = React.useState<SqlCluster[]>([]);
  const [page, setPage] = React.useState(1);
  const [totalPages, setTotalPages] = React.useState(1);
  const [total, setTotal] = React.useState(0);
  const [totalExecCount, setTotalExecCount] = React.useState(0);
  const [search, setSearch] = React.useState('');
  const [searchInput, setSearchInput] = React.useState('');
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState('');
  const [warnings, setWarnings] = React.useState<Array<{ lineNumber: number; content: string }>>([]);
  const [exportFormat, setExportFormat] = React.useState<'txt' | 'csv'>('txt');
  const [uploadedFile, setUploadedFile] = React.useState<{ filename: string; path: string } | null>(null);
  const [recentFiles, setRecentFiles] = React.useState<RecentFile[]>([]);
  const [analysisDirty, setAnalysisDirty] = React.useState(false);
  const [cleaningRules, setCleaningRules] = React.useState<CleaningRules>({
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
  });
  const pageSize = 10;

  // Load recent files on mount
  React.useEffect(() => {
    bootstrapAuth();
  }, []);

  // Load results when taskId/page/search changes
  React.useEffect(() => {
    if (taskId && authUser) fetchResults();
  }, [taskId, page, search, authUser]);

  async function requestApi(input: string, init?: RequestInit) {
    const res = await apiFetch(input, init);
    if (res.status === 401) {
      clearStoredToken();
      setAuthUser(null);
      setRecentFiles([]);
      setTaskId(null);
      setTaskInfo(null);
      setClusters([]);
      throw new Error('登录已失效，请重新登录');
    }
    return res;
  }

  async function bootstrapAuth() {
    try {
      const res = await apiFetch('/api/auth/me');
      if (!res.ok) {
        clearStoredToken();
        setAuthUser(null);
        return;
      }
      const data = await res.json();
      setAuthUser(data.user || null);
      if (data.user) {
        const recentRes = await apiFetch('/api/recent');
        if (recentRes.ok) {
          const recentData = await recentRes.json();
          setRecentFiles(recentData.files || []);
        }
      }
    } catch {
      clearStoredToken();
      setAuthUser(null);
    } finally {
      setAuthLoading(false);
    }
  }

  async function fetchRecentFiles() {
    try {
      const res = await requestApi('/api/recent');
      if (!res.ok) return;
      const data = await res.json();
      setRecentFiles(data.files || []);
    } catch { }
  }

  async function fetchResults() {
    if (!taskId) return;
    try {
      const params = new URLSearchParams({
        page: String(page),
        pageSize: String(pageSize),
        search,
        sortBy: 'exec_count',
        sortOrder: 'desc',
      });
      const res = await requestApi(`/api/results/${taskId}?${params}`);
      if (!res.ok) {
        const text = await res.text();
        throw new Error(text || `服务器返回 ${res.status}`);
      }
      const data = await res.json();
      if (data.task) setTaskInfo(data.task);
      if (data.task?.engine) setEngine(data.task.engine);
      if (data.clusters) {
        setClusters(data.clusters.items || []);
        setTotalPages(data.clusters.totalPages || 1);
        setTotal(data.clusters.total || 0);
        setTotalExecCount(data.clusters.totalExecCount || 0);
      }
      setAnalysisDirty(false);
    } catch (e: any) {
      setError('获取结果失败: ' + e.message);
    }
  }

  async function handleUpload(file: File) {
    setError('');
    const formData = new FormData();
    formData.append('logfile', file);
    try {
      const res = await requestApi('/api/upload', { method: 'POST', body: formData });
      if (!res.ok) {
        let errMsg = `服务器返回 ${res.status}`;
        try { const d = await res.json(); errMsg = d.error || errMsg; } catch { errMsg = await res.text() || errMsg; }
        throw new Error(errMsg);
      }
      const data = await res.json();
      setUploadedFile({ filename: data.filename, path: data.path });
      setAnalysisDirty(true);
    } catch (e: any) {
      setError('上传失败: ' + e.message);
    }
  }

  async function handleAnalyze() {
    const filePathInfo = uploadedFile
      ? { path: uploadedFile.path, name: uploadedFile.filename }
      : taskInfo
        ? { path: taskInfo.filePath, name: taskInfo.originalFilename }
        : null;

    if (!filePathInfo) {
      setError('请先上传日志文件');
      return;
    }
    setLoading(true);
    setError('');
    setWarnings([]);
    // Do not clear everything immediately if we are just re-analyzing the same file 
    // to give a better UX without completely blanking the screen

    try {
      const res = await requestApi('/api/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          filePath: filePathInfo.path,
          originalFilename: filePathInfo.name,
          engine,
          cleaningRules,
        }),
      });
      if (!res.ok) {
        let errMsg = `服务器返回 ${res.status}`;
        try { const d = await res.json(); errMsg = d.error || errMsg; } catch { errMsg = await res.text() || errMsg; }
        throw new Error(errMsg);
      }
      const data = await res.json();
      setTaskId(data.taskId);
      setTaskInfo(null);
      if (data.warnings && data.warnings.length > 0) {
        setWarnings(data.warnings);
      }
      setAnalysisDirty(false);
      fetchRecentFiles();
    } catch (e: any) {
      setError('解析失败: ' + e.message);
    } finally {
      setLoading(false);
    }
  }

  function getExportFilename(format: 'txt' | 'csv') {
    const now = new Date();
    const dateStr = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
    let baseName = 'report';
    if (taskInfo?.originalFilename) {
      baseName = taskInfo.originalFilename.replace(/\.[^.]+$/, '');
    }
    return `${baseName}_聚类报告_${dateStr}.${format}`;
  }

  function parseContentDispositionFilename(header: string | null) {
    if (!header) return null;

    const utf8Match = header.match(/filename\*=UTF-8''([^;]+)/i);
    if (utf8Match?.[1]) {
      try {
        return decodeURIComponent(utf8Match[1]);
      } catch {
        return utf8Match[1];
      }
    }

    const quotedMatch = header.match(/filename="([^"]+)"/i);
    if (quotedMatch?.[1]) {
      return quotedMatch[1];
    }

    const plainMatch = header.match(/filename=([^;]+)/i);
    return plainMatch?.[1]?.trim() || null;
  }

  async function handleExport(format?: 'txt' | 'csv') {
    if (!taskId) return;
    const fmt = format || exportFormat;
    setError('');

    try {
      const res = await requestApi(`/api/export/${taskId}?format=${fmt}`);
      if (!res.ok) {
        let errMsg = `服务器返回 ${res.status}`;
        try { const d = await res.json(); errMsg = d.error || errMsg; } catch { errMsg = await res.text() || errMsg; }
        throw new Error(errMsg);
      }

      const blob = await res.blob();
      const headerFilename = parseContentDispositionFilename(res.headers.get('Content-Disposition'));
      const filename = headerFilename || getExportFilename(fmt);
      const url = URL.createObjectURL(blob);

      try {
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
      } finally {
        window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      }
    } catch (e: any) {
      setError('导出失败: ' + e.message);
    }
  }

  function handleLoadRecent(recentTaskId: number) {
    setUploadedFile(null);
    setTaskId(recentTaskId);
    setPage(1);
    setSearch('');
    setSearchInput('');
    setAnalysisDirty(false);
  }

  async function handleDeleteRecent(recentTaskId: number) {
    try {
      await requestApi(`/api/recent/${recentTaskId}`, { method: 'DELETE' });
      setRecentFiles(prev => prev.filter(f => f.task_id !== recentTaskId));
      if (taskId === recentTaskId) {
        setTaskId(null);
        setTaskInfo(null);
        setClusters([]);
        setAnalysisDirty(false);
      }
    } catch (e) {
      console.error('Delete failed:', e);
    }
  }

  function handleSearch() {
    setSearch(searchInput);
    setPage(1);
  }

  function handleEngineChange(nextEngine: 'udal' | 'postgresql') {
    if (engine === nextEngine) return;
    setEngine(nextEngine);
    if (uploadedFile || taskInfo) {
      setAnalysisDirty(true);
    }
  }

  function handleCleaningRuleChange(nextRules: CleaningRules) {
    setCleaningRules(nextRules);
    if (uploadedFile || taskInfo) {
      setAnalysisDirty(true);
    }
  }

  async function handleAuthSuccess(payload: { token: string; user: AuthUser }) {
    setStoredToken(payload.token);
    setAuthUser(payload.user);
    setAuthLoading(false);
    setError('');
    setTaskId(null);
    setTaskInfo(null);
    setClusters([]);
    setUploadedFile(null);
    setWarnings([]);
    setSearch('');
    setSearchInput('');
    await fetchRecentFiles();
  }

  async function handleLogout() {
    try {
      await requestApi('/api/auth/logout', { method: 'POST' });
    } catch { }
    clearStoredToken();
    setAuthUser(null);
    setRecentFiles([]);
    setTaskId(null);
    setTaskInfo(null);
    setClusters([]);
    setUploadedFile(null);
    setWarnings([]);
    setSearch('');
    setSearchInput('');
  }

  if (authLoading) {
    return <AppLoadingScreen />;
  }

  if (!authUser) {
    return <AuthScreen onAuthSuccess={handleAuthSuccess} />;
  }

  return (
    <div data-testid="app-shell" className="flex h-screen w-full bg-background-light text-slate-900 antialiased overflow-hidden">
      <Sidebar
        engine={engine}
        setEngine={handleEngineChange}
        cleaningRules={cleaningRules}
        setCleaningRules={handleCleaningRuleChange}
        onUpload={handleUpload}
        uploadedFile={uploadedFile}
        onAnalyze={handleAnalyze}
        loading={loading}
        taskInfo={taskInfo}
        analysisDirty={analysisDirty}
        recentFiles={recentFiles}
        onLoadRecent={handleLoadRecent}
        onDeleteRecent={handleDeleteRecent}
        activeTaskId={taskId}
      />
      <MainContent
        authUser={authUser}
        onLogout={handleLogout}
        taskInfo={taskInfo}
        clusters={clusters}
        page={page}
        totalPages={totalPages}
        total={total}
        totalExecCount={totalExecCount}
        searchInput={searchInput}
        setSearchInput={setSearchInput}
        onSearch={handleSearch}
        onPageChange={setPage}
        onExport={handleExport}
        exportFormat={exportFormat}
        setExportFormat={setExportFormat}
        loading={loading}
        error={error}
        warnings={warnings}
      />
    </div>
  );
}

function AppLoadingScreen() {
  return (
    <div className="min-h-screen w-full bg-slate-50 flex items-center justify-center">
      <div className="rounded-2xl border border-slate-200 bg-white px-8 py-6 shadow-sm text-center">
        <p className="text-sm font-bold text-slate-700">正在恢复会话</p>
        <p className="mt-2 text-xs text-slate-500">请稍候，正在连接后端服务...</p>
      </div>
    </div>
  );
}

function AuthScreen({ onAuthSuccess }: { onAuthSuccess: (payload: { token: string; user: AuthUser }) => Promise<void> }) {
  const [mode, setMode] = React.useState<'login' | 'register'>('login');
  const [email, setEmail] = React.useState('');
  const [password, setPassword] = React.useState('');
  const [displayName, setDisplayName] = React.useState('');
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState('');

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError('');

    try {
      const endpoint = mode === 'login' ? '/api/auth/login' : '/api/auth/register';
      const body: Record<string, string> = {
        email,
        password,
      };
      if (mode === 'register') {
        body.displayName = displayName;
      }

      const res = await apiFetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        let errMsg = `服务器返回 ${res.status}`;
        try {
          const data = await res.json();
          errMsg = data.error || errMsg;
        } catch {
          errMsg = await res.text() || errMsg;
        }
        throw new Error(errMsg);
      }

      const payload = await res.json();
      await onAuthSuccess(payload);
    } catch (err: any) {
      setError(err.message || '认证失败');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="min-h-screen w-full bg-slate-50 flex items-center justify-center px-6">
      <div className="grid w-full max-w-5xl overflow-hidden rounded-3xl border border-slate-200 bg-white shadow-xl shadow-slate-200/60 md:grid-cols-[1.1fr_0.9fr]">
        <div className="bg-slate-900 text-white p-10 flex flex-col justify-between">
          <div>
            <p className="text-xs font-bold uppercase tracking-[0.35em] text-primary">SQL Log Analyzer</p>
            <h1 className="mt-6 text-4xl font-bold leading-tight">多人协作的 SQL 日志分析工作台</h1>
            <p className="mt-4 text-sm leading-7 text-slate-300">
              上传日志、隔离任务、保留个人分析历史。当前版本已经按用户会话隔离 recent、任务结果和上传目录。
            </p>
          </div>
          <div className="grid gap-3 text-sm text-slate-300">
            <p>适合公网部署前的演示环境、内网共享环境和小团队共同使用。</p>
            <p>下一步仍建议补 PostgreSQL、对象存储和更完整的权限体系。</p>
          </div>
        </div>

        <div className="p-10">
          <div className="flex items-center gap-2 rounded-full bg-slate-100 p-1">
            <button
              type="button"
              onClick={() => setMode('login')}
              className={`flex-1 rounded-full px-4 py-2 text-sm font-bold transition-colors ${mode === 'login' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500'}`}
            >
              登录
            </button>
            <button
              type="button"
              onClick={() => setMode('register')}
              className={`flex-1 rounded-full px-4 py-2 text-sm font-bold transition-colors ${mode === 'register' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500'}`}
            >
              注册
            </button>
          </div>

          <form onSubmit={handleSubmit} className="mt-8 space-y-4">
            {mode === 'register' && (
              <label className="block">
                <span className="mb-2 block text-xs font-bold uppercase tracking-widest text-slate-500">昵称</span>
                <input
                  value={displayName}
                  onChange={e => setDisplayName(e.target.value)}
                  className="w-full rounded-xl border border-slate-300 bg-white px-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-primary/20"
                  placeholder="输入显示名称"
                />
              </label>
            )}

            <label className="block">
              <span className="mb-2 block text-xs font-bold uppercase tracking-widest text-slate-500">邮箱</span>
              <input
                value={email}
                onChange={e => setEmail(e.target.value)}
                type="email"
                className="w-full rounded-xl border border-slate-300 bg-white px-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-primary/20"
                placeholder="name@example.com"
              />
            </label>

            <label className="block">
              <span className="mb-2 block text-xs font-bold uppercase tracking-widest text-slate-500">密码</span>
              <input
                value={password}
                onChange={e => setPassword(e.target.value)}
                type="password"
                className="w-full rounded-xl border border-slate-300 bg-white px-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-primary/20"
                placeholder="至少 8 位"
              />
            </label>

            {error && <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-600">{error}</div>}

            <button
              type="submit"
              disabled={submitting}
              className="w-full rounded-xl bg-primary px-4 py-3 text-sm font-bold text-white shadow-lg shadow-primary/20 transition-colors hover:bg-primary/90 disabled:opacity-60"
            >
              {submitting ? '提交中...' : mode === 'login' ? '登录并进入工作台' : '创建账号并进入工作台'}
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}

// ===================== Sidebar =====================
function Sidebar({
  engine, setEngine, cleaningRules, setCleaningRules, onUpload, uploadedFile, onAnalyze, loading,
  taskInfo, analysisDirty, recentFiles, onLoadRecent, onDeleteRecent, activeTaskId,
}: {
  engine: 'udal' | 'postgresql';
  setEngine: (e: 'udal' | 'postgresql') => void;
  cleaningRules: CleaningRules;
  setCleaningRules: (r: CleaningRules) => void;
  onUpload: (f: File) => void;
  uploadedFile: { filename: string; path: string } | null;
  onAnalyze: () => void;
  loading: boolean;
  taskInfo: TaskInfo | null;
  analysisDirty: boolean;
  recentFiles: RecentFile[];
  onLoadRecent: (taskId: number) => void;
  onDeleteRecent: (taskId: number) => void;
  activeTaskId: number | null;
}) {
  const fileInputRef = React.useRef<HTMLInputElement>(null);
  const [recommendedRulesOpen, setRecommendedRulesOpen] = React.useState(true);
  const [advancedRulesOpen, setAdvancedRulesOpen] = React.useState(false);

  function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    const file = e.dataTransfer.files[0];
    if (file) onUpload(file);
  }

  function toggleRule(key: keyof CleaningRules) {
    setCleaningRules({ ...cleaningRules, [key]: !cleaningRules[key] });
  }

  return (
    <aside className="w-1/4 h-full border-r border-slate-200 flex flex-col bg-white shrink-0">
      <div className="p-6 flex items-center gap-3">
        <div className="bg-primary p-1.5 rounded-lg">
          <span className="material-symbols-outlined text-white text-2xl">database</span>
        </div>
        <div>
          <h1 className="text-lg font-bold leading-tight">SQL 日志分析</h1>
          <p className="text-xs text-slate-500 font-medium tracking-wide">LOG ANALYZER PRO</p>
        </div>
      </div>

      <nav className="px-4 flex flex-col gap-2">
        <div className="px-2 mb-1">
          <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">优先解析引擎</p>
          <p className="mt-1 text-[11px] leading-snug text-slate-400">
            优先按所选数据库规则解析，未匹配时会自动回退另一套规则。
          </p>
        </div>
        <div
          data-testid="engine-udal"
          onClick={() => setEngine('udal')}
          className={`flex items-center gap-3 px-3 py-2.5 rounded-lg cursor-pointer transition-colors border ${engine === 'udal' ? 'bg-primary/10 text-primary border-primary/20' : 'hover:bg-slate-50 text-slate-600 border-transparent'}`}
        >
          <span className="material-symbols-outlined text-xl">storage</span>
          <p className="text-sm font-semibold">优先 UDAL (MySQL)</p>
        </div>
        <div
          data-testid="engine-postgresql"
          onClick={() => setEngine('postgresql')}
          className={`flex items-center gap-3 px-3 py-2.5 rounded-lg cursor-pointer transition-colors border ${engine === 'postgresql' ? 'bg-primary/10 text-primary border-primary/20' : 'hover:bg-slate-50 text-slate-600 border-transparent'}`}
        >
          <span className="material-symbols-outlined text-xl">database</span>
          <p className="text-sm font-semibold">优先 PostgreSQL</p>
        </div>
      </nav>

      {/* File Upload */}
      <div className="mt-6 px-6">
        <div
          data-testid="upload-dropzone"
          className="flex flex-col items-center gap-4 rounded-xl border-2 border-dashed border-slate-300 bg-slate-50 p-6 text-center hover:border-primary/50 transition-colors group cursor-pointer"
          onClick={() => fileInputRef.current?.click()}
          onDragOver={e => e.preventDefault()}
          onDrop={handleDrop}
        >
          <span className="material-symbols-outlined text-4xl text-slate-400 group-hover:text-primary transition-colors">cloud_upload</span>
          <div className="space-y-1">
            {uploadedFile ? (
              <>
                <p className="text-sm font-bold text-primary">✓ {uploadedFile.filename}</p>
                <p className="text-xs text-slate-500">点击重新选择文件</p>
              </>
            ) : (
              <>
                <p className="text-sm font-bold">上传 SQL 日志文件</p>
                <p className="text-xs text-slate-500">拖放或点击浏览</p>
              </>
            )}
          </div>
        </div>
        <input
          ref={fileInputRef}
          data-testid="file-input"
          type="file"
          className="hidden"
          accept=".log,.txt,.sql,.csv"
          onChange={e => { if (e.target.files?.[0]) onUpload(e.target.files[0]); }}
        />
      </div>

      {/* Recent Files */}
      {recentFiles.length > 0 && (
        <div className="mt-4 px-6">
          <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-2">最近处理文件</p>
          <div className="space-y-1 max-h-32 overflow-y-auto">
            {recentFiles.map(f => (
              <div
                key={f.id}
                data-testid={`recent-item-${f.task_id}`}
                onClick={() => onLoadRecent(f.task_id)}
                className={`flex items-center gap-2 px-3 py-2 rounded-lg cursor-pointer text-xs transition-colors border group ${activeTaskId === f.task_id
                  ? 'bg-primary/10 border-primary/20 text-primary'
                  : 'hover:bg-slate-50 border-transparent text-slate-600'
                  }`}
              >
                <span className="material-symbols-outlined text-sm">description</span>
                <div className="flex-1 truncate">
                  <p className="font-medium truncate">{f.filename}</p>
                  <p className="text-[10px] text-slate-400">{f.cluster_count} 聚类 · {new Date(f.created_at).toLocaleDateString('zh-CN')}</p>
                </div>
                <button
                  data-testid={`recent-delete-${f.task_id}`}
                  onClick={(e) => { e.stopPropagation(); onDeleteRecent(f.task_id); }}
                  className="opacity-0 group-hover:opacity-100 p-0.5 rounded hover:bg-red-100 hover:text-red-500 transition-all text-slate-400 shrink-0"
                  title="删除记录"
                >
                  <span className="material-symbols-outlined text-sm">close</span>
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Cleaning Rules */}
      <div className="mt-4 px-6 space-y-3 overflow-y-auto flex-1">
        <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">清洗规则设置</p>
        <div className="rounded-xl border border-slate-200 bg-slate-50/70">
          <button
            type="button"
            onClick={() => setRecommendedRulesOpen(open => !open)}
            className="w-full flex items-center justify-between px-4 py-3 text-left"
          >
            <div>
              <p className="text-xs font-bold text-slate-700">推荐</p>
              <p className="mt-1 text-[10px] leading-snug text-slate-500">
                这组规则对真实业务聚类帮助最大，建议默认保持开启。
              </p>
            </div>
            <span className={`material-symbols-outlined text-slate-400 transition-transform ${recommendedRulesOpen ? 'rotate-180' : ''}`}>
              expand_more
            </span>
          </button>
          {recommendedRulesOpen && (
            <div className="border-t border-slate-200 px-4 py-3 space-y-3">
              <Checkbox label="移除 SET 变量语句" checked={cleaningRules.removeSet} onChange={() => toggleRule('removeSet')} tags={['影响大', '建议保留', '仅 UDAL']} />
              <Checkbox label="参数模版化 (Normalize)" checked={cleaningRules.normalize} onChange={() => toggleRule('normalize')} tags={['影响大', '建议保留']} />
              <CheckboxWithDesc label="过滤驱动初始化 (SELECT @@...)" desc="过滤 JDBC/驱动读取环境变量、版本和用户信息的初始化查询" checked={cleaningRules.filterDriverInit} onChange={() => toggleRule('filterDriverInit')} tags={['影响大', '建议保留']} />
              <CheckboxWithDesc label="过滤连接元语句 (USE/SELECT DATABASE())" desc="过滤切库和连接上下文识别语句，如 USE、SELECT DATABASE()、CURRENT_SCHEMA()" checked={cleaningRules.filterConnectionMeta} onChange={() => toggleRule('filterConnectionMeta')} tags={['建议保留', '仅 UDAL']} />
              <CheckboxWithDesc label="过滤客户端元查询 (SHOW ...)" desc="过滤客户端工具和运维界面发出的 SHOW DATABASES、SHOW WARNINGS 等探测语句" checked={cleaningRules.filterClientMeta} onChange={() => toggleRule('filterClientMeta')} tags={['影响大', '建议保留', '仅 UDAL']} />
              <CheckboxWithDesc label="过滤 UDAL/运维指令" desc="过滤以 'udal' 或 'udal_' 开头的中间件/运维命令" checked={cleaningRules.filterUdalOps} onChange={() => toggleRule('filterUdalOps')} tags={['建议保留', '仅 UDAL']} />
              <CheckboxWithDesc label="请求响应关联合并" desc="通过 requestId 关联并提取 SQL + 耗时" checked={cleaningRules.correlateRequests} onChange={() => toggleRule('correlateRequests')} tags={['影响大', '建议保留', '仅 UDAL']} />
            </div>
          )}
        </div>

        <div className="rounded-xl border border-slate-200 bg-white">
          <button
            type="button"
            onClick={() => setAdvancedRulesOpen(open => !open)}
            className="w-full flex items-center justify-between px-4 py-3 text-left"
          >
            <div>
              <p className="text-xs font-bold text-slate-700">高级</p>
              <p className="mt-1 text-[10px] leading-snug text-slate-500">
                场景化噪声过滤，通常只在排查特殊日志时调整。
              </p>
            </div>
            <span className={`material-symbols-outlined text-slate-400 transition-transform ${advancedRulesOpen ? 'rotate-180' : ''}`}>
              expand_more
            </span>
          </button>
          {advancedRulesOpen && (
            <div className="border-t border-slate-200 px-4 py-3 space-y-3">
              <Checkbox label="移除 COMMIT 显式提交" checked={cleaningRules.removeCommit} onChange={() => toggleRule('removeCommit')} />
              <CheckboxWithDesc label="过滤事务控制 (BEGIN/ROLLBACK...)" desc="包含 ROLLBACK, BEGIN, START TRANSACTION 过滤" checked={cleaningRules.filterTransaction} onChange={() => toggleRule('filterTransaction')} />
              <CheckboxWithDesc label="过滤探活语句 (SELECT 1)" desc="过滤最小心跳保活查询" checked={cleaningRules.filterHeartbeat} onChange={() => toggleRule('filterHeartbeat')} />
              <CheckboxWithDesc label="过滤 END_REQUEST 响应行" desc="过滤审计日志中仅包含耗时信息的响应行" checked={cleaningRules.filterEndRequest} onChange={() => toggleRule('filterEndRequest')} />
            </div>
          )}
        </div>
      </div>

      {/* Analyze Button */}
      <div className="p-6">
        <button
          data-testid="analyze-button"
          onClick={onAnalyze}
          disabled={loading || (!uploadedFile && !taskInfo)}
          className="w-full flex items-center justify-center gap-2 rounded-xl h-12 bg-primary hover:bg-primary/90 text-white text-sm font-bold shadow-lg shadow-primary/20 transition-all active:scale-[0.98] disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {loading ? (
            <>
              <span className="material-symbols-outlined text-xl animate-spin">progress_activity</span>
              <span>解析中...</span>
            </>
          ) : (
            <>
              <span className="material-symbols-outlined text-xl">play_circle</span>
              <span>{taskInfo && !uploadedFile ? '重新分析日志' : analysisDirty ? '应用规则并重新分析' : '开始解析日志'}</span>
            </>
          )}
        </button>
        {(uploadedFile || taskInfo) && analysisDirty && (
          <p data-testid="analysis-dirty-hint" className="mt-2 text-xs leading-snug text-slate-500">
            配置已修改，点击按钮后才会按当前规则重新分析。
          </p>
        )}
      </div>
    </aside>
  );
}

// ===================== Checkbox Components =====================
function Checkbox({
  label,
  checked,
  onChange,
  tags = [],
}: {
  label: string;
  checked: boolean;
  onChange: () => void;
  tags?: string[];
}) {
  return (
    <label className="flex flex-col gap-1 cursor-pointer group">
      <div className="flex items-center gap-3">
        <div className="relative flex items-center">
          <input
            type="checkbox"
            checked={checked}
            onChange={onChange}
            className="peer h-5 w-5 rounded border-slate-300 bg-transparent text-primary focus:ring-primary/20 transition-all cursor-pointer accent-[#13edb9]"
          />
        </div>
        <span className="text-sm text-slate-700 group-hover:text-primary transition-colors">{label}</span>
      </div>
      {tags.length > 0 && <div className="pl-8"><RuleTags tags={tags} /></div>}
    </label>
  );
}

function RuleTags({ tags }: { tags: string[] }) {
  return (
    <div className="flex flex-wrap gap-1">
      {tags.map(tag => (
        <span
          key={tag}
          className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${tag === '影响大'
            ? 'bg-amber-100 text-amber-700'
            : tag === '建议保留'
              ? 'bg-emerald-100 text-emerald-700'
              : 'bg-sky-100 text-sky-700'
            }`}
        >
          {tag}
        </span>
      ))}
    </div>
  );
}

function CheckboxWithDesc({
  label,
  desc,
  checked,
  onChange,
  tags = [],
}: {
  label: string;
  desc: string;
  checked: boolean;
  onChange: () => void;
  tags?: string[];
}) {
  return (
    <label className="flex flex-col gap-1 cursor-pointer group">
      <div className="flex items-center gap-3">
        <input
          type="checkbox"
          checked={checked}
          onChange={onChange}
          className="h-5 w-5 rounded border-slate-300 bg-transparent text-primary focus:ring-primary/20 transition-all cursor-pointer accent-[#13edb9]"
        />
        <span className="text-sm text-slate-700 group-hover:text-primary transition-colors font-medium">{label}</span>
      </div>
      {tags.length > 0 && <div className="pl-8"><RuleTags tags={tags} /></div>}
      <p className="pl-8 text-[10px] text-slate-500 leading-tight">{desc}</p>
    </label>
  );
}

// ===================== Main Content =====================
function MainContent({
  authUser, onLogout,
  taskInfo, clusters, page, totalPages, total, totalExecCount,
  searchInput, setSearchInput, onSearch, onPageChange, onExport,
  exportFormat, setExportFormat, loading, error, warnings,
}: {
  authUser: AuthUser;
  onLogout: () => void;
  taskInfo: TaskInfo | null;
  clusters: SqlCluster[];
  page: number;
  totalPages: number;
  total: number;
  totalExecCount: number;
  searchInput: string;
  setSearchInput: (s: string) => void;
  onSearch: () => void;
  onPageChange: (p: number) => void;
  onExport: (format?: 'txt' | 'csv') => void;
  exportFormat: 'txt' | 'csv';
  setExportFormat: (f: 'txt' | 'csv') => void;
  loading: boolean;
  error: string;
  warnings: Array<{ lineNumber: number; content: string }>;
}) {
  const [showWarnings, setShowWarnings] = React.useState(false);
  return (
    <main className="flex-1 h-full flex flex-col bg-slate-50 overflow-hidden">
      <Header authUser={authUser} onLogout={onLogout} taskInfo={taskInfo} onExport={onExport} exportFormat={exportFormat} setExportFormat={setExportFormat} />
      <div className="p-8 flex-1 flex flex-col gap-8 overflow-hidden">
        {error && (
          <div data-testid="error-banner" className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg text-sm">{error}</div>
        )}
        <Metrics taskInfo={taskInfo} loading={loading} />
        <SqlTable
          clusters={clusters}
          page={page}
          totalPages={totalPages}
          total={total}
          totalExecCount={totalExecCount}
          searchInput={searchInput}
          setSearchInput={setSearchInput}
          onSearch={onSearch}
          onPageChange={onPageChange}
          taskInfo={taskInfo}
        />
      </div>
    </main>
  );
}

// ===================== Header =====================
function Header({ authUser, onLogout, taskInfo, onExport, exportFormat, setExportFormat }: {
  authUser: AuthUser;
  onLogout: () => void;
  taskInfo: TaskInfo | null;
  onExport: (format?: 'txt' | 'csv') => void;
  exportFormat: 'txt' | 'csv';
  setExportFormat: (f: 'txt' | 'csv') => void;
}) {
  return (
    <header data-testid="header" className="h-16 border-b border-slate-200 bg-white/50 backdrop-blur-md flex items-center justify-between px-8 shrink-0 sticky top-0 z-10">
      <div className="flex items-center gap-2">
        <span className="text-sm font-medium text-slate-500">当前任务:</span>
        {taskInfo ? (
          <>
            <span data-testid="current-task-name" className="text-sm font-bold text-slate-900">{taskInfo.originalFilename}</span>
            <span className={`px-2 py-0.5 rounded text-[10px] font-bold border ${taskInfo.status === 'completed'
              ? 'bg-green-500/10 text-green-500 border-green-500/20'
              : 'bg-amber-500/10 text-amber-500 border-amber-500/20'
              }`}>
              {taskInfo.status === 'completed' ? '已完成' : '处理中'}
            </span>
          </>
        ) : (
          <span className="text-sm text-slate-400">未选择文件</span>
        )}
      </div>
      <div className="flex items-center gap-2">
        <div className="hidden md:flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2">
          <div className="h-8 w-8 rounded-full bg-primary/10 text-primary flex items-center justify-center text-xs font-bold">
            {authUser.displayName.slice(0, 1).toUpperCase()}
          </div>
          <div className="leading-tight">
            <p className="text-xs font-bold text-slate-700">{authUser.displayName}</p>
            <p className="text-[10px] text-slate-500">{authUser.email}</p>
          </div>
        </div>
        <select
          data-testid="export-format"
          value={exportFormat}
          onChange={e => setExportFormat(e.target.value as 'txt' | 'csv')}
          className="px-3 py-2 bg-slate-50 border border-slate-300 rounded-lg text-sm font-bold text-slate-700 focus:outline-none focus:ring-2 focus:ring-primary/20"
        >
          <option value="txt">TXT 格式</option>
          <option value="csv">CSV 格式</option>
        </select>
        <button
          data-testid="export-button"
          onClick={() => onExport()}
          disabled={!taskInfo}
          className="flex items-center gap-2 px-4 py-2 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-lg text-sm font-bold transition-all border border-slate-300 group disabled:opacity-50 disabled:cursor-not-allowed"
        >
          <span className="material-symbols-outlined text-xl group-hover:scale-110 transition-transform">description</span>
          <span>导出聚类报告</span>
        </button>
        <button
          type="button"
          onClick={onLogout}
          className="flex items-center gap-2 px-4 py-2 bg-white hover:bg-slate-100 text-slate-700 rounded-lg text-sm font-bold transition-all border border-slate-300"
        >
          <span className="material-symbols-outlined text-lg">logout</span>
          <span>退出</span>
        </button>
      </div>
    </header>
  );
}

// ===================== Metrics =====================
function Metrics({ taskInfo, loading }: { taskInfo: TaskInfo | null; loading: boolean }) {
  return (
    <div className="grid grid-cols-3 gap-6">
      <MetricCard
        testId="metric-total-lines"
        icon="list_alt"
        iconColor="text-blue-500"
        iconBg="bg-blue-500/10"
        label="解析总行数"
        value={loading ? '...' : taskInfo ? taskInfo.totalLines.toLocaleString() : '0'}
      />
      <MetricCard
        testId="metric-cleaned-count"
        icon="cleaning"
        iconColor="text-emerald-500"
        iconBg="bg-emerald-500/10"
        label="已清洗 SQL 数"
        value={loading ? '...' : taskInfo ? taskInfo.cleanedCount.toLocaleString() : '0'}
      />
      <MetricCard
        testId="metric-cluster-count"
        icon="hub"
        iconColor="text-amber-500"
        iconBg="bg-amber-500/10"
        label="唯一 SQL 聚类"
        value={loading ? '...' : taskInfo ? taskInfo.clusterCount.toLocaleString() : '0'}
      />
    </div>
  );
}

function MetricCard({ testId, icon, iconColor, iconBg, label, value }: { testId: string; icon: string; iconColor: string; iconBg: string; label: string; value: string }) {
  return (
    <div data-testid={testId} className="bg-white border border-slate-200 rounded-xl p-6 shadow-sm flex items-center gap-4">
      <div className={`${iconBg} p-3 rounded-lg ${iconColor}`}>
        <span className="material-symbols-outlined text-3xl">{icon}</span>
      </div>
      <div>
        <p className="text-xs font-bold text-slate-500 uppercase tracking-tight">{label}</p>
        <p className="text-2xl font-bold mt-1">{value}</p>
      </div>
    </div>
  );
}

// ===================== SQL Table =====================
function SqlTable({
  clusters, page, totalPages, total, totalExecCount,
  searchInput, setSearchInput, onSearch, onPageChange, taskInfo,
}: {
  clusters: SqlCluster[];
  page: number;
  totalPages: number;
  total: number;
  totalExecCount: number;
  searchInput: string;
  setSearchInput: (s: string) => void;
  onSearch: () => void;
  onPageChange: (p: number) => void;
  taskInfo: TaskInfo | null;
}) {
  function formatAvgTime(cluster: SqlCluster) {
    return cluster.timed_exec_count > 0 ? `${cluster.avg_time_ms}ms` : 'N/A';
  }

  const typeColors: Record<string, string> = {
    READ: 'bg-blue-100 text-blue-600',
    WRITE: 'bg-orange-100 text-orange-600',
    APPEND: 'bg-emerald-100 text-emerald-600',
    DELETE: 'bg-red-100 text-red-600',
    DDL: 'bg-purple-100 text-purple-600',
    ADMIN: 'bg-slate-100 text-slate-600',
    CALL: 'bg-cyan-100 text-cyan-600',
    OTHER: 'bg-slate-100 text-slate-500',
    UNKNOWN: 'bg-slate-100 text-slate-400',
  };

  const startIndex = (page - 1) * 10;

  return (
    <div className="bg-white border border-slate-200 rounded-xl shadow-sm flex flex-col flex-1 overflow-hidden">
      <div className="p-6 border-b border-slate-200 flex flex-col md:flex-row md:items-center justify-between gap-4 shrink-0">
        <div className="flex items-center gap-3">
          <h2 className="text-lg font-bold">高频 SQL 模版排名</h2>
          <span className="bg-slate-100 px-2 py-0.5 rounded text-xs font-mono text-slate-500">
            共 {total} 聚类
          </span>
        </div>
        <div className="relative w-full md:w-96 flex gap-2">
          <div className="relative flex-1">
            <span className="material-symbols-outlined absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 text-xl">search</span>
            <input
              data-testid="search-input"
              type="text"
              placeholder="搜索 SQL 关键词..."
              value={searchInput}
              onChange={e => setSearchInput(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') onSearch(); }}
              className="w-full pl-10 pr-4 py-2 bg-slate-50 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary/20 transition-all"
            />
          </div>
          <button
            data-testid="search-button"
            onClick={onSearch}
            className="px-4 py-2 bg-primary text-white rounded-lg text-sm font-bold hover:bg-primary/90 transition-colors shrink-0"
          >
            搜索
          </button>
        </div>
      </div>

      <div className="overflow-auto flex-1">
        {!taskInfo ? (
          <div data-testid="empty-state-idle" className="flex flex-col items-center justify-center h-full text-slate-400 gap-3 py-20">
            <span className="material-symbols-outlined text-6xl">analytics</span>
            <p className="text-sm font-medium">上传日志文件并点击"开始解析"查看结果</p>
          </div>
        ) : clusters.length === 0 ? (
          <div data-testid="empty-state-search" className="flex flex-col items-center justify-center h-full text-slate-400 gap-3 py-20">
            <span className="material-symbols-outlined text-6xl">search_off</span>
            <p className="text-sm font-medium">未找到匹配的 SQL 聚类</p>
          </div>
        ) : (
          <table data-testid="results-table" className="w-full text-left border-collapse relative">
            <thead className="sticky top-0 z-10">
              <tr className="bg-slate-50 text-[10px] font-bold text-slate-500 uppercase tracking-widest border-b border-slate-200 shadow-sm">
                <th className="px-6 py-4 w-16">排名</th>
                <th className="px-6 py-4">SQL 语法模版</th>
                <th className="px-6 py-4 w-32">执行次数</th>
                <th className="px-6 py-4 w-48 text-right">执行占比</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {clusters.map((c, idx) => {
                const rank = startIndex + idx + 1;
                const percent = totalExecCount > 0 ? (c.exec_count / totalExecCount) * 100 : 0;
                return (
                  <tr key={c.id || c.fingerprint} className="hover:bg-slate-50/80 transition-colors">
                    <td className={`px-6 py-5 font-mono text-sm font-bold ${rank === 1 ? 'text-primary' : 'text-slate-500'}`}>
                      #{String(rank).padStart(2, '0')}
                    </td>
                    <td className="px-6 py-5">
                      <div className="sql-code text-sm leading-relaxed max-w-2xl overflow-hidden text-ellipsis whitespace-nowrap" title={c.sql_template}>
                        <HighlightSql sql={c.sql_template} />
                      </div>
                      <div className="mt-1 flex items-center gap-2">
                        <span className="text-[10px] bg-slate-100 px-1.5 py-0.5 rounded text-slate-500 font-mono">
                          avg: {formatAvgTime(c)}
                        </span>
                        <span className={`text-[10px] px-1.5 py-0.5 rounded font-mono ${typeColors[c.sql_type] || typeColors.OTHER}`}>
                          {c.sql_type}
                        </span>
                      </div>
                    </td>
                    <td className="px-6 py-5 font-bold text-sm">{c.exec_count.toLocaleString()}</td>
                    <td className="px-6 py-5">
                      <div className="flex flex-col gap-2">
                        <div className="w-full bg-slate-100 h-1.5 rounded-full overflow-hidden">
                          <div className="bg-primary h-full rounded-full" style={{ width: `${percent}%`, opacity: Math.max(0.25, percent / 100) }} />
                        </div>
                        <div className="text-right text-[10px] font-bold text-slate-500">{percent.toFixed(1)}%</div>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {/* Pagination */}
      <div className="p-6 border-t border-slate-200 bg-slate-50/50 flex items-center justify-between shrink-0">
        <p className="text-xs text-slate-500">
          {total > 0
            ? `显示 ${(page - 1) * 10 + 1} 到 ${Math.min(page * 10, total)} 条，共 ${total} 个聚类结果`
            : '暂无数据'}
        </p>
        <div className="flex gap-2">
          <button
            data-testid="pagination-prev"
            onClick={() => onPageChange(page - 1)}
            disabled={page <= 1}
            className="px-3 py-1.5 rounded-lg border border-slate-300 text-xs font-bold hover:bg-slate-100 transition-colors disabled:opacity-50"
          >
            上一页
          </button>
          <span data-testid="pagination-status" className="px-3 py-1.5 text-xs font-mono text-slate-500">{page}/{totalPages}</span>
          <button
            data-testid="pagination-next"
            onClick={() => onPageChange(page + 1)}
            disabled={page >= totalPages}
            className="px-3 py-1.5 rounded-lg border border-slate-300 text-xs font-bold hover:bg-slate-100 transition-colors disabled:opacity-50"
          >
            下一页
          </button>
        </div>
      </div>
    </div>
  );
}

// ===================== SQL Syntax Highlighting =====================
function HighlightSql({ sql }: { sql: string }) {
  const keywords = /\b(SELECT|INSERT INTO|INSERT|UPDATE|DELETE FROM|DELETE|FROM|WHERE|AND|OR|SET|VALUES|INTO|JOIN|LEFT JOIN|RIGHT JOIN|INNER JOIN|ON|ORDER BY|GROUP BY|HAVING|LIMIT|OFFSET|AS|IN|NOT|NULL|IS|LIKE|BETWEEN|EXISTS|DISTINCT|COUNT|SUM|AVG|MAX|MIN|CREATE|ALTER|DROP|TRUNCATE|INDEX|TABLE|VIEW)\b/gi;

  const parts = sql.split(keywords);
  return (
    <>
      {parts.map((part, i) => {
        if (keywords.test(part)) {
          return <span key={i} className="text-purple-500">{part}</span>;
        }
        if (part === '?') {
          return <span key={i} className="text-orange-400">{part}</span>;
        }
        // Handle ? within the part
        const subParts = part.split('?');
        if (subParts.length > 1) {
          return (
            <React.Fragment key={i}>
              {subParts.map((sp, j) => (
                <React.Fragment key={j}>
                  {sp}
                  {j < subParts.length - 1 && <span className="text-orange-400">?</span>}
                </React.Fragment>
              ))}
            </React.Fragment>
          );
        }
        return <React.Fragment key={i}>{part}</React.Fragment>;
      })}
    </>
  );
}
