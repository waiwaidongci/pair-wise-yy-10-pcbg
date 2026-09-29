/* 判定层（纯逻辑）：
 * - 按 批次号 + 操作号 合并部件工序包，缺陷回执按批次+操作定位
 * - 序号乱到 → 冲突挂起，同时保留 工坊值 / 本地值(回执) / 处理结果，绝不覆盖
 * - 同号回执全局只收一次（幂等）
 * - 工序改动后先重算部件，再重算交付批次（未闭缺陷 / 阴干未到 / 合拢未完成 → 退回原交付批次）
 * - 失败可重试；重启后从断点继续
 * 本文件不依赖 DOM 与 localStorage，state 全部由调用方传入，便于测试与复用。 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.Domain = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  /* ---------- 常量与工具 ---------- */

  var STATUS = {
    QUEUED: "queued",       // 已入队，待处理
    APPLIED: "applied",     // 已合并成功
    CONFLICT: "conflict",   // 序号冲突，挂起待裁决
    FAILED: "failed",       // 处理失败，可重试
    DUPLICATE: "duplicate"  // 同号回执重复送达，只登记不处理
  };

  // 部件是否具备交付条件：未闭缺陷 / 阴干未到 / 合拢未完成 任一成立即不可交付
  var BLOCKERS = [
    { code: "open_defect", test: function (c) { return c.openDefects > 0; }, label: "存在未闭缺陷" },
    { code: "dry_not_ready", test: function (c) { return !c.dryReady; }, label: "阴干未到" },
    { code: "assembly_open", test: function (c) { return !c.assemblyClosed; }, label: "合拢未完成" }
  ];

  function uid(prefix) {
    var rnd = (typeof crypto !== "undefined" && crypto.randomUUID)
      ? crypto.randomUUID()
      : "id-" + Math.random().toString(16).slice(2) + Date.now().toString(16);
    return (prefix || "") + rnd;
  }

  function clone(v) { return JSON.parse(JSON.stringify(v)); }

  function nowIso(clock) {
    return new Date((clock && clock.now) ? clock.now() : Date.now()).toISOString();
  }

  function pad(n) { return n < 10 ? "0" + n : String(n); }

  function ymd(d) {
    if (typeof d === "string") return d; // 已是 YYYY-MM-DD
    return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
  }

  function addDays(dateStr, days) {
    var d = dateStr ? new Date(dateStr + "T00:00:00") : new Date();
    d.setDate(d.getDate() + days);
    return ymd(d);
  }

  function DomainError(code, message, extra) {
    var e = new Error(message);
    e.code = code;
    e.extra = extra || {};
    return e;
  }

  function addLog(state, message, clock) {
    state.logs.unshift({ at: nowIso(clock), message: message });
    if (state.logs.length > 200) state.logs.length = 200;
  }

  function opKey(batchNo, opNo) { return batchNo + "::" + opNo; }
  function findOp(state, batchNo, opNo) {
    return state.operations.find(function (o) { return o.batchNo === batchNo && o.opNo === opNo; });
  }
  function findPart(state, partId) { return state.parts.find(function (p) { return p.partId === partId; }); }
  function findReceipt(state, receiptId) {
    return state.receipts.find(function (r) { return r.receiptId === receiptId; });
  }
  function findDefect(state, batchNo, opNo, defectId) {
    return state.defects.find(function (d) {
      return d.defectId === defectId && d.batchNo === batchNo && d.opNo === opNo;
    });
  }
  function sortedPartsOfOp(state, batchNo, opNo) {
    return state.parts
      .filter(function (p) { return p.batchNo === batchNo && p.opNo === opNo; })
      .sort(function (a, b) { return a.partId.localeCompare(b.partId); });
  }
  function currentSeqFor(state, batchNo, opNo) {
    var parts = sortedPartsOfOp(state, batchNo, opNo);
    if (!parts.length) return 0;
    return parts.reduce(function (m, p) { return Math.max(m, p.seq); }, 0);
  }

  // 工序的回执序号游标：优先用显式 lastSeq（每并一条回执推进），
  // 老台账/初始主数据没有 lastSeq 时，从部件序号兜底推导
  function opCursor(state, batchNo, opNo) {
    var op = findOp(state, batchNo, opNo);
    if (!op) return 0;
    if (op.lastSeq != null) return op.lastSeq;
    return currentSeqFor(state, batchNo, opNo);
  }

  // 部件未闭缺陷数（缺陷以部件为载体登记）
  function partOpenDefects(state, partId) {
    var part = findPart(state, partId);
    if (!part) return 0;
    return state.defects.filter(function (d) {
      return d.partId === partId && d.batchNo === part.batchNo && d.opNo === part.opNo && !d.closed;
    }).length;
  }

  // 重算派生量：未闭缺陷数、阴干是否到期、阻碍交付原因列表
  function recomputePartReadiness(part, state, clock) {
    var today = ymd(new Date(clock && clock.now ? clock.now() : Date.now()));
    part.openDefects = partOpenDefects(state, part.partId);
    part.dryReady = !part.dryUntil || part.dryUntil <= today;
    part.blockers = BLOCKERS
      .filter(function (b) { return b.test(part); })
      .map(function (b) { return { code: b.code, label: b.label }; });
    return part;
  }

  /* ---------- 初始状态 ---------- */

  function createState(clock) {
    return {
      version: 1,
      operations: [],
      parts: [],
      defects: [],
      batches: [],        // 交付批次
      receipts: [],
      conflicts: [],
      checkpoint: { lastProcessedIndex: -1, updatedAt: null },
      logs: [{ at: nowIso(clock), message: "初始化合并台账" }]
    };
  }

  /* ---------- 主数据维护（页面登记补单用） ---------- */

  function putOperation(state, input) {
    var op = findOp(state, input.batchNo, input.opNo);
    if (op) {
      op.name = input.name != null ? input.name : op.name;
      op.status = input.status != null ? input.status : op.status;
      if (input.lastSeq != null) op.lastSeq = input.lastSeq;
      op.updatedAt = new Date().toISOString();
      return op;
    }
    op = {
      batchNo: input.batchNo,
      opNo: input.opNo,
      name: input.name || "",
      status: input.status || "待开工",
      lastSeq: input.lastSeq != null ? input.lastSeq : null,
      source: "workshop",
      updatedAt: new Date().toISOString()
    };
    state.operations.push(op);
    return op;
  }

  function putPart(state, input, clock) {
    var part = findPart(state, input.partId);
    if (!part) {
      part = {
        partId: input.partId,
        name: input.name || input.partId,
        batchNo: input.batchNo,
        opNo: input.opNo,
        seq: input.seq != null ? input.seq : currentSeqFor(state, input.batchNo, input.opNo) + 1,
        opStatus: input.opStatus || "待开工",
        dryUntil: input.dryUntil || null,
        assemblyClosed: !!input.assemblyClosed,
        deliveryBatchId: input.deliveryBatchId || null,
        updatedAt: null
      };
      state.parts.push(part);
    }
    if (input.name != null) part.name = input.name;
    if (input.seq != null) part.seq = input.seq;
    if (input.opStatus != null) part.opStatus = input.opStatus;
    if (input.dryUntil !== undefined) part.dryUntil = input.dryUntil;
    if (input.assemblyClosed !== undefined) part.assemblyClosed = !!input.assemblyClosed;
    if (input.deliveryBatchId !== undefined) part.deliveryBatchId = input.deliveryBatchId;
    part.updatedAt = nowIso(clock);
    recomputePartReadiness(part, state, clock);
    return part;
  }

  function putDefect(state, input) {
    var d = findDefect(state, input.batchNo, input.opNo, input.defectId);
    if (!d) {
      d = {
        defectId: input.defectId,
        partId: input.partId || null,
        batchNo: input.batchNo,
        opNo: input.opNo,
        desc: input.desc || "",
        severity: input.severity || "一般",
        closed: !!input.closed,
        closedAt: input.closedAt || null,
        updatedAt: new Date().toISOString()
      };
      state.defects.push(d);
    }
    if (input.desc != null) d.desc = input.desc;
    if (input.severity != null) d.severity = input.severity;
    if (input.partId != null) d.partId = input.partId;
    if (input.closed != null) {
      d.closed = !!input.closed;
      d.closedAt = input.closed ? (input.closedAt || new Date().toISOString()) : null;
    }
    d.updatedAt = new Date().toISOString();
    return d;
  }

  /* ---------- 交付批次重算 ----------
   * 工序改动后：先逐个部件重算阻碍项；有阻碍的部件从交付批次摘出，
   * 整批被摘空/含受阻部件时原交付批次退回（returned，记录退回原因），
   * 受阻部件落回 pendingParts 等待下次重新成批。 */

  function regroupDeliveries(state, reason, clock, options) {
    // rejoinReady=true 时，无阻碍的待排部件立即重新成批；
    // 工序改动触发的重算默认 false：整批退回后留在“待重排”，不悄悄换批
    var rejoinReady = !!(options && options.rejoinReady);
    var affectedBatchIds = {};

    // 1) 全部部件重算交付阻碍
    state.parts.forEach(function (part) { recomputePartReadiness(part, state, clock); });

    // 2) 受阻部件：记录原因并从所在交付批次摘出（原批次退回）
    state.parts.forEach(function (part) {
      if (part.blockers.length) {
        if (part.deliveryBatchId) {
          affectedBatchIds[part.deliveryBatchId] =
            (affectedBatchIds[part.deliveryBatchId] || []).concat(part.blockers.map(function (b) { return b.label; }));
        }
        part.returnReason = part.blockers.map(function (b) { return b.label; }).join("、");
        part.deliveryBatchId = null;
      } else {
        part.returnReason = null;
      }
    });

    // 3) 被摘过部件的原交付批次整体退回（未交付批次不允许静默留存半成品）
    state.batches.forEach(function (batch) {
      if (affectedBatchIds[batch.batchId] && batch.status === "active") {
        var why = affectedBatchIds[batch.batchId].filter(function (v, i, arr) {
          return arr.indexOf(v) === i;
        }).join("、");
        batch.status = "returned";
        batch.returnedAt = nowIso(clock);
        batch.returnReason = (reason || "工序改动后重算") + "：" + why;
        // 批内其余（当时合格的）部件一并退回待重排，保证“整批退回”
        state.parts.forEach(function (part) {
          if (part.deliveryBatchId === batch.batchId) {
            part.deliveryBatchId = null;
            part.returnReason = part.returnReason || ("原批次退回（" + batch.code + "），待重排");
          }
        });
        addLog(state, "交付批次 " + batch.code + " 退回：" + batch.returnReason, clock);
      }
    });

    // 4) 仅在显式重排时，合格且待排的部件重新成批
    if (rejoinReady) {
      state.parts
        .filter(function (p) { return !p.blockers.length && !p.deliveryBatchId; })
        .sort(function (a, b) {
          return (a.planDelivery || "") < (b.planDelivery || "") ? -1
            : (a.planDelivery || "") > (b.planDelivery || "") ? 1
            : a.partId.localeCompare(b.partId);
        })
        .forEach(function (part) {
          var day = part.planDelivery || ymd(new Date(clock && clock.now ? clock.now() : Date.now()));
          var target = state.batches.find(function (b) {
            return b.status === "active" && b.planDate === day;
          });
          if (!target) {
            var seq = state.batches.filter(function (b) { return b.planDate === day; }).length + 1;
            target = {
              batchId: uid("db_"),
              code: "DLV-" + day.replace(/-/g, "") + "-" + pad(seq),
              planDate: day,
              status: "active",
              partIds: [],
              createdAt: nowIso(clock),
              returnReason: null
            };
            state.batches.push(target);
            addLog(state, "新建交付批次 " + target.code, clock);
          }
          target.partIds.push(part.partId);
          part.deliveryBatchId = target.batchId;
          part.returnReason = null;
        });
    }

    // 5) 同步每批部件快照数量
    state.batches.forEach(function (batch) {
      batch.partIds = state.parts
        .filter(function (p) { return p.deliveryBatchId === batch.batchId; })
        .map(function (p) { return p.partId; });
    });
  }

  // 显式重排：把无阻碍的待排部件重新组成交付批次（人工/定时触发，与“退回”分开）
  function rejoinPending(state, clock) {
    var next = clone(state);
    next.parts.forEach(function (part) { recomputePartReadiness(part, next, clock); });
    regroupDeliveries(next, "人工重排待交付部件", clock, { rejoinReady: true });
    var count = pendingParts(next).length;
    addLog(next, "执行交付重排，剩余待排 " + count + " 件", clock);
    return next;
  }

  /* ---------- 回执内容应用（序号校验通过后调用） ---------- */

  function normalizePayload(raw) {
    var p = raw || {};
    return {
      opStatus: p.opStatus,
      parts: Array.isArray(p.parts) ? p.parts : [],
      defects: Array.isArray(p.defects) ? p.defects : []
    };
  }

  // 应用回执到一份 state（调用方保证传入的是草稿副本）
  function applyReceiptContent(draft, r, clock) {
    var p = normalizePayload(r.payload);
    var changes = [];

    if (p.opStatus) {
      var op = findOp(draft, r.batchNo, r.opNo);
      if (!op) throw DomainError("op_missing", "找不到工序 " + r.batchNo + "/" + r.opNo, { retryable: true });
      if (op.status !== p.opStatus) changes.push("工序 " + op.status + "→" + p.opStatus);
      op.status = p.opStatus;
      op.source = "tablet";
      op.updatedAt = nowIso(clock);
    }

    p.parts.forEach(function (incoming) {
      if (!incoming.partId) throw DomainError("bad_payload", "回执缺少部件号 partId");
      var part = findPart(draft, incoming.partId);
      if (!part) {
        throw DomainError("part_missing", "找不到部件 " + incoming.partId, {
          retryable: true, partId: incoming.partId
        });
      }
      var before = clone(part);
      if (incoming.name != null) part.name = incoming.name;
      if (incoming.opStatus != null) part.opStatus = incoming.opStatus;
      if (incoming.dryUntil !== undefined) part.dryUntil = incoming.dryUntil || null;
      if (incoming.assemblyClosed !== undefined) part.assemblyClosed = !!incoming.assemblyClosed;
      if (incoming.planDelivery !== undefined) part.planDelivery = incoming.planDelivery || null;
      // 注意：不把回执序号写进部件序号——序号是工序级回执游标，部件顺序归主数据管
      part.source = "tablet";
      part.updatedAt = nowIso(clock);
      recomputePartReadiness(part, draft, clock);
      ["opStatus", "dryUntil", "assemblyClosed", "planDelivery"].forEach(function (f) {
        if (incoming[f] !== undefined && before[f] !== part[f]) {
          changes.push(part.partId + "." + f + ": " + before[f] + "→" + part[f]);
        }
      });
    });

    p.defects.forEach(function (incoming) {
      var id = incoming.defectId || uid("df_");
      var existing = findDefect(draft, r.batchNo, r.opNo, id);
      if (!existing) {
        putDefect(draft, {
          defectId: id,
          partId: incoming.partId || null,
          batchNo: r.batchNo,
          opNo: r.opNo,
          desc: incoming.desc || "",
          severity: incoming.severity || "一般",
          closed: !!incoming.closed
        });
        changes.push("登记缺陷 " + id);
      } else {
        var wasClosed = existing.closed;
        putDefect(draft, Object.assign({ defectId: id, batchNo: r.batchNo, opNo: r.opNo }, incoming));
        if (!wasClosed && incoming.closed) changes.push("缺陷关闭 " + id);
      }
    });

    return changes;
  }

  /* ---------- 单条回执处理（核心入口，纯函数式：返回新 state） ---------- */

  function validateReceiptShape(raw) {
    if (!raw || typeof raw !== "object") throw DomainError("bad_payload", "回执不是对象");
    ["id", "batchNo", "opNo", "seq"].forEach(function (f) {
      if (raw[f] == null || raw[f] === "") throw DomainError("bad_payload", "回执缺少字段 " + f);
    });
    if (typeof raw.seq !== "number" || raw.seq <= 0) throw DomainError("bad_payload", "回执 seq 必须是正整数");
  }

  // 处理一条已入队回执。返回 {state, receipt, conflict}
  function processReceipt(state, receiptId, clock) {
    var next = clone(state);
    var r = findReceipt(next, receiptId);
    if (!r) throw DomainError("receipt_missing", "回执不存在：" + receiptId);

    // 幂等：已成功/已判重的不再执行
    if (r.status === STATUS.APPLIED || r.status === STATUS.DUPLICATE) {
      return { state: next, receipt: r, conflict: null, skipped: true };
    }

    var op = findOp(next, r.batchNo, r.opNo);
    var expected = opCursor(next, r.batchNo, r.opNo);

    // 序号乱到：期望收到 expected+1，实际不是 → 挂起冲突，保留三值，绝不覆盖
    // 例外：冲突已被人工裁决为“采用本地值”（forceSeq），跳过校验强制并入
    var want = expected + 1;
    if (r.seq !== want && !r.forceSeq) {
      var conflict = next.conflicts.find(function (c) { return c.receiptId === r.receiptId && c.resolution === null; });
      if (!conflict) {
        conflict = {
          conflictId: uid("cf_"),
          receiptId: r.receiptId,
          batchNo: r.batchNo,
          opNo: r.opNo,
          field: "seq",
          workshopValue: want,       // 工坊当前应有序号
          localValue: r.seq,         // 平板（本地）带来的序号
          result: "挂起：序号乱到，等待人工裁决", // 处理结果
          resolution: null,          // null | workshop | local
          detectedAt: nowIso(clock),
          resolvedAt: null
        };
        next.conflicts.push(conflict);
        addLog(next, "序号冲突 批次" + r.batchNo + " 操作" + r.opNo +
          "：工坊期望 " + want + "，回执为 " + r.seq + "，已挂起", clock);
      }
      r.status = STATUS.CONFLICT;
      r.updatedAt = nowIso(clock);
      bumpCheckpoint(next, clock);
      return { state: next, receipt: r, conflict: conflict };
    }

    // 序号正确：在草稿上应用，再整体重算部件与交付批次
    try {
      var changes = applyReceiptContent(next, r, clock);
      regroupDeliveries(next, "工序 " + r.batchNo + "/" + r.opNo + " 改动后重算", clock);
      var appliedOp = findOp(next, r.batchNo, r.opNo);
      if (appliedOp) appliedOp.lastSeq = r.seq; // 推进工序序号游标
      r.status = STATUS.APPLIED;
      r.appliedAt = nowIso(clock);
      r.updatedAt = r.appliedAt;
      r.error = null;
      r.attempts = (r.attempts || 0) + 1;
      r.resultSummary = changes.length ? changes.join("；") : "无字段变化";
      addLog(next, "回执 " + r.receiptId + " 已合并（" + r.resultSummary + "）", clock);
      bumpCheckpoint(next, clock);
      return { state: next, receipt: r, conflict: null };
    } catch (e) {
      r.status = STATUS.FAILED;
      r.error = { code: e.code || "unknown", message: e.message, retryable: e.code !== "bad_payload" };
      r.attempts = (r.attempts || 0) + 1;
      r.updatedAt = nowIso(clock);
      addLog(next, "回执 " + r.receiptId + " 处理失败：" + e.message + "（可重试）", clock);
      bumpCheckpoint(next, clock);
      return { state: next, receipt: r, conflict: null, error: e };
    }
  }

  function bumpCheckpoint(state, clock) {
    var idx = -1;
    state.receipts.forEach(function (r, i) {
      if (r.status === STATUS.APPLIED || r.status === STATUS.DUPLICATE) idx = Math.max(idx, i);
    });
    state.checkpoint.lastProcessedIndex = idx;
    state.checkpoint.updatedAt = nowIso(clock);
  }

  /* ---------- 队列、重启续跑、重试 ---------- */

  function processQueue(state, clock, maxAttempts) {
    var limit = maxAttempts || 5;
    var current = state;
    var touched = [];
    var progressed = true;

    // 反复扫描，直到没有可推进的回执（冲突/失败会自然停住）
    while (progressed) {
      progressed = false;
      var snapshot = current.receipts.slice();
      for (var i = 0; i < snapshot.length; i++) {
        var r = snapshot[i];
        var canRun =
          r.status === STATUS.QUEUED ||
          (r.status === STATUS.FAILED && (r.attempts || 0) < limit);
        if (!canRun) continue;
        var out = processReceipt(current, r.receiptId, clock);
        current = out.state;
        touched.push(out.receipt);
        if (out.receipt.status === STATUS.APPLIED || out.receipt.status === STATUS.DUPLICATE) progressed = true;
      }
    }
    bumpCheckpoint(current, clock);
    return { state: current, touched: touched };
  }

  // 重启后从断点继续：自动重放 queued / 未超限 failed
  function resumeAfterRestart(state, clock, maxAttempts) {
    var next = clone(state);
    addLog(next, "重启恢复：从断点 " + next.checkpoint.lastProcessedIndex + " 继续", clock);
    return processQueue(next, clock, maxAttempts);
  }

  // 手动重试一条失败回执
  function retryReceipt(state, receiptId, clock) {
    var r = findReceipt(state, receiptId);
    if (!r) throw DomainError("receipt_missing", "回执不存在：" + receiptId);
    if (r.status !== STATUS.FAILED) throw DomainError("not_retryable", "仅失败回执可重试，当前状态：" + r.status);
    return processReceipt(state, receiptId, clock);
  }

  /* ---------- 收包：同号回执只收一次 ---------- */

  // 导入一个断网回执包（含多条 receipts）。同号（id）回执全局只登记一次。
  function ingestPackage(state, pkg, clock, autoProcess) {
    if (!pkg || !Array.isArray(pkg.receipts)) {
      throw DomainError("bad_package", "回执包格式错误：缺少 receipts 数组");
    }
    var next = clone(state);
    var accepted = [];
    var knownIds = {};
    next.receipts.forEach(function (r) { knownIds[r.receiptId] = true; });

    pkg.receipts.forEach(function (raw) {
      validateReceiptShape(raw);
      if (knownIds[raw.id]) {
        // 同号只收一次：已存在则忽略，但在原回执上留痕，绝不重复处理
        var exist = findReceipt(next, raw.id);
        exist.duplicateCount = (exist.duplicateCount || 0) + 1;
        exist.lastDuplicateAt = nowIso(clock);
        addLog(next, "同号回执重复送达，已忽略：" + raw.id, clock);
        accepted.push({ receiptId: raw.id, status: STATUS.DUPLICATE });
        return;
      }
      var op = findOp(next, raw.batchNo, raw.opNo);
      var receipt = {
        receiptId: raw.id,
        packageId: pkg.packageId || null,
        batchNo: raw.batchNo,
        opNo: raw.opNo,
        seq: raw.seq,
        payload: raw.payload || {},
        status: STATUS.QUEUED,
        attempts: 0,
        duplicateCount: 0,
        receivedAt: nowIso(clock),
        appliedAt: null,
        error: null,
        resultSummary: null,
        opExisted: !!op
      };
      next.receipts.push(receipt);
      knownIds[raw.id] = true;
      accepted.push({ receiptId: raw.id, status: STATUS.QUEUED });
      addLog(next, "收到回执 " + raw.id + "（批次" + raw.batchNo + " 操作" + raw.opNo + " 序号" + raw.seq + "）", clock);
    });

    if (autoProcess !== false) {
      var out = processQueue(next, clock);
      next = out.state;
    } else {
      bumpCheckpoint(next, clock);
    }
    return { state: next, accepted: accepted };
  }

  /* ---------- 冲突裁决 ---------- */

  // decision: "workshop" 丢弃乱序回执保留工坊值；"local" 采用平板值（强制按该序号并入）
  function resolveConflict(state, conflictId, decision, clock) {
    var next = clone(state);
    var c = next.conflicts.find(function (x) { return x.conflictId === conflictId; });
    if (!c) throw DomainError("conflict_missing", "冲突不存在：" + conflictId);
    if (c.resolution) throw DomainError("already_resolved", "冲突已裁决");
    var r = findReceipt(next, c.receiptId);

    if (decision === "workshop") {
      c.resolution = "workshop";
      c.resolvedAt = nowIso(clock);
      c.result = "保留工坊值 " + c.workshopValue + "，已拒收序号 " + c.localValue + " 的回执";
      r.status = STATUS.APPLIED; // 该回执不作数据变更，标记终态避免重复处理
      r.appliedAt = nowIso(clock);
      r.resultSummary = "冲突裁决：保留工坊值，回执未并入";
      addLog(next, "冲突 " + c.conflictId + " 裁决保留工坊值", clock);
    } else if (decision === "local") {
      // 强制对齐：标记该回执跳过序号校验，直接走正常应用 + 重算流程
      var target = findReceipt(next, c.receiptId);
      target.forceSeq = true;
      target.status = STATUS.QUEUED;
      var out = processReceipt(next, c.receiptId, clock);
      next = out.state;
      var r2 = findReceipt(next, c.receiptId);
      c = next.conflicts.find(function (x) { return x.conflictId === conflictId; });
      if (r2.status === STATUS.APPLIED) {
        c.resolution = "local";
        c.resolvedAt = nowIso(clock);
        c.result = "采用本地（平板）值 " + c.localValue + "，已并入并重算";
        addLog(next, "冲突 " + c.conflictId + " 裁决采用本地值并已重算", clock);
      } else {
        c.result = "采用本地值后处理未通过：" + (r2.error ? r2.error.message : r2.status);
      }
    } else {
      throw DomainError("bad_decision", "裁决取值必须是 workshop 或 local");
    }
    bumpCheckpoint(next, clock);
    return { state: next, conflict: c };
  }

  /* ---------- 失败补登：缺工序/缺部件导致可重试失败时，页面登记后重试 ---------- */

  function provisionMissing(state, receiptId, input, clock) {
    var next = clone(state);
    var r = findReceipt(next, receiptId);
    if (!r) throw DomainError("receipt_missing", "回执不存在：" + receiptId);
    if (r.status !== STATUS.FAILED || !r.error) {
      throw DomainError("not_failed", "仅失败回执可补登");
    }
    if (r.error.code === "op_missing") {
      putOperation(next, {
        batchNo: r.batchNo, opNo: r.opNo,
        name: (input && input.opName) || "补登工序",
        status: (input && input.opStatus) || "待开工",
        lastSeq: 0
      });
      // 为回执内部件补建主数据
      normalizePayload(r.payload).parts.forEach(function (incoming, i) {
        putPart(next, {
          partId: incoming.partId,
          name: incoming.name || incoming.partId,
          batchNo: r.batchNo, opNo: r.opNo,
          seq: i + 1,
          opStatus: "待开工",
          dryUntil: null,
          assemblyClosed: false
        }, clock);
      });
      addLog(next, "已补登工序 " + r.batchNo + "/" + r.opNo + "，等待重试", clock);
    } else if (r.error.code === "part_missing") {
      var pid = r.error.extra && r.error.extra.partId;
      var incomingPart = normalizePayload(r.payload).parts.find(function (x) { return x.partId === pid; });
      var maxSeq = currentSeqFor(next, r.batchNo, r.opNo);
      putPart(next, {
        partId: pid,
        name: (incomingPart && incomingPart.name) || pid,
        batchNo: r.batchNo, opNo: r.opNo,
        seq: maxSeq + 1,
        opStatus: "待开工",
        dryUntil: null,
        assemblyClosed: false
      }, clock);
      addLog(next, "已补登部件 " + pid + "，等待重试", clock);
    } else {
      throw DomainError("not_provisionable", "该失败原因不支持补登：" + r.error.code);
    }
    return next;
  }

  /* ---------- 导出：带冲突与当前状态 ---------- */

  function exportSnapshot(state, clock) {
    return {
      exportedAt: nowIso(clock),
      checkpoint: state.checkpoint,
      currentStatus: {
        operations: state.operations.length,
        parts: state.parts.length,
        partsBlocked: state.parts.filter(function (p) { return p.blockers.length > 0; }).length,
        openDefects: state.defects.filter(function (d) { return !d.closed; }).length,
        activeDeliveryBatches: state.batches.filter(function (b) { return b.status === "active"; }).length,
        returnedDeliveryBatches: state.batches.filter(function (b) { return b.status === "returned"; }).length,
        receipts: state.receipts.reduce(function (acc, r) {
          acc[r.status] = (acc[r.status] || 0) + 1; return acc;
        }, {}),
        unresolvedConflicts: state.conflicts.filter(function (c) { return !c.resolution; }).length
      },
      conflicts: state.conflicts,
      operations: state.operations,
      parts: state.parts,
      defects: state.defects,
      deliveryBatches: state.batches,
      receipts: state.receipts,
      logs: state.logs
    };
  }

  /* ---------- 对外只读视图辅助 ---------- */

  function pendingParts(state) {
    return state.parts.filter(function (p) { return !p.deliveryBatchId; });
  }

  return {
    STATUS: STATUS,
    BLOCKERS: BLOCKERS,
    // 工具（供页面造种子/样例）
    uid: uid, clone: clone, nowIso: nowIso, ymd: ymd, addDays: addDays,
    createState: createState,
    putOperation: putOperation,
    putPart: putPart,
    putDefect: putDefect,
    recomputePartReadiness: recomputePartReadiness,
    regroupDeliveries: regroupDeliveries,
    rejoinPending: rejoinPending,
    ingestPackage: ingestPackage,
    processReceipt: processReceipt,
    processQueue: processQueue,
    resumeAfterRestart: resumeAfterRestart,
    retryReceipt: retryReceipt,
    resolveConflict: resolveConflict,
    provisionMissing: provisionMissing,
    exportSnapshot: exportSnapshot,
    pendingParts: pendingParts,
    // 只读查询
    findOp: findOp, findPart: findPart, findReceipt: findReceipt,
    currentSeqFor: currentSeqFor, opCursor: opCursor
  };
});
