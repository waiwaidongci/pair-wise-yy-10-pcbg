/* 页面编排冒烟测试：在无浏览器环境下模拟 app.js 的关键调用路径
 * （Storage 内存兜底 + Domain 判定），node tests/smoke.js */
const Storage = require("../js/storage.js");
const Domain = require("../js/domain.js");

let t = Date.parse("2026-09-29T08:00:00Z");
const clock = { now: () => t };
const store = Storage.createStore("smoke");
store.resetState();
assert(store.loadState() === null, "初始无状态");

// 1) 造台账（与 app.js seedState 同构）
let s = Domain.createState(clock);
Domain.putOperation(s, { batchNo: "WF2601", opNo: "OP10", name: "贴线", status: "贴线中" });
Domain.putPart(s, { partId: "C01", name: "盖", batchNo: "WF2601", opNo: "OP10", seq: 1,
  opStatus: "已贴线", dryUntil: "2026-09-25", assemblyClosed: true, planDelivery: "2026-10-02" }, clock);
Domain.putPart(s, { partId: "C02", name: "身", batchNo: "WF2601", opNo: "OP10", seq: 2,
  opStatus: "贴线中", dryUntil: "2026-10-05", assemblyClosed: true, planDelivery: "2026-10-02" }, clock);
Domain.regroupDeliveries(s, "初始成批", clock, { rejoinReady: true });
store.saveState(s);

// 2) “重启”：从 Storage 读盘并 resumeAfterRestart（无待处理项，幂等）
s = store.loadState();
s = Domain.resumeAfterRestart(s, clock, 5).state;
store.saveState(s);

// 3) 收样例包（含正常/乱序/缺工序/同号重复）
const cursor = Domain.opCursor(s, "WF2601", "OP10");
const pkg = {
  packageId: "PKG-SMOKE",
  receipts: [
    { id: "R-OK", batchNo: "WF2601", opNo: "OP10", seq: cursor + 1,
      payload: { opStatus: "待阴干", parts: [{ partId: "C02", dryUntil: "2026-09-28" }] } },
    { id: "R-CF", batchNo: "WF2601", opNo: "OP10", seq: cursor + 5,
      payload: { parts: [{ partId: "C01", assemblyClosed: false }] } },
    { id: "R-MISS", batchNo: "WF2601", opNo: "OP88", seq: 1,
      payload: { opStatus: "贴线中", parts: [{ partId: "Z9" }] } },
    { id: "R-OK", batchNo: "WF2601", opNo: "OP10", seq: cursor + 1, payload: {} }
  ]
};
s = Domain.ingestPackage(s, pkg, clock, true).state;
store.saveState(s);

assert(Domain.findReceipt(s, "R-OK").status === "applied", "R-OK 应已合并");
assert(Domain.findReceipt(s, "R-OK").duplicateCount === 1, "同号回执记一次重发");
assert(Domain.findReceipt(s, "R-CF").status === "conflict", "R-CF 应冲突挂起");
assert(Domain.findPart(s, "C01").assemblyClosed === true, "冲突不得覆盖主数据");
assert(Domain.findReceipt(s, "R-MISS").status === "failed", "R-MISS 应失败");

// 4) 裁决采用本地值 → C01 合拢被改回未完成，若已在批次则触发退回
const cf = s.conflicts[0];
s = Domain.resolveConflict(s, cf.conflictId, "local", clock).state;
store.saveState(s);
assert(Domain.findReceipt(s, "R-CF").status === "applied", "裁决后应并入");
assert(Domain.findPart(s, "C01").assemblyClosed === false, "本地值应已并入");

// 5) 失败回执补登并重试
s = Domain.provisionMissing(s, "R-MISS", { opName: "新工序" }, clock);
s = Domain.retryReceipt(s, "R-MISS", clock).state;
store.saveState(s);
assert(Domain.findReceipt(s, "R-MISS").status === "applied", "补登后重试应成功");

// 6) 再次“重启续跑”，状态稳定不变化
const beforeJson = JSON.stringify(s.receipts.map(r => [r.receiptId, r.status]));
s = Domain.resumeAfterRestart(store.loadState(), clock, 5).state;
const afterJson = JSON.stringify(s.receipts.map(r => [r.receiptId, r.status]));
assert(beforeJson === afterJson, "重启续跑不得重复处理已终态回执");

// 7) 导出带冲突和当前状态
const snap = Domain.exportSnapshot(s, clock);
assert(snap.conflicts.length >= 1 && snap.currentStatus && snap.deliveryBatches.length >= 0, "导出结构完整");
assert(Array.isArray(snap.receipts) && snap.receipts.length === 3, "三条独立回执");

console.log("smoke OK:", JSON.stringify(snap.currentStatus, null, 2));

function assert(cond, msg) { if (!cond) { console.error("ASSERT FAIL: " + msg); process.exit(1); } }
