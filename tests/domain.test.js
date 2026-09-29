/* 判定层测试（纯 Node，无第三方依赖）：node tests/domain.test.js
 * 覆盖：按批次+操作合并、序号乱到三值保留不覆盖、同号幂等、
 * 工序改动触发部件与交付批次重算、三类退回、失败重试、重启断点续跑、导出。 */
const assert = require("assert");
const Domain = require("../js/domain.js");

// 固定时钟，保证“阴干未到/已到”可断言
let t = Date.parse("2026-09-29T08:00:00Z");
const clock = { now: () => t };
const advance = (ms) => { t += ms; };

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log("  ✓ " + name); }
  catch (e) { console.error("  ✗ " + name + "\n    " + (e.stack || e.message)); process.exitCode = 1; }
}
function group(name, fn) { console.log("\n" + name); fn(); }

/* ---------- 造初始台账 ---------- */
// 批次 WF2601 操作号 OP10（贴线），两个部件；C01 已合拢阴干到期，C02 阴干未到
function seed() {
  let s = Domain.createState(clock);
  Domain.putOperation(s, { batchNo: "WF2601", opNo: "OP10", name: "贴线", status: "贴线中" });
  Domain.putPart(s, {
    partId: "C01", name: "香盒盖", batchNo: "WF2601", opNo: "OP10", seq: 1,
    opStatus: "已贴线", dryUntil: "2026-09-25", assemblyClosed: true, planDelivery: "2026-10-02"
  }, clock);
  Domain.putPart(s, {
    partId: "C02", name: "香盒身", batchNo: "WF2601", opNo: "OP10", seq: 2,
    opStatus: "贴线中", dryUntil: "2026-10-05", assemblyClosed: true, planDelivery: "2026-10-02"
  }, clock);
  Domain.regroupDeliveries(s, "初始成批", clock, { rejoinReady: true });
  return s;
}

group("初始台账与交付成批", () => {
  const s = seed();
  test("合格部件 C01 进入在役交付批次，阴干未到 C02 不进批", () => {
    const c01 = Domain.findPart(s, "C01"), c02 = Domain.findPart(s, "C02");
    assert.ok(c01.deliveryBatchId, "C01 应已分配批次");
    assert.strictEqual(c02.deliveryBatchId, null);
    assert.deepStrictEqual(c02.blockers.map(b => b.code), ["dry_not_ready"]);
    const batch = s.batches.find(b => b.batchId === c01.deliveryBatchId);
    assert.strictEqual(batch.status, "active");
    assert.deepStrictEqual(batch.partIds, ["C01"]);
  });
  test("当前序号基线为 2，下一条期望 3", () => {
    assert.strictEqual(Domain.currentSeqFor(s, "WF2601", "OP10"), 2);
  });
});

group("按批次号+操作号正常合并，工序改动触发重算", () => {
  const s = seed();
  // seq=3 正确：C02 阴干日提前到今天之前 → 应变为可交付并入批次；工序状态推进
  const out = Domain.ingestPackage(s, {
    packageId: "PKG-A",
    receipts: [{
      id: "R-001", batchNo: "WF2601", opNo: "OP10", seq: 3,
      payload: {
        opStatus: "待阴干",
        parts: [{ partId: "C02", seq: 3, opStatus: "待阴干", dryUntil: "2026-09-28" }]
      }
    }]
  }, clock);
  const s2 = out.state;
  test("回执标记 applied，工序状态被平板值更新", () => {
    assert.strictEqual(Domain.findReceipt(s2, "R-001").status, Domain.STATUS.APPLIED);
    assert.strictEqual(Domain.findOp(s2, "WF2601", "OP10").status, "待阴干");
  });
  test("部件重算后 C02 阴干到期，仍先待排；执行重排后与 C01 同批", () => {
    const c02 = Domain.findPart(s2, "C02");
    assert.strictEqual(c02.dryReady, true);
    assert.strictEqual(c02.blockers.length, 0);
    assert.strictEqual(c02.deliveryBatchId, null, "工序回执不自动重批，先待排");
    const s3 = Domain.rejoinPending(s2, clock);
    const c02b = Domain.findPart(s3, "C02");
    assert.ok(c02b.deliveryBatchId);
    assert.strictEqual(c02b.deliveryBatchId, Domain.findPart(s3, "C01").deliveryBatchId);
    const batch = s3.batches.find(b => b.batchId === c02b.deliveryBatchId);
    assert.deepStrictEqual(batch.partIds.sort(), ["C01", "C02"]);
  });
});

group("序号乱到：保留工坊值/本地值/处理结果，绝不覆盖", () => {
  const s = seed(); // 期望 seq=3
  const s2 = Domain.ingestPackage(s, {
    packageId: "PKG-B",
    receipts: [{
      id: "R-010", batchNo: "WF2601", opNo: "OP10", seq: 5, // 乱到
      payload: { opStatus: "已合拢", parts: [{ partId: "C02", seq: 5, assemblyClosed: false }] }
    }]
  }, clock).state;

  test("回执 conflict 挂起，主数据未被覆盖", () => {
    assert.strictEqual(Domain.findReceipt(s2, "R-010").status, Domain.STATUS.CONFLICT);
    assert.strictEqual(Domain.findOp(s2, "WF2601", "OP10").status, "贴线中"); // 未改动
    assert.strictEqual(Domain.findPart(s2, "C02").assemblyClosed, true);     // 未改动
  });
  test("冲突记录同时含工坊值(3)、本地值(5)、处理结果", () => {
    const c = s2.conflicts[0];
    assert.strictEqual(c.workshopValue, 3);
    assert.strictEqual(c.localValue, 5);
    assert.ok(/挂起/.test(c.result));
    assert.strictEqual(c.resolution, null);
  });

  test("裁决保留工坊值：回执不入数据，冲突留痕", () => {
    const out = Domain.resolveConflict(s2, s2.conflicts[0].conflictId, "workshop", clock);
    const s3 = out.state;
    assert.strictEqual(Domain.findOp(s3, "WF2601", "OP10").status, "贴线中");
    assert.strictEqual(s3.conflicts[0].resolution, "workshop");
  });

  test("裁决采用本地值：强制并入并重算交付批次", () => {
    const out = Domain.resolveConflict(s2, s2.conflicts[0].conflictId, "local", clock);
    const s3 = out.state;
    assert.strictEqual(Domain.findReceipt(s3, "R-010").status, Domain.STATUS.APPLIED);
    assert.strictEqual(Domain.findOp(s3, "WF2601", "OP10").status, "已合拢");
    // C02 被改成未合拢 → 受阻，应退出交付批次
    const c02 = Domain.findPart(s3, "C02");
    assert.deepStrictEqual(c02.blockers.map(b => b.code), ["dry_not_ready", "assembly_open"]);
    assert.strictEqual(c02.deliveryBatchId, null);
    assert.strictEqual(s3.conflicts[0].resolution, "local");
  });
});

group("同号回执只收一次（幂等）", () => {
  let s = seed();
  const pkg = (idSuffix) => ({
    receipts: [{
      id: "R-DUP", batchNo: "WF2601", opNo: "OP10", seq: 3,
      payload: { opStatus: "待阴干", parts: [{ partId: "C02", seq: 3, dryUntil: "2026-09-28" }] }
    }]
  });
  s = Domain.ingestPackage(s, pkg(), clock).state;
  const appliedAt = Domain.findReceipt(s, "R-DUP").appliedAt;
  advance(1000);
  const s2 = Domain.ingestPackage(s, pkg(), clock).state;
  test("重复送达不产生第二条回执、不再次处理", () => {
    assert.strictEqual(s2.receipts.filter(r => r.receiptId === "R-DUP").length, 1);
    const r = Domain.findReceipt(s2, "R-DUP");
    assert.strictEqual(r.duplicateCount, 1);
    assert.strictEqual(r.appliedAt, appliedAt);
  });
});

group("三类阻碍 → 原交付批次退回", () => {
  test("合拢被改回未完成：原批 returned，批内合格部件一并退回", () => {
    let s = seed();
    // 先让 C02 合格成批
    s = Domain.ingestPackage(s, {
      receipts: [{ id: "R1", batchNo: "WF2601", opNo: "OP10", seq: 3,
        payload: { parts: [{ partId: "C02", seq: 3, dryUntil: "2026-09-28" }] } }]
    }, clock).state;
    const batchId = Domain.findPart(s, "C01").deliveryBatchId;
    // 再把 C01 合拢改回未完成
    s = Domain.ingestPackage(s, {
      receipts: [{ id: "R2", batchNo: "WF2601", opNo: "OP10", seq: 4,
        payload: { parts: [{ partId: "C01", seq: 4, assemblyClosed: false }] } }]
    }, clock).state;
    const batch = s.batches.find(b => b.batchId === batchId);
    assert.strictEqual(batch.status, "returned");
    assert.ok(/合拢未完成/.test(batch.returnReason));
    assert.strictEqual(Domain.findPart(s, "C01").deliveryBatchId, null);
    assert.strictEqual(Domain.findPart(s, "C02").deliveryBatchId, null, "同批部件整批退回");
  });

  test("未闭缺陷：缺陷回执登记未关闭缺陷后原批退回，缺陷关闭后重新成批", () => {
    let s = seed();
    s = Domain.ingestPackage(s, {
      receipts: [{
        id: "R3", batchNo: "WF2601", opNo: "OP10", seq: 3,
        payload: { defects: [{ defectId: "D1", partId: "C01", desc: "花瓣翘线", closed: false }] }
      }]
    }, clock).state;
    const c01 = Domain.findPart(s, "C01");
    assert.strictEqual(c01.openDefects, 1);
    assert.deepStrictEqual(c01.blockers.map(b => b.code), ["open_defect"]);
    assert.strictEqual(c01.deliveryBatchId, null);
    assert.ok(s.batches.some(b => b.status === "returned"));

    s = Domain.ingestPackage(s, {
      receipts: [{
        id: "R4", batchNo: "WF2601", opNo: "OP10", seq: 4,
        payload: { defects: [{ defectId: "D1", partId: "C01", closed: true }] }
      }]
    }, clock).state;
    const c01b = Domain.findPart(s, "C01");
    assert.strictEqual(c01b.openDefects, 0);
    assert.strictEqual(c01b.deliveryBatchId, null, "关闭缺陷后先待排，不悄悄回批");
    const s2b = Domain.rejoinPending(s, clock);
    assert.ok(Domain.findPart(s2b, "C01").deliveryBatchId, "执行重排后重新成批");
    assert.strictEqual(
      s2b.batches.find(b => b.batchId === Domain.findPart(s2b, "C01").deliveryBatchId).status,
      "active"
    );
  });
});

group("失败重试 / 缺主数据补登 / 重启断点续跑", () => {
  test("缺工序：先 failed，补登工序后 retry 成功", () => {
    let s = seed();
    s = Domain.ingestPackage(s, {
      receipts: [{ id: "RX", batchNo: "WF2601", opNo: "OP99", seq: 1,
        payload: { opStatus: "贴线中", parts: [{ partId: "X1", seq: 1 }] } }]
    }, clock).state;
    const rx = Domain.findReceipt(s, "RX");
    assert.strictEqual(rx.status, Domain.STATUS.FAILED);
    assert.strictEqual(rx.error.code, "op_missing");
    s = Domain.provisionMissing(s, "RX", { opName: "补登的扫金" }, clock);
    const again = Domain.retryReceipt(s, "RX", clock);
    assert.strictEqual(again.receipt.status, Domain.STATUS.APPLIED);
    assert.ok(Domain.findOp(again.state, "WF2601", "OP99"));
  });

  test("重启后从断点继续：queued 回执在 resume 时自动处理", () => {
    let s = seed();
    // 只收包不自动处理，模拟断网时落盘
    s = Domain.ingestPackage(s, {
      receipts: [{ id: "RP", batchNo: "WF2601", opNo: "OP10", seq: 3,
        payload: { parts: [{ partId: "C02", seq: 3, dryUntil: "2026-09-28" }] } }]
    }, clock, false).state;
    assert.strictEqual(Domain.findReceipt(s, "RP").status, Domain.STATUS.QUEUED);
    // “重启”：对同一份持久化状态执行 resume
    const out = Domain.resumeAfterRestart(s, clock);
    assert.strictEqual(Domain.findReceipt(out.state, "RP").status, Domain.STATUS.APPLIED);
    assert.ok(out.state.logs.some(l => /重启恢复/.test(l.message)));
    assert.strictEqual(Domain.findPart(out.state, "C02").deliveryBatchId, null, "自动续跑只合数据，不自动重批");
    const rejoined = Domain.rejoinPending(out.state, clock);
    assert.ok(Domain.findPart(rejoined, "C02").deliveryBatchId, "重排后成批");
  });
});

group("导出带冲突与当前状态", () => {
  test("exportSnapshot 含 currentStatus、conflicts、批次、回执、日志", () => {
    let s = seed();
    s = Domain.ingestPackage(s, {
      receipts: [{ id: "RC", batchNo: "WF2601", opNo: "OP10", seq: 9,
        payload: { parts: [{ partId: "C02", seq: 9 }] } }]
    }, clock).state;
    const snap = Domain.exportSnapshot(s, clock);
    assert.strictEqual(snap.currentStatus.unresolvedConflicts, 1);
    assert.strictEqual(snap.currentStatus.parts, 2);
    assert.strictEqual(snap.conflicts.length, 1);
    assert.ok(Array.isArray(snap.deliveryBatches));
    assert.strictEqual(snap.receipts[0].receiptId, "RC");
    assert.ok(snap.exportedAt);
  });
});

console.log("\n" + (process.exitCode ? "存在失败用例" : ("全部通过：" + passed + " 个断言块")));
