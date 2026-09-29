/* 最小 DOM 桩下真实加载 storage/domain/works/app，验证页面层启动与交互路径。
 * 不追求覆盖所有渲染细节，只保证：无异常、状态转换符合判定层契约。 */
const fs = require("fs");
const path = require("path");
const vm = require("vm");

// ---------- 极小 DOM / BOM 桩 ----------
function makeEl(id) {
  const el = {
    id: id || "", innerHTML: "", textContent: "", value: "", className: "",
    files: [], dataset: {}, style: {},
    listeners: {}, childNodes: [],
    classList: {
      _s: new Set(),
      add(c) { this._s.add(c); },
      remove(c) { this._s.delete(c); },
      contains(c) { return this._s.has(c); }
    },
    addEventListener(t, fn) { (this.listeners[t] = this.listeners[t] || []).push(fn); },
    trigger(t, ev) { (this.listeners[t] || []).forEach(fn => fn(ev || {})); },
    click() { this.trigger("click", { target: this }); },
    showModal() {}, close() {}, reset() {},
    querySelector() { return makeEl(); },
    querySelectorAll() { return []; },
    closest(sel) {
      // 仅支持 button[data-act]
      return this.dataset && this.dataset.act ? this : null;
    },
    appendChild() {}
  };
  return el;
}

const els = Object.create(null);
const docListeners = {};
const documentStub = {
  getElementById(id) { return els[id] || (els[id] = makeEl(id)); },
  querySelector(sel) {
    // works.js 会访问 form.dryDate 等子控件：返回惰性元素，未知属性即子控件
    if (!this._q) {
      const base = makeEl("q");
      this._q = new Proxy(base, {
        get(target, prop) {
          if (prop in target) return target[prop];
          if (typeof prop === "string" && !prop.startsWith("on")) {
            return target[prop] !== undefined ? target[prop] : (target[prop] = makeEl(prop));
          }
          return target[prop];
        },
        set(target, prop, val) { target[prop] = val; return true; }
      });
    }
    return this._q;
  },
  querySelectorAll(sel) {
    // DOMContentLoaded 绑定的 .tab；app.js 里实际 tab 点击不参与本测试
    if (sel === ".tab") return this._tabs || (this._tabs = []);
    return [];
  },
  addEventListener(t, fn) { (docListeners[t] = docListeners[t] || []).push(fn); },
  createElement() { return makeEl(); }
};

const store = {};
const localStorageStub = {
  getItem(k) { return Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null; },
  setItem(k, v) { store[k] = String(v); },
  removeItem(k) { delete store[k]; }
};

const sandbox = {
  console,
  document: documentStub,
  localStorage: localStorageStub,
  alert: (m) => { throw new Error("不应触发 alert: " + m); },
  confirm: () => true,
  prompt: () => null,
  Blob: function (parts) { this.parts = parts; },
  FileReader: function () {
    this.readAsText = function () { this.onload && this.onload({ target: { result: this._txt } }); };
  },
  URL: { createObjectURL: () => "blob:x", revokeObjectURL() {} },
  setTimeout: (fn) => { fn(); return 0; },
  clearTimeout() {},
  crypto: { randomUUID: () => "u-" + Math.random().toString(16).slice(2) },
  Date, JSON, Math, Object, Array, String, Number, RegExp
};
sandbox.self = sandbox;
sandbox.window = sandbox;
vm.createContext(sandbox);

function load(rel) {
  const code = fs.readFileSync(path.join(__dirname, "..", rel), "utf8");
  vm.runInContext(code, sandbox, { filename: rel });
}

load("js/storage.js");
load("js/domain.js");
load("js/works.js"); // 会注册 DOMContentLoaded，初始化看板
load("js/app.js");

// 触发 DOMContentLoaded → boot() 执行（种子台账 + resume）
(docListeners.DOMContentLoaded || []).forEach(fn => fn());

const D = sandbox.Domain;
// 从 localStorage 取出落盘状态（app 每次变更都整块写盘，等于真实断点）
const getState = () => JSON.parse(store["zfl42:syncState"]);
let s = getState();
function assert(c, m) { if (!c) { console.error("FAIL: " + m); process.exit(1); } }

assert(s.operations.length === 2, "启动应有 2 道工序");
assert(els.statBar.innerHTML.includes("工序"), "状态条已渲染");
assert(els.opRows.innerHTML.includes("WF2601"), "工序表已渲染");

// 构造样例包文本，走“粘贴合并”按钮的同一处理函数路径：直接写 pkgText.value + 点击
const cursor = D.opCursor(s, "WF2601", "OP10");
const pkg = {
  packageId: "PKG-DOM",
  receipts: [
    { id: "D-OK", batchNo: "WF2601", opNo: "OP10", seq: cursor + 1,
      payload: { parts: [{ partId: "C02", dryUntil: "2026-09-28" }] } },
    { id: "D-CF", batchNo: "WF2601", opNo: "OP10", seq: cursor + 4, payload: {} },
    { id: "D-MISS", batchNo: "WF2601", opNo: "OP77", seq: 1,
      payload: { opStatus: "贴线中", parts: [{ partId: "N1" }] } },
    { id: "D-OK", batchNo: "WF2601", opNo: "OP10", seq: cursor + 1, payload: {} }
  ]
};
documentStub.getElementById("pkgText").value = JSON.stringify(pkg);
els.importTextBtn.trigger("click");

s = getState();
assert(D.findReceipt(s, "D-OK").status === "applied", "正常回执自动合并");
assert(D.findReceipt(s, "D-OK").duplicateCount === 1, "同号只收一次");
assert(D.findReceipt(s, "D-CF").status === "conflict", "乱序挂起冲突");
assert(D.findReceipt(s, "D-MISS").status === "failed", "缺工序失败可重试");
assert(els.conflictList.innerHTML.includes("工坊值"), "冲突面板渲染三值");
assert(els.receiptRows.innerHTML.includes("补登缺失并重试"), "失败行有补登按钮");

// 事件委托：模拟在冲突行点击“采用本地值”
const cfId = s.conflicts.find(c => c.receiptId === "D-CF").conflictId;
const cfBtn = makeEl();
cfBtn.dataset = { act: "cf-local", id: cfId };
els.syncRoot.trigger("click", { target: cfBtn });
s = getState();
assert(D.findReceipt(s, "D-CF").status === "applied", "裁决本地值后已合并");
assert(s.conflicts.find(c => c.conflictId === cfId).resolution === "local", "冲突记录裁决结果");

// 模拟点击“补登缺失并重试”
const provBtn = makeEl();
provBtn.dataset = { act: "provision", id: "D-MISS" };
els.syncRoot.trigger("click", { target: provBtn });
s = getState();
assert(D.findReceipt(s, "D-MISS").status === "applied", "补登后重试成功");
assert(D.findOp(s, "WF2601", "OP77"), "缺失工序已补登");

// 导出按钮不抛错
els.exportBtn.trigger("click");

// 重新加载 app（模拟重启）：从断点继续，终态不重复处理
(docListeners.DOMContentLoaded || []).length; // 已注册
// boot 只会在首次 DOMContentLoaded 时运行一次；这里直接验证 resume 对落盘状态稳定
const resumed = D.resumeAfterRestart(getState(), { now: () => Date.now() }, 5).state;
assert(resumed.receipts.every(r => r.status !== "queued"), "重启后无残留待处理");

console.log("DOM harness OK：启动渲染、收包、冲突三值保留与裁决、失败补登重试、导出、断点续跑全部通过");
