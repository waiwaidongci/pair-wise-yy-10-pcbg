/*
 * 页面层（UI）
 * 只负责渲染与事件绑定：从存储层读状态、调判定层处理、再写回存储层。
 * 不含业务判定规则，不含 localStorage 细节（通过 Storage 访问）。
 */
(function () {
  "use strict";

  var Storage = window.Outsource.Storage;
  var Judge = window.Outsource.Judge;

  var state = Storage.load();

  function save() { Storage.save(state); }

  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function fmtValue(v) {
    if (v === null || v === undefined) return "<span class='empty'>—</span>";
    if (typeof v === "object") return "<code>" + esc(JSON.stringify(v)) + "</code>";
    return esc(v);
  }

  /* ---- 演示数据 ---- */
  function demoBatch() {
    return {
      batchNo: "B-2026-001",
      deliveryDate: "2026-07-15",
      dryDate: "2026-06-20",
      status: Judge.BATCH.PENDING,
      components: [
        {
          componentId: "C1", name: "盖", status: "未开始", progress: 0,
          operations: [
            { operationNo: 10, name: "贴线", seq: 1, status: "完成", value: { line: "细线", progress: 100 }, result: "贴线完成", lastSeq: 1, logs: [] },
            { operationNo: 20, name: "阴干", seq: 2, status: "完成", value: { dryDate: "2026-06-20" }, result: "阴干到位", lastSeq: 2, logs: [] },
            { operationNo: 30, name: "上金粉", seq: 3, status: "进行中", value: null, result: null, lastSeq: 0, logs: [] },
            { operationNo: 40, name: "合拢", seq: 4, status: "未开始", value: null, result: null, lastSeq: 0, logs: [] }
          ]
        },
        {
          componentId: "C2", name: "身", status: "未开始", progress: 0,
          operations: [
            { operationNo: 10, name: "贴线", seq: 1, status: "完成", value: { line: "细线", progress: 100 }, result: "贴线完成", lastSeq: 1, logs: [] },
            { operationNo: 20, name: "阴干", seq: 2, status: "完成", value: { dryDate: "2026-06-20" }, result: "阴干到位", lastSeq: 2, logs: [] },
            { operationNo: 30, name: "上金粉", seq: 3, status: "未开始", value: null, result: null, lastSeq: 0, logs: [] },
            { operationNo: 40, name: "合拢", seq: 4, status: "未开始", value: null, result: null, lastSeq: 0, logs: [] }
          ]
        }
      ],
      defects: [
        { defectId: "D1", componentId: "C1", location: "盖右侧断线", closed: false, result: null, lastSeq: 0, logs: [] }
      ],
      returnReasons: [],
      progress: 0,
      logs: []
    };
  }

  function demoPackage1() {
    return {
      packageId: "PKG-DEMO-1",
      source: "workshop",
      processReceipts: [
        { receiptNo: "R-001", batchNo: "B-2026-001", componentId: "C1", operationNo: 30, seq: 4, value: { gold: "已上金粉" }, result: "上金粉完成", status: "完成" },
        { receiptNo: "R-002", batchNo: "B-2026-001", componentId: "C2", operationNo: 10, seq: 1, value: { line: "细线", progress: 100 }, result: "贴线完成", status: "完成" },
        { receiptNo: "R-001", batchNo: "B-2026-001", componentId: "C1", operationNo: 30, seq: 4, value: { gold: "已上金粉" }, result: "上金粉完成", status: "完成" }
      ],
      defectReceipts: [
        { receiptNo: "D-001", batchNo: "B-2026-001", defectId: "D1", componentId: "C1", action: "修复", result: "断线已修复", closed: true, seq: 1 },
        { receiptNo: "R-003", batchNo: "B-9999", componentId: "C1", operationNo: 40, seq: 4, value: { closed: true }, result: "合拢完成", status: "完成" }
      ]
    };
  }

  function demoPackage2() {
    return {
      packageId: "PKG-DEMO-2",
      source: "workshop",
      processReceipts: [
        { receiptNo: "R-004", batchNo: "B-2026-001", componentId: "C1", operationNo: 40, seq: 5, value: { closed: true }, result: "合拢到位", status: "完成" },
        { receiptNo: "R-005", batchNo: "B-2026-001", componentId: "C2", operationNo: 40, seq: 5, value: { closed: true }, result: "合拢到位", status: "完成" }
      ]
    };
  }

  /* ---- 渲染 ---- */
  function statusBadge(s) {
    var cls = "badge";
    if (s === Judge.BATCH.DONE) cls += " badge-done";
    else if (s === Judge.BATCH.RECEIVED) cls += " badge-ok";
    else if (s === Judge.BATCH.RETURNED) cls += " badge-return";
    else cls += " badge-pending";
    return '<span class="' + cls + '">' + esc(s) + "</span>";
  }

  function renderBatches() {
    var el = document.querySelector("#osBatches");
    if (!state.batches.length) {
      el.innerHTML = '<div class="empty">暂无批次，点击「载入演示批次」开始。</div>';
      return;
    }
    el.innerHTML = state.batches.map(function (b) {
      var comps = b.components.map(function (c) {
        var ops = c.operations.map(function (o) {
          return '<li class="op ' + (o.status === "完成" ? "op-done" : "") + '">' +
            '<b>' + esc(o.name) + '</b>（操作号 ' + o.operationNo + '）· ' + esc(o.status) +
            ' · 序号 ' + (o.lastSeq || 0) +
            '<div class="meta">工坊值：' + fmtValue(o.value) + ' · 处理结果：' + (o.result ? esc(o.result) : "—") + '</div>' +
            "</li>";
        }).join("");
        return '<div class="comp"><b>' + esc(c.name) + '</b>（' + esc(c.componentId) + '）· ' + esc(c.status) +
          ' · 进度 ' + c.progress + '%<ul class="ops">' + ops + "</ul></div>";
      }).join("");
      var defects = b.defects.map(function (d) {
        return '<li class="' + (d.closed ? "op-done" : "") + '">' + esc(d.defectId) + " · " + esc(d.location || "") +
          " · " + (d.closed ? "已闭合" : "未闭合") + (d.result ? " · " + esc(d.result) : "") + "</li>";
      }).join("");
      return '<article class="batch ' + (b.status === Judge.BATCH.RETURNED ? "batch-return" : "") + '">' +
        "<div class='batch-head'><b>" + esc(b.batchNo) + "</b> " + statusBadge(b.status) +
        '<span class="meta">交付 ' + esc(b.deliveryDate) + " · 阴干 " + esc(b.dryDate) + " · 总进度 " + b.progress + "%</span></div>" +
        (b.returnReasons && b.returnReasons.length ? '<div class="return-reasons">退回原因：' + b.returnReasons.map(esc).join("；") + "</div>" : "") +
        '<div class="comps">' + comps + "</div>" +
        '<div class="defects"><b>缺陷：</b><ul>' + (defects || "<li>无</li>") + "</ul></div>" +
        "</article>";
    }).join("");
  }

  function renderConflicts() {
    var el = document.querySelector("#osConflicts");
    if (!state.conflicts.length) {
      el.innerHTML = '<div class="empty">暂无冲突。</div>';
      return;
    }
    el.innerHTML = state.conflicts.map(function (cf) {
      return '<div class="conflict">' +
        '<b>' + esc(cf.conflictId) + "</b> · " + esc(cf.batchNo) +
        (cf.componentId ? " · 部件 " + esc(cf.componentId) : "") +
        (cf.operationNo ? " · 操作号 " + esc(cf.operationNo) : "") +
        (cf.defectId ? " · 缺陷 " + esc(cf.defectId) : "") +
        '<div class="meta">原因：' + esc(cf.reason) + "</div>" +
        '<div class="meta">工坊值：' + fmtValue(cf.workshopValue) + "</div>" +
        '<div class="meta">本地值：' + fmtValue(cf.localValue) + "</div>" +
        '<div class="meta">处理结果：' + (cf.result ? esc(cf.result) : "—") + "</div>" +
        '<div class="meta">时间：' + esc(cf.detectedAt) + "</div>" +
        "</div>";
    }).join("");
  }

  function renderRetry() {
    var el = document.querySelector("#osRetry");
    if (!state.retryQueue.length) {
      el.innerHTML = '<div class="empty">暂无失败回执。</div>';
      return;
    }
    el.innerHTML = state.retryQueue.map(function (item) {
      var r = item.receipt;
      return '<div class="retry">' +
        "<b>" + esc(r.receiptNo) + "</b> · " + esc(r.batchNo) +
        (r.componentId ? " · 部件 " + esc(r.componentId) : "") +
        (r.operationNo ? " · 操作号 " + esc(r.operationNo) : "") +
        (r.defectId ? " · 缺陷 " + esc(r.defectId) : "") +
        '<div class="meta">错误：' + esc(item.error) + "</div>" +
        '<div class="meta">已重试 ' + item.retryCount + " 次 · 首次 " + esc(item.firstFailedAt) + "</div>" +
        "</div>";
    }).join("");
  }

  function renderCheckpoint() {
    var el = document.querySelector("#osCheckpoint");
    var cp = state.checkpoint;
    el.innerHTML =
      '<div class="meta">最后处理回执包：<b>' + (cp.lastPackageId ? esc(cp.lastPackageId) : "—") + "</b></div>" +
      '<div class="meta">最后回执序号：' + (cp.lastReceiptIndex >= 0 ? cp.lastReceiptIndex : "—") + "</div>" +
      '<div class="meta">更新时间：' + (cp.updatedAt ? esc(cp.updatedAt) : "—") + "</div>" +
      '<div class="meta">已处理回执（台账）：' + Object.keys(state.ledger).length + ' 条 · 冲突 ' + state.conflicts.length + ' 条 · 待重试 ' + state.retryQueue.length + ' 条</div>' +
      '<div class="meta checkpoint-note">重启后自动从此断点继续，已处理回执不重复应用。</div>';
  }

  function render() {
    renderBatches();
    renderConflicts();
    renderRetry();
    renderCheckpoint();
  }

  function showReport(report) {
    var el = document.querySelector("#osReport");
    var lines = [];
    if (report.applied && report.applied.length) lines.push("已应用 " + report.applied.length + " 条");
    if (report.duplicates && report.duplicates.length) lines.push("重复跳过 " + report.duplicates.length + " 条");
    if (report.conflicts && report.conflicts.length) lines.push("冲突 " + report.conflicts.length + " 条（已保留工坊值/本地值/处理结果）");
    if (report.failed && report.failed.length) lines.push("失败 " + report.failed.length + " 条（已入重试队列）");
    if (report.returned && report.returned.length) lines.push("退回批次 " + report.returned.length + " 个");
    if (report.received && report.received.length) lines.push("接收批次 " + report.received.length + " 个");
    el.innerHTML = lines.length ? lines.map(esc).join(" · ") : "处理完成。";
  }

  /* ---- 事件 ---- */
  function parsePackage() {
    var raw = document.querySelector("#pkgInput").value.trim();
    if (!raw) { alert("请先粘贴回执包 JSON"); return null; }
    try { return JSON.parse(raw); }
    catch (e) { alert("回执包 JSON 解析失败：" + e.message); return null; }
  }

  function onProcess() {
    var pkg = parsePackage();
    if (!pkg) return;
    var result = Judge.mergePackage(state, pkg);
    state = result.state;
    save();
    render();
    showReport(result.report);
  }

  function onRetry() {
    if (!state.retryQueue.length) { alert("重试队列为空"); return; }
    var result = Judge.retryFailed(state);
    state = result.state;
    save();
    render();
    var el = document.querySelector("#osReport");
    el.innerHTML = "重试成功 " + result.report.retried.length + " 条 · 仍失败 " + result.report.stillFailed.length + " 条";
  }

  function onExport() {
    var payload = {
      exportedAt: new Date().toISOString(),
      checkpoint: state.checkpoint,
      batches: state.batches,
      conflicts: state.conflicts,
      retryQueue: state.retryQueue,
      ledger: state.ledger,
      packages: state.packages
    };
    var blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    var link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = "outsource-state.json";
    link.click();
    URL.revokeObjectURL(link.href);
  }

  function onSeedDemo() {
    var exists = state.batches.some(function (b) { return b.batchNo === "B-2026-001"; });
    if (!exists) {
      var batch = demoBatch();
      Judge.recalcBatch(batch);
      state.batches.push(batch);
      save();
    }
    document.querySelector("#pkgInput").value = JSON.stringify(demoPackage1(), null, 2);
    render();
    document.querySelector("#osReport").innerHTML = "已载入演示批次与 PKG-DEMO-1，点击「处理回执包」。";
  }

  function onLoadClosing() {
    document.querySelector("#pkgInput").value = JSON.stringify(demoPackage2(), null, 2);
    document.querySelector("#osReport").innerHTML = "已载入收尾包 PKG-DEMO-2（合拢完成），点击「处理回执包」。";
  }

  function onReset() {
    if (!confirm("确定清空所有外发合并状态？")) return;
    Storage.reset();
    state = Storage.load();
    document.querySelector("#pkgInput").value = "";
    render();
    document.querySelector("#osReport").innerHTML = "已重置。";
  }

  function bind() {
    document.querySelector("#processPkg").addEventListener("click", onProcess);
    document.querySelector("#retryFailed").addEventListener("click", onRetry);
    document.querySelector("#exportState").addEventListener("click", onExport);
    document.querySelector("#seedDemo").addEventListener("click", onSeedDemo);
    document.querySelector("#loadClosing").addEventListener("click", onLoadClosing);
    document.querySelector("#resetOs").addEventListener("click", onReset);
  }

  document.addEventListener("DOMContentLoaded", function () {
    bind();
    render();
  });

  window.Outsource = window.Outsource || {};
  window.Outsource.UI = { render: render };
})();
