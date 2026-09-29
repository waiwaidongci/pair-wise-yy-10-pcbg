/*
 * 判定层（Judge）
 * 纯业务逻辑：合并规则、冲突检测、重算、退回判定、重试。
 * 不接触 DOM、不读写 localStorage；输入 state，输出新 state 与报告。
 * 存储见 storage.js，页面见 ui.js。
 */
(function () {
  "use strict";

  var BATCH = {
    PENDING: "待接收",
    RECEIVED: "已接收",
    RETURNED: "已退回",
    DONE: "已完成"
  };

  function now() { return new Date().toISOString(); }
  function todayStr() { return new Date().toISOString().slice(0, 10); }

  function deepEqual(a, b) {
    return JSON.stringify(a) === JSON.stringify(b);
  }

  function findBatch(state, batchNo) {
    for (var i = 0; i < state.batches.length; i++) {
      if (state.batches[i].batchNo === batchNo) return state.batches[i];
    }
    return null;
  }
  function findComponent(batch, componentId) {
    for (var i = 0; i < batch.components.length; i++) {
      if (batch.components[i].componentId === componentId) return batch.components[i];
    }
    return null;
  }
  function findOperation(comp, operationNo) {
    for (var i = 0; i < comp.operations.length; i++) {
      if (comp.operations[i].operationNo === operationNo) return comp.operations[i];
    }
    return null;
  }
  function findDefect(batch, defectId) {
    for (var i = 0; i < batch.defects.length; i++) {
      if (batch.defects[i].defectId === defectId) return batch.defects[i];
    }
    return null;
  }

  function newReport(pkg) {
    return {
      packageId: (pkg && pkg.packageId) || null,
      applied: [],
      duplicates: [],
      conflicts: [],
      failed: [],
      returned: [],
      received: [],
      affectedBatches: []
    };
  }

  function failReceipt(state, report, kind, receipt, error) {
    report.failed.push({ receiptNo: receipt.receiptNo, error: error });
    state.retryQueue.push({
      kind: kind, // "process" | "defect"
      receipt: receipt,
      error: error,
      retryCount: 0,
      firstFailedAt: now(),
      lastTriedAt: now()
    });
  }

  /* ---- 部件工序回执：按批次号 + 操作号合并 ---- */
  function applyProcessReceipt(state, receipt, report) {
    var rn = receipt.receiptNo;
    if (state.ledger[rn]) {
      // 同号回执只收一次
      report.duplicates.push({ receiptNo: rn, reason: "同号回执已处理，跳过" });
      return;
    }
    if (receipt.value === undefined || receipt.value === null) {
      failReceipt(state, report, "process", receipt, "回执缺少 value");
      return;
    }
    var batch = findBatch(state, receipt.batchNo);
    if (!batch) { failReceipt(state, report, "process", receipt, "批次不存在：" + receipt.batchNo); return; }
    var comp = findComponent(batch, receipt.componentId);
    if (!comp) { failReceipt(state, report, "process", receipt, "部件不存在：" + receipt.componentId); return; }
    var op = findOperation(comp, receipt.operationNo);
    if (!op) { failReceipt(state, report, "process", receipt, "工序不存在：" + receipt.operationNo); return; }

    var localValue = op.value;
    var workshopValue = receipt.value;
    var lastSeq = op.lastSeq || 0;
    var outOfOrder = (typeof receipt.seq === "number") && (receipt.seq <= lastSeq);
    var bothChanged = (localValue !== null && localValue !== undefined) &&
                      (workshopValue !== null && workshopValue !== undefined) &&
                      !deepEqual(localValue, workshopValue);

    if (outOfOrder || bothChanged) {
      // 冲突：保留工坊值、本地值与处理结果，不悄悄覆盖
      state.conflicts.push({
        conflictId: "CF-" + rn,
        batchNo: batch.batchNo,
        componentId: comp.componentId,
        operationNo: op.operationNo,
        receiptNo: rn,
        seq: receipt.seq,
        workshopValue: workshopValue,
        localValue: localValue,
        result: op.result, // 处理结果保留
        reason: outOfOrder
          ? "序号乱到（回执序号 " + receipt.seq + " 不大于已应用序号 " + lastSeq + "）"
          : "工坊值与本地值不一致，双方均有改动",
        detectedAt: now(),
        resolved: false
      });
      report.conflicts.push({ receiptNo: rn, reason: outOfOrder ? "序号乱到" : "双方改动" });
      // 同号只收一次：标记已处理（冲突已记录），但不覆盖工序值
      state.ledger[rn] = { receiptNo: rn, batchNo: batch.batchNo, kind: "process", result: "conflict", processedAt: now() };
      return;
    }

    // 正常应用工坊值
    op.value = workshopValue;
    if (receipt.result !== undefined) op.result = receipt.result;
    if (receipt.status !== undefined) op.status = receipt.status;
    if (typeof receipt.seq === "number") op.lastSeq = receipt.seq;
    op.logs = op.logs || [];
    op.logs.push(now() + " 应用回执 " + rn + "（工坊值）");
    state.ledger[rn] = { receiptNo: rn, batchNo: batch.batchNo, kind: "process", result: "applied", processedAt: now() };
    report.applied.push({ receiptNo: rn, batchNo: batch.batchNo, componentId: comp.componentId, operationNo: op.operationNo });
    if (report.affectedBatches.indexOf(batch.batchNo) === -1) report.affectedBatches.push(batch.batchNo);
  }

  /* ---- 缺陷回执 ---- */
  function applyDefectReceipt(state, receipt, report) {
    var rn = receipt.receiptNo;
    if (state.ledger[rn]) {
      report.duplicates.push({ receiptNo: rn, reason: "同号回执已处理，跳过" });
      return;
    }
    var batch = findBatch(state, receipt.batchNo);
    if (!batch) { failReceipt(state, report, "defect", receipt, "批次不存在：" + receipt.batchNo); return; }
    var defect = findDefect(batch, receipt.defectId);
    if (!defect) { failReceipt(state, report, "defect", receipt, "缺陷不存在：" + receipt.defectId); return; }

    var lastSeq = defect.lastSeq || 0;
    var outOfOrder = (typeof receipt.seq === "number") && (receipt.seq <= lastSeq);
    if (outOfOrder) {
      state.conflicts.push({
        conflictId: "CF-" + rn,
        batchNo: batch.batchNo,
        defectId: defect.defectId,
        receiptNo: rn,
        seq: receipt.seq,
        workshopValue: { closed: receipt.closed, result: receipt.result },
        localValue: { closed: defect.closed, result: defect.result },
        result: defect.result,
        reason: "序号乱到（回执序号 " + receipt.seq + " 不大于已应用序号 " + lastSeq + "）",
        detectedAt: now(),
        resolved: false
      });
      report.conflicts.push({ receiptNo: rn, reason: "序号乱到" });
      state.ledger[rn] = { receiptNo: rn, batchNo: batch.batchNo, kind: "defect", result: "conflict", processedAt: now() };
      return;
    }

    defect.closed = !!receipt.closed;
    if (receipt.result !== undefined) defect.result = receipt.result;
    if (typeof receipt.seq === "number") defect.lastSeq = receipt.seq;
    defect.logs = defect.logs || [];
    defect.logs.push(now() + " 应用缺陷回执 " + rn + "（closed=" + defect.closed + "）");
    state.ledger[rn] = { receiptNo: rn, batchNo: batch.batchNo, kind: "defect", result: "applied", processedAt: now() };
    report.applied.push({ receiptNo: rn, batchNo: batch.batchNo, defectId: defect.defectId });
    if (report.affectedBatches.indexOf(batch.batchNo) === -1) report.affectedBatches.push(batch.batchNo);
  }

  /* ---- 重算：部件与交付批次一起重算 ---- */
  function recalcComponent(comp) {
    var ops = comp.operations;
    var done = 0;
    for (var i = 0; i < ops.length; i++) if (ops[i].status === "完成") done++;
    if (ops.length === 0) { comp.status = "未开始"; comp.progress = 0; }
    else if (done === ops.length) { comp.status = "完成"; comp.progress = 100; }
    else if (done > 0) { comp.status = "进行中"; comp.progress = Math.round((done / ops.length) * 100); }
    else { comp.status = "未开始"; comp.progress = 0; }
    return comp;
  }

  function allOperations(batch) {
    var ops = [];
    batch.components.forEach(function (c) { c.operations.forEach(function (o) { ops.push(o); }); });
    return ops;
  }

  function recalcBatch(batch) {
    batch.components.forEach(recalcComponent);
    var total = 0, count = 0;
    batch.components.forEach(function (c) { total += c.progress; count++; });
    batch.progress = count ? Math.round(total / count) : 0;
    return batch;
  }

  /* ---- 退回判定：未闭缺陷 / 阴干未到 / 合拢未完成 ---- */
  function evaluateBatch(batch, report) {
    var reasons = [];
    var unclosed = batch.defects.filter(function (d) { return !d.closed; });
    if (unclosed.length) {
      reasons.push("未闭缺陷（" + unclosed.length + "）：" + unclosed.map(function (d) { return d.defectId; }).join("、"));
    }
    var ops = allOperations(batch);
    var dryingOps = ops.filter(function (o) { return o.name === "阴干"; });
    var dryingNotReached = dryingOps.some(function (o) { return o.status !== "完成"; }) ||
      (batch.dryDate && batch.dryDate > todayStr());
    if (dryingNotReached) reasons.push("阴干未到");
    var closingOps = ops.filter(function (o) { return o.name === "合拢"; });
    var closingIncomplete = closingOps.length > 0 && closingOps.some(function (o) { return o.status !== "完成"; });
    if (closingIncomplete) reasons.push("合拢未完成");

    if (reasons.length) {
      batch.status = BATCH.RETURNED;
      batch.returnReasons = reasons;
      batch.returnedAt = now();
      report.returned.push({ batchNo: batch.batchNo, reasons: reasons });
    } else {
      batch.returnReasons = [];
      var allDone = batch.components.every(function (c) { return c.status === "完成"; });
      if (allDone) {
        batch.status = BATCH.DONE;
      } else if (batch.status === BATCH.PENDING || batch.status === BATCH.RETURNED) {
        batch.status = BATCH.RECEIVED;
      }
      report.received.push({ batchNo: batch.batchNo, status: batch.status });
    }
  }

  /* ---- 合并一个回执包 ---- */
  function mergePackage(state, pkg) {
    state = state || window.Outsource.Storage.defaultState();
    var report = newReport(pkg);

    state.packages.push({
      packageId: pkg.packageId,
      source: pkg.source || "workshop",
      receivedAt: now(),
      processCount: (pkg.processReceipts || []).length,
      defectCount: (pkg.defectReceipts || []).length
    });

    (pkg.processReceipts || []).forEach(function (r) { applyProcessReceipt(state, r, report); });
    (pkg.defectReceipts || []).forEach(function (r) { applyDefectReceipt(state, r, report); });

    // 工序改动后，部件和交付批次一起重算
    report.affectedBatches.forEach(function (bn) {
      var batch = findBatch(state, bn);
      if (batch) {
        recalcBatch(batch);
        evaluateBatch(batch, report);
      }
    });

    // 断点续传检查点
    state.checkpoint = {
      lastPackageId: pkg.packageId,
      lastReceiptIndex: (pkg.processReceipts || []).length + (pkg.defectReceipts || []).length - 1,
      updatedAt: now()
    };

    return { state: state, report: report };
  }

  /* ---- 重试失败回执 ---- */
  function retryFailed(state) {
    state = state || window.Outsource.Storage.defaultState();
    var report = { retried: [], stillFailed: [] };
    var remaining = [];

    state.retryQueue.forEach(function (item) {
      var sub = { applied: [], duplicates: [], conflicts: [], failed: [], affectedBatches: [] };
      if (item.kind === "defect") applyDefectReceipt(state, item.receipt, sub);
      else applyProcessReceipt(state, item.receipt, sub);

      if (sub.failed.length || sub.conflicts.length) {
        item.retryCount += 1;
        item.error = sub.failed.length ? sub.failed[0].error : "重试后仍冲突";
        item.lastTriedAt = now();
        remaining.push(item);
        report.stillFailed.push({ receiptNo: item.receipt.receiptNo, error: item.error, retryCount: item.retryCount });
      } else {
        report.retried.push({ receiptNo: item.receipt.receiptNo });
        sub.affectedBatches.forEach(function (bn) {
          var batch = findBatch(state, bn);
          if (batch) { recalcBatch(batch); evaluateBatch(batch, { returned: [], received: [] }); }
        });
      }
    });

    state.retryQueue = remaining;
    return { state: state, report: report };
  }

  window.Outsource = window.Outsource || {};
  window.Outsource.Judge = {
    BATCH: BATCH,
    mergePackage: mergePackage,
    retryFailed: retryFailed,
    recalcBatch: recalcBatch,
    recalcComponent: recalcComponent,
    evaluateBatch: evaluateBatch
  };
})();
