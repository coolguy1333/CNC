// Browser smoke tests: starts the real server and drives the real pages in Chromium.
// Run with:  node --test tests/browser.test.js        (needs Playwright; skipped if it isn't installed)
const test = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

let chromium = null;
for (const mod of ["playwright", "/opt/node-tools/node_modules/playwright"]) {
  try { ({ chromium } = require(mod)); break; } catch (e) { /* try the next */ }
}
const skip = chromium ? false : "Playwright is not installed";

let srv, browser, base, dataDir;
const wait = ms => new Promise(r => setTimeout(r, ms));

test.before(async () => {
  if (skip) return;
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "shop-browser-"));
  const port = 19000 + Math.floor(Math.random() * 800);
  srv = spawn("python3", ["server.py"], { cwd: path.join(__dirname, ".."), env: { ...process.env, PORT: String(port), HOST: "127.0.0.1", DATA_DIR: dataDir } });
  srv.stderr.on("data", d => process.stderr.write(d));
  base = `http://127.0.0.1:${port}/`;
  for (let i = 0; i < 80; i++) { try { if ((await fetch(base + "api/health")).ok) break; } catch (e) { /* not up yet */ } await wait(100); }
  browser = await chromium.launch();
});
test.after(async () => { if (browser) await browser.close(); if (srv) srv.kill(); });

async function newPage(opts = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, ...opts });
  const page = await ctx.newPage();
  page.problems = [];
  page.on("pageerror", e => page.problems.push("pageerror: " + e.message));
  page.on("console", m => { if (m.type() === "error" || m.type() === "warning") page.problems.push(m.type() + ": " + m.text()); });
  page.on("dialog", d => d.accept());
  page.ctx = ctx;
  return page;
}
const api = async (page, method, p, body) => page.evaluate(async ([m, u, b]) => {
  const r = await fetch(u, { method: m, headers: { "Content-Type": "application/json" }, body: b === undefined ? undefined : JSON.stringify(b) });
  return r.json();
}, [method, "/" + p.replace(/^\//, ""), body]);
const tileText = (page, label) => page.locator("#out .tile", { hasText: label }).first().innerText();
const go = async (page, id) => {
  await page.goto(base + "#/" + id);
  // the nav highlight moves to the new page right before it renders, so wait for that and then for its heading
  await page.waitForFunction(i => { const a = document.querySelector(`#nav a[data-id="${i}"]`); return a && a.getAttribute("aria-current") === "page"; }, id);
  await page.waitForSelector("#main h1, #main h2");
};
async function pageIds(page) { await page.goto(base + "#/cnc"); await page.waitForSelector("#nav a"); return page.$$eval("#nav a", as => as.map(a => a.dataset.id)); }

test("every page loads without errors and is accessible", { skip }, async () => {
  const page = await newPage();
  const ids = await pageIds(page);
  assert.ok(ids.length >= 25, "expected the full set of pages, got " + ids.length);
  for (const id of ids) {
    await go(page, id);
    await wait(120);
    const issues = await page.evaluate(() => {
      const out = [];
      const seen = new Set();
      document.querySelectorAll("[id]").forEach(el => { if (seen.has(el.id)) out.push("duplicate id " + el.id); seen.add(el.id); });
      document.querySelectorAll("#main input:not([type=hidden]):not([type=file]), #main select, #main textarea").forEach(el => {
        const named = el.getAttribute("aria-label") || (el.id && document.querySelector(`label[for="${el.id}"]`)) || el.closest("label");
        if (!named) out.push("unlabelled control " + (el.id || el.name || el.type));
      });
      document.querySelectorAll("#main button").forEach(b => { if (!b.textContent.trim() && !b.getAttribute("aria-label")) out.push("unnamed button"); });
      if (!document.querySelector("#main h1")) out.push("no h1");
      return out;
    });
    assert.deepEqual(issues, [], `${id}: ${issues.join(", ")}`);
    assert.deepEqual(page.problems, [], `${id}: ${page.problems.join(" | ")}`);
  }
  await page.ctx.close();
});

test("nothing scrolls sideways on a phone", { skip }, async () => {
  const page = await newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const ids = await pageIds(page);
  const wide = [];
  for (const id of ids) {
    await go(page, id);
    await wait(100);
    const [sw, iw] = await page.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]);
    if (sw > iw + 1) wide.push(`${id} (${sw} > ${iw})`);
  }
  assert.deepEqual(wide, []);
  assert.deepEqual(page.problems, []);
  await page.ctx.close();
});

test("feeds & speeds starts on the team's tested aluminum settings", { skip }, async () => {
  const page = await newPage();
  await go(page, "cnc");
  await page.waitForSelector("#out .tile");
  assert.match(await tileText(page, "Spindle speed"), /24,000 rpm/);
  assert.match(await tileText(page, "Cutting feed"), /68 in\/min/);
  assert.match(await tileText(page, "Cutting feed"), /1727 mm\/min/);
  assert.match(await tileText(page, "Max stepdown"), /0\.0625 in/);
  assert.match(await page.locator("#out").innerText(), /Team-tested setting/);
  // polycarbonate
  await page.click('#form [data-f="material"] button[data-v="polycarbonate"]');
  assert.match(await tileText(page, "Cutting feed"), /155 in\/min/);
  assert.match(await tileText(page, "Max stepdown"), /0\.125 in/);
  // other tool: tested 6 mm settings are the team's, however conservative
  await page.selectOption("#f_toolId", { label: "6 mm endmill" });
  assert.match(await tileText(page, "Spindle speed"), /22,000 rpm/);
  // spoilboard: the facemill
  await page.click('#form [data-f="material"] button[data-v="spoilboard"]');
  assert.match(await tileText(page, "Spindle speed"), /5,000 rpm/);
  assert.match(await tileText(page, "Cutting feed"), /30 in\/min/);
  assert.deepEqual(page.problems, []);
  await page.ctx.close();
});

test("units toggle, custom tool and remembered choices", { skip }, async () => {
  const page = await newPage();
  await go(page, "cnc");
  await page.waitForSelector("#out .tile");
  await page.click('#unitSeg button[data-u="met"]');
  assert.match(await tileText(page, "Cutting feed"), /^CUTTING FEED\s+1727 mm\/min/i);
  await page.click('#form [data-f="material"] button[data-v="aluminum"]');
  await page.selectOption("#f_toolId", "0");                       // Other size…
  await page.fill("#f_cDia", "8");
  assert.match(await tileText(page, "Spindle speed"), /rpm/);
  assert.match(await page.locator("#out").innerText(), /Calculated/);
  await page.reload();
  await page.waitForSelector("#out .tile");
  assert.equal(await page.inputValue("#f_cDia"), "8", "the custom size is remembered");
  assert.equal(await page.$eval('#unitSeg button.on', b => b.dataset.u), "met", "the units choice is remembered");
  await page.click('#unitSeg button[data-u="imp"]');
  await page.ctx.close();
});

test("save a tested setting and log a job from the calculator", { skip }, async () => {
  const page = await newPage();
  await go(page, "cnc");
  await page.waitForSelector("#out .tile");
  const before = (await api(page, "GET", "api/state")).recipes.length;
  await page.click("#saveTested");
  await page.waitForSelector("#dlg[open]");
  await page.fill('#dlg [data-f="label"]', "Browser test");
  await page.click('#dlg button[type="submit"]');
  await page.waitForFunction(() => !document.querySelector("#dlg").open);
  const after = await api(page, "GET", "api/state");
  assert.equal(after.recipes.length, before + 1);
  const made = after.recipes.find(r => r.label === "Browser test");
  assert.ok(made && made.rpm === 24000 && made.material === "aluminum");
  await api(page, "DELETE", "api/recipes/" + made.id);
  await go(page, "cnc");
  await page.click("#logJob");
  await page.waitForSelector("#dlg[open]");
  await page.fill('#dlg [data-f="name"]', "Browser gusset");
  await page.click('#dlg button[type="submit"]');
  await page.waitForFunction(() => !document.querySelector("#dlg").open);
  const log = await api(page, "GET", "api/joblog");
  assert.ok(log.some(j => j.name === "Browser gusset" && j.rpm === 24000));
  assert.deepEqual(page.problems, []);
  await page.ctx.close();
});

test("spoilboard plan matches the model", { skip }, async () => {
  const page = await newPage();
  await go(page, "spoil");
  await page.waitForSelector("#out .tile");
  assert.match(await tileText(page, "Time"), /14 min/);
  assert.match(await tileText(page, "Lines"), /13/);
  assert.match(await tileText(page, "Spindle speed"), /5,000 rpm/);
  assert.ok(await page.locator("#out svg").count());
  assert.deepEqual(page.problems, []);
  await page.ctx.close();
});

test("inventory: add, low-stock flag, quick adjust, delete", { skip }, async () => {
  const page = await newPage();
  await go(page, "inventory");
  await page.click("#add");
  await page.waitForSelector("#dlg[open]");
  await page.fill('#dlg [data-f="name"]', "Test screws");
  await page.fill('#dlg [data-f="qty"]', "5");
  await page.fill('#dlg [data-f="min_qty"]', "10");
  await page.click('#dlg button[type="submit"]');
  await page.waitForSelector("tr.low");
  assert.match(await page.locator("tr.low").innerText(), /Test screws/);
  assert.match(await page.locator("tr.low").innerText(), /Low/);
  assert.equal(await page.locator('#nav [data-badge="inventory"]').innerText(), "1");
  await page.click('tr.low button[data-act="plus"]');
  await page.waitForFunction(() => /\b6\b/.test(document.querySelector("tr.low").innerText));
  await page.click('tr.low button[data-act="del"]');
  await page.waitForSelector("tr.low", { state: "detached" });
  assert.ok(!(await api(page, "GET", "api/state")).inventory.some(i => i.name === "Test screws"));
  assert.deepEqual(page.problems, []);
  await page.ctx.close();
});

test("tool library: add, edit and delete a tool", { skip }, async () => {
  const page = await newPage();
  await go(page, "tools");
  await page.click("#add");
  await page.waitForSelector("#dlg[open]");
  await page.fill('#dlg [data-f="name"]', "Browser 3 mm");
  await page.fill('#dlg [data-f="nominal_mm"]', "0.1181");
  await page.fill('#dlg [data-f="actual_mm"]', "0.1102");
  await page.click('#dlg button[type="submit"]');
  await page.waitForSelector("td >> text=Browser 3 mm");
  const t = (await api(page, "GET", "api/state")).tools.find(x => x.name === "Browser 3 mm");
  assert.ok(Math.abs(t.nominal_mm - 3) < 0.01 && Math.abs(t.actual_mm - 2.8) < 0.01);
  // a bad value is explained, not lost
  await page.click(`button[data-act="edit"][data-id="${t.id}"]`);
  await page.waitForSelector("#dlg[open]");
  await page.fill('#dlg [data-f="actual_mm"]', "1");
  await page.click('#dlg button[type="submit"]');
  await page.waitForSelector("#dlg .err:not([hidden])");
  assert.match(await page.locator("#dlg .err").innerText(), /Real cutting diameter|actual_mm/i);
  await page.click("#dlg [data-cancel]");
  await page.click(`button[data-act="del"][data-id="${t.id}"]`);
  await page.waitForSelector("td >> text=Browser 3 mm", { state: "detached" });
  // the one 400 above was the deliberate bad edit; nothing else may be wrong
  assert.deepEqual(page.problems.filter(p => !/status of 400/.test(p)), []);
  await page.ctx.close();
});

test("machine limits flow into the calculator", { skip }, async () => {
  const page = await newPage();
  await go(page, "settings");
  await page.fill('#f_max_rpm', "18000");
  await page.click("#ssave");
  await page.waitForSelector("#toast.show");
  await go(page, "cnc");
  await page.selectOption("#f_toolId", "0");
  await page.fill("#f_cDia", "0.1811");                              // 4.6 mm, typed in inches
  assert.match(await tileText(page, "Spindle speed"), /18,000 rpm/);
  await go(page, "settings");
  await page.fill('#f_max_rpm', "24000");
  await page.click("#ssave");
  await page.waitForSelector("#toast.show");
  assert.equal((await api(page, "GET", "api/state")).settings.max_rpm, 24000);
  await page.ctx.close();
});

test("search and the phone menu", { skip }, async () => {
  const page = await newPage();
  await go(page, "cnc");
  await page.fill("#search", "tap");
  await page.waitForSelector("#searchOut a");
  await page.keyboard.press("Enter");
  assert.match(page.url(), /#\/drilltap$/);
  await page.keyboard.press("/");
  assert.equal(await page.evaluate(() => document.activeElement.id), "search");
  await page.ctx.close();
  const m = await newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  await go(m, "cnc");
  assert.equal(await m.locator("#nav").evaluate(n => n.getBoundingClientRect().right <= 0), true, "the menu starts closed");
  await m.click("#menuBtn");
  await m.waitForFunction(() => document.querySelector("#nav").getBoundingClientRect().left >= 0);
  await m.click('#nav a[data-id="weight"]');
  await m.waitForSelector("#main h1:has-text('Weight')");
  assert.equal(await m.evaluate(() => document.body.classList.contains("menu")), false, "the menu closes after choosing a page");
  await m.ctx.close();
});

test("weight calculator feeds the weight budget", { skip }, async () => {
  const page = await newPage();
  await page.goto(base + "#/weight");
  await page.waitForSelector("#out .tile");
  await page.evaluate(() => { try { localStorage.removeItem("shop:budget"); } catch (e) { /* ignore */ } });
  await page.selectOption("#f_preset", "1x1x1/16");
  assert.match(await tileText(page, "Each"), /0\.27[0-9]* lb/);
  await page.click("#addBudget");
  await go(page, "budget");
  await page.waitForSelector("#main table");
  assert.match(await page.locator("#main table").innerText(), /1 × 1 × 1\/16 in aluminum tube/);
  assert.match(await page.locator(".tile", { hasText: "Total" }).first().innerText(), /0\.2\d* lb/);
  await page.click("#clearB");
  await page.waitForSelector("#main table", { state: "detached" });
  assert.deepEqual(page.problems, []);
  await page.ctx.close();
});

test("calculators give the standard answers", { skip }, async () => {
  const page = await newPage();
  await go(page, "drilltap");
  await page.waitForSelector("#out .tile");
  assert.match(await tileText(page, "Tap drill"), /#21/);
  await page.selectOption("#f_thread", "M5x0.8");
  assert.match(await tileText(page, "Tap drill"), /4\.2 mm/);
  await go(page, "cutlist");
  await page.waitForSelector("#out .tile");
  assert.match(await tileText(page, "Bars to buy"), /3/);
  await go(page, "belts");
  await page.waitForSelector("#out .tile");
  assert.match(await page.locator("#out").innerText(), /centre distance/i);
  await go(page, "convert");
  await page.fill("#f_text", "5/16");
  assert.match(await tileText(page, "Inches"), /0\.3125/);
  await go(page, "elec");
  await page.waitForSelector("#out .tile");
  assert.match(await tileText(page, "Voltage lost"), /0\.38 V/);   // 12 AWG, 3 ft each way, 40 A
  await go(page, "flywheel");
  await page.waitForSelector("#out .tile");
  assert.match(await tileText(page, "Spin-up time"), /\d(\.\d+)? s/);
  assert.deepEqual(page.problems, []);
  await page.ctx.close();
});

test("stored text can't run script (XSS)", { skip }, async () => {
  const page = await newPage();
  await go(page, "cnc");
  const evil = '<img src=x onerror="window.__xss=1"><script>window.__xss=2</script>';
  const made = await api(page, "POST", "api/inventory", { name: evil, notes: evil, location: evil });
  assert.ok(made.id);
  for (const id of ["inventory", "cnc", "tools"]) { await go(page, id); await wait(200); }
  await go(page, "inventory");
  await page.waitForSelector("tr");
  assert.equal(await page.evaluate(() => window.__xss), undefined);
  assert.ok((await page.locator("#list").innerText()).includes("<img src=x"), "it shows as plain text");
  assert.equal(await page.locator("#list img").count(), 0);
  await api(page, "DELETE", "api/inventory/" + made.id);
  await page.ctx.close();
});

test("a second visitor sees changes made by the first", { skip }, async () => {
  const a = await newPage(), b = await newPage();
  await go(b, "inventory");
  await go(a, "inventory");
  const made = await api(a, "POST", "api/inventory", { name: "Shared item", qty: 1 });
  // navigating to another page and back refreshes shared data
  await go(b, "cnc");
  await go(b, "inventory");
  await b.waitForSelector("td >> text=Shared item");
  // and so does coming back to the tab
  await api(a, "POST", "api/inventory", { name: "Shared item two", qty: 1 });
  await b.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await b.waitForSelector("td >> text=Shared item two");
  for (const i of (await api(a, "GET", "api/state")).inventory.filter(i => i.name.startsWith("Shared item"))) await api(a, "DELETE", "api/inventory/" + i.id);
  assert.ok(made.id);
  await a.ctx.close(); await b.ctx.close();
});

test("garbage in the boxes never breaks a calculator page", { skip }, async () => {
  const page = await newPage();
  const ids = await pageIds(page);
  const calculators = ids.filter(id => !["tools", "tested", "joblog", "inventory", "maint", "settings", "safety", "omio", "trouble", "materials", "links", "budget"].includes(id));
  const weird = ["", "0", "-5", "1e9", "0.0001"];
  const bad = /NaN|Infinity|undefined|\[object|null/;
  const outputOf = () => page.evaluate(() => document.querySelector("#main").innerText);
  for (const id of calculators) {
    await go(page, id);
    const nums = page.locator('#main input[type="number"]');
    const n = await nums.count();
    for (let i = 0; i < n; i++) {
      const box = nums.nth(i);
      if (!(await box.isVisible())) continue;
      const original = await box.inputValue();
      for (const w of weird) {
        await box.fill(w);
        const text = await outputOf();
        assert.ok(!bad.test(text), `${id}: typing "${w}" into box ${i} shows ${(bad.exec(text) || [])[0]}`);
      }
      await box.fill(original);
    }
    const selects = page.locator("#main select");
    const m = await selects.count();
    for (let i = 0; i < m; i++) {
      const sel = selects.nth(i);
      if (!(await sel.isVisible())) continue;
      const original = await sel.inputValue();
      const count = await sel.locator("option").count();
      for (let k = 0; k < Math.min(count, 40); k++) {
        await sel.selectOption({ index: k });
        const text = await outputOf();
        assert.ok(!bad.test(text), `${id}: choosing option ${k} of select ${i} shows ${(bad.exec(text) || [])[0]}`);
      }
      await sel.selectOption(original);
    }
    const segs = page.locator('#main .seg:not(#unitSeg) button');
    const sc = await segs.count();
    for (let i = 0; i < sc; i++) {
      if (!(await segs.nth(i).isVisible())) continue;
      await segs.nth(i).click();
      const text = await outputOf();
      assert.ok(!bad.test(text), `${id}: segment button ${i} shows ${(bad.exec(text) || [])[0]}`);
    }
  }
  assert.deepEqual(page.problems, []);
  await page.ctx.close();
});

test("tested settings: a new one shows up in the calculator and can be picked", { skip }, async () => {
  const page = await newPage();
  await go(page, "tested");
  await page.click("#add");
  await page.waitForSelector("#dlg[open]");
  await page.selectOption('#dlg [data-f="tool_id"]', { label: "Thrifty Bot 5 mm" });
  await page.selectOption('#dlg [data-f="material"]', "aluminum");
  await page.fill('#dlg [data-f="label"]', "Browser preset");
  await page.fill('#dlg [data-f="rpm"]', "18000");
  await page.fill('#dlg [data-f="feed_mm"]', "40");                 // 40 in/min typed in inches
  await page.selectOption('#dlg [data-f="rating"]', "5");
  await page.click('#dlg button[type="submit"]');
  await page.waitForFunction(() => !document.querySelector("#dlg").open);
  const made = (await api(page, "GET", "api/state")).recipes.find(r => r.label === "Browser preset");
  assert.ok(made && made.rpm === 18000 && Math.abs(made.feed_mm - 1016) < 0.5, JSON.stringify(made));
  await go(page, "cnc");
  await page.waitForSelector("#out .tile");
  // best-rated preset wins, and the picker lists both
  assert.match(await tileText(page, "Spindle speed"), /18,000 rpm/);
  assert.match(await tileText(page, "Cutting feed"), /40 in\/min/);
  assert.equal(await page.locator("#preset option").count(), 2);
  const stock = await page.$$eval("#preset option", os => os.find(o => o.textContent.startsWith("Aluminum (")).value);
  await page.selectOption("#preset", stock);
  assert.match(await tileText(page, "Spindle speed"), /24,000 rpm/);
  await api(page, "DELETE", "api/recipes/" + made.id);
  await page.ctx.close();
});

test("maintenance: new tasks are not overdue, and Done today starts the clock", { skip }, async () => {
  const page = await newPage();
  await go(page, "maint");
  assert.equal(await page.locator("tr.low").count(), 0, "nothing is overdue on a fresh install");
  assert.equal(await page.locator('#nav [data-badge="maint"]').isVisible(), false);
  await page.locator('button[data-act="done"]').first().click();
  await page.waitForSelector("text=Due in");
  const state = await api(page, "GET", "api/state");
  assert.ok(state.maintenance.some(m => m.last_done));
  // an old date makes it overdue
  const task = state.maintenance.find(m => m.interval_days > 0);
  await api(page, "PUT", "api/maintenance/" + task.id, { last_done: "2020-01-01" });
  await go(page, "cnc");
  await go(page, "maint");
  await page.waitForSelector("tr.low");
  assert.equal(await page.locator('#nav [data-badge="maint"]').innerText(), "1");
  await api(page, "PUT", "api/maintenance/" + task.id, { last_done: "" });
  await page.ctx.close();
});

test("backups: back up now, restore a snapshot, restore from a file", { skip }, async () => {
  const page = await newPage();
  await go(page, "settings");
  await page.click("#bnow");
  await page.waitForSelector("[data-restore]");
  const marker = await api(page, "POST", "api/inventory", { name: "after the snapshot" });
  await page.reload();
  await page.waitForSelector("[data-restore]");
  await page.locator("[data-restore]").first().click();                 // newest snapshot: taken before the marker existed
  await page.waitForFunction(async () => !(await (await fetch("/api/state")).json()).inventory.some(i => i.name === "after the snapshot"));
  assert.ok(marker.id);
  // a downloaded export can be restored from a file
  const exported = await api(page, "GET", "api/export");
  exported.tools = exported.tools.filter(t => t.name !== "6 mm endmill");
  exported.recipes = exported.recipes.filter(r => exported.tools.some(t => t.id === r.tool_id));
  const file = path.join(dataDir, "restore-me.json");
  fs.writeFileSync(file, JSON.stringify(exported));
  await go(page, "settings");
  await page.setInputFiles("#bfile", file);
  await page.waitForFunction(async () => !(await (await fetch("/api/state")).json()).tools.some(t => t.name === "6 mm endmill"));
  await page.click("[data-restore] >> nth=0");                           // and the pre-import snapshot undoes it
  await page.waitForFunction(async () => (await (await fetch("/api/state")).json()).tools.some(t => t.name === "6 mm endmill"));
  assert.deepEqual(page.problems, []);
  await page.ctx.close();
});

test("job log: CSV export defuses spreadsheet formulas", { skip }, async () => {
  const page = await newPage({ acceptDownloads: true });
  await go(page, "cnc");
  const made = await api(page, "POST", "api/joblog", { name: '=HYPERLINK("http://evil.example","click")', operator: "+cmd", notes: "-1+1", date: "2026-01-02" });
  await go(page, "joblog");
  await page.waitForSelector("#csv");
  const [download] = await Promise.all([page.waitForEvent("download"), page.click("#csv")]);
  const text = fs.readFileSync(await download.path(), "utf8");
  assert.ok(text.includes("'=HYPERLINK"), "formula cell is prefixed with an apostrophe: " + text);
  assert.ok(!/(^|,)=HYPERLINK/m.test(text));
  assert.ok(text.includes("'+cmd"));
  await api(page, "DELETE", "api/joblog/" + made.id);
  await page.ctx.close();
});

test("a tool deleted elsewhere doesn't break the calculator", { skip }, async () => {
  const a = await newPage(), b = await newPage();
  await go(a, "cnc");
  const made = await api(a, "POST", "api/tools", { name: "Doomed 4 mm", nominal_mm: 4, actual_mm: 3.9, flutes: 1, flute_len_mm: 12, overall_mm: 45 });
  await go(b, "cnc");
  await b.selectOption("#f_toolId", String(made.id));
  assert.match(await tileText(b, "Spindle speed"), /rpm/);
  await api(a, "DELETE", "api/tools/" + made.id);
  await go(b, "weight");
  await go(b, "cnc");                                                   // navigating refreshes shared data
  await b.waitForSelector("#out .tile");
  assert.match(await tileText(b, "Spindle speed"), /rpm/);
  assert.ok(!(await b.locator("#f_toolId option", { hasText: "Doomed" }).count()));
  assert.deepEqual(b.problems, []);
  await a.ctx.close(); await b.ctx.close();
});
