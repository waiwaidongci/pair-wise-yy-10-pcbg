/* 存储层：只负责 localStorage 的持久化与读取，不包含任何合并/判定规则。
   判定规则全部放在 domain.js，页面只调用这一层的 load / save，不直接触碰 localStorage。 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.Storage = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  var DEFAULT_PREFIX = "zfl42";

  function createStore(prefix) {
    var p = prefix || DEFAULT_PREFIX;
    var memory = Object.create(null); // 无 localStorage（测试环境）时的兜底

    function rawGet(key) {
      try {
        if (typeof localStorage !== "undefined") return localStorage.getItem(key);
      } catch (e) { /* 隐私模式等场景降级到内存 */ }
      return Object.prototype.hasOwnProperty.call(memory, key) ? memory[key] : null;
    }

    function rawSet(key, value) {
      try {
        if (typeof localStorage !== "undefined") { localStorage.setItem(key, value); return; }
      } catch (e) { /* 降级 */ }
      memory[key] = value;
    }

    return {
      prefix: p,

      // 整块状态读取，缺省返回 null，由上层决定如何初始化
      loadState: function () {
        var raw = rawGet(p + ":syncState");
        if (!raw) return null;
        try {
          return JSON.parse(raw);
        } catch (e) {
          // 损坏数据不静默吞掉：交给上层看到解析错误
          throw new Error("本地状态解析失败：" + e.message);
        }
      },

      // 整块状态写入（每次处理一个包后立即落盘，构成“断点”）
      saveState: function (state) {
        rawSet(p + ":syncState", JSON.stringify(state));
      },

      resetState: function () {
        try {
          if (typeof localStorage !== "undefined") localStorage.removeItem(p + ":syncState");
        } catch (e) { /* 降级 */ }
        delete memory[p + ":syncState"];
      },

      // 作品看板沿用原有的独立 key，与合并状态互不影响
      loadWorks: function () {
        var raw = rawGet(p + "Works");
        return raw ? JSON.parse(raw) : null;
      },
      saveWorks: function (works) {
        rawSet(p + "Works", JSON.stringify(works));
      }
    };
  }

  return { createStore: createStore, DEFAULT_PREFIX: DEFAULT_PREFIX };
});
