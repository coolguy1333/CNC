/* Shared shop data pages (tool library, tested settings, job log, inventory, maintenance) and settings/backups. */
(function () {
  "use strict";
  const { html, $, $$, U, fmt, group, table, note, tile, tiles, openForm, toast, api, store, download, confirmDialog } = App;
  const IN = 25.4;
  const MATS = [["aluminum", "Aluminum"], ["polycarbonate", "Polycarbonate"], ["spoilboard", "Spoilboard"]];
  const MAT_LABEL = Object.fromEntries(MATS);
  const OPS = [...Object.entries(Cnc.OPS).map(([k, o]) => [k, o.label]), ["surface", "Surfacing (facemill)"]];
  const today = () => { const d = new Date(); return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0"); };
  const toolName = id => { const t = id ? App.toolById(id) : null; return t ? t.name : id ? "(deleted tool)" : "–"; };
  const toolOptions = (withNone) => [...(withNone ? [[0, "Not sure / not listed"]] : []), ...(App.data.tools || []).slice().sort((a, b) => a.nominal_mm - b.nominal_mm).map(t => [t.id, t.name])];
  // Spreadsheets run cells that start with = + - @ as formulas, and notes are typed by anyone: defuse them with a leading apostrophe.
  const csvCell = v => { let s = String(v == null ? "" : v); if (/^[=+\-@\t\r]/.test(s) && isNaN(Number(s))) s = "'" + s; return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };

  /**
   * One list page. Each row has an Edit button (plus any page-specific quick action); copy and delete live inside the edit dialog.
   * cfg: {id, title, entity, intro, fields, columns:[[head, row=>html]], sort(a,b), load(), blank(), name(row), actions(row)=>html, onAction(act,row), filterable, csv, foot}
   */
  function crudPage(cfg) {
    let filterText = "";
    App.register({
      id: cfg.id, title: cfg.title, keywords: cfg.keywords || "",
      async render(root) {
        const rows = (cfg.load ? await cfg.load() : App.data[cfg.entity]).slice().sort(cfg.sort || ((a, b) => a.id - b.id));
        root.innerHTML = html`
          <div class="bar"><h1>${cfg.title}</h1><div class="btns">${cfg.csv ? html`<button class="btn" id="csv">Download CSV</button>` : ""}<button class="btn pri" id="add">${cfg.addLabel || "Add"}</button></div></div>
          ${cfg.intro ? html`<p class="mut lead">${cfg.intro}</p>` : ""}
          ${cfg.summary ? cfg.summary(rows) : ""}
          <section class="card">
            ${rows.length > 6 ? html`<div class="field"><label for="flt">Filter</label><input id="flt" type="search" placeholder="Type to filter…" value="${filterText}"></div>` : ""}
            <div id="list"></div>
            ${cfg.foot || ""}
          </section>`.s;
        const draw = () => {
          const q = filterText.trim().toLowerCase();
          const shown = q ? rows.filter(r => JSON.stringify(Object.values(r)).toLowerCase().includes(q) || (cfg.searchText ? cfg.searchText(r).toLowerCase().includes(q) : false)) : rows;
          $("#list", root).innerHTML = shown.length ? html`<div class="tw"><table class="resp rec"><thead><tr>${cfg.columns.map(c => html`<th scope="col">${c[0]}</th>`)}<th></th></tr></thead><tbody>
            ${shown.map(r => html`<tr class="${cfg.rowClass ? cfg.rowClass(r) : ""}">${cfg.columns.map(c => html`<td data-label="${c[0]}"><div>${c[1](r)}</div></td>`)}<td class="act">${cfg.actions ? cfg.actions(r) : ""}<button class="btn sm" data-act="edit" data-id="${r.id}">Edit</button></td></tr>`)}
            </tbody></table></div>`.s : html`<p class="mut">${rows.length ? "No matches." : cfg.empty || "Nothing here yet."}</p>`.s;
        };
        draw();
        const flt = $("#flt", root);
        if (flt) flt.oninput = () => { filterText = flt.value; draw(); };
        const edit = (row, isNew) => {
          const fields = typeof cfg.fields === "function" ? cfg.fields() : cfg.fields;
          const body = v => Object.fromEntries(fields.map(f => [f.id, v[f.id] == null && f.type !== "text" && f.type !== "textarea" && f.type !== "date" ? f.def : v[f.id]]));
          const what = cfg.name ? cfg.name(row) : "this entry";
          openForm({
            title: (isNew ? "Add " : "Edit ") + (cfg.noun || cfg.title.toLowerCase().replace(/s$/, "")), fields, values: row, submit: "Save", fold: { label: cfg.foldLabel },
            onSubmit: async v => { await App.save(cfg.entity, isNew ? null : row.id, body(v)); toast("Saved"); },
            extra: isNew ? [] : [
              { label: "Make a copy", onClick: () => {
                const c = Object.assign({}, row); delete c.id;
                if (c.name) c.name += " copy"; if (c.task) c.task += " copy";
                $("#dlg").close(); edit(c, true); return false;
              } },
              { label: "Delete", cls: "del", onClick: async () => {
                if (!(await confirmDialog(`Delete “${what}”?` + (cfg.deleteWarning ? "\n\n" + cfg.deleteWarning(row) : "") + "\n\n(A backup is kept automatically.)"))) return false;
                await App.remove(cfg.entity, row.id); toast("Deleted");
              } },
            ],
          });
        };
        $("#add", root).onclick = () => edit(cfg.blank ? cfg.blank() : {}, true);
        if (cfg.csv) $("#csv", root).onclick = () => download(`${cfg.id}.csv`, [cfg.csv.map(c => csvCell(c[0])).join(","), ...rows.map(r => cfg.csv.map(c => csvCell(c[1](r))).join(","))].join("\n"), "text/csv");
        root.addEventListener("click", async e => {
          const b = e.target.closest("button[data-act]");
          if (!b) return;
          const row = rows.find(r => r.id === +b.dataset.id);
          if (!row) return;
          try {
            if (b.dataset.act === "edit") edit(row, false);
            else if (cfg.onAction) await cfg.onAction(b.dataset.act, row);
          } catch (x) { toast(x.message, true); }
        });
        if (cfg.after) cfg.after(root);
      },
    });
  }

  // ------------------------------------------------------------------ Tool library
  const toolFields = () => [
    { id: "name", label: "Name", type: "text", max: 120, def: "", wide: true },
    { id: "kind", label: "Type", type: "select", def: "flat", options: [["flat", "Flat endmill"], ["ball", "Ball nose"], ["bull", "Bull nose"], ["face", "Facemill / surfacing bit"], ["drill", "Drill"], ["other", "Other"]] },
    { id: "nominal_mm", label: "Size on the label", type: "len", def: 6, hint: "What's printed on it." },
    { id: "actual_mm", label: "Real cutting diameter", type: "len", def: 6, hint: "Measured. Calculations use this one. Use Hole & Tool Size to measure it from a test cut." },
    { id: "flutes", label: "Flutes", type: "int", def: 1, min: 1, max: 12, dp: 0 },
    { id: "mat", label: "Tool material", type: "select", def: "carbide", options: [["carbide", "Carbide"], ["hss", "HSS"]] },
    { id: "flute_len_mm", label: "Flute (cutting) length", type: "len", def: 12 },
    { id: "notes", label: "Notes", type: "textarea", def: "", wide: true },
    { id: "vendor", adv: true, label: "Vendor", type: "text", max: 120, def: "" },
    { id: "overall_mm", adv: true, label: "Overall length", type: "len", def: 50 },
    { id: "shank_mm", adv: true, label: "Shank diameter", type: "len", def: 6 },
    { id: "coating", adv: true, label: "Coating", type: "text", max: 60, def: "" },
    { id: "feed_factor", adv: true, label: "Feed factor", type: "num", def: 1, min: 0.2, max: 2, hint: "1 = normal. Use less than 1 for a flimsy or worn tool." },
  ];
  crudPage({
    id: "tools", title: "Tool Library", entity: "tools", noun: "tool", keywords: "endmill facemill bits library diameter flutes thrifty",
    intro: "The endmills and facemills the shop owns. Calculators use the real cutting diameter.",
    fields: toolFields, foldLabel: "More about this tool", empty: "No tools yet. Add your first endmill.",
    sort: (a, b) => (a.kind === "face") - (b.kind === "face") || a.nominal_mm - b.nominal_mm || a.name.localeCompare(b.name),
    blank: () => ({ nominal_mm: 6, actual_mm: 6, flute_len_mm: 12, overall_mm: 50, shank_mm: 6 }),
    columns: [["Name", t => html`<b>${t.name}</b><span class="sub">${[t.vendor, t.kind === "flat" ? "" : t.kind, t.mat, t.coating].filter(Boolean).join(" · ")}</span>`],
      ["Really cuts", t => html`<b>${U.fmt("len", t.actual_mm, 3)}</b>${Math.abs(t.actual_mm - t.nominal_mm) > 0.05 ? html`<span class="sub">label says ${U.fmt("len", t.nominal_mm, 3)}</span>` : ""}`],
      ["Flutes", t => t.flutes], ["Flute length", t => U.fmt("len", t.flute_len_mm, 2)],
      ["Tested settings", t => (App.data.recipes || []).filter(r => r.tool_id === t.id).length || "–"]],
    name: t => t.name,
    deleteWarning: t => { const n = (App.data.recipes || []).filter(r => r.tool_id === t.id).length; return n ? `Its ${n} tested setting${n > 1 ? "s" : ""} will be deleted too.` : ""; },
    foot: html`<p class="mut small foot">Deleted one of the built-in tools by accident? <button class="btn link" id="restore">Restore built-in tools</button> (anything you edited stays as it is).</p>`,
    after: root => {
      const b = $("#restore", root);
      if (b) b.onclick = async () => {
        try { await api("POST", "/api/restore-defaults", {}); await App.reload(); toast("Built-in tools and tested settings restored"); }
        catch (x) { toast(x.message, true); }
      };
    },
  });

  // ------------------------------------------------------------------ Tested settings
  // the preset's name is worth showing only when it says more than the material column already does
  const DULL_NAMES = new Set(["aluminum", "poly", "polycarbonate", "spoilboard", "default preset"]);
  const presetName = r => (r.label && !DULL_NAMES.has(r.label.toLowerCase().trim()) ? html`<span class="sub">${r.label}</span>` : "");
  crudPage({
    id: "tested", title: "Tested Settings", entity: "recipes", noun: "tested setting", keywords: "recipes known good proven saved presets",
    intro: "Settings the team has actually run. Feeds & Speeds uses them first.",
    foldLabel: "More numbers", empty: "Nothing saved yet. Run a part, then use “Save as tested” on the Feeds & Speeds page.",
    fields: () => [
      { id: "tool_id", label: "Tool", type: "select", number: true, def: ((App.data.tools || [])[0] || {}).id || 0, options: () => toolOptions(false) },
      { id: "material", label: "Material", type: "select", def: "aluminum", options: MATS },
      { id: "op", label: "Operation", type: "select", def: "slot", options: OPS },
      { id: "label", label: "Name", type: "text", max: 60, def: "", placeholder: "e.g. 1/8 in plate" },
      { id: "rpm", label: "Spindle speed (rpm)", type: "num", dp: 0, def: 0 },
      { id: "feed_mm", label: "Cutting feed", type: "feed", def: 0 },
      { id: "doc_mm", label: "Depth per pass (0 = not recorded)", type: "len", def: 0 },
      { id: "rating", label: "Rating", type: "select", number: true, def: 4, options: [[5, "★★★★★ Perfect"], [4, "★★★★ Good"], [3, "★★★ OK"], [2, "★★ Rough"], [1, "★ Bad"]] },
      { id: "notes", label: "Notes", type: "textarea", def: "", wide: true },
      { id: "plunge_mm", adv: true, label: "Plunge feed", type: "feed", def: 0 },
      { id: "ramp_mm", adv: true, label: "Ramp feed", type: "feed", def: 0 },
      { id: "woc_mm", adv: true, label: "Width of cut", type: "len", def: 0 },
    ],
    blank: () => ({ tool_id: ((App.data.tools || [])[0] || {}).id || 0 }),
    sort: (a, b) => toolName(a.tool_id).localeCompare(toolName(b.tool_id)) || a.material.localeCompare(b.material) || a.id - b.id,
    columns: [["Tool", r => html`<b>${toolName(r.tool_id)}</b>${presetName(r)}`], ["Material", r => MAT_LABEL[r.material]], ["Spindle", r => group(r.rpm) + " rpm"],
      ["Feed", r => { const [a, b] = U.both("feed", r.feed_mm); return html`${a}<span class="sub">${b}</span>`; }], ["Depth per pass", r => (r.doc_mm ? U.fmt("len", r.doc_mm, 4) : "–")],
      ["Rating", r => html`<span class="stars">${"★".repeat(r.rating)}</span>`]],
    searchText: r => toolName(r.tool_id) + " " + MAT_LABEL[r.material],
    name: r => `${toolName(r.tool_id)} in ${MAT_LABEL[r.material]}`,
  });

  // ------------------------------------------------------------------ Job log
  const jobFields = () => [
    { id: "date", label: "Date", type: "date", def: today() },
    { id: "name", label: "Part / job", type: "text", max: 120, def: "", wide: true, placeholder: "e.g. Intake gusset, batch of 8" },
    { id: "operator", label: "Who ran it", type: "text", max: 60, def: store.get("operator", "") },
    { id: "material", label: "Material", type: "select", def: "aluminum", options: MATS },
    { id: "tool_id", label: "Tool", type: "select", number: true, def: 0, options: () => toolOptions(true) },
    { id: "result", label: "How did it come out?", type: "select", def: "ok", options: [["great", "Great"], ["ok", "OK"], ["bad", "Bad (note why)"]] },
    { id: "minutes", label: "Run time (minutes)", type: "num", def: 0 },
    { id: "notes", label: "Notes", type: "textarea", def: "", wide: true, placeholder: "Anything the next person should know" },
    { id: "thickness_mm", adv: true, label: "Thickness", type: "len", def: 0 },
    { id: "rpm", adv: true, label: "Spindle speed (rpm)", type: "num", dp: 0, def: 0 },
    { id: "feed_mm", adv: true, label: "Cutting feed", type: "feed", def: 0 },
    { id: "doc_mm", adv: true, label: "Depth per pass", type: "len", def: 0 },
  ];
  /** Open the "log a job" dialog with some fields prefilled (used by the calculators too). */
  App.openJobDialog = pre => {
    const fields = jobFields();
    openForm({
      title: "Log this job", fields, values: Object.assign({ date: today(), operator: store.get("operator", ""), name: "" }, pre || {}), submit: "Save to job log", fold: { label: "Settings used" },
      onSubmit: async v => {
        if (v.operator) store.set("operator", v.operator);
        await App.save("joblog", null, Object.fromEntries(fields.map(f => [f.id, v[f.id] == null && f.type !== "text" && f.type !== "textarea" && f.type !== "date" ? f.def : v[f.id]])));
        toast("Logged");
      },
    });
  };
  crudPage({
    id: "joblog", title: "Job Log", entity: "joblog", noun: "job", keywords: "history parts runs who ran log notes",
    intro: "What got cut, by whom, and how it went.",
    empty: "No jobs logged yet. After a run, use “Log this job” on the Feeds & Speeds page or add one here.",
    load: () => api("GET", "/api/joblog"), foldLabel: "Settings used", fields: jobFields, blank: () => ({ date: today(), operator: store.get("operator", "") }),
    sort: (a, b) => (b.date || "").localeCompare(a.date || "") || b.id - a.id,
    columns: [["Date", j => j.date], ["Job", j => html`<b>${j.name}</b>${j.notes ? html`<span class="sub">${j.notes}</span>` : ""}`], ["Who", j => j.operator || "–"],
      ["Material", j => html`${MAT_LABEL[j.material]}<span class="sub">${toolName(j.tool_id)}${j.thickness_mm ? ", " + U.fmt("len", j.thickness_mm, 3) : ""}</span>`],
      ["Settings", j => (j.rpm ? html`${group(j.rpm)} rpm, ${U.both("feed", j.feed_mm)[0]}${j.minutes ? html`<span class="sub">${fmt(j.minutes, 1)} min</span>` : ""}` : "–")],
      ["Result", j => html`<span class="badge ${j.result === "great" ? "ok" : j.result === "bad" ? "bad" : "info"}">${j.result}</span>`]],
    csv: [["Date", j => j.date], ["Job", j => j.name], ["Operator", j => j.operator], ["Material", j => j.material], ["Tool", j => toolName(j.tool_id)], ["Thickness mm", j => j.thickness_mm],
      ["RPM", j => j.rpm], ["Feed mm/min", j => j.feed_mm], ["Depth mm", j => j.doc_mm], ["Minutes", j => j.minutes], ["Result", j => j.result], ["Notes", j => j.notes]],
    name: j => j.name,
    summary: rows => {
      const mins = rows.reduce((s, j) => s + (j.minutes || 0), 0);
      return rows.length ? tiles([tile("Jobs logged", String(rows.length)), tile("Machine time", fmt(mins / 60, 1) + " h"), tile("Went badly", String(rows.filter(j => j.result === "bad").length))]) : "";
    },
  });

  // ------------------------------------------------------------------ Inventory
  const CATS = [["stock", "Stock (tube, plate, sheet)"], ["endmill", "Endmills & bits"], ["hardware", "Hardware"], ["consumable", "Consumables"], ["other", "Other"]];
  const CAT_LABEL = Object.fromEntries(CATS);
  crudPage({
    id: "inventory", title: "Inventory", entity: "inventory", noun: "item", keywords: "stock hardware screws endmills supplies reorder low",
    intro: "Stock, bits, hardware and supplies. Low items are flagged so you can reorder in time.",
    empty: "Nothing tracked yet. Add endmills, tube stock, screws, WD-40: whatever you run out of.",
    fields: () => [
      { id: "name", label: "Item", type: "text", max: 120, def: "", wide: true, placeholder: "e.g. 1x1x1/16 aluminum tube, 6 ft" },
      { id: "category", label: "Category", type: "select", def: "stock", options: CATS },
      { id: "qty", label: "How many we have", type: "num", def: 0 },
      { id: "unit", label: "Unit", type: "text", max: 20, def: "ea", placeholder: "ea, ft, sheets…" },
      { id: "min_qty", label: "Reorder when at or below", type: "num", def: 0, hint: "0 = don't track" },
      { id: "location", label: "Where it lives", type: "text", max: 80, def: "" },
      { id: "notes", label: "Notes", type: "textarea", def: "", wide: true },
    ],
    sort: (a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name),
    rowClass: i => (i.min_qty > 0 && i.qty <= i.min_qty ? "low" : ""),
    columns: [["Item", i => html`<b>${i.name}</b><span class="sub">${[CAT_LABEL[i.category], i.location].filter(Boolean).join(" · ")}</span>`], ["Have", i => html`<b>${fmt(i.qty, 2)}</b> ${i.unit}`],
      ["Reorder at", i => (i.min_qty ? fmt(i.min_qty, 2) : "–")], ["Status", i => (i.min_qty > 0 && i.qty <= i.min_qty ? html`<span class="badge bad">Low</span>` : html`<span class="badge ok">OK</span>`)]],
    actions: i => html`<button class="btn sm" data-act="minus" data-id="${i.id}" aria-label="Use one">−1</button><button class="btn sm" data-act="plus" data-id="${i.id}" aria-label="Add one">+1</button>`,
    onAction: async (act, row) => {
      if (act !== "plus" && act !== "minus") return;
      await App.save("inventory", row.id, { qty: Math.max(0, row.qty + (act === "plus" ? 1 : -1)) });
    },
    csv: [["Item", i => i.name], ["Category", i => i.category], ["Qty", i => i.qty], ["Unit", i => i.unit], ["Reorder at", i => i.min_qty], ["Location", i => i.location], ["Notes", i => i.notes]],
    name: i => i.name,
    summary: rows => { const low = rows.filter(i => i.min_qty > 0 && i.qty <= i.min_qty); return low.length ? note("warn", `Low or out: ${low.map(i => i.name).join(", ")}`) : ""; },
  });

  // ------------------------------------------------------------------ Maintenance
  // older databases stored the starter notes as "Suggested: ..." (or just "Suggested task."): show the useful part only
  const maintNote = m => { const n = (m.notes || "").replace(/^Suggested:\s*/i, "").trim(); return /^Suggested task\.?$/i.test(n) ? "" : n; };
  crudPage({
    id: "maint", title: "Maintenance", entity: "maintenance", noun: "task", keywords: "service lubricate rails collet spindle cooling schedule overdue",
    intro: "Recurring machine care. The intervals are suggestions: change them to fit your manual and how much you run the machine.",
    empty: "No tasks yet.",
    fields: () => [
      { id: "task", label: "Task", type: "text", max: 120, def: "", wide: true },
      { id: "machine", label: "Machine", type: "text", max: 60, def: "OMIO X8" },
      { id: "interval_days", label: "Repeat every (days, 0 = as needed)", type: "int", def: 30, dp: 0 },
      { id: "last_done", label: "Last done", type: "date", def: "" },
      { id: "notes", label: "Notes", type: "textarea", def: "", wide: true },
    ],
    sort: (a, b) => { const sa = App.maintStatus(a), sb = App.maintStatus(b); return (sa.overdue ? 0 : 1) - (sb.overdue ? 0 : 1) || (sa.days ?? 1e9) - (sb.days ?? 1e9) || a.id - b.id; },
    rowClass: m => (App.maintStatus(m).overdue ? "low" : ""),
    columns: [["Task", m => html`<b>${m.task}</b>${maintNote(m) ? html`<span class="sub">${maintNote(m)}</span>` : ""}`], ["Every", m => (m.interval_days ? m.interval_days + " days" : "As needed")],
      ["Last done", m => m.last_done || "never"], ["Status", m => { const s = App.maintStatus(m); return html`<span class="badge nowrap ${s.overdue ? "bad" : s.never ? "info" : s.days != null && s.days <= 7 ? "warn" : "ok"}">${s.text}</span>`; }]],
    actions: m => html`<button class="btn sm pri" data-act="done" data-id="${m.id}">Done today</button>`,
    onAction: async (act, row) => { if (act === "done") { await App.save("maintenance", row.id, { last_done: today() }); toast("Marked done"); } },
    name: m => m.task,
    summary: rows => {
      const od = rows.filter(m => App.maintStatus(m).overdue), fresh = rows.filter(m => App.maintStatus(m).never);
      if (od.length) return note("warn", `${od.length} task${od.length > 1 ? "s" : ""} overdue: ${od.map(m => m.task).join("; ")}`);
      return fresh.length ? note("info", `Nothing overdue. ${fresh.length} task${fresh.length > 1 ? "s haven't" : " hasn't"} been started: press “Done today” as you do ${fresh.length > 1 ? "them" : "it"} to start the clock.`) : note("ok", "Nothing is overdue.");
    },
  });

  // ================================================================== Settings & data
  const setFields = [
    { id: "units", label: "Default units for new visitors", type: "select", def: "in", options: [["in", "Inches / pounds"], ["mm", "Millimetres / kilograms"]] },
    { id: "max_rpm", label: "Maximum spindle speed (rpm)", type: "num", dp: 0, def: 24000 },
    { id: "max_feed_mm", label: "Maximum cutting feed", type: "feed", def: 4000 },
    { id: "table_x_mm", label: "Table travel, X", type: "len", def: 565 },
    { id: "table_y_mm", label: "Table travel, Y", type: "len", def: 770 },
    { id: "z_travel_mm", label: "Travel, Z", type: "len", def: 85 },
    { id: "min_rpm", adv: true, label: "Lowest spindle speed to use (rpm)", type: "num", dp: 0, def: 5000 },
    { id: "spindle_w", adv: true, label: "Spindle power (W)", type: "num", dp: 0, def: 2200 },
    { id: "defl_limit_mm", adv: true, label: "Allowed tool deflection", type: "len", def: 0.02, hint: "0.02 mm (0.0008 in) is a good limit for clean walls." },
    { id: "weight_limit_lb", adv: true, label: "Robot weight limit (lb)", type: "num", def: 115, hint: "Without bumpers and battery. 115 lb for the 2025 and 2026 seasons (135 lb with bumpers); check the current manual." },
  ];

  App.register({
    id: "settings", title: "Settings & Backups", keywords: "settings machine limits max rpm feed backup restore export import units spindle travel weight limit",
    async render(root) {
      const vals = Object.assign({}, App.data.settings);
      let backups = [];
      try { backups = (await api("GET", "/api/backups")).backups || []; } catch (e) { /* the list is a nicety; the page works without it */ }
      root.innerHTML = html`
        <h1>Settings &amp; Backups</h1>
        <div class="grid2">
          <section class="card"><h2>Machine limits</h2>
            <p class="mut small">The defaults match the OMIO X8. Every calculator stays inside these limits.</p>
            <div id="sform"></div><div class="err" id="serr" role="alert" hidden></div>
            <div class="dact"><button class="btn pri" id="ssave">Save</button></div></section>
          <section class="card"><h2>Backups</h2>
            <p class="mut small">Snapshots are taken automatically (on start, every few hours of edits, and before any restore or import). Restoring puts the shared data back exactly as it was.</p>
            <div class="btns"><button class="btn pri" id="bnow">Back up now</button><button class="btn" id="bdl">Download everything</button><label class="btn">Restore from file…<input type="file" id="bfile" accept="application/json,.json" hidden></label></div>
            ${backups.length ? table(["Snapshot", "Size", ""], backups.slice(0, 12).map(b => [new Date(b.time * 1000).toLocaleString(), fmt(b.size / 1024, 0) + " KB", html`<button class="btn sm" data-restore="${b.name}">Restore</button>`])) : html`<p class="mut">No snapshots yet.</p>`}
          </section>
        </div>
        <p class="mut small foot">Shop Toolkit ${App.data.version}. No login: anyone with the link can use and edit the shared data (tools, tested settings, job log, inventory, maintenance). Your units and last inputs stay in your own browser. All feeds and speeds are starting points: run a scrap test first.
          <button class="btn link" id="resetLocal">Forget my saved choices on this device</button></p>`.s;
      App.mountForm($("#sform", root), setFields, vals, "settings", () => {});
      $("#ssave", root).onclick = async () => {
        const err = $("#serr", root); err.hidden = true;
        try {
          const body = Object.fromEntries(setFields.map(f => [f.id, vals[f.id] == null ? f.def : vals[f.id]]));
          await api("PUT", "/api/settings", body);
          await App.load(); toast("Saved");
        } catch (e) { err.textContent = App.friendlyError(e.message, setFields.map(f => Object.assign({}, f, { serverName: f.id }))); err.hidden = false; }
      };
      $("#bnow", root).onclick = async () => { try { await api("POST", "/api/backups", {}); toast("Backup saved"); App.rerender(); } catch (e) { toast(e.message, true); } };
      $("#bdl", root).onclick = async () => {
        try { const r = await fetch("/api/export"); if (!r.ok) throw new Error("Export failed"); download("shop-data-" + today() + ".json", await r.text(), "application/json"); }
        catch (e) { toast(e.message, true); }
      };
      $("#bfile", root).onchange = async e => {
        const f = e.target.files[0]; if (!f) return;
        try {
          if (f.size > 8e6) throw new Error("That file is too big to be a backup.");
          const data = JSON.parse(await f.text());
          if (!(await confirmDialog(`Replace ALL shared data with the contents of “${f.name}”?\n\nA snapshot of the current data is saved first so you can undo this.`))) return;
          await api("POST", "/api/import", data); await App.load(); toast("Restored"); App.rerender();
        } catch (x) { toast(x instanceof SyntaxError ? "That isn't a valid backup file." : x.message, true); }
        e.target.value = "";
      };
      $("#bnow", root).closest(".grid2").addEventListener("click", async e => {
        const b = e.target.closest("[data-restore]");
        if (!b) return;
        if (!(await confirmDialog("Restore this snapshot? Current data is backed up first, so you can undo it."))) return;
        try { await api("POST", "/api/backups/restore", { name: b.dataset.restore }); await App.load(); toast("Restored"); App.rerender(); } catch (x) { toast(x.message, true); }
      });
      $("#resetLocal", root).onclick = () => { try { Object.keys(localStorage).filter(k => k.startsWith("shop:")).forEach(k => localStorage.removeItem(k)); } catch (e) { /* ignore */ } toast("Cleared"); location.reload(); };
    },
  });
})();
