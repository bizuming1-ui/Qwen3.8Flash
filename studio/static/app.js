/* Qwen3.8Flash Kaggle & Voice Cloning Browser Studio — Frontend Controller */
/* Uses 100% relative /api/... endpoints for Arena HTTPS Live Preview compatibility */

const state = {
  overview: null,
  cells: [],
  pyRelPath: "src/voice_cloning/kaggle_main.py",
  ipynbRelPath: "notebooks/kaggle_voice_cloning.ipynb",
  activeExplorerFile: "src/voice_cloning/kaggle_main.py",
};

function escapeHtml(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function showToast(msg, isError = false) {
  const el = document.getElementById("toast");
  el.textContent = msg;
  el.style.borderColor = isError ? "#f43f5e" : "#10b981";
  el.style.display = "block";
  clearTimeout(window.__toastTimer);
  window.__toastTimer = setTimeout(() => {
    el.style.display = "none";
  }, 3800);
}

async function apiFetch(url, options = {}) {
  const headers = options.headers || {};
  if (options.body && !(options.body instanceof FormData) && !headers["Content-Type"]) {
    headers["Content-Type"] = "application/json";
  }
  const resp = await fetch(url, { ...options, headers });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    throw new Error(data.detail || data.error || `HTTP ${resp.status}`);
  }
  return data;
}

function switchTab(tabId) {
  document.querySelectorAll(".tab-pane").forEach((el) => el.classList.remove("active"));
  document.querySelectorAll(".tab-btn").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.tab === tabId);
  });
  const target = document.getElementById(tabId);
  if (target) target.classList.add("active");

  if (tabId === "tab-repo") {
    loadProjectFileTree();
    refreshGitPanel();
  } else if (tabId === "tab-train") {
    loadExperimentsList();
  }
}

/* ---- Overview & Header ---- */
async function refreshOverview() {
  try {
    const data = await apiFetch("/api/overview");
    state.overview = data;

    // Accelerator selector
    const accelSel = document.getElementById("globalAcceleratorSelect");
    if (data.kaggle?.state?.accelerator) {
      accelSel.value = data.kaggle.state.accelerator;
    }
    const nbSym = document.getElementById("nbSymlinkBadge");
    if (nbSym) {
      nbSym.textContent = data.kaggle?.os_kaggle_symlink_active
        ? "已挂载 (/kaggle -> kaggle_workspace)"
        : "Python 虚拟桥接已启用";
    }

    // Populate Architectures
    const vcArch = document.getElementById("vcArchSelect");
    const trArch = document.getElementById("trArchSelect");
    if (vcArch && vcArch.options.length === 0) {
      (data.architectures || []).forEach((a) => {
        vcArch.add(new Option(a.name, a.id));
        trArch.add(new Option(a.name, a.id));
      });
      renderArchStages();
      vcArch.addEventListener("change", renderArchStages);
    }

    // Populate Reference Audios
    const refSel = document.getElementById("vcRefAudioSelect");
    if (refSel) {
      const prev = refSel.value;
      refSel.innerHTML = "";
      (data.reference_audios || []).forEach((r) => {
        const opt = new Option(`${r.name} (${r.kaggle_path})`, r.kaggle_path);
        opt.dataset.url = r.url;
        refSel.add(opt);
      });
      if (prev && [...refSel.options].some((o) => o.value === prev)) {
        refSel.value = prev;
      }
      updateRefAudioPlayer();
    }

    renderGitBadges(data.git);
  } catch (err) {
    showToast(`初始化状态失败: ${err.message}`, true);
  }
}

function renderArchStages() {
  const vcArch = document.getElementById("vcArchSelect");
  const box = document.getElementById("vcStagesBox");
  if (!state.overview || !vcArch || !box) return;
  const arch = (state.overview.architectures || []).find((a) => a.id === vcArch.value);
  if (!arch) return;
  box.innerHTML =
    `<strong>流水线阶段 (${arch.sample_rate}Hz / ${arch.n_mels} Mels):</strong><br>` +
    arch.stages.map((s) => `• ${escapeHtml(s)}`).join("<br>");
}

function renderGitBadges(git) {
  if (!git) return;
  document.getElementById("headerBranchName").textContent = git.branch || "unknown";
  const badge = document.getElementById("gitHeaderBadge");
  const syncSpan = document.getElementById("headerSyncState");

  if (git.synced_with_github) {
    badge.className = "pill synced";
    syncSpan.innerHTML = git.branch_url
      ? `✅ <a href="${escapeHtml(git.branch_url)}" target="_blank" rel="noopener">已同步 GitHub</a>`
      : "✅ 已同步 GitHub";
  } else {
    badge.className = "pill dirty";
    syncSpan.textContent = `● ${git.changed_count} 处更改 / ${git.ahead} 待推送`;
  }

  const pasteSummary = document.getElementById("pasteGitSummary");
  if (pasteSummary) {
    const repoLink = git.repo_url
      ? `<a href="${escapeHtml(git.branch_url || git.repo_url)}" target="_blank" rel="noopener" style="color:#38bdf8;">${escapeHtml(git.repo_url)}</a>`
      : "GitHub Remote";
    pasteSummary.innerHTML = `
      <div>远程仓库: ${repoLink}</div>
      <div>当前分支: <span class="mono" style="color:#6ee7b7;">${escapeHtml(git.branch)}</span> | 未提交文件: <strong>${git.changed_count}</strong> | 待推送提交: <strong>${git.ahead}</strong></div>
    `;
  }
}

/* ---- Tab 1: Paste Full Kaggle Code & Real Project Persistence ---- */
async function loadWorkspaceFromDisk() {
  try {
    const pyPath = document.getElementById("pastePyPath").value.trim() || state.pyRelPath;
    const nbPath = document.getElementById("pasteIpynbPath").value.trim() || state.ipynbRelPath;
    const ws = await apiFetch(
      `/api/workspace/load?ipynb_rel_path=${encodeURIComponent(nbPath)}&py_rel_path=${encodeURIComponent(pyPath)}`
    );
    state.cells = ws.cells || [];
    state.pyRelPath = ws.py_rel_path;
    state.ipynbRelPath = ws.ipynb_rel_path;

    document.getElementById("nbBoundPy").textContent = state.pyRelPath;
    document.getElementById("nbBoundIpynb").textContent = state.ipynbRelPath;

    syncCellsToPasteTextarea();
    renderNotebookCells();
    renderKaggleDetectInfo(ws.kaggle_references, []);
  } catch (err) {
    showToast(`读取项目代码失败: ${err.message}`, true);
  }
}

function syncCellsToPasteTextarea() {
  const combined = state.cells
    .map((c) => {
      if (c.cell_type === "markdown") {
        const commented = (c.source || "")
          .split("\n")
          .map((l) => (l ? `# ${l}` : "#"))
          .join("\n");
        return `# %% [markdown] ${c.title || ""}\n${commented}`;
      }
      return `# %% ${c.title || ""}\n${c.source || ""}`;
    })
    .join("\n\n");
  document.getElementById("fullKagglePasteInput").value = combined;
}

function loadCurrentProjectIntoPasteBox() {
  loadWorkspaceFromDisk().then(() => showToast("已从项目仓库加载最新代码"));
}

function clearPasteEditor() {
  const ta = document.getElementById("fullKagglePasteInput");
  ta.value = "";
  ta.focus();
  showToast("已清空编辑区，请直接粘贴您的完整 Kaggle 代码 (Ctrl+V)");
}

function handleImportCodeFile(ev) {
  const file = ev.target.files?.[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    document.getElementById("fullKagglePasteInput").value = String(reader.result || "");
    showToast(`已载入文件 ${file.name}，请点击「真实保存到项目」完成落盘与 GitHub 同步`);
    previewKagglePaste();
  };
  reader.readAsText(file);
}

async function previewKagglePaste() {
  const raw = document.getElementById("fullKagglePasteInput").value;
  if (!raw.trim()) {
    showToast("请先在编辑区粘贴您的 Kaggle 代码", true);
    return;
  }
  try {
    const autoSplit = document.getElementById("chkAutoSplit").checked;
    const res = await apiFetch("/api/workspace/parse-preview", {
      method: "POST",
      body: JSON.stringify({ raw_code: raw, auto_split_sections: autoSplit }),
    });
    renderKaggleDetectInfo(res.kaggle_references, res.extracted_writefiles, res.cell_count);
    showToast(`解析成功：共识别出 ${res.cell_count} 个单元格`);
  } catch (err) {
    showToast(`预解析失败: ${err.message}`, true);
  }
}

function renderKaggleDetectInfo(refs, writefiles = [], cellCount = null) {
  const box = document.getElementById("kaggleDetectBox");
  if (!box || !refs) return;
  const inputs = refs.input_paths || [];
  const workings = refs.working_paths || [];
  const pips = refs.pip_commands || [];
  const cuda = refs.uses_cuda?.[0] === "True";

  let html = "";
  if (cellCount !== null) {
    html += `<div style="margin-bottom:6px;color:#e2e8f0;">📦 识别单元格数量: <strong>${cellCount}</strong></div>`;
  }
  html += `<div style="margin-bottom:6px;">⚡ CUDA / GPU 调用检测: <strong>${cuda ? "是 (由虚拟 Kaggle GPU 支持)" : "未检测到显式 CUDA 调用"}</strong></div>`;
  html += `<div style="margin-bottom:6px;">📥 <span class="mono">/kaggle/input</span> 引用 (${inputs.length}): ${
    inputs.length ? inputs.map((p) => `<span class="mono" style="color:#38bdf8;">${escapeHtml(p)}</span>`).join(", ") : "无"
  }</div>`;
  html += `<div style="margin-bottom:6px;">📤 <span class="mono">/kaggle/working</span> 引用 (${workings.length}): ${
    workings.length ? workings.map((p) => `<span class="mono" style="color:#fcd34d;">${escapeHtml(p)}</span>`).join(", ") : "无"
  }</div>`;
  html += `<div style="margin-bottom:6px;">📦 <span class="mono">!pip</span> 命令 (${pips.length}): ${
    pips.length ? pips.map((p) => `<code style="color:#a7f3d0;">${escapeHtml(p)}</code>`).join(" | ") : "无"
  }</div>`;
  if (writefiles && writefiles.length > 0) {
    html += `<div style="margin-top:6px;color:#6ee7b7;">✨ 检测到 <strong>${writefiles.length}</strong> 个 <code>%%writefile</code> 模块将自动提取至项目仓库: ${writefiles
      .map((w) => `<span class="mono">${escapeHtml(w.project_rel_path)}</span>`)
      .join(", ")}</div>`;
  }
  box.innerHTML = html;
}

function renderDiskReceipts(savedFiles) {
  const box = document.getElementById("diskSaveReceiptBox");
  if (!box) return;
  if (!savedFiles || savedFiles.length === 0) {
    box.innerHTML = "<div>暂无保存记录</div>";
    return;
  }
  box.innerHTML = savedFiles
    .map(
      (f) => `
      <div class="receipt-item">
        <div style="font-weight:700;color:#6ee7b7;" class="mono">✔ ${escapeHtml(f.project_rel_path)}</div>
        <div style="color:var(--text-muted);margin-top:2px;">
          真实绝对路径: <span class="mono">${escapeHtml(f.absolute_path)}</span>
        </div>
        <div style="color:#cbd5e1;margin-top:2px;">
          大小: <strong>${f.size_bytes} B</strong> | SHA256: <span class="mono">${escapeHtml(f.sha256_short)}</span> | 时间: ${escapeHtml(f.saved_at_utc)}
        </div>
      </div>
    `
    )
    .join("");
}

function renderGitSyncResult(gitSync, terminalElId) {
  const term = document.getElementById(terminalElId);
  if (!term || !gitSync) return;
  if (gitSync.ok) {
    const lines = [
      `[分支] ${gitSync.branch}`,
      `[Commit] ${gitSync.head_sha ? gitSync.head_sha.slice(0, 10) : "N/A"}`,
      gitSync.commit_output || "",
      gitSync.pushed ? `[GitHub Push 成功] -> ${gitSync.branch_url}` : "[未执行远程 Push]",
      gitSync.push_output || "",
    ].filter(Boolean);
    term.style.color = "#a7f3d0";
    term.textContent = lines.join("\n");
  } else {
    term.style.color = "#fda4af";
    term.textContent = `[Git 同步异常 @ ${gitSync.stage}]\n${gitSync.error || "Unknown error"}`;
  }
}

async function saveFullPasteToProject(runAfterSave = false) {
  const raw = document.getElementById("fullKagglePasteInput").value;
  if (!raw.trim()) {
    showToast("代码内容为空，请先粘贴您的 Kaggle 代码", true);
    return;
  }
  const pyPath = document.getElementById("pastePyPath").value.trim() || "src/voice_cloning/kaggle_main.py";
  const nbPath = document.getElementById("pasteIpynbPath").value.trim() || "notebooks/kaggle_voice_cloning.ipynb";
  const extractSub = document.getElementById("chkExtractSubmodules").checked;
  const autoSplit = document.getElementById("chkAutoSplit").checked;
  const pushGh = document.getElementById("chkAutoPushOnSave").checked;
  const commitMsg = document.getElementById("pasteCommitMsg").value.trim();

  const btn = document.getElementById("btnSaveAndSyncMain");
  btn.disabled = true;
  const origText = btn.textContent;
  btn.textContent = pushGh ? "⏳ 正在写入项目并推送至 GitHub..." : "⏳ 正在写入项目仓库磁盘...";

  try {
    const res = await apiFetch("/api/workspace/save", {
      method: "POST",
      body: JSON.stringify({
        raw_code: raw,
        py_rel_path: pyPath,
        ipynb_rel_path: nbPath,
        extract_submodules: extractSub,
        auto_split_sections: autoSplit,
        push_to_github: pushGh,
        commit_message: commitMsg,
      }),
    });

    state.cells = res.workspace.cells || [];
    state.pyRelPath = res.workspace.py_rel_path;
    state.ipynbRelPath = res.workspace.ipynb_rel_path;

    document.getElementById("nbBoundPy").textContent = state.pyRelPath;
    document.getElementById("nbBoundIpynb").textContent = state.ipynbRelPath;

    renderDiskReceipts(res.workspace.saved_files);
    renderKaggleDetectInfo(res.workspace.kaggle_references, [], state.cells.length);
    renderGitBadges(res.git_status);
    renderNotebookCells();

    if (res.git_sync) {
      renderGitSyncResult(res.git_sync, "pasteGitTerminal");
      if (res.git_sync.ok) {
        showToast("✅ 已真实保存到项目仓库并成功更新到 GitHub！");
      } else {
        showToast("⚠️ 已保存到项目磁盘，但 GitHub 推送返回告警，请查看右侧日志", true);
      }
    } else {
      document.getElementById("pasteGitTerminal").textContent =
        "文件已真实写入本地项目仓库。如需推送到远程 GitHub，请勾选自动推送或点击右上角「保存项目并更新 GitHub」。";
      showToast("✅ 已真实保存到项目仓库！");
    }

    if (runAfterSave) {
      switchTab("tab-notebook");
      await runAllNotebookCells();
    }
  } catch (err) {
    showToast(`保存失败: ${err.message}`, true);
  } finally {
    btn.disabled = false;
    btn.textContent = origText;
  }
}

async function quickSaveAndPushGitHub() {
  // Sync whichever tab user is actively editing
  const activePane = document.querySelector(".tab-pane.active")?.id;
  if (activePane === "tab-paste") {
    document.getElementById("chkAutoPushOnSave").checked = true;
    await saveFullPasteToProject(false);
  } else if (activePane === "tab-notebook") {
    await saveNotebookCellsToRepo(true);
  } else {
    try {
      showToast("⏳ 正在提交项目全部更改并推送至 GitHub...");
      const res = await apiFetch("/api/git/sync", {
        method: "POST",
        body: JSON.stringify({
          message: "feat: sync Kaggle voice cloning project repository",
          push: true,
        }),
      });
      renderGitBadges(res.status);
      renderGitSyncResult(res, "pasteGitTerminal");
      renderGitSyncResult(res, "gitPanelTerminal");
      if (res.ok) {
        showToast("✅ 项目仓库已成功提交并更新到 GitHub！");
      } else {
        showToast(`GitHub 同步失败: ${res.error}`, true);
      }
    } catch (err) {
      showToast(`GitHub 同步异常: ${err.message}`, true);
    }
  }
}

/* ---- Tab 2: Multi-Cell Kaggle Notebook Simulator ---- */
function renderNotebookCells() {
  const container = document.getElementById("notebookCellsContainer");
  if (!container) return;
  container.innerHTML = "";

  state.cells.forEach((cell, idx) => {
    const card = document.createElement("div");
    card.className = "cell-card";
    card.id = `dom-${cell.id}`;

    const execBadge =
      cell.cell_type === "code"
        ? `<span>[${cell.execution_count ? cell.execution_count : " "}]</span>`
        : `<span>[MD]</span>`;

    card.innerHTML = `
      <div class="cell-toolbar">
        <div class="cell-meta">
          ${execBadge}
          <input type="text" class="cell-title-input" value="${escapeHtml(cell.title || `Cell ${idx + 1}`)}"
            onchange="updateCellTitle(${idx}, this.value)" />
          <span style="font-size:11px;opacity:0.75;">(${cell.cell_type})</span>
        </div>
        <div class="btn-row">
          ${
            cell.cell_type === "code"
              ? `<button class="btn btn-primary btn-sm" onclick="runSingleCell(${idx})">▶ 运行此格</button>`
              : ""
          }
          <button class="btn btn-sm" onclick="moveCell(${idx}, -1)" ${idx === 0 ? "disabled" : ""}>↑</button>
          <button class="btn btn-sm" onclick="moveCell(${idx}, 1)" ${idx === state.cells.length - 1 ? "disabled" : ""}>↓</button>
          <button class="btn btn-danger btn-sm" onclick="deleteCell(${idx})">✕</button>
        </div>
      </div>
      <div class="cell-body">
        <textarea class="code-editor" rows="${Math.max(3, Math.min(18, (cell.source || "").split("\n").length + 1))}"
          oninput="updateCellSource(${idx}, this.value)">${escapeHtml(cell.source || "")}</textarea>
      </div>
      <div class="cell-output" id="out-${cell.id}" style="display:${cell._lastResult ? "block" : "none"};"></div>
    `;
    container.appendChild(card);

    if (cell._lastResult) {
      renderCellOutputDom(cell.id, cell._lastResult);
    }
  });
}

function updateCellSource(idx, val) {
  if (state.cells[idx]) {
    state.cells[idx].source = val;
  }
}

function updateCellTitle(idx, val) {
  if (state.cells[idx]) {
    state.cells[idx].title = val;
  }
}

function addNotebookCell(cellType) {
  const n = state.cells.length + 1;
  state.cells.push({
    id: `cell-${Date.now()}`,
    cell_type: cellType,
    title: cellType === "markdown" ? `说明 ${n}` : `Cell ${n}`,
    source: cellType === "markdown" ? "## 实验步骤说明" : "# 在此编写或粘贴 Kaggle 代码\n",
  });
  renderNotebookCells();
}

function moveCell(idx, delta) {
  const target = idx + delta;
  if (target < 0 || target >= state.cells.length) return;
  const tmp = state.cells[idx];
  state.cells[idx] = state.cells[target];
  state.cells[target] = tmp;
  renderNotebookCells();
}

function deleteCell(idx) {
  if (state.cells.length <= 1) {
    state.cells[0].source = "";
  } else {
    state.cells.splice(idx, 1);
  }
  renderNotebookCells();
}

function renderCellOutputDom(cellId, res) {
  const outEl = document.getElementById(`out-${cellId}`);
  if (!outEl) return;
  outEl.style.display = "block";

  let html = `<div style="font-size:11px;color:var(--text-muted);margin-bottom:4px;">
    状态: <strong style="color:${res.status === "ok" ? "#34d399" : "#f43f5e"};">${res.status.toUpperCase()}</strong>
    | 耗时: ${res.duration_ms} ms
    ${res.synced_project_files?.length ? `| 自动同步回项目: ${res.synced_project_files.join(", ")}` : ""}
  </div>`;

  if (res.stdout) {
    html += `<pre class="out-stdout">${escapeHtml(res.stdout)}</pre>`;
  }
  if (res.stderr) {
    html += `<pre class="out-stderr">${escapeHtml(res.stderr)}</pre>`;
  }
  if (res.rich_outputs && res.rich_outputs.length > 0) {
    html += `<div class="rich-media-box">`;
    res.rich_outputs.forEach((ro) => {
      if (ro.type === "audio") {
        html += `
          <div>
            <div style="font-size:12px;color:#38bdf8;margin-bottom:3px;">🔊 音频输出: ${escapeHtml(ro.label || "audio.wav")}</div>
            <audio controls src="${escapeHtml(ro.url)}"></audio>
          </div>`;
      } else if (ro.type === "image") {
        html += `<img src="data:${ro.mime || "image/png"};base64,${ro.data_b64}" alt="Plot output" />`;
      } else if (ro.type === "text") {
        html += `<pre class="out-stdout">${escapeHtml(ro.text)}</pre>`;
      }
    });
    html += `</div>`;
  }
  outEl.innerHTML = html;
}

async function runSingleCell(idx) {
  const cell = state.cells[idx];
  if (!cell) return;
  const domCard = document.getElementById(`dom-${cell.id}`);
  if (domCard) domCard.classList.add("running");

  try {
    const res = await apiFetch("/api/kaggle/run-cell", {
      method: "POST",
      body: JSON.stringify(cell),
    });
    cell.execution_count = res.execution_count;
    cell._lastResult = res;
    renderNotebookCells();
    syncCellsToPasteTextarea();
  } catch (err) {
    showToast(`单元格执行异常: ${err.message}`, true);
  } finally {
    if (domCard) domCard.classList.remove("running");
  }
}

async function runAllNotebookCells() {
  try {
    showToast("⏳ 正在落盘保存并依次执行全部 Kaggle 单元格...");
    const res = await apiFetch("/api/kaggle/run-all", {
      method: "POST",
      body: JSON.stringify({
        cells: state.cells,
        stop_on_error: true,
        save_before_run: true,
        py_rel_path: state.pyRelPath,
        ipynb_rel_path: state.ipynbRelPath,
      }),
    });

    const mapById = {};
    (res.execution?.results || []).forEach((r) => {
      mapById[r.cell_id] = r;
    });
    state.cells.forEach((c) => {
      if (mapById[c.id]) {
        c.execution_count = mapById[c.id].execution_count;
        c._lastResult = mapById[c.id];
      }
    });
    renderNotebookCells();
    syncCellsToPasteTextarea();
    refreshOverview();
    showToast(
      res.execution.status === "ok"
        ? `✅ 全部单元格执行完毕 (${res.execution.total_duration_ms} ms)`
        : "⚠️ 执行过程中遇到错误，请查看单元格红色报错详情",
      res.execution.status !== "ok"
    );
  } catch (err) {
    showToast(`批量运行失败: ${err.message}`, true);
  }
}

async function saveNotebookCellsToRepo(pushToGitHub = true) {
  try {
    showToast(pushToGitHub ? "⏳ 正在保存 Notebook 到项目并推送 GitHub..." : "⏳ 正在保存 Notebook 到项目...");
    const res = await apiFetch("/api/workspace/save", {
      method: "POST",
      body: JSON.stringify({
        cells: state.cells,
        py_rel_path: state.pyRelPath,
        ipynb_rel_path: state.ipynbRelPath,
        extract_submodules: true,
        push_to_github: pushToGitHub,
        commit_message: `feat: update ${state.pyRelPath} & ${state.ipynbRelPath} from Kaggle Notebook Simulator`,
      }),
    });
    syncCellsToPasteTextarea();
    renderDiskReceipts(res.workspace.saved_files);
    renderGitBadges(res.git_status);
    if (res.git_sync) {
      renderGitSyncResult(res.git_sync, "pasteGitTerminal");
    }
    showToast(pushToGitHub ? "✅ 已保存到项目仓库并推送到 GitHub！" : "✅ 已保存到项目仓库！");
  } catch (err) {
    showToast(`保存失败: ${err.message}`, true);
  }
}

async function resetKaggleKernel() {
  await apiFetch("/api/kaggle/reset-kernel", { method: "POST" });
  state.cells.forEach((c) => {
    c.execution_count = null;
    delete c._lastResult;
  });
  renderNotebookCells();
  showToast("🔄 Kaggle Python 模拟器内核已重置");
}

async function uploadToKaggleInput(ev) {
  const file = ev.target.files?.[0];
  if (!file) return;
  const dsName = prompt("请输入 /kaggle/input/ 下的数据集文件夹名称:", "custom-voice-data");
  if (!dsName) return;
  const fd = new FormData();
  fd.append("dataset_name", dsName);
  fd.append("target_area", "kaggle_input");
  fd.append("file", file);
  try {
    const res = await apiFetch("/api/kaggle/upload", { method: "POST", body: fd });
    await refreshOverview();
    showToast(`✅ 已上传至 ${res.kaggle_path}`);
  } catch (err) {
    showToast(`上传失败: ${err.message}`, true);
  }
}

async function promptSetKaggleSecret() {
  const key = prompt("请输入 Kaggle Secret 名称 (如 HF_TOKEN / WANDB_API_KEY):", "HF_TOKEN");
  if (!key) return;
  const val = prompt(`请输入 ${key} 的值 (保存在本地 .kaggle_secrets.local.json，已加入 .gitignore 不会泄露到 GitHub):`, "");
  if (val === null) return;
  await apiFetch("/api/kaggle/secrets", {
    method: "POST",
    body: JSON.stringify({ key, value: val }),
  });
  showToast(`🔑 Secret ${key} 已安全保存，代码中可通过 UserSecretsClient().get_secret('${key}') 读取`);
}

/* ---- Tab 3: Voice Cloning DSP & Synthesis Simulator ---- */
function updateRefAudioPlayer() {
  const sel = document.getElementById("vcRefAudioSelect");
  const player = document.getElementById("vcRefAudioPlayer");
  const opt = sel?.selectedOptions?.[0];
  if (opt && player) {
    player.src = opt.dataset.url || "";
  }
}

async function uploadCustomRefWav(ev) {
  const file = ev.target.files?.[0];
  if (!file) return;
  const fd = new FormData();
  fd.append("dataset_name", "sample-voice-dataset");
  fd.append("target_area", "kaggle_input");
  fd.append("file", file);
  try {
    const res = await apiFetch("/api/kaggle/upload", { method: "POST", body: fd });
    await refreshOverview();
    document.getElementById("vcRefAudioSelect").value = res.kaggle_path;
    updateRefAudioPlayer();
    showToast(`✅ 参考音色 ${res.filename} 已上传并选中`);
  } catch (err) {
    showToast(`上传音频失败: ${err.message}`, true);
  }
}

async function runRefVoiceAnalysis() {
  const path = document.getElementById("vcRefAudioSelect").value;
  if (!path) return;
  const area = document.getElementById("vcResultArea");
  area.innerHTML = "⏳ 正在分析参考语音声学与声纹特征...";
  try {
    const res = await apiFetch("/api/sim/voice-analyze", {
      method: "POST",
      body: JSON.stringify({ audio_path: path }),
    });
    area.innerHTML = `
      <div class="metrics-grid">
        <div class="metric-box"><div class="metric-label">采样率 / 时长</div><div class="metric-val">${res.sample_rate}Hz / ${res.duration_sec}s</div></div>
        <div class="metric-box"><div class="metric-label">基频均值 F0</div><div class="metric-val">${res.f0_mean_hz} Hz</div></div>
        <div class="metric-box"><div class="metric-label">VAD 有效语音占比</div><div class="metric-val">${(res.vad_speech_ratio * 100).toFixed(1)}%</div></div>
        <div class="metric-box"><div class="metric-label">响度 RMS</div><div class="metric-val">${res.rms_dbfs} dBFS</div></div>
      </div>
      <div style="font-size:12px;color:var(--text-muted);margin-bottom:8px;">
        256 维归一化声纹向量前 8 维预览: <span class="mono">[${res.embedding_preview.slice(0, 8).join(", ")}, ...]</span>
      </div>
      <img class="plot-img" src="data:image/png;base64,${res.plot_b64}" alt="Acoustic Analysis" />
    `;
  } catch (err) {
    area.innerHTML = `<div style="color:#f43f5e;">分析失败: ${escapeHtml(err.message)}</div>`;
  }
}

async function runVoiceCloneSim() {
  const btn = document.getElementById("btnRunVcSim");
  const area = document.getElementById("vcResultArea");
  btn.disabled = true;
  area.innerHTML = "⏳ 正在提取参考声纹、迁移共振峰与基频包络并生成克隆音频...";

  try {
    const res = await apiFetch("/api/sim/voice-clone", {
      method: "POST",
      body: JSON.stringify({
        ref_audio_path: document.getElementById("vcRefAudioSelect").value,
        target_text: document.getElementById("vcTargetText").value,
        architecture_id: document.getElementById("vcArchSelect").value,
        speed: parseFloat(document.getElementById("vcSpeed").value || "1.0"),
        pitch_shift_semitones: parseFloat(document.getElementById("vcPitchShift").value || "0.0"),
        temperature: parseFloat(document.getElementById("vcTemp").value || "0.7"),
        nfe_steps: parseInt(document.getElementById("vcNfe").value || "24", 10),
        log_experiment: true,
      }),
    });

    const m = res.metrics;
    const traceRows = (res.tensor_trace || [])
      .map(
        (t) =>
          `<tr><td class="mono">${escapeHtml(t.stage)}</td><td class="mono">[${t.shape.join(", ")}]</td><td class="mono">${t.dtype}</td></tr>`
      )
      .join("");

    area.innerHTML = `
      <div style="background:#0f172a;border:1px solid #334155;border-radius:8px;padding:12px;margin-bottom:12px;">
        <div style="font-weight:700;color:#6ee7b7;margin-bottom:6px;">🔊 克隆合成音频已生成 (<span class="mono">${escapeHtml(res.cloned_kaggle_path)}</span>)</div>
        <audio controls autoplay src="${escapeHtml(res.cloned_audio_url)}"></audio>
      </div>

      <div class="metrics-grid">
        <div class="metric-box"><div class="metric-label">SECS 音色相似度 (↑)</div><div class="metric-val" style="color:#34d399;">${m.speaker_cosine_similarity_secs}</div></div>
        <div class="metric-box"><div class="metric-label">MCD 梅尔倒谱失真 (↓)</div><div class="metric-val">${m.mcd_db} dB</div></div>
        <div class="metric-box"><div class="metric-label">RTF 实时率</div><div class="metric-val">${m.rtf}</div></div>
        <div class="metric-box"><div class="metric-label">预估 Kaggle 显存</div><div class="metric-val">${m.estimated_kaggle_vram_gb} GB</div></div>
      </div>

      <img class="plot-img" src="data:image/png;base64,${res.plot_b64}" alt="Voice Cloning Spectrogram" style="margin-bottom:12px;" />

      <div style="font-size:12.5px;font-weight:700;margin-bottom:6px;">🔎 模型张量维度追踪 (Tensor Shape Trace):</div>
      <table class="table-clean">
        <thead><tr><th>Pipeline 阶段张量</th><th>Shape</th><th>DType</th></tr></thead>
        <tbody>${traceRows}</tbody>
      </table>
    `;
    showToast("✅ 克隆语音实验完成，指标已自动记录到 experiments/registry.json");
  } catch (err) {
    area.innerHTML = `<div style="color:#f43f5e;">合成实验失败: ${escapeHtml(err.message)}</div>`;
  } finally {
    btn.disabled = false;
  }
}

/* ---- Tab 4: Kaggle GPU VRAM & Training Simulator ---- */
async function runTrainingSim() {
  const area = document.getElementById("trResultArea");
  area.innerHTML = "⏳ 正在计算 Kaggle 显存占用与训练收敛模拟...";
  try {
    const res = await apiFetch("/api/sim/training-benchmark", {
      method: "POST",
      body: JSON.stringify({
        architecture_id: document.getElementById("trArchSelect").value,
        accelerator_id: document.getElementById("trAccelSelect").value,
        finetune_mode: document.getElementById("trMode").value,
        precision: document.getElementById("trPrecision").value,
        batch_size: parseInt(document.getElementById("trBatch").value || "4", 10),
        grad_accum_steps: parseInt(document.getElementById("trAccum").value || "4", 10),
        max_audio_sec: parseFloat(document.getElementById("trMaxSec").value || "10"),
        dataset_hours: parseFloat(document.getElementById("trHours").value || "2"),
        learning_rate: parseFloat(document.getElementById("trLr").value || "0.0001"),
        epochs: parseInt(document.getElementById("trEpochs").value || "12", 10),
        log_experiment: true,
      }),
    });

    const v = res.vram_breakdown_gb;
    const sc = res.schedule;
    const fm = res.final_metrics;
    const recs = (res.recommendations || []).map((r) => `<div style="margin-bottom:5px;">${escapeHtml(r)}</div>`).join("");

    area.innerHTML = `
      <div class="banner" style="border-color:${v.oom_risk ? "#f43f5e" : "#10b981"};">
        ${recs}
      </div>

      <div class="metrics-grid">
        <div class="metric-box">
          <div class="metric-label">单卡显存峰值 / 上限</div>
          <div class="metric-val" style="color:${v.oom_risk ? "#f43f5e" : "#34d399"};">${v.peak_per_gpu_gb} / ${v.gpu_limit_gb} GB</div>
        </div>
        <div class="metric-box">
          <div class="metric-label">预计训练耗时</div>
          <div class="metric-val">${sc.est_train_minutes} min</div>
        </div>
        <div class="metric-box">
          <div class="metric-label">占 Kaggle 30h 周配额</div>
          <div class="metric-val">${sc.kaggle_weekly_30h_quota_pct}%</div>
        </div>
        <div class="metric-box">
          <div class="metric-label">收敛音色相似度 SECS</div>
          <div class="metric-val" style="color:#34d399;">${fm.val_secs}</div>
        </div>
      </div>

      <div style="font-size:12px;color:var(--text-muted);margin-bottom:10px;">
        显存拆解：模型权重 ${v.weights_gb} GB + 梯度 ${v.gradients_gb} GB + 优化器状态 ${v.optimizer_gb} GB + 音频激活值 ${v.activations_per_gpu_gb} GB
      </div>

      <img class="plot-img" src="data:image/png;base64,${res.plot_b64}" alt="Training Curve" />
    `;
    loadExperimentsList();
  } catch (err) {
    area.innerHTML = `<div style="color:#f43f5e;">模拟失败: ${escapeHtml(err.message)}</div>`;
  }
}

async function loadExperimentsList() {
  const box = document.getElementById("experimentsTableBox");
  if (!box) return;
  try {
    const res = await apiFetch("/api/experiments");
    const runs = res.runs || [];
    if (runs.length === 0) {
      box.innerHTML = `<div style="color:var(--text-muted);font-size:12px;">暂无实验记录。</div>`;
      return;
    }
    box.innerHTML = `
      <table class="table-clean">
        <thead><tr><th>ID</th><th>实验名称</th><th>核心指标</th><th>时间</th></tr></thead>
        <tbody>
          ${runs
            .slice(0, 12)
            .map((r) => {
              const secs = r.metrics?.speaker_cosine_similarity_secs ?? r.metrics?.val_secs ?? "-";
              const vram = r.metrics?.estimated_kaggle_vram_gb ?? r.metrics?.peak_vram_gb ?? "-";
              return `<tr>
                <td class="mono">${escapeHtml(r.run_id)}</td>
                <td>${escapeHtml(r.name)}</td>
                <td class="mono">SECS=${secs} | VRAM=${vram}G</td>
                <td style="font-size:11px;color:var(--text-muted);">${escapeHtml(r.timestamp_utc)}</td>
              </tr>`;
            })
            .join("")}
        </tbody>
      </table>
    `;
  } catch (err) {
    box.innerHTML = `<div style="color:#f43f5e;">读取失败</div>`;
  }
}

/* ---- Tab 5: Real Project File Explorer & GitHub Panel ---- */
async function loadProjectFileTree() {
  const treeEl = document.getElementById("repoFileTree");
  if (!treeEl) return;
  try {
    const res = await apiFetch("/api/files/tree");
    const files = res.files || [];
    treeEl.innerHTML = files
      .map(
        (f) => `
        <div class="file-item ${f.path === state.activeExplorerFile ? "active" : ""}"
             onclick="openExplorerFile('${escapeHtml(f.path)}', ${f.is_text})">
          <span>${f.is_audio ? "🔊" : "📄"} ${escapeHtml(f.path)}</span>
          <span style="color:var(--text-muted);font-size:11px;">${f.size_bytes}B</span>
        </div>
      `
      )
      .join("");
  } catch (err) {
    showToast(`加载文件树失败: ${err.message}`, true);
  }
}

async function openExplorerFile(relPath, isText = true) {
  state.activeExplorerFile = relPath;
  document.getElementById("activeEditorPath").textContent = relPath;
  loadProjectFileTree();

  if (!isText) {
    document.getElementById("repoFileEditor").value = `[二进制/音频文件: ${relPath}]\n可在 Kaggle 模拟器或语音实验室直接播放加载。`;
    return;
  }
  try {
    const res = await apiFetch(`/api/files/read?path=${encodeURIComponent(relPath)}`);
    document.getElementById("repoFileEditor").value = res.content;
  } catch (err) {
    showToast(`读取文件失败: ${err.message}`, true);
  }
}

async function promptNewProjectFile() {
  const rel = prompt("请输入新项目文件的相对路径 (如 src/voice_cloning/my_model.py):", "src/voice_cloning/custom_module.py");
  if (!rel) return;
  state.activeExplorerFile = rel.trim();
  document.getElementById("activeEditorPath").textContent = state.activeExplorerFile;
  document.getElementById("repoFileEditor").value = "# 新建项目源码文件\n";
}

async function saveActiveExplorerFile(pushToGitHub = false) {
  const path = state.activeExplorerFile;
  const content = document.getElementById("repoFileEditor").value;
  try {
    const res = await apiFetch("/api/files/write", {
      method: "POST",
      body: JSON.stringify({
        path,
        content,
        push_to_github: pushToGitHub,
        commit_message: `feat: update ${path} in project repository`,
      }),
    });
    renderGitBadges(res.git_status);
    if (res.git_sync) {
      renderGitSyncResult(res.git_sync, "gitPanelTerminal");
    }
    loadProjectFileTree();
    refreshGitPanel();
    showToast(pushToGitHub ? `✅ ${path} 已保存并推送到 GitHub！` : `✅ ${path} 已真实写入磁盘！`);
  } catch (err) {
    showToast(`保存文件失败: ${err.message}`, true);
  }
}

async function refreshGitPanel() {
  try {
    const git = await apiFetch("/api/git/status");
    renderGitBadges(git);

    const detail = document.getElementById("gitDetailBox");
    const changedHtml =
      git.changed_files && git.changed_files.length
        ? git.changed_files
            .slice(0, 15)
            .map((f) => `<div class="mono" style="color:#fcd34d;">[${escapeHtml(f.code)}] ${escapeHtml(f.path)}</div>`)
            .join("")
        : `<div style="color:#6ee7b7;">工作区干净，所有文件均已纳入 Git 版本管理。</div>`;

    detail.innerHTML = `
      <div>当前活跃分支: <strong class="mono" style="color:#38bdf8;">${escapeHtml(git.branch)}</strong></div>
      <div>GitHub 仓库: <a href="${escapeHtml(git.branch_url || git.repo_url)}" target="_blank" rel="noopener" style="color:#6ee7b7;">${escapeHtml(git.repo_url)}</a></div>
      <div style="margin-top:8px;font-weight:600;">待提交变更 (${git.changed_count}):</div>
      <div style="margin-top:4px;max-height:120px;overflow-y:auto;">${changedHtml}</div>
    `;

    const commitsBox = document.getElementById("gitCommitsList");
    commitsBox.innerHTML = (git.recent_commits || [])
      .map(
        (c) => `
        <div class="receipt-item" style="border-left-color:#38bdf8;">
          <div style="display:flex;justify-content:space-between;">
            <a href="${escapeHtml(c.url)}" target="_blank" rel="noopener" class="mono" style="color:#38bdf8;font-weight:700;">${escapeHtml(c.short_sha)}</a>
            <span style="color:var(--text-muted);font-size:11px;">${escapeHtml(c.relative_time)}</span>
          </div>
          <div style="margin-top:3px;color:#f1f5f9;">${escapeHtml(c.message)}</div>
        </div>
      `
      )
      .join("");
  } catch (err) {
    showToast(`获取 Git 状态失败: ${err.message}`, true);
  }
}

async function triggerGitSyncFromPanel() {
  const msg = document.getElementById("gitPanelMsg").value.trim() || "feat: update Kaggle voice cloning project";
  const term = document.getElementById("gitPanelTerminal");
  term.textContent = "⏳ 正在执行 git add / commit / push origin ...";
  try {
    const res = await apiFetch("/api/git/sync", {
      method: "POST",
      body: JSON.stringify({ message: msg, push: true }),
    });
    renderGitSyncResult(res, "gitPanelTerminal");
    renderGitBadges(res.status);
    refreshGitPanel();
    if (res.ok) {
      showToast("✅ 已成功 Commit 并 Push 更新到 GitHub！");
    } else {
      showToast(`Git 推送异常: ${res.error}`, true);
    }
  } catch (err) {
    term.textContent = `错误: ${err.message}`;
    showToast(`Git 同步失败: ${err.message}`, true);
  }
}

/* ---- Global Event Listeners & Boot ---- */
document.addEventListener("DOMContentLoaded", async () => {
  document.getElementById("globalAcceleratorSelect").addEventListener("change", async (ev) => {
    const accel = ev.target.value;
    try {
      await apiFetch("/api/kaggle/config", {
        method: "POST",
        body: JSON.stringify({ accelerator: accel }),
      });
      document.getElementById("trAccelSelect").value = accel;
      await refreshOverview();
      showToast(`⚡ Kaggle 硬件模拟器已切换至: ${accel}`);
    } catch (err) {
      showToast(`切换硬件配置失败: ${err.message}`, true);
    }
  });

  await refreshOverview();
  await loadWorkspaceFromDisk();
  await openExplorerFile(state.pyRelPath, true);
});
