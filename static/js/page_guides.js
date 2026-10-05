/* Written guides: shop safety, running the OMIO, troubleshooting, materials, links. Static content. */
(function () {
  "use strict";
  const { html, $, $$, store, toast } = App;

  /** A checklist whose ticks are remembered in this browser. */
  function checklist(id, items) {
    const done = store.get("check:" + id, []);
    return html`<ul class="checklist" data-check="${id}">${items.map((t, i) => html`<li><label><input type="checkbox" data-i="${i}"${done.includes(i) ? " checked" : ""}> <span>${t}</span></label></li>`)}</ul><button class="btn sm" data-reset="${id}">Clear ticks</button>`;
  }
  function wireChecklists(root) {
    root.addEventListener("change", e => {
      const box = e.target.closest("input[data-i]");
      if (!box) return;
      const id = box.closest("[data-check]").dataset.check;
      const set = new Set(store.get("check:" + id, []));
      if (box.checked) set.add(+box.dataset.i); else set.delete(+box.dataset.i);
      store.set("check:" + id, [...set]);
    });
    root.addEventListener("click", e => {
      const b = e.target.closest("[data-reset]");
      if (!b) return;
      store.del("check:" + b.dataset.reset);
      $$(`[data-check="${b.dataset.reset}"] input`, root).forEach(i => { i.checked = false; });
    });
  }
  const guide = (id, title, keywords, body) => App.register({
    id, title, keywords,
    render(root) { root.innerHTML = html`<article class="card prose"><h1>${title}</h1>${body()}</article>`.s; wireChecklists(root); },
  });
  const link = (href, text) => html`<a href="${href}" target="_blank" rel="noopener noreferrer">${text}</a>`;

  // ================================================================== Safety
  guide("safety", "Shop Safety", "safety rules ppe glasses hearing gloves dust fire e-stop lockout mentor", () => html`
    <p class="mut">General shop guidance. Your team's mentors, school and FIRST's rules come first; if they differ, follow the stricter one.</p>
    <h2>Everyone, every time</h2>
    <ul>
      <li><b>Safety glasses on before you step into the shop</b> and stay on, including for visitors and for people just standing nearby.</li>
      <li><b>Hearing protection</b> whenever the router, saws, grinder or compressor are running.</li>
      <li>Tie back long hair. No loose sleeves, hanging jewelry, lanyards or drawstrings near moving tools. Closed-toe shoes.</li>
      <li><b>No gloves near rotating tools</b> (drill press, mill, lathe, router spindle): they can drag your hand in. Wear gloves only to handle sharp sheet and chips away from the machines.</li>
      <li>Never run a machine alone, and never without an adult mentor who knows you're doing it.</li>
      <li>Know where the first-aid kit, fire extinguisher and every emergency stop are before you start.</li>
      <li>Tell a mentor about every injury and every close call, however small.</li>
    </ul>
    <h2>CNC router</h2>
    <ul>
      <li>Stay at the machine for the whole run. Never walk away from a cutting machine.</li>
      <li>Keep your hands, hair and sleeves away from the spindle. Never reach in while the spindle is turning, even if the program is paused. Wait for it to stop completely.</li>
      <li>Change tools only with the spindle fully stopped.</li>
      <li>Clamp the work so it can't move or fly out, and keep clamps and screws out of the toolpath.</li>
      <li>Do an air-cut check (tool raised well above the work) before the first real cut of any new program.</li>
      <li>Use the dust shoe and vacuum. MDF dust is harmful to breathe: wear a respirator when cutting or surfacing it.</li>
      <li>Aluminum chips are razor sharp and hot: brush or vacuum them, never wipe with a bare hand.</li>
      <li>Keep mist lubricant light and chips cleared so they don't pile up, and keep the machine area clean. Know what type of extinguisher the shop has.</li>
      <li>Polycarbonate fumes when it overheats: ventilate, and don't keep cutting if it starts to melt.</li>
    </ul>
    <h2>Hand and power tools</h2>
    <ul>
      <li><b>Drill press:</b> clamp the work (never hold it with your hand), take the chuck key out before starting, and slow down for big bits.</li>
      <li><b>Bandsaw:</b> set the guide just above the work, keep fingers out of the line of the blade, and support round stock so it can't roll.</li>
      <li><b>Grinder / sander:</b> face shield or goggles, guards on, and never use a cracked wheel.</li>
      <li>Deburr sharp edges before handling parts. Lift plates and long stock with a second person.</li>
    </ul>
    <h2>If something goes wrong</h2>
    <ol><li>Hit the emergency stop.</li><li>Wait until everything has stopped turning before reaching in.</li><li>Get a mentor, treat injuries, and write down what happened so it doesn't happen again.</li></ol>`);

  // ================================================================== OMIO
  guide("omio", "Running the OMIO X8", "omio x8 router startup shutdown tool change mach3 homing zero workholding checklist wcp spindle collet", () => html`
    <p class="mut">A practical routine for the OMIO CNC Router X8 (USB). The exact button names are in WCP's manual: ${link("https://docs.wcproducts.com/omio-cnc-router-x8-usb", "OMIO X8 docs")}.</p>
    <h2>Machine facts</h2>
    <div class="tw"><table class="kv"><tbody>
      <tr><th scope="row">Work area</th><td>X 565 mm (22.24 in) × Y 770 mm (30.32 in) × Z 85 mm (3.35 in); Z up to 140 mm (5.51 in) with the Z dust cover removed</td></tr>
      <tr><th scope="row">Spindle</th><td>2.2 kW, up to 24,000 rpm, ER20 collets</td></tr>
      <tr><th scope="row">Feed</th><td>100–4,000 mm/min (about 4–157 in/min); max rapid 4,000 mm/min</td></tr>
      <tr><th scope="row">Accuracy</th><td>0.05 mm (0.002 in)</td></tr>
      <tr><th scope="row">Control</th><td>USB controller, run with Mach3</td></tr>
      <tr><th scope="row">Weight / power</th><td>90 kg (198 lb); 110 V</td></tr>
    </tbody></table></div>
    <p class="mut small">Source: WCP's OMIO X8 documentation. Community advice (Chief Delphi) is to avoid running the spindle below roughly 8,000 rpm and prefer 12,000+ when you can.</p>

    <h2>Before you cut</h2>
    ${checklist("omio-start", [
      "Safety glasses and hearing protection on; dust shoe and vacuum ready; respirator if cutting MDF.",
      "Spindle cooling is on and circulating (water-cooled spindle: check the reservoir level and that the pump is running).",
      "Table and spoilboard are clear and flat; surface the spoilboard first if cuts aren't going all the way through.",
      "Stock is clamped or screwed down firmly. Clamps and screws are outside every toolpath.",
      "The right tool is in the right collet: clean collet, shank seated deep, nut snug with the wrench.",
      "Power up the machine, start Mach3, and click RESET if it's flashing. Home all axes.",
      "Set X/Y zero where the CAM program expects it, and set Z zero (top of the stock, or as the program says) with the tool you will actually cut with.",
      "Load the program. Check the units, the tool, spindle speed and feeds against this app.",
      "Air-cut check: raise Z well above the stock and run the program with the spindle off to see the whole path.",
      "Coolant: air blast on (polycarbonate), or mist plus air (aluminum).",
    ])}
    <h2>Running</h2>
    <ul>
      <li>Let the spindle reach speed before the tool touches the material.</li>
      <li>Start with the feed override a little low and listen. Raise it to 100% once the cut sounds smooth.</li>
      <li>Ramp in (the team's usual angle is 2°) rather than plunging straight down.</li>
      <li>Watch the chips: aluminum should come off as small, bright curls. Long gummy strings, smoke, or melted plastic mean it's too hot: raise the feed or add air/lubricant.</li>
      <li>To stop: Feed Hold, then spindle off. Wait for it to stop before reaching in.</li>
    </ul>
    <h2>Changing a tool</h2>
    <ol>
      <li>Raise Z and wait for the spindle to stop completely.</li>
      <li>Hold the spindle flat with one wrench and loosen the collet nut with the other.</li>
      <li>Clean the collet, nut and spindle taper with a brush or a clean rag. Chips under a collet cause runout.</li>
      <li>Snap the collet into the nut, slide the tool in as deep as the shank allows (flutes clear of the nut), and tighten.</li>
      <li><b>Re-measure Z zero</b> after every tool change.</li>
    </ol>
    <h2>Holding the work</h2>
    <ul>
      <li>Clamp from above on the edges and cut only where the clamps can't be hit, or screw the stock to the spoilboard in waste areas.</li>
      <li>Small parts can come loose or get thrown when they finish cutting: leave tabs (small bridges of material), a typical size is about 1/16 in thick and 1/4 in wide, then snip and file them off.</li>
      <li>Thin sheet flexes and chatters. Support it, clamp it close to the cut, and use a lighter cut.</li>
    </ul>
    <h2>When you're done</h2>
    ${checklist("omio-end", [
      "Spindle fully stopped, Z raised.",
      "Vacuum chips from the table, rails, covers and dust shoe.",
      "Remove the tool or leave it, then wipe the collet and nut.",
      "Remove and deburr the part. Check the key dimensions with calipers.",
      "Log the job (and save the settings as tested if they worked well).",
      "Shut down Mach3, then power the machine off.",
    ])}
    <h2>Useful reading</h2>
    <ul>
      <li>${link("https://docs.wcproducts.com/omio-cnc-router-x8-usb/misc/recommendations", "WCP's feeds and speeds recommendations")} (slotting aluminum with WCP endmills; they say values can be doubled or tripled for plastic and wood).</li>
      <li>${link("https://www.chiefdelphi.com/t/omio-router-user-instructions/396810", "Chief Delphi: Omio Router User Instructions")}</li>
      <li>${link("https://www.chiefdelphi.com/t/omio-cnc-first-setup/441637", "Chief Delphi: Omio CNC First Setup")}</li>
    </ul>`);

  // ================================================================== Troubleshooting
  const problems = [
    ["Chatter: loud buzzing or a rippled wall", "The tool is vibrating against the work.",
      ["Shorten the stick-out (get the tool deeper in the collet).", "Take a lighter depth per pass.", "Change the spindle speed by 10–20% either way.", "Clamp the work closer to the cut and check it isn't flexing.", "Replace a dull tool."]],
    ["Aluminum chips welded to the tool, gummy cut", "Not enough lubricant, or the tool is rubbing instead of cutting.",
      ["Use mist or a little lubricant plus an air blast.", "Raise the feed so every tooth takes a real chip (check chipload on the Feeds & Speeds page).", "Use a single-flute tool: it clears chips best.", "Replace a dull or already-coated-in-aluminum tool."]],
    ["Polycarbonate melts or gums up", "Too slow a feed, no chip clearing, or a dull tool: heat builds up.",
      ["Feed faster so the tool takes bigger chips instead of rubbing.", "Use an air blast (or water-based coolant) to clear chips.", "Don't pause or dwell with the tool in the cut.", "Use a sharp single-flute tool made for plastic."]],
    ["Polycarbonate cracks or crazes later", "Stress from sharp corners, over-tight clamps or the wrong chemical.",
      ["Put a radius on inside corners (at least the tool radius).", "Don't over-tighten clamps or screws.", "Use only air or water-based coolant. Oils and solvents can craze it.", "Avoid sharp scratches and notches at edges."]],
    ["Burrs or fuzz on aluminum edges", "Dull tool, feed too slow, or an unlucky tool path direction.",
      ["Replace or sharpen the tool.", "Raise the feed a little.", "Add a light finishing pass.", "Deburr by hand."]],
    ["Endmill broke", "Too deep or fast, packed chips, a loose tool, or hitting a clamp.",
      ["Reduce depth per pass and check chipload.", "Clear chips with air; use a single flute in aluminum.", "Make sure the tool is seated deep and the collet nut is tight.", "Check the toolpath against your clamps and screws.", "Re-measure Z zero after every tool change."]],
    ["Holes or slots are the wrong size", "The tool cuts smaller than its label, or the tool diameter in CAM is wrong.",
      ["Measure a test slot and use that as the CAM diameter (Hole & Tool Size page).", "Check for runout: re-seat the tool and clean the collet.", "Use a finishing pass for sizes that matter."]],
    ["Cuts don't go all the way through", "Z zero is off, or the spoilboard isn't flat.",
      ["Re-set Z zero with the tool you're using.", "Cut about 0.2 mm into the spoilboard.", "Surface the spoilboard (Spoilboard Surfacing page)."]],
    ["Part moved or lifted during the cut", "Not enough holding force, or a small part finished cutting.",
      ["Add clamps or screws, and use tabs on small parts.", "Check nothing is under the part (chips).", "Use a lighter cut on thin stock."]],
    ["Walls are tapered or stair-stepped", "The tool is deflecting.",
      ["Shorter stick-out and a lighter depth per pass.", "Add a finishing pass at full depth.", "Use a stiffer (shorter, thicker) tool."]],
    ["The machine skips, loses position or stalls", "Feeds too high, something is binding, or a coupler or set screw is loose.",
      ["Lower the feed and check the machine moves freely by hand.", "Clean and lubricate rails and ball screws.", "Check couplers, set screws and cables."]],
    ["Spindle stops or shows a drive error", "The spindle drive (VFD) reported a fault.",
      ["Read the code on the drive display and look it up in the drive manual.", "Check spindle cooling and the connections.", "Search Chief Delphi for “Omio spindle error”: other teams have hit these."]],
  ];
  App.register({
    id: "trouble", title: "Troubleshooting", keywords: "problem chatter melting burrs broke tool oversize wrong size not through spoilboard help fix",
    render(root) {
      root.innerHTML = html`<article class="card prose"><h1>Troubleshooting</h1><p class="mut">Find the symptom, then work down the list: the first fixes are the most likely.</p>
        ${problems.map(([t, why, fixes]) => html`<details class="qa"><summary>${t}</summary><p><b>Likely cause:</b> ${why}</p><ol>${fixes.map(f => html`<li>${f}</li>`)}</ol></details>`)}
        <p class="mut small">Change one thing at a time so you know what fixed it, then save the working settings as tested.</p></article>`.s;
    },
  });

  // ================================================================== Materials
  guide("materials", "Materials & Terms", "aluminum 6061 5052 polycarbonate lexan mdf spoilboard chipload sfm stepover stepdown glossary terms", () => html`
    <h2>Aluminum (6061-T6)</h2>
    <ul>
      <li>The workhorse alloy for FRC: strong, machines well, and welds. It's too hard-tempered to bend tightly (see Sheet Bending: 5052 bends much better).</li>
      <li>Chips weld to the tool without lubrication. Use mist plus an air blast, a sharp single-flute tool, and a chipload big enough to cut instead of rub.</li>
      <li>Deburr every edge. Cut edges are sharp.</li>
      <li>Density about 2.70 g/cm³ (0.0975 lb/in³).</li>
    </ul>
    <h2>Polycarbonate (Lexan)</h2>
    <ul>
      <li>Tough, clear and light, but <b>notch-sensitive</b>: sharp inside corners, scratches and over-tight clamps start cracks.</li>
      <li>Cuts best with a sharp single-flute tool, a high feed, and air or water-based coolant. Slow feeds and dwelling melt it.</li>
      <li>Some oils, solvents, adhesives and cleaners attack it, especially when it is stressed (they cause crazing). Keep to air, water and soap, and test anything else on scrap.</li>
      <li>Cold bending needs a very large radius (100 × thickness or more); use heat for tighter bends.</li>
      <li>Leave the protective film on while machining if it doesn't gum up the tool; it keeps scratches off.</li>
      <li>Density about 1.20 g/cm³ (0.0433 lb/in³).</li>
    </ul>
    <h2>MDF spoilboard</h2>
    <ul>
      <li>A sacrificial board that lets cuts go all the way through. Surface it flat with the facemill so every part is cut at the same height.</li>
      <li>MDF dust is harmful: use the vacuum and wear a respirator.</li>
      <li>Keep it dry; it swells with moisture. Avoid cutting the same lines over and over so it stays flat longer.</li>
    </ul>
    <h2>Terms</h2>
    <dl>
      <dt>Spindle speed (rpm)</dt><dd>How fast the tool turns.</dd>
      <dt>SFM (surface feet per minute)</dt><dd>How fast the cutting edge moves past the material. Depends on rpm and tool diameter: SFM = rpm × diameter(in) × 0.2618.</dd>
      <dt>Feed rate</dt><dd>How fast the tool moves through the material (in/min or mm/min).</dd>
      <dt>Chipload (feed per tooth)</dt><dd>How thick a chip each cutting edge takes: feed ÷ (rpm × flutes). Too small and the tool rubs and heats; too big and it overloads.</dd>
      <dt>Depth of cut / stepdown</dt><dd>How deep each pass goes.</dd>
      <dt>Width of cut / stepover</dt><dd>How much of the tool's diameter is in the material sideways. A slot is 100%.</dd>
      <dt>Chip thinning</dt><dd>With a narrow width of cut each chip is thinner than the chipload suggests, so you can feed faster.</dd>
      <dt>Ramp</dt><dd>Easing into the material along a shallow angle instead of plunging straight down.</dd>
      <dt>Stick-out</dt><dd>How far the tool sticks out of the collet. Stiffness drops fast as it gets longer.</dd>
      <dt>Climb vs conventional</dt><dd>Climb milling feeds with the rotation (cleaner cut, standard in CAM); conventional feeds against it.</dd>
      <dt>Kerf</dt><dd>The width of material a saw or router bit removes.</dd>
    </dl>`);

  // ================================================================== Links
  const L = (href, title, text) => html`<li>${link(href, title)}<span class="mut"> — ${text}</span></li>`;
  guide("links", "Links & References", "links resources docs manual wcp thrifty bot chief delphi reca wpilib rev ctre andymark mcmaster", () => html`
    <h2>Our machine and tools</h2>
    <ul>
      ${L("https://wcproducts.com/products/omio-cnc-and-accessories", "OMIO CNC Router X8 (WCP-0341)", "the machine's store page")}
      ${L("https://docs.wcproducts.com/omio-cnc-router-x8-usb", "OMIO X8 documentation", "WCP's setup and operation guide")}
      ${L("https://docs.wcproducts.com/omio-cnc-router-x8-usb/misc/recommendations", "WCP feeds and speeds recommendations", "table for slotting aluminum")}
      ${L("https://www.thethriftybot.com/products/qty-2-5mm-carbide-single-flute-endmill", "Thrifty Bot 5 mm carbide single-flute endmill", "5 mm × 12 mm cut × 50 mm long, sold in pairs")}
      ${L("https://wcproducts.com/products/srpp-sheets", "WCP SRPP sheets", "self-reinforced polypropylene sheet from WCP")}
      ${L("https://www.chiefdelphi.com/t/omio-router-user-instructions/396810", "Chief Delphi: Omio Router User Instructions", "community how-to")}
      ${L("https://www.chiefdelphi.com/t/omio-cnc-first-setup/441637", "Chief Delphi: Omio CNC First Setup", "first-time setup experiences")}
    </ul>
    <h2>FRC rules</h2>
    <ul>
      ${L("https://www.frcmanual.com/2026/robot-construction-rules-(r)", "FRC Manual (2026): Robot Construction Rules", "weight, wiring, pneumatics and more. Check the current season's manual")}
      ${L("https://firstfrc.blob.core.windows.net/frc2026/Manual/2026FRCInspectionChecklist.pdf", "2026 FRC inspection checklist (PDF)", "what inspectors look for")}
      ${L("https://info.firstinspires.org/hubfs/web/program/frc/resources/bumper-guide.pdf", "FIRST bumper guide (PDF)", "bumper construction")}
    </ul>
    <h2>Motors, electronics and parts</h2>
    <ul>
      ${L("https://docs.revrobotics.com/brushless/neo/compare", "REV: NEO motor comparison", "NEO, NEO 550 and Vortex specs")}
      ${L("https://store.ctr-electronics.com/products/kraken-x60", "CTR Electronics: Kraken X60", "motor specs")}
      ${L("https://docs.wcproducts.com/frc-build-system/electronics-and-pneumatics/brushless-motors", "WCP: brushless motors", "Kraken X60 and X44 data")}
      ${L("https://andymark.com/am-2986", "AndyMark: 1/2 in hex flanged bearing", "1.125 in OD, FR8ZZ-HexHD")}
      ${L("https://docs.wpilib.org/", "WPILib documentation", "control system, wiring and programming docs")}
      ${L("https://www.reca.lc/", "ReCalc", "the full FRC mechanism calculators (this app covers the basics)")}
      ${L("https://www.mcmaster.com/", "McMaster-Carr", "stock, fasteners and tooling")}
    </ul>
    <p class="mut small">Links open in a new tab. Specs and rules change from year to year, so confirm anything that matters at the source.</p>`);
})();
