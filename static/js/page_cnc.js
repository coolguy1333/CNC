/* CNC router pages: feeds & speeds, spoilboard surfacing, hole/tool sizing. */
(function () {
  "use strict";
  const { html, $, $$, U, fmt, group, tile, tiles, note, table, kvTable, openForm, copyText, store, toast } = App;
  const IN = 25.4;

  const MAT_LABEL = { aluminum: "Aluminum", polycarbonate: "Polycarbonate", spoilboard: "Spoilboard" };
  const COOL = [["mist", "Mist or flood, plus air"], ["air", "Air blast only"], ["none", "None"]];
  const THICK = [[1.5875, '1/16"'], [3.175, '1/8"'], [4.7625, '3/16"'], [6.35, '1/4"'], [9.525, '3/8"'], [12.7, '1/2"']];
  const toolSort = (a, b) => a.nominal_mm - b.nominal_mm || a.name.localeCompare(b.name);
  const isFace = t => t.kind === "face";

  function toolLabel(t) {
    const cuts = Math.abs(t.actual_mm - t.nominal_mm) > 0.05 ? ` (cuts ${U.fmt("len", t.actual_mm)})` : "";
    return t.name + cuts;
  }
  const toolList = face => (App.data.tools || []).filter(t => isFace(t) === face).sort(toolSort);

  /** toolId: -1 = not chosen yet, 0 = "Other size…", otherwise a library tool of the right kind. */
  function normalizeTool(v, face) {
    const t = v.toolId > 0 ? App.toolById(v.toolId) : null;
    if (v.toolId > 0 && !(t && isFace(t) === face)) v.toolId = -1;
    if (v.toolId === -1) {
      const list = toolList(face);
      const pref = list.find(x => /thrifty bot 5/i.test(x.name)) || list[0];
      v.toolId = pref ? pref.id : 0;
    }
  }
  /** The tool the form describes: a library tool, or the custom one typed in. */
  function chosenTool(v, face) {
    if (v.toolId > 0) return App.toolById(v.toolId) || null;
    if (!(v.cDia > 0)) return null;
    return { id: 0, name: "Custom tool", kind: face ? "face" : "flat", nominal_mm: v.cDia, actual_mm: v.cDia, flutes: v.cFlutes || 1,
      flute_len_mm: v.cFlute > 0 ? v.cFlute : v.cDia * 2.5, overall_mm: 0, mat: v.cMat || "carbide", feed_factor: 1 };
  }
  /** Tested settings for a tool + material, best first. */
  function testedFor(toolId, material, op) {
    return (App.data.recipes || []).filter(r => r.tool_id === toolId && r.material === material && (op ? r.op === op : true))
      .sort((a, b) => b.rating - a.rating || a.id - b.id);
  }
  const rpmFmt = r => group(r) + " rpm";

  // ================================================================== Feeds & Speeds
  // The page asks for the material and the endmill. Everything under "More options" has a sensible default.
  const cncFields = [
    { id: "material", label: "What are you cutting?", type: "seg", wide: true, def: "aluminum", options: [["aluminum", "Aluminum"], ["polycarbonate", "Polycarbonate"], ["spoilboard", "Spoilboard"]] },
    { id: "toolId", label: v => (v.material === "spoilboard" ? "Facemill" : "Endmill"), type: "select", wide: true, number: true, def: -1,
      options: v => [...toolList(v.material === "spoilboard").map(t => [t.id, toolLabel(t)]), [0, "Other size…"]] },
    { id: "cDia", label: "Cutting diameter", type: "len", def: 6.35, show: v => !v.toolId, hint: "Measure it with calipers. Cheap tools often cut a bit under their label." },
    { id: "cFlutes", label: "Flutes", type: "int", def: 1, show: v => !v.toolId, min: 1, max: 12, dp: 0 },
    { id: "cFlute", label: "Flute (cutting) length", type: "len", def: 19, show: v => !v.toolId },
    { id: "cMat", label: "Tool material", type: "select", def: "carbide", show: v => !v.toolId, options: [["carbide", "Carbide"], ["hss", "HSS"]] },
    { id: "depth", label: "Depth to remove", type: "len", def: 0.5, show: v => v.material === "spoilboard",
      hint: "How much spoilboard to skim off. 0.5 mm (0.020 in) is plenty for a flatten." },
    { id: "op", adv: true, label: "Operation", type: "select", wide: true, def: "slot", show: v => v.material !== "spoilboard",
      options: () => Object.entries(Cnc.OPS).map(([k, o]) => [k, o.label]) },
    { id: "thkPreset", adv: true, label: "Material thickness", type: "select", wide: true, def: "3.175", show: v => v.material !== "spoilboard",
      options: () => [...THICK.map(([mm, l]) => [String(mm), `${l} (${fmt(mm, 2)} mm)`]), ["custom", "Other…"]] },
    { id: "thk", adv: true, label: "Thickness / depth to cut", type: "len", wide: true, def: 3.175, show: v => v.material !== "spoilboard" && v.thkPreset === "custom" },
    { id: "through", adv: true, type: "check", label: "Through-cut", checkLabel: "Also cut a little into the spoilboard (so it goes all the way through)", def: false, show: v => v.material !== "spoilboard" },
    { id: "extra", adv: true, label: "Extra depth into spoilboard", type: "len", def: 0.2, show: v => v.material !== "spoilboard" && v.through },
    { id: "cool", adv: true, label: "Cooling", type: "select", wide: true, def: "mist", options: COOL, show: v => v.material !== "spoilboard" },
    { id: "agg", adv: true, label: "How hard to push", type: "seg", number: true, def: 1, options: [[0.8, "Careful"], [1, "Normal"], [1.15, "Push"]] },
    { id: "stick", adv: true, label: "Stick-out (0 = automatic)", type: "len", def: 0, show: v => v.material !== "spoilboard", hint: "How far the tool sticks out of the collet. Shorter is stiffer." },
    { id: "cutLen", adv: true, label: "Toolpath length (for a time estimate)", type: "len", def: 0, hint: "Total length the cutter travels per pass (CAM shows it). 0 = skip." },
  ];

  App.register({
    id: "cnc", title: "Feeds & Speeds", keywords: "router omio endmill rpm feed aluminum polycarbonate spoilboard facemill chipload",
    render(root) {
      const vals = App.pageVals("cnc", cncFields);
      normalizeTool(vals, vals.material === "spoilboard");

      root.innerHTML = html`
        <h1>Feeds &amp; Speeds</h1>
        <p class="mut lead">Pick the material and the endmill. You get the numbers to type into CAM.</p>
        <div class="two">
          <section class="card"><div id="form"></div></section>
          <section class="card" id="out" aria-live="polite"></section>
        </div>`.s;

      let tool = null, form;
      const onChange = (id, redraw) => {
        if (id === "material") {
          vals.toolId = -1;
          normalizeTool(vals, vals.material === "spoilboard");
          vals.cool = vals.material === "aluminum" ? "mist" : "air";
          redraw();
        } else if (id === "thkPreset" && vals.thkPreset !== "custom") {
          vals.thk = +vals.thkPreset;
        }
        update();
      };
      form = App.mountForm($("#form", root), cncFields, vals, "cnc", onChange);

      function update() {
        App.persist("cnc", vals);
        const face = vals.material === "spoilboard";
        tool = chosenTool(vals, face);
        const out = $("#out", root);
        const chk = App.checkVals(cncFields, vals);
        if (chk.issues.length) {
          out.innerHTML = html`<h2>Recommended settings</h2>${chk.issues.map(t => note("info", t))}`.s;
          if (chk.bad.some(id => (cncFields.find(f => f.id === id) || {}).adv)) form.openMore();
          return;
        }
        if (!tool) {
          out.innerHTML = html`<h2>Recommended settings</h2><p class="mut">${face ? "Add a facemill in the Tool Library, or enter its size." : "Pick an endmill, or choose “Other size…” and enter its diameter."}</p>`.s;
          return;
        }
        const thicknessMm = vals.thkPreset === "custom" ? (vals.thk > 0 ? vals.thk : 0) : +vals.thkPreset;
        const total = face ? Math.max(0, vals.depth || 0) : thicknessMm + (vals.through && vals.extra > 0 ? vals.extra : 0);
        const tested = tool.id ? testedFor(tool.id, vals.material, face ? "surface" : "slot") : [];
        let recipe = tested.find(r => r.id === vals.preset) || tested[0] || null;
        let res;
        try {
          res = Cnc.recommend({ material: vals.material, tool, op: face ? "surface" : vals.op, total_mm: total, stock_mm: face ? 0 : thicknessMm, stick_mm: vals.stick || 0, cool: vals.cool,
            agg: vals.agg || 1, machine: App.machine(), recipe, stepover: 0.7 });
        } catch (e) { out.innerHTML = html`<h2>Recommended settings</h2>${note("bad", e.message)}`.s; return; }
        renderResult(out, res, tool, tested, recipe, total, thicknessMm, face);
      }

      function camText(res, tool, total) {
        const f = (kind, mm) => U.both(kind, mm).join(" = ");
        const lines = [
          `Material: ${MAT_LABEL[res.material]}`,
          `Tool: ${tool.name}, ${tool.flutes} flute${tool.flutes > 1 ? "s" : ""}, CAM diameter ${fmt(tool.actual_mm, 3)} mm (${fmt(tool.actual_mm / IN, 4)} in)`,
          `Spindle speed: ${Math.round(res.rpm)} rpm (${Math.round(res.sfm)} SFM)`,
          `Cutting feedrate: ${f("feed", res.feed)}`,
          `Plunge feedrate: ${f("feed", res.plunge)}`,
          `Ramp feedrate: ${f("feed", res.ramp)}, ramp angle ${res.rampAngle} deg`,
          `Feed per tooth: ${fmt(res.fz, 4)} mm (${fmt(res.fz / IN, 5)} in)`,
          res.passes ? `Depth per pass (max stepdown): ${fmt(res.docPass, 4)} mm (${fmt(res.docPass / IN, 4)} in) -> ${res.passes} pass${res.passes > 1 ? "es" : ""} for ${fmt(total, 3)} mm total` : `Max stepdown: ${fmt(res.doc, 4)} mm (${fmt(res.doc / IN, 4)} in)`,
          res.material === "spoilboard" ? `Stepover: ${fmt(res.ae, 1)} mm (${fmt(res.aeFrac * 100, 0)}% of the cutter)` : `Max stepover: ${res.aeFrac >= 0.999 ? "full width (slot)" : fmt(res.ae, 2) + " mm (" + fmt(res.aeFrac * 100, 0) + "% of the tool)"}`,
        ];
        return lines.join("\n");
      }

      function renderResult(out, res, tool, tested, recipe, total, thicknessMm, face) {
        const [feedA, feedB] = U.both("feed", res.feed);
        const [plA, plB] = U.both("feed", res.plunge);
        const [rpA] = U.both("feed", res.ramp);
        const badge = res.source === "tested" ? html`<span class="badge ok">Team-tested setting</span>` :
          res.source === "tested-scaled" ? html`<span class="badge info">Scaled from your tested setting</span>` : html`<span class="badge info">Calculated</span>`;
        const ipt = U.isImp() ? `${fmt(res.fz / IN, 5)} in/tooth` : `${fmt(res.fz, 4)} mm/tooth`;
        const mrr = U.isImp() ? `${fmt(res.mrr / 16387.064, 3)} in³/min` : `${fmt(res.mrr / 1000, 1)} cm³/min`;
        const stepover = face ? `${U.fmt("len", res.ae)}` : res.aeFrac >= 0.999 ? "Full slot" : U.fmt("len", res.ae);
        const stepSub = face ? "70% of the cutter" : res.aeFrac >= 0.999 ? `= tool diameter ${U.fmt("len", tool.actual_mm)}` : `${fmt(res.aeFrac * 100, 0)}% of the tool`;
        const minutes = vals.cutLen > 0 ? Cnc.cutMinutes(vals.cutLen, Math.max(1, res.passes), res.feed) : 0;
        const presetPick = tested.length > 1 ? html`<div class="field"><label for="preset">Tested preset</label><select id="preset">${tested.map(r => html`<option value="${r.id}"${recipe && r.id === recipe.id ? " selected" : ""}>${r.label || "Tested"} (${rpmFmt(r.rpm)}, ${U.both("feed", r.feed_mm)[0]})</option>`)}</select></div>` : "";
        // the tool-diameter warning first, the generic tips after; "all fine" confirmations add nothing next to the badge
        const rank = n => (n.level === "bad" || n.level === "warn" ? 0 : /^Undersized tool/.test(n.text) ? 1 : 2);
        const notes = res.notes.filter(n => n.level !== "ok").sort((a, b) => rank(a) - rank(b));
        const detailRows = [
          ...(recipe && res.source === "tested" ? [[recipe.label ? `Tested setting “${recipe.label}”` : "Tested setting", recipe.notes || "Saved by the team."]] : []),
          ...(res.model && res.source === "tested" ? [["Generic calculation says", `${rpmFmt(res.model.rpm)}, ${U.both("feed", res.model.feed)[0]}, ${U.fmt("len", res.model.doc, 4)} max stepdown`]] : []),
          ["Chipload", ipt], ["Surface speed", `${Math.round(res.sfm)} SFM (${Math.round(res.vc)} m/min)`], ["Material removal", mrr],
          ...(face ? [] : [["Spindle load (est.)", `${Math.round(res.power)} W of ${Math.round(res.availW)} W (${Math.round((res.power / res.availW) * 100)}%)`],
            ["Tool deflection (est.)", U.isImp() ? `${fmt((res.defl / IN) * 1000, 2)} thou` : `${fmt(res.defl * 1000, 1)} µm`], ["Stick-out used", U.fmt("len", res.stick)]]),
          ["Depth limited by", res.docLimit],
          ...(minutes ? [["Estimated cutting time", `${fmt(minutes, 1)} min (${Math.max(1, res.passes)} pass${res.passes > 1 ? "es" : ""} × ${U.fmt("len", vals.cutLen, 1)})`]] : []),
        ];
        out.innerHTML = html`
          <div class="bar"><h2>Recommended settings</h2>${badge}</div>
          ${tiles([
            tile("Spindle speed", rpmFmt(res.rpm), `${Math.round(res.sfm)} SFM`, "main"),
            tile("Cutting feed", feedA, feedB, "main"),
            tile("Depth per pass", U.fmt("len", res.passes ? res.docPass : res.doc, 4), res.passes ? `${res.passes} pass${res.passes > 1 ? "es" : ""} for ${U.fmt("len", total, 4)}${!face && vals.through && vals.extra > 0 ? ` (${U.fmt("len", thicknessMm, 4)} stock + ${U.fmt("len", vals.extra, 3)} into the spoilboard)` : ""}${res.passes && res.doc > res.docPass * 1.02 ? ` · up to ${U.fmt("len", res.doc, 4)} is fine` : ""}` : "set a depth to count passes", "main"),
            tile(face ? "Stepover" : "Stepover (width of cut)", stepover, stepSub),
            tile("Plunge feed", plA, plB),
            tile("Ramp feed", rpA, `${res.rampAngle}° ramp${res.rampLength ? " · " + U.fmt("len", res.rampLength, 2) + " per pass" : ""}`),
          ])}
          ${presetPick}
          <div class="notes">${notes.map(n => note(n.level, n.text))}</div>
          <details class="more"><summary>Details</summary>
            ${kvTable(detailRows)}
            <p class="small mut">${tested.length ? "" : "No tested setting for this tool and material yet: run a scrap test, then press “Save as tested”. "}<a href="#/tested">All tested settings</a></p>
          </details>
          <div class="bar actions"><button class="btn pri" id="copyCam">Copy for CAM</button></div>
          ${tool.id ? html`<p class="after">After the run: <button class="btn link" id="saveTested">Save as tested</button><button class="btn link" id="logJob">Log this job</button></p>` : ""}`.s;
        App.foldNotes(out);
        const sp = $("#preset", out);
        if (sp) sp.onchange = () => { vals.preset = +sp.value; update(); };
        $("#copyCam", out).onclick = () => copyText(camText(res, tool, total));
        const st = $("#saveTested", out);
        if (st) st.onclick = () => saveTested(res, tool);
        const lj = $("#logJob", out);
        if (lj) lj.onclick = () => logJob(res, tool, thicknessMm, minutes);
      }

      function saveTested(res, tool) {
        const fields = [
          { id: "label", label: "Name", type: "text", max: 60, def: "", placeholder: "e.g. 1/8 in plate, clean edge" },
          { id: "rating", label: "How well did it work?", type: "select", number: true, def: 4, options: [[5, "★★★★★ Perfect"], [4, "★★★★ Good"], [3, "★★★ OK"], [2, "★★ Rough"], [1, "★ Bad"]] },
          { id: "rpm", adv: true, label: "Spindle speed (rpm)", type: "num", dp: 0, def: 0 },
          { id: "feed_mm", adv: true, label: "Cutting feed", type: "feed", def: 0 },
          { id: "plunge_mm", adv: true, label: "Plunge feed", type: "feed", def: 0 },
          { id: "ramp_mm", adv: true, label: "Ramp feed", type: "feed", def: 0 },
          { id: "doc_mm", adv: true, label: "Depth per pass", type: "len", def: 0 },
          { id: "woc_mm", adv: true, label: "Width of cut", type: "len", def: 0 },
          { id: "notes", label: "Notes", type: "textarea", def: "", wide: true },
        ];
        openForm({
          title: `Save tested setting: ${tool.name}, ${MAT_LABEL[vals.material]}`, fields, submit: "Save", fold: { label: "The numbers (change them if you ran something different)" },
          intro: "Only save settings you actually ran. They become the team's recommendation for this tool and material.",
          values: { rpm: Math.round(res.rpm), feed_mm: Math.round(res.feed), plunge_mm: Math.round(res.plunge), ramp_mm: Math.round(res.ramp), doc_mm: +fmt(res.passes ? res.docPass : res.doc, 4), woc_mm: +fmt(res.ae, 3) },
          onSubmit: async v => {
            await App.save("recipes", null, { tool_id: tool.id, material: vals.material, op: vals.material === "spoilboard" ? "surface" : vals.op, label: v.label, rpm: v.rpm, feed_mm: v.feed_mm,
              plunge_mm: v.plunge_mm, ramp_mm: v.ramp_mm, doc_mm: v.doc_mm, woc_mm: v.woc_mm, rating: v.rating, notes: v.notes });
            toast("Saved to tested settings");
            update();
          },
        });
      }

      function logJob(res, tool, thicknessMm, minutes) {
        App.openJobDialog({ material: vals.material, tool_id: tool.id, thickness_mm: vals.material === "spoilboard" ? 0 : thicknessMm, rpm: Math.round(res.rpm), feed_mm: Math.round(res.feed),
          doc_mm: +fmt(res.passes ? res.docPass : res.doc, 4), minutes: minutes ? +fmt(minutes, 1) : 0 });
      }
      update();
    },
  });

  // ================================================================== Check my settings
  const checkFields = [
    { id: "material", label: "Material", type: "seg", def: "aluminum", options: [["aluminum", "Aluminum"], ["polycarbonate", "Polycarbonate"]] },
    { id: "toolId", label: "Endmill", type: "select", wide: true, number: true, def: -1, options: () => [...toolList(false).map(t => [t.id, toolLabel(t)]), [0, "Other size…"]] },
    { id: "cDia", label: "Cutting diameter", type: "len", def: 6.35, show: v => !v.toolId },
    { id: "cFlutes", label: "Flutes", type: "int", def: 1, min: 1, max: 12, dp: 0, show: v => !v.toolId },
    { id: "cMat", label: "Tool material", type: "select", def: "carbide", show: v => !v.toolId, options: [["carbide", "Carbide"], ["hss", "HSS"]] },
    { id: "rpm", label: "Spindle speed from CAM", type: "num", unit: "rpm", def: 24000, dp: 0, min: 1 },
    { id: "feed", label: "Cutting feed from CAM", type: "feed", def: 1727.2, min: 1 },
    { id: "doc", adv: true, label: "Depth per pass", type: "len", def: 0, hint: "0 = skip the depth check." },
    { id: "ae", adv: true, label: "Width of cut", type: "len", def: 0, hint: "0 = full slot. A narrow cut thins the chip, so it can take a higher feed." },
    { id: "stick", adv: true, label: "Stick-out", type: "len", def: 0, hint: "0 = automatic." },
  ];
  App.calcPage({
    id: "check", title: "Check My Settings", keywords: "check verify sanity chipload too fast too slow cam fusion settings ok rubbing aggressive",
    intro: "Type in the rpm and feed you set in CAM. See if they're sensible for this tool.",
    fields: () => checkFields,
    init: v => normalizeTool(v, false),
    compute(v) {
      const tool = chosenTool(v, false);
      if (!tool) return note("info", "Pick an endmill, or choose “Other size…” and enter its diameter.");
      const recipe = tool.id ? testedFor(tool.id, v.material, "slot")[0] || null : null;
      let r;
      try { r = Cnc.checkSettings({ material: v.material, tool, rpm: v.rpm, feed: v.feed, doc: v.doc, ae: v.ae, stick_mm: v.stick, machine: App.machine(), recipe }); }
      catch (e) { return note("bad", e.message); }
      const ipt = mm => (U.isImp() ? `${fmt(mm / IN, 5)} in/tooth` : `${fmt(mm, 4)} mm/tooth`);
      const level = r.verdict.level;
      return html`<h2>Verdict</h2>
        <div class="verdict ${level}"><b>${level === "ok" ? "Looks good" : level === "warn" ? "Check this" : "Fix this"}</b><span>${r.verdict.text}</span></div>
        ${tiles([
          tile("Your chipload", ipt(r.fz), `${fmt(r.ratio * 100, 0)}% of what we'd use${r.source === "model" ? "" : " (your tested setting)"}`, level === "ok" ? "main" : "main " + (level === "bad" ? "bad" : "")),
          tile("We'd use", ipt(r.refFz), `${group(r.refRpm)} rpm, ${U.both("feed", r.refFeed)[0]} for a slot`, "main"),
          tile("At your rpm, feed would be", U.both("feed", r.feedHere)[0], U.both("feed", r.feedHere)[1]),
          tile("Surface speed", `${Math.round(r.sfm)} SFM`, `${group(r.refRpm)} rpm recommended`),
          tile("Spindle load (est.)", `${Math.round(r.power)} W`, `${fmt((r.power / r.availW) * 100, 0)}% of ${Math.round(r.availW)} W`),
          tile("Tool deflection (est.)", U.isImp() ? `${fmt((r.defl / IN) * 1000, 2)} thou` : `${fmt(r.defl * 1000, 1)} µm`, ""),
        ])}
        <div class="notes">${r.notes.filter(n => n.level !== "ok").map(n => note(n.level, n.text))}${note("info", "Judgement beats arithmetic: listen to the cut and look at the chips.")}</div>`;
    },
  });

  // ================================================================== Spoilboard surfacing
  const spoilFields = [
    { id: "toolId", label: "Facemill", type: "select", wide: true, number: true, def: -1, options: () => [...toolList(true).map(t => [t.id, toolLabel(t)]), [0, "Other size…"]] },
    { id: "cDia", label: "Cutter diameter", type: "len", def: 63.5, show: v => !v.toolId },
    { id: "cFlutes", label: "Flutes / inserts", type: "int", def: 4, min: 1, max: 12, dp: 0, show: v => !v.toolId },
    { id: "ax", label: "Board size, X (side to side)", type: "len", def: 565 },
    { id: "ay", label: "Board size, Y (front to back)", type: "len", def: 770 },
    { id: "depth", label: "Depth to remove", type: "len", def: 0.508, hint: "0.010–0.020 in (0.25–0.5 mm) is plenty to flatten a board." },
    { id: "stepover", adv: true, label: "Stepover (% of cutter)", type: "num", unit: "%", def: 70, min: 10, max: 95, dp: 0, hint: "Lower leaves a smoother, flatter finish but takes longer." },
    { id: "agg", adv: true, label: "How hard to push", type: "seg", number: true, def: 1, options: [[0.8, "Careful"], [1, "Normal"], [1.15, "Push"]] },
    { id: "along", adv: true, label: "Lines run along", type: "seg", def: "auto", options: [["auto", "Shortest time"], ["y", "Along Y"], ["x", "Along X"]] },
    { id: "margin", adv: true, label: "Run past the edge by", type: "len", def: 3.175, hint: "So the cutter clears the very edge of the board." },
  ];

  App.register({
    id: "spoil", title: "Spoilboard Surfacing", keywords: "facemill mdf flatten planing surfacing resurface table time passes",
    render(root) {
      const specs = spoilFields;
      const vals = App.pageVals("spoil", specs);
      if (!store.get("vals:spoil")) { const s = App.machine(); vals.ax = s.table_x_mm || 565; vals.ay = s.table_y_mm || 770; }
      normalizeTool(vals, true);
      root.innerHTML = html`
        <h1>Spoilboard Surfacing</h1>
        <p class="mut lead">Plan the facemill pass that flattens the MDF: how many lines, how long it takes, what to type into CAM.</p>
        <div class="two">
          <section class="card"><div id="form"></div></section>
          <section class="card" id="out" aria-live="polite"></section>
        </div>`.s;
      const form = App.mountForm($("#form", root), specs, vals, "spoil", () => update());

      function update() {
        App.persist("spoil", vals);
        const out = $("#out", root);
        const chk = App.checkVals(specs, vals);
        if (chk.issues.length) {
          out.innerHTML = html`<h2>Plan</h2>${chk.issues.map(t => note("info", t))}`.s;
          if (chk.bad.some(id => (specs.find(f => f.id === id) || {}).adv)) form.openMore();
          return;
        }
        const tool = chosenTool({ toolId: vals.toolId, cDia: vals.cDia, cFlutes: vals.cFlutes, cMat: "hss" }, true);
        if (!tool || !(vals.ax > 0) || !(vals.ay > 0)) { out.innerHTML = html`<h2>Plan</h2><p class="mut">Enter the cutter and the board size.</p>`.s; return; }
        const tested = tool.id ? testedFor(tool.id, "spoilboard", "surface") : [];
        const recipe = tested[0] || null;
        const step = clamp01((vals.stepover > 0 ? vals.stepover : 70) / 100);
        const res = Cnc.recommend({ material: "spoilboard", tool, total_mm: Math.max(0.01, vals.depth || 0.5), agg: vals.agg || 1, machine: App.machine(), recipe, stepover: step });
        const mk = (w, l) => Cnc.spoilboardPlan({ diameter: tool.actual_mm, w, l, stepover: step, margin: vals.margin || 0, feed: res.feed, depth: vals.depth || 0.5, docPerPass: res.docPass });
        let planY, planX;
        try { planY = mk(vals.ax, vals.ay); planX = mk(vals.ay, vals.ax); }   // lines along Y step across X, and vice versa
        catch (e) { out.innerHTML = html`<h2>Plan</h2>${note("bad", e.message)}`.s; return; }
        const alongY = vals.along === "y" || (vals.along === "auto" && planY.totalMin <= planX.totalMin);
        const plan = alongY ? planY : planX;
        const across = alongY ? vals.ax : vals.ay, along = alongY ? vals.ay : vals.ax;
        const [feedA, feedB] = U.both("feed", res.feed);
        const maxFeedHit = res.feedCapped;
        out.innerHTML = html`
          <div class="bar"><h2>Plan</h2>${res.source === "tested" ? html`<span class="badge ok">Team-tested setting</span>` : html`<span class="badge info">Calculated</span>`}</div>
          ${tiles([
            tile("Time", `${fmt(plan.totalMin, 0)} min`, plan.layers > 1 ? `${plan.layers} layers × ${fmt(plan.layerMin, 1)} min` : "one layer", "main"),
            tile("Spindle speed", rpmFmt(res.rpm), `${Math.round(res.sfm)} SFM rim speed`, "main"),
            tile("Cutting feed", feedA, feedB, "main"),
            tile("Depth per layer", U.fmt("len", plan.docPass, 4), `${plan.layers} layer${plan.layers > 1 ? "s" : ""} for ${U.fmt("len", vals.depth, 4)}`),
            tile("Lines", String(plan.lines), `${U.fmt("len", plan.spacing, 2)} apart`),
            tile("Path per layer", U.fmt("longlen", plan.layerPath, 1), `lines run along ${alongY ? "Y" : "X"}`),
          ])}
          <details class="more sketch"><summary>Sketch of the toolpath</summary><figure class="plan">${planSvg(across, along, plan, tool.actual_mm, alongY)}<figcaption class="mut small">The lines run up and down the picture (the ${alongY ? "Y" : "X"} direction). The cutter centre follows the zig-zag; the first line is ${U.fmt("len", plan.firstLine, 2)} in from the board edge.</figcaption></figure></details>
          <div class="notes">
            ${plan.spacing > tool.actual_mm * 0.96 ? note("warn", "Stepover is close to the cutter diameter. Lower it so the lines overlap.") : ""}
            ${Math.max(vals.ax, vals.ay) > Math.max(App.machine().table_x_mm || 0, App.machine().table_y_mm || 0) + 1 ? note("warn", "The board is bigger than the machine's travel in at least one direction.") : ""}
            ${maxFeedHit ? note("info", "Feed is held to the machine's maximum.") : ""}
            ${res.notes.filter(n => n.level !== "ok").sort((a, b) => spoilRank(a) - spoilRank(b)).map(n => note(n.level, n.text))}
            ${note("info", `Other direction: lines along ${alongY ? "X" : "Y"} would take about ${fmt((alongY ? planX : planY).totalMin, 0)} min.`)}
          </div>
          <details class="more"><summary>Details</summary>${kvTable([
            ["Chipload", U.isImp() ? `${fmt(res.fz / IN, 5)} in/tooth` : `${fmt(res.fz, 4)} mm/tooth`],
            ["Stepover", `${U.fmt("len", res.ae, 2)} (${fmt(step * 100, 0)}%) planned, ${U.fmt("len", plan.spacing, 2)} actual`],
            ["Overlap between lines", `${fmt(plan.overlap * 100, 0)}%`],
            ["Material removed", U.isImp() ? `${fmt(plan.removedCm3 / 16.387064, 2)} in³` : `${fmt(plan.removedCm3, 1)} cm³`],
            ["Plunge / ramp feed", `${U.both("feed", res.plunge)[0]} (plunge off the board, never into it)`],
          ])}</details>
          <div class="bar actions"><button class="btn pri" id="copyPlan">Copy plan</button></div>
          ${tool.id ? html`<p class="after">After the run: <button class="btn link" id="logJob">Log this job</button></p>` : ""}`.s;
        App.foldNotes(out);
        $("#copyPlan", out).onclick = () => copyText([
          `Spoilboard surfacing with ${tool.name} (${fmt(tool.actual_mm, 2)} mm)`,
          `Board: ${fmt(vals.ax, 1)} x ${fmt(vals.ay, 1)} mm, remove ${fmt(vals.depth, 2)} mm in ${plan.layers} layer(s) of ${fmt(plan.docPass, 3)} mm`,
          `Spindle: ${Math.round(res.rpm)} rpm, feed ${Math.round(res.feed)} mm/min (${fmt(res.feed / IN, 1)} in/min)`,
          `Stepover: ${fmt(step * 100, 0)}% planned; ${plan.lines} lines ${fmt(plan.spacing, 2)} mm apart, running along ${alongY ? "Y" : "X"}`,
          `Time: about ${fmt(plan.totalMin, 0)} min`].join("\n"));
        const lj = $("#logJob", out);
        if (lj) lj.onclick = () => App.openJobDialog({ name: "Resurface spoilboard", material: "spoilboard", tool_id: tool.id, rpm: Math.round(res.rpm), feed_mm: Math.round(res.feed), doc_mm: +fmt(plan.docPass, 4), minutes: +fmt(plan.totalMin, 0) });
      }
      update();
    },
  });
  const spoilRank = n => (n.level === "bad" || n.level === "warn" ? 0 : /skims/.test(n.text) ? 1 : 2);   // dust warning, then the skim-depth tip, then the rest
  const clamp01 = x => Math.min(0.95, Math.max(0.1, isFinite(x) ? x : 0.7));

  /** Top-down sketch of the board and the cutter's zig-zag. `across` = size the lines step over, `along` = size they run. */
  function planSvg(across, along, plan, dia, alongY) {
    const W = 300, scale = Math.min(W / across, 300 / along), pw = across * scale, ph = along * scale;
    const pad = 10;
    const xs = Array.from({ length: plan.lines }, (_, i) => pad + (plan.firstLine + i * plan.spacing) * scale);
    let d = "";
    xs.forEach((x, i) => { const [a, b] = i % 2 ? [pad + ph, pad] : [pad, pad + ph]; d += `${i ? "L" : "M"}${x.toFixed(1)} ${a.toFixed(1)} L${x.toFixed(1)} ${b.toFixed(1)} `; });
    const r = (dia / 2) * scale;
    return html`<svg viewBox="0 0 ${pw + pad * 2} ${ph + pad * 2}" role="img" aria-label="Top view: ${plan.lines} cutter lines across the board" class="planimg">
      <rect x="${pad}" y="${pad}" width="${pw.toFixed(1)}" height="${ph.toFixed(1)}" class="board"/>
      <path d="${d}" class="path"/>
      <circle cx="${xs[0].toFixed(1)}" cy="${pad}" r="${Math.max(2, r).toFixed(1)}" class="cutter"/>
    </svg>`;
  }

  // ================================================================== Hole & tool size
  const holeFields = [
    { id: "hole", label: "Finished hole diameter", type: "len", def: 12.7 },
    { id: "toolId", label: "Endmill", type: "select", wide: true, number: true, def: -1, options: () => [...toolList(false).map(t => [t.id, toolLabel(t)]), [0, "Other size…"]] },
    { id: "cDia", label: "Tool cutting diameter", type: "len", def: 4.6, show: v => !v.toolId },
    { id: "feed", adv: true, label: "Cutting feed", type: "feed", def: 0, hint: "Enter the feed you want at the cutting edge to see what to command at the tool centre. 0 = skip." },
  ];
  const calFields = [
    { id: "method", label: "What did you measure?", type: "seg", def: "slot", options: [["slot", "A slot"], ["hole", "A hole"]] },
    { id: "slotW", label: "Slot width (calipers)", type: "len", def: 0, show: v => v.method === "slot", hint: "Cut a straight full-width slot. Its width is what the tool really cuts." },
    { id: "camDia", label: "Tool diameter you gave CAM", type: "len", def: 5, show: v => v.method === "hole" },
    { id: "holeProg", label: "Hole size you programmed", type: "len", def: 12.7, show: v => v.method === "hole" },
    { id: "holeMeas", label: "Hole size you measured", type: "len", def: 0, show: v => v.method === "hole" },
  ];
  const fitFields = [
    { id: "nom", label: "Part or bearing size", type: "len", def: 28.575, hint: "For a bearing, its outside diameter." },
    { id: "fit", label: "How should it fit?", type: "select", wide: true, def: "press", options: Shop.FITS.map(f => [f.id, f.label]) },
  ];
  const BEARINGS = [
    ["1/2 in hex flanged (FR8ZZ-HexHD)", 1.125, 0.312, "0.062 in flange. Common FRC hex bearing."],
    ["3/8 in hex flanged", 1.125, null, "Same 1.125 in outside diameter as the 1/2 in version."],
  ];

  const holeModes = [["hole", "Round hole"], ["tool", "Measure my tool"], ["fit", "Fits"]];
  App.register({
    id: "holes", title: "Hole & Tool Size", keywords: "calibrate undersized endmill diameter hole compensation fit bearing press fit slip kerf offset",
    render(root) {
      const hv = App.pageVals("holes", holeFields), cv = App.pageVals("holes:cal", calFields), fv = App.pageVals("holes:fit", fitFields);
      normalizeTool(hv, false);
      let mode = store.get("holes:mode", "hole");
      if (!holeModes.some(m => m[0] === mode)) mode = "hole";
      root.innerHTML = html`
        <h1>Hole &amp; Tool Size</h1>
        <p class="mut lead">Round-hole toolpaths, what your endmill really cuts, and hole sizes for press and slip fits.</p>
        <div class="seg modes" role="group" aria-label="What do you need?">${holeModes.map(([id, label]) => html`<button type="button" data-mode="${id}" aria-pressed="${id === mode}" class="${id === mode ? "on" : ""}">${label}</button>`)}</div>
        <div class="two" data-pane="hole">
          <section class="card"><div id="hForm"></div></section>
          <section class="card" id="hOut" aria-live="polite"></section>
        </div>
        <div class="two" data-pane="tool">
          <section class="card"><p class="mut small">Cheap and undersized endmills cut smaller than their label. Cut a test, measure it, and give CAM the real number.</p><div id="cForm"></div></section>
          <section class="card" id="cOut" aria-live="polite"></section>
        </div>
        <div class="two" data-pane="fit">
          <section class="card"><div id="fForm"></div></section>
          <section class="card" aria-live="polite"><div id="fOut"></div>
            ${table(["Fit", "Add to nominal", "Use for"], Shop.FITS.map(f => [f.label, `+${fmt(f.add, 3)} in (+${fmt(f.add * IN, 2)} mm)`, f.note]))}
            <details class="more"><summary>Common FRC bearings</summary>
              ${table(["Bearing", "Outside dia", "Thickness", "Notes"], BEARINGS.map(([n, od, t, c]) => [n, `${fmt(od, 3)} in (${fmt(od * IN, 2)} mm)`, t ? `${fmt(t, 3)} in` : "–", c]))}
              <p class="mut small">Source: AndyMark's published dimensions. Cut a test pocket in scrap and check the fit before cutting the real part.</p>
            </details></section>
        </div>`.s;
      const showMode = () => {
        $$("[data-pane]", root).forEach(el => { el.hidden = el.dataset.pane !== mode; });
        $$("button[data-mode]", root).forEach(b => { const on = b.dataset.mode === mode; b.classList.toggle("on", on); b.setAttribute("aria-pressed", on); });
      };
      $(".modes", root).addEventListener("click", e => {
        const b = e.target.closest("button[data-mode]");
        if (!b) return;
        mode = b.dataset.mode; store.set("holes:mode", mode); showMode();
      });
      showMode();

      function updateH() {
        App.persist("holes", hv);
        const tool = chosenTool({ toolId: hv.toolId, cDia: hv.cDia }, false);
        const out = $("#hOut", root);
        const chk = App.checkVals(holeFields, hv);
        if (chk.issues.length) { out.innerHTML = chk.issues.map(t => note("info", t)).join(""); return; }
        if (!tool || !(hv.hole > 0)) { out.innerHTML = html`<p class="mut">Pick an endmill and enter the finished hole size.</p>`.s; return; }
        const r = Cnc.holePath({ hole: hv.hole, tool: tool.actual_mm, feed: hv.feed });
        out.innerHTML = r.ok ? html`${tiles([
          tile("Toolpath circle", U.fmt("len", r.pathDia, 4), "diameter the tool centre follows", "main"),
          ...(r.feedCentre ? [tile("Command at tool centre", U.both("feed", r.feedCentre)[0], `for ${U.both("feed", hv.feed)[0]} at the edge`)] : []),
        ])}<div class="notes">${hv.hole < tool.actual_mm * 1.3 ? note("warn", "The hole is barely bigger than the tool. Ramp or helix in slowly, or use a drill.") : ""}${note("info", `Tool ${U.fmt("len", tool.actual_mm, 4)} cuts a ${U.fmt("len", hv.hole, 4)} hole when its centre follows a ${U.fmt("len", r.pathDia, 4)} circle. Most CAM does this for you if the tool diameter is right.`)}</div>`.s :
          note("bad", "The hole is smaller than the tool. Use a smaller tool or drill it.").s;
      }
      function updateC() {
        App.persist("holes:cal", cv);
        const out = $("#cOut", root);
        let d;
        try { d = Cnc.effectiveDiameter({ slotWidth: cv.method === "slot" ? cv.slotW : 0, holeMeasured: cv.method === "hole" ? cv.holeMeas : 0, holeProgrammed: cv.holeProg, camDia: cv.camDia }); }
        catch (e) { out.innerHTML = html`<p class="mut">${cv.method === "slot" ? "Cut a straight, full-width slot in scrap, measure it with calipers and enter the width." : "Enter the tool size you gave CAM, the hole you programmed and the hole you measured."}</p>`.s; return; }
        if (!(d > 0.1)) { out.innerHTML = note("bad", "That doesn't look right. Check the measurement.").s; return; }
        const tool = App.toolById(hv.toolId);
        out.innerHTML = html`${tiles([tile("Real cutting diameter", U.fmt("len", d, 4), `${fmt(d, 3)} mm`, "main")])}
          ${tool ? html`<p>Library tool “${tool.name}” is set to ${U.fmt("len", tool.actual_mm, 4)}.</p><button class="btn pri" id="setDia">Update it to ${U.fmt("len", d, 4)}</button>` : html`<p class="mut">Pick a library endmill on “Cut a round hole” to save this number to it.</p>`}`.s;
        const b = $("#setDia", out);
        if (b) b.onclick = async () => {
          try { await App.save("tools", tool.id, { actual_mm: d }); toast("Tool updated"); updateH(); updateC(); }
          catch (e) { toast(e.message, true); }
        };
      }
      function updateF() {
        App.persist("holes:fit", fv);
        const fit = Shop.FITS.find(f => f.id === fv.fit) || Shop.FITS[0];
        const out = $("#fOut", root);
        if (!(fv.nom > 0)) { out.innerHTML = ""; return; }
        const hole = fv.nom + fit.add * IN;
        const fr = Shop.toFraction(hole / IN, 64);
        out.innerHTML = tiles([tile("Cut the hole at", U.fmt("len", hole, 4), `${fmt(hole / IN, 4)} in = ${fmt(hole, 3)} mm`, "main"), tile("Nearest fraction", fr.text + '"', `${fr.error >= 0 ? "+" : ""}${fmt(fr.error, 4)} in`)]).s;
      }
      App.mountForm($("#hForm", root), holeFields, hv, "holes", () => { updateH(); updateC(); });
      App.mountForm($("#cForm", root), calFields, cv, "holes:cal", () => updateC());
      App.mountForm($("#fForm", root), fitFields, fv, "holes:fit", () => updateF());
      updateH(); updateC(); updateF();
    },
  });
})();
