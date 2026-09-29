/*
 * 存储层（Storage）
 * 只负责 localStorage 的读取、写入与重置，不包含任何业务判定逻辑。
 * 判定规则见 judge.js，页面渲染见 ui.js。
 */
(function () {
  "use strict";

  var STORAGE_KEY = "zfl42OutsourceState";

  function defaultState() {
    return {
      batches: [],       // 交付批次
      ledger: {},        // 同号回执台账：receiptNo -> 处理记录（同号回执只收一次）
      conflicts: [],     // 冲突记录：保留工坊值、本地值与处理结果
      retryQueue: [],    // 处理失败、待重试的回执
      packages: [],      // 已处理回执包记录
      checkpoint: { lastPackageId: null, lastReceiptIndex: -1, updatedAt: null } // 断点续传检查点
    };
  }

  function load() {
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return defaultState();
      var parsed = JSON.parse(raw);
      // 合并默认字段，避免旧版本数据缺字段
      var state = defaultState();
      Object.keys(parsed).forEach(function (k) { state[k] = parsed[k]; });
      if (!state.checkpoint) state.checkpoint = { lastPackageId: null, lastReceiptIndex: -1, updatedAt: null };
      return state;
    } catch (e) {
      console.error("[存储] 读取失败：", e);
      return defaultState();
    }
  }

  function save(state) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
      return true;
    } catch (e) {
      console.error("[存储] 写入失败：", e);
      return false;
    }
  }

  function reset() {
    localStorage.removeItem(STORAGE_KEY);
  }

  window.Outsource = window.Outsource || {};
  window.Outsource.Storage = {
    KEY: STORAGE_KEY,
    defaultState: defaultState,
    load: load,
    save: save,
    reset: reset
  };
})();
