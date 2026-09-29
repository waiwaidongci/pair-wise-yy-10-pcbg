// 判定层逻辑自测：在 node 中模拟 localStorage 与 window，跑演示流程
global.window = global;
global.localStorage = (function () {
  var m = {};
  return {
    getItem: function (k) { return m[k] || null; },
    setItem: function (k, v) { m[k] = String(v); },
    removeItem: function (k) { delete m[k]; }
  };
})();

require("./app/storage.js");
require("./app/judge.js");
var Storage = global.Outsource.Storage;
var Judge = global.Outsource.Judge;

var state = Storage.load();

function demoBatch() {
  return {
    batchNo: "B-2026-001", deliveryDate: "2026-07-15", dryDate: "2026-06-20",
    status: Judge.BATCH.PENDING,
    components: [
      { componentId: "C1", name: "盖", status: "未开始", progress: 0, operations: [
        { operationNo: 10, name: "贴线", seq: 1, status: "完成", value: { line: "细线", progress: 100 }, result: "贴线完成", lastSeq: 1, logs: [] },
        { operationNo: 20, name: "阴干", seq: 2, status: "完成", value: { dryDate: "2026-06-20" }, result: "阴干到位", lastSeq: 2, logs: [] },
        { operationNo: 30, name: "上金粉", seq: 3, status: "进行中", value: null, result: null, lastSeq: 0, logs: [] },
        { operationNo: 40, name: "合拢", seq: 4, status: "未开始", value: null, result: null, lastSeq: 0, logs: [] }
      ]},
      { componentId: "C2", name: "身", status: "未开始", progress: 0, operations: [
        { operationNo: 10, name: "贴线", seq: 1, status: "完成", value: { line: "细线", progress: 100 }, result: "贴线完成", lastSeq: 1, logs: [] },
        { operationNo: 20, name: "阴干", seq: 2, status: "完成", value: { dryDate: "2026-06-20" }, result: "阴干到位", lastSeq: 2, logs: [] },
        { operationNo: 30, name: "上金粉", seq: 3, status: "未开始", value: null, result: null, lastSeq: 0, logs: [] },
        { operationNo: 40, name: "合拢", seq: 4, status: "未开始", value: null, result: null, lastSeq: 0, logs: [] }
      ]}
    ],
    defects: [ { defectId: "D1", componentId: "C1", location: "盖右侧断线", closed: false, result: null, lastSeq: 0, logs: [] } ],
    returnReasons: [], progress: 0, logs: []
  };
}

var pkg1 = { packageId: "PKG-DEMO-1", source: "workshop", processReceipts: [
  { receiptNo: "R-001", batchNo: "B-2026-001", componentId: "C1", operationNo: 30, seq: 4, value: { gold: "已上金粉" }, result: "上金粉完成", status: "完成" },
  { receiptNo: "R-002", batchNo: "B-2026-001", componentId: "C2", operationNo: 10, seq: 1, value: { line: "细线", progress: 100 }, result: "贴线完成", status: "完成" },
  { receiptNo: "R-001", batchNo: "B-2026-001", componentId: "C1", operationNo: 30, seq: 4, value: { gold: "已上金粉" }, result: "上金粉完成", status: "完成" }
], defectReceipts: [
  { receiptNo: "D-001", batchNo: "B-2026-001", defectId: "D1", componentId: "C1", action: "修复", result: "断线已修复", closed: true, seq: 1 },
  { receiptNo: "R-003", batchNo: "B-9999", componentId: "C1", operationNo: 40, seq: 4, value: { closed: true }, result: "合拢完成", status: "完成" }
]};

var pkg2 = { packageId: "PKG-DEMO-2", source: "workshop", processReceipts: [
  { receiptNo: "R-004", batchNo: "B-2026-001", componentId: "C1", operationNo: 40, seq: 5, value: { closed: true }, result: "合拢到位", status: "完成" },
  { receiptNo: "R-005", batchNo: "B-2026-001", componentId: "C2", operationNo: 40, seq: 5, value: { closed: true }, result: "合拢到位", status: "完成" }
]};

function assert(cond, msg) {
  if (!cond) { console.error("FAIL:", msg); process.exit(1); }
  console.log("PASS:", msg);
}

// 初始：批次入库
var batch = demoBatch();
Judge.recalcBatch(batch);
state.batches.push(batch);

// 处理 PKG-1
var r1 = Judge.mergePackage(state, pkg1);
var b1 = state.batches[0];
assert(r1.report.applied.length === 2, "PKG-1 已应用 2 条（R-001、D-001），实际 " + r1.report.applied.length);
assert(r1.report.duplicates.length === 1, "PKG-1 重复跳过 1 条（R-001 同号），实际 " + r1.report.duplicates.length);
assert(r1.report.conflicts.length === 1, "PKG-1 冲突 1 条（R-002 序号乱到），实际 " + r1.report.conflicts.length);
assert(r1.report.failed.length === 1, "PKG-1 失败 1 条（R-003 批次不存在），实际 " + r1.report.failed.length);
assert(b1.status === Judge.BATCH.RETURNED, "PKG-1 后批次退回（合拢未完成），实际 " + b1.status);
assert(b1.returnReasons.some(function (x) { return x.indexOf("合拢未完成") >= 0; }), "退回原因含合拢未完成：" + b1.returnReasons.join("；"));
assert(b1.defects[0].closed === true, "D1 缺陷已闭合");
assert(b1.components[0].operations[2].status === "完成", "C1 上金粉已完成（工序改动重算）");
assert(state.conflicts[0].workshopValue && state.conflicts[0].localValue, "冲突保留工坊值与本地值");
assert(state.conflicts[0].result === "贴线完成", "冲突保留处理结果");
assert(state.retryQueue.length === 1, "重试队列 1 条");
assert(state.checkpoint.lastPackageId === "PKG-DEMO-1", "检查点记录 PKG-DEMO-1");

// 处理 PKG-2（合拢完成）
var r2 = Judge.mergePackage(state, pkg2);
assert(b1.status === Judge.BATCH.RECEIVED, "PKG-2 后批次已接收，实际 " + b1.status);
assert(b1.returnReasons.length === 0, "PKG-2 后退回原因清空");
assert(r2.report.applied.length === 2, "PKG-2 已应用 2 条");

// 再次处理 PKG-2：全部同号重复
var r3 = Judge.mergePackage(state, pkg2);
assert(r3.report.duplicates.length === 2, "PKG-2 重复处理：2 条全部跳过，实际 " + r3.report.duplicates.length);
assert(r3.report.applied.length === 0, "PKG-2 重复处理：无新增应用");

// 重试失败回执（R-003 批次仍不存在，应仍失败，计数 +1）
var rt = Judge.retryFailed(state);
assert(rt.report.retried.length === 0, "重试无成功（批次仍不存在）");
assert(rt.report.stillFailed.length === 1, "重试仍失败 1 条");
assert(state.retryQueue[0].retryCount === 1, "重试计数为 1，实际 " + state.retryQueue[0].retryCount);

// 导出结构
var exportPayload = {
  exportedAt: new Date().toISOString(),
  checkpoint: state.checkpoint,
  batches: state.batches,
  conflicts: state.conflicts,
  retryQueue: state.retryQueue,
  ledger: state.ledger,
  packages: state.packages
};
assert(exportPayload.conflicts.length === 1, "导出含冲突");
assert(exportPayload.batches[0].status === Judge.BATCH.RECEIVED, "导出含当前状态");
assert(Object.keys(exportPayload.ledger).length === 5, "台账含 5 条唯一回执（R-001,R-002,D-001,R-004,R-005），实际 " + Object.keys(exportPayload.ledger).length);

console.log("\n全部通过。");
