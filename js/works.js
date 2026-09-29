/* 页面层 · 作品看板：原 index.html 的看板逻辑原样抽出，
 * 只通过 store 持久化，不包含任何合并/判定规则。 */
(function () {
  "use strict";

  var statuses = ["贴线中", "待阴干", "上金粉", "待交付"];
  var today = new Date().toISOString().slice(0, 10);
  var seed = [
    { id: crypto.randomUUID(), base: "木胎香盒", theme: "海水江崖", line: "细线", progress: 70, dryDate: today, gold: "未处理", defect: "", delivery: "2026-10-26", status: "待阴干", note: "边线需保持低浮雕感", logs: ["创建作品"] },
    { id: crypto.randomUUID(), base: "脱胎盘", theme: "折枝梅", line: "混合线", progress: 95, dryDate: "2026-09-20", gold: "试扫粉", defect: "左侧枝干翘线", delivery: "2026-10-03", status: "上金粉", note: "客户要求金粉偏暗", logs: ["创建作品", "记录翘线"] },
    { id: crypto.randomUUID(), base: "竹胎笔筒", theme: "云雷纹", line: "中线", progress: 40, dryDate: "2026-09-24", gold: "未处理", defect: "", delivery: "2026-10-30", status: "贴线中", note: "", logs: ["创建作品"] }
  ];

  window.initWorksApp = function (store) {
    var works = store.loadWorks() || seed;
    var activeId = null;

    var form = document.querySelector("#workForm");
    var board = document.querySelector("#board");
    var statusFilter = document.querySelector("#statusFilter");
    var themeFilter = document.querySelector("#themeFilter");
    var sortMode = document.querySelector("#sortMode");
    var dialog = document.querySelector("#detailDialog");

    form.dryDate.value = today;
    form.delivery.value = new Date(Date.now() + 5 * 86400000).toISOString().slice(0, 10);
    statusFilter.innerHTML = `<option value="">全部状态</option>` + statuses.map(s => `<option>${s}</option>`).join("");

    function save() { store.saveWorks(works); }

    function filtered() {
      return works
        .filter(w => !statusFilter.value || w.status === statusFilter.value)
        .filter(w => !themeFilter.value || w.theme.includes(themeFilter.value.trim()))
        .sort((a, b) => (a[sortMode.value] || "").localeCompare(b[sortMode.value] || ""));
    }

    function updateStatus(id, status) {
      const work = works.find(w => w.id === id);
      work.status = status;
      if (status === "待阴干") work.dryDate = new Date().toISOString().slice(0, 10);
      if (status === "上金粉") work.gold = "已上金粉";
      if (status === "待交付") work.progress = 100;
      work.logs.push(`${new Date().toLocaleString()} 更新为 ${status}`);
      save();
      render();
    }

    function recordDefect(id, text) {
      const work = works.find(w => w.id === id);
      const value = text || prompt("输入断线/翘线位置");
      if (!value) return;
      work.defect = work.defect ? `${work.defect}; ${value}` : value;
      work.logs.push(`${new Date().toLocaleString()} 缺陷：${value}`);
      save();
      render();
    }

    function showDetail(id) {
      activeId = id;
      const w = works.find(item => item.id === id);
      document.querySelector("#detailTitle").textContent = `${w.theme} · ${w.base}`;
      document.querySelector("#detailContent").innerHTML = `
        胎体材质：${w.base}<br>线条粗细：${w.line}<br>贴线进度：${w.progress}%<br>
        阴干日期：${w.dryDate}<br>金粉状态：${w.gold}<br>缺陷位置：${w.defect || "无"}<br>
        交付日期：${w.delivery}<br>当前状态：${w.status}<br>备注：${w.note || "无"}<br>
        流转记录：${w.logs.join(" / ")}
      `;
      document.querySelector("#defectInput").value = "";
      dialog.showModal();
    }

    function renderSummaries() {
      const todayDry = works.filter(w => w.dryDate <= today && w.status === "待阴干");
      const defects = works.filter(w => w.defect);
      const delivery = [...works].sort((a, b) => a.delivery.localeCompare(b.delivery)).slice(0, 4);
      document.querySelector("#todayDry").innerHTML = todayDry.length ? todayDry.map(w => `<div class="item" onclick="showDetail('${w.id}')"><b>${w.theme}</b><div class="meta">${w.base} · ${w.dryDate}</div></div>`).join("") : `<div class="empty">暂无</div>`;
      document.querySelector("#defectList").innerHTML = defects.length ? defects.map(w => `<div class="item overdue" onclick="showDetail('${w.id}')"><b>${w.theme}</b><div class="meta">${w.defect}</div></div>`).join("") : `<div class="empty">暂无</div>`;
      document.querySelector("#deliveryList").innerHTML = delivery.map(w => `<div class="item" onclick="showDetail('${w.id}')"><b>${w.theme}</b><div class="meta">${w.delivery} · ${w.status}</div></div>`).join("");
    }

    function renderBoard() {
      const list = filtered();
      board.innerHTML = statuses.map(status => {
        const cards = list.filter(w => w.status === status);
        return `<section class="col">
          <h3><span>${status}</span><span>${cards.length}</span></h3>
          ${cards.length ? cards.map(w => `<article class="item ${w.defect ? "overdue" : ""}" onclick="showDetail('${w.id}')">
            <b>${w.theme}</b>
            <div class="meta">${w.base} · ${w.line}<br>进度 ${w.progress}% · 阴干 ${w.dryDate}<br>金粉：${w.gold} · 交付：${w.delivery}<br>${w.defect ? "缺陷：" + w.defect : "缺陷：无"}</div>
            <div class="actions" onclick="event.stopPropagation()">
              ${statuses.map(s => `<button class="${s === status ? "secondary" : ""}" onclick="updateStatus('${w.id}', '${s}')">${s}</button>`).join("")}
              <button class="warn" onclick="recordDefect('${w.id}')">记缺陷</button>
            </div>
          </article>`).join("") : `<div class="empty">暂无作品</div>`}
        </section>`;
      }).join("");
    }

    function render() { renderSummaries(); renderBoard(); }

    form.addEventListener("submit", event => {
      event.preventDefault();
      const data = Object.fromEntries(new FormData(form).entries());
      works.unshift({
        id: crypto.randomUUID(),
        base: data.base, theme: data.theme, line: data.line,
        progress: Number(data.progress), dryDate: data.dryDate, gold: data.gold,
        defect: data.defect, delivery: data.delivery, status: data.status,
        note: data.note, logs: [`${new Date().toLocaleString()} 创建作品`]
      });
      form.reset();
      form.dryDate.value = today;
      form.delivery.value = new Date(Date.now() + 5 * 86400000).toISOString().slice(0, 10);
      save();
      render();
    });

    document.querySelector("#saveDefect").addEventListener("click", () => {
      recordDefect(activeId, document.querySelector("#defectInput").value.trim());
      showDetail(activeId);
    });
    document.querySelector("#closeDialog").addEventListener("click", () => dialog.close());
    document.querySelector("#clearFilters").addEventListener("click", () => {
      themeFilter.value = "";
      statusFilter.value = "";
      render();
    });
    [statusFilter, themeFilter, sortMode].forEach(el => el.addEventListener("input", render));
    document.querySelector("#exportWorksBtn").addEventListener("click", () => {
      const blob = new Blob([JSON.stringify(works, null, 2)], { type: "application/json" });
      const link = document.createElement("a");
      link.href = URL.createObjectURL(blob);
      link.download = "lacquer-thread-works.json";
      link.click();
      URL.revokeObjectURL(link.href);
    });

    window.updateStatus = updateStatus;
    window.recordDefect = recordDefect;
    window.showDetail = showDetail;
    save();
    render();
  };
})();
