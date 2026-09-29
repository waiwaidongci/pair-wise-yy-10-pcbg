/* 页面层 · 断网回执合并台：
 * 只做“读输入 → 调判定层 Domain → 存 Storage → 渲染”，不写任何判定规则。
 * 状态每次变更后整块落盘，刷新/重启即从断点继续。 */
(function () {
  "use strict";

  var store = Storage.createStore("zfl42");
  var clock = { now: function () { return Date.now(); } };
  var state = null;

  /* ---------- 演示用初始台账 ---------- */
  function seedState() {
    var s = Domain.createState(clock);
    Domain.putOperation(s, { batchNo: "WF2601", opNo: "OP10", name: "贴线", status: "贴线中" });
    Domain.putPart(s, {
      partId: "C01", name: "香盒盖", batchNo: "WF2601", opNo: "OP10", seq: 1,
      opStatus: "已贴线", dryUntil: "2026-09-25", assemblyClosed: true, planDelivery: "2026-10-02"
    }, clock);
    Domain.putPart(s, {
      partId: "C02", name: "香盒身", batchNo: "WF2601", opNo: "OP10", seq: 2,
      opStatus: "贴线中", dryUntil: "2026-10-05", assemblyClosed: true, planDelivery: "2026-10-02"
    }, clock);
    // OP20 扫金：演示“未闭缺陷”
    Domain.putOperation(s, { batchNo: "WF2601", opNo: "OP20", name: "扫金", status: "待扫金" });
    Domain.putPart(s, {
      partId: "C03", name: "香盒托", batchNo: "WF2601", opNo: "OP20", seq: 1,
      opStatus: "待扫金", dryUntil: "2026-09-20", assemblyClosed: true, planDelivery: "2026-10-02"
    }, clock);
    Domain.regroupDeliveries(s, "初始成批", clock, { rejoinReady: true });
    return s;
  }

  /* ---------- 启动：读盘 → 断点续跑 ---------- */
  function boot() {
    try {
      state = store.loadState();
    } catch (e) {
      alert(e.message);
      state = seedState();
    }
    if (!state) {
      state = seedState();
      store.saveState(state);
    } else {
      // 重启后从断点继续：queued / 未超限 failed 自动重放
      var out = Domain.resumeAfterRestart(state, clock, 5);
      state = out.state;
      persist();
    }
    bindUI();
    render();
  }

  function persist() { store.saveState(state); }

  function commit(next, message) {
    state = next;
    persist();
    if (message) flash(message);
    render();
  }

  /* ---------- 交互 ---------- */

  function bindUI() {
    var fileInput = document.getElementById("pkgFile");
    document.getElementById("importBtn").addEventListener("click", function () {
      fileInput.value = "";
      fileInput.click();
    });
    fileInput.addEventListener("change", function () {
      var f = fileInput.files[0];
      if (!f) return;
      var reader = new FileReader();
      reader.onload = function () { ingestText(reader.result); };
      reader.readAsText(f);
    });
    document.getElementById("importTextBtn").addEventListener("click", function () {
      var txt = document.getElementById("pkgText").value.trim();
      if (txt) ingestText(txt);
    });
    document.getElementById("sampleBtn").addEventListener("click", function () {
      document.getElementById("pkgText").value = JSON.stringify(samplePackage(), null, 2);
    });
    document.getElementById("rejoinBtn").addEventListener("click", function () {
      commit(Domain.rejoinPending(state, clock), "已执行交付重排");
    });
    document.getElementById("exportBtn").addEventListener("click", exportJson);
    document.getElementById("resetBtn").addEventListener("click", function () {
      if (confirm("清空合并台账并恢复演示数据？（不影响作品看板）")) {
        store.resetState();
        state = seedState();
        persist();
        render();
        flash("已重置为演示台账");
      }
    });
    document.getElementById("syncRoot").addEventListener("click", onTableClick);
  }

  function ingestText(text) {
    var pkg;
    try { pkg = JSON.parse(text); }
    catch (e) { flash("回执包不是合法 JSON：" + e.message, true); return; }
    try {
      var out = Domain.ingestPackage(state, pkg, clock, true);
      var counts = out.accepted.reduce(function (acc, a) {
        acc[a.status] = (acc[a.status] || 0) + 1; return acc;
      }, {});
      commit(out.state, "收包完成：新收 " + (counts.queued || 0) +
        " 条，重复忽略 " + (counts.duplicate || 0) + " 条（含自动处理结果，见下表）");
    } catch (e) {
      flash("收包失败：" + e.message, true);
    }
  }

  function onTableClick(ev) {
    var btn = ev.target.closest("button[data-act]");
    if (!btn) return;
    var act = btn.dataset.act;
    var id = btn.dataset.id;
    try {
      if (act === "cf-workshop") commit(Domain.resolveConflict(state, id, "workshop", clock).state, "已裁决：保留工坊值");
      else if (act === "cf-local") commit(Domain.resolveConflict(state, id, "local", clock).state, "已裁决：采用平板本地值并重算");
      else if (act === "retry") commit(Domain.retryReceipt(state, id, clock).state, "已重试该回执");
      else if (act === "provision") {
        state = Domain.provisionMissing(state, id, {}, clock);
        persist();
        commit(Domain.retryReceipt(state, id, clock).state, "已补登缺失主数据并重试");
      }
    } catch (e) {
      flash(e.message, true);
    }
  }

  function exportJson() {
    var snap = Domain.exportSnapshot(state, clock);
    var blob = new Blob([JSON.stringify(snap, null, 2)], { type: "application/json" });
    var a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "huifang-hebing-" + Domain.ymd(new Date()).replace(/-/g, "") + ".json";
    a.click();
    URL.revokeObjectURL(a.href);
  }

  var flashTimer = null;
  function flash(msg, isError) {
    var el = document.getElementById("flash");
    el.textContent = msg;
    el.className = "flash " + (isError ? "err" : "ok show");
    if (!isError) {
      clearTimeout(flashTimer);
      flashTimer = setTimeout(function () { el.className = "flash"; }, 3200);
    }  }

  /* ---------- 样例断网包：覆盖正常 / 序号乱到 / 同号重复 / 缺工序失败 ---------- */
  function samplePackage() {
    var cursor = Domain.opCursor(state, "WF2601", "OP10");
    return {
      packageId: "PKG-DEMO-" + Domain.ymd(new Date()),
      exportedFromTablet: "平板-01",
      receipts: [
        {
          id: "R-DEMO-OK", batchNo: "WF2601", opNo: "OP10", seq: cursor + 1,
          payload: {
            opStatus: "待阴干",
            parts: [{ partId: "C02", opStatus: "待阴干", dryUntil: "2026-09-28" }]
          }
        },
        {
          id: "R-DEMO-CONFLICT", batchNo: "WF2601", opNo: "OP10", seq: cursor + 5,
          payload: { parts: [{ partId: "C01", assemblyClosed: false }] }
        },
        {
          id: "R-DEMO-MISSING", batchNo: "WF2601", opNo: "OP88", seq: 1,
          payload: { opStatus: "贴线中", parts: [{ partId: "Z9", opStatus: "贴线中" }] }
        },
        {
          id: "R-DEMO-OK", batchNo: "WF2601", opNo: "OP10", seq: cursor + 1,
          payload: { note: "同号重发，应被忽略" }
        }
      ]
    };
  }

  /* ---------- 渲染 ---------- */

  var STATUS_LABEL = {
    queued: "待处理", applied: "已合并", conflict: "冲突挂起",
    failed: "失败待重试", duplicate: "重复忽略"
  };
  var STATUS_CLS = {
    queued: "badge amber", applied: "badge teal", conflict: "badge red",
    failed: "badge red", duplicate: "badge gray"
  };

  function esc(v) {
    return String(v == null ? "" : v).replace(/[&<>"']/g, function (ch) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch];
    });
  }
  function shortTime(iso) {
    return iso ? new Date(iso).toLocaleString("zh-CN", { hour12: false }) : "—";
  }

  function render() {
    renderStatus();
    renderConflicts();
    renderOps();
    renderParts();
    renderDefects();
    renderBatches();
    renderReceipts();
    renderLogs();
  }

  function renderStatus() {
    var open = state.defects.filter(function (d) { return !d.closed; }).length;
    var blocked = state.parts.filter(function (p) { return p.blockers.length; }).length;
    var pending = Domain.pendingParts(state).length;
    var active = state.batches.filter(function (b) { return b.status === "active"; }).length;
    var returned = state.batches.filter(function (b) { return b.status === "returned"; }).length;
    var unresolved = state.conflicts.filter(function (c) { return !c.resolution; }).length;
    var failed = state.receipts.filter(function (r) { return r.status === "failed"; }).length;
    document.getElementById("statBar").innerHTML = [
      ["工序", state.operations.length],
      ["部件", state.parts.length],
      ["受阻部件", blocked],
      ["待重排", pending],
      ["未闭缺陷", open],
      ["在役交付批", active],
      ["退回批次", returned],
      ["未决冲突", unresolved],
      ["失败回执", failed],
      ["断点", state.checkpoint.lastProcessedIndex]
    ].map(function (kv) {
      return `<div class="stat"><span class="num">${kv[1]}</span><span class="cap">${kv[0]}</span></div>`;
    }).join("");
  }

  function renderConflicts() {
    var box = document.getElementById("conflictList");
    var open = state.conflicts.filter(function (c) { return !c.resolution; });
    if (!open.length) { box.innerHTML = `<div class="empty">无未决冲突</div>`; return; }
    box.innerHTML = open.map(function (c) {
      return `<article class="cf">
        <div><b>批次 ${esc(c.batchNo)} / 操作 ${esc(c.opNo)}</b> · 回执 ${esc(c.receiptId)}</div>
        <div class="cfvals">
          <span>工坊值：<b>${esc(c.workshopValue)}</b></span>
          <span>平板本地值：<b>${esc(c.localValue)}</b></span>
          <span>处理结果：<b>${esc(c.result)}</b></span>
        </div>
        <div class="actions">
          <button class="secondary" data-act="cf-workshop" data-id="${c.conflictId}">保留工坊值（拒收）</button>
          <button class="violet" data-act="cf-local" data-id="${c.conflictId}">采用本地值（并入并重算）</button>
        </div>
      </article>`;
    }).join("");
  }

  function renderOps() {
    document.getElementById("opRows").innerHTML = state.operations.map(function (o) {
      var cursor = Domain.opCursor(state, o.batchNo, o.opNo);
      return `<tr>
        <td>${esc(o.batchNo)}</td><td>${esc(o.opNo)}</td><td>${esc(o.name)}</td>
        <td>${esc(o.status)}</td><td>${cursor}</td><td class="meta">下条期望 ${cursor + 1}</td>
      </tr>`;
    }).join("") || `<tr><td colspan="6" class="empty">暂无工序</td></tr>`;
  }

  function renderParts() {
    document.getElementById("partRows").innerHTML = state.parts.map(function (p) {
      var batch = state.batches.find(function (b) { return b.batchId === p.deliveryBatchId; });
      var blockers = p.blockers.map(function (b) {
        return `<span class="badge red">${esc(b.label)}</span>`;
      }).join(" ") || `<span class="badge teal">可交付</span>`;
      return `<tr>
        <td>${esc(p.partId)}</td><td>${esc(p.name)}</td>
        <td>${esc(p.batchNo)}</td><td>${esc(p.opNo)}</td>
        <td>${esc(p.opStatus)}</td>
        <td>${p.dryUntil ? esc(p.dryUntil) : "—"}${p.dryReady ? " ✓" : ""}</td>
        <td>${p.assemblyClosed ? "已合拢" : `<span class="badge red">未合拢</span>`}</td>
        <td>${blockers}</td>
        <td>${batch ? esc(batch.code) : `<span class="badge amber">待重排</span>`}</td>
      </tr>`;
    }).join("") || `<tr><td colspan="9" class="empty">暂无部件</td></tr>`;
  }

  function renderDefects() {
    document.getElementById("defectRows").innerHTML = state.defects.map(function (d) {
      return `<tr>
        <td>${esc(d.defectId)}</td><td>${esc(d.partId || "—")}</td>
        <td>${esc(d.batchNo)}</td><td>${esc(d.opNo)}</td>
        <td>${esc(d.desc)}</td>
        <td>${d.closed ? `<span class="badge teal">已闭</span>` : `<span class="badge red">未闭</span>`}</td>
        <td class="meta">${shortTime(d.closedAt)}</td>
      </tr>`;
    }).join("") || `<tr><td colspan="7" class="empty">暂无缺陷</td></tr>`;
  }

  function renderBatches() {
    var sorted = state.batches.slice().sort(function (a, b) {
      return (b.createdAt || "").localeCompare(a.createdAt || "");
    });
    document.getElementById("batchRows").innerHTML = sorted.map(function (b) {
      var st = b.status === "active"
        ? `<span class="badge teal">在役</span>`
        : `<span class="badge red">已退回</span>`;
      return `<tr>
        <td>${esc(b.code)}</td><td>${esc(b.planDate)}</td><td>${st}</td>
        <td>${b.partIds.map(esc).join("、") || "—"}</td>
        <td class="meta">${esc(b.returnReason || "")}</td>
        <td class="meta">${shortTime(b.returnedAt)}</td>
      </tr>`;
    }).join("") || `<tr><td colspan="6" class="empty">暂无交付批次</td></tr>`;
  }

  function renderReceipts() {
    var sorted = state.receipts.slice().sort(function (a, b) {
      return (b.receivedAt || "").localeCompare(a.receivedAt || "");
    });
    document.getElementById("receiptRows").innerHTML = sorted.map(function (r) {
      var detail = "";
      if (r.status === "conflict") detail = esc(r.error ? r.error.message : "序号乱到，等待裁决");
      else if (r.status === "failed") detail = esc((r.error && r.error.message) || "处理失败");
      else detail = esc(r.resultSummary || "");
      var acts = "";
      if (r.status === "failed") {
        var providable = r.error && (r.error.code === "op_missing" || r.error.code === "part_missing");
        acts = `<button class="secondary" data-act="retry" data-id="${r.receiptId}">重试</button>` +
          (providable ? `<button class="warn" data-act="provision" data-id="${r.receiptId}">补登缺失并重试</button>` : "");
      }
      return `<tr>
        <td>${esc(r.receiptId)}${r.duplicateCount ? ` <span class="badge gray">重发×${r.duplicateCount}</span>` : ""}</td>
        <td>${esc(r.batchNo)}</td><td>${esc(r.opNo)}</td><td>${esc(r.seq)}</td>
        <td><span class="${STATUS_CLS[r.status] || "badge"}">${STATUS_LABEL[r.status] || r.status}</span></td>
        <td class="meta">${r.attempts || 0}</td>
        <td class="meta">${detail}</td>
        <td class="acts">${acts}</td>
      </tr>`;
    }).join("") || `<tr><td colspan="8" class="empty">尚未收到回执包</td></tr>`;
  }

  function renderLogs() {
    document.getElementById("logList").innerHTML = state.logs.slice(0, 30).map(function (l) {
      return `<li><span class="meta">${shortTime(l.at)}</span> ${esc(l.message)}</li>`;
    }).join("");
  }

  document.addEventListener("DOMContentLoaded", function () {
    // 作品看板与合并台都只依赖 store；两者互不包含对方的规则
    window.initWorksApp(store);
    boot();

    document.querySelectorAll(".tab").forEach(function (tab) {
      tab.addEventListener("click", function () {
        document.querySelectorAll(".tab").forEach(function (t) { t.classList.remove("active"); });
        document.querySelectorAll(".page").forEach(function (p) { p.classList.remove("active"); });
        tab.classList.add("active");
        document.getElementById(tab.dataset.page).classList.add("active");
      });
    });
  });
})();
