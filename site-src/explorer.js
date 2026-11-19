// Explorer for the type graph: Cytoscape for nodes and edges, Oxigraph for SPARQL over all.ttl.
// Data comes from assets/kg/graph.json, written by tools/build-site.mjs from the ontology JSON.

const OXIGRAPH = "https://cdn.jsdelivr.net/npm/oxigraph@0.5.12/web.js";
const PALETTE = { "l1": "#2E5C8A", "l2": "#2A8C5A", "l2-bpmn": "#C0661B", "l2-dmn": "#8A3E9C", "l3": "#B23A48" };
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

const graph = await (await fetch("assets/kg/graph.json")).json();
const byId = new Map(graph.classes.map((c) => [c.id, c]));
const color = (layer) => PALETTE[layer] ?? "#666";
const params = new URLSearchParams(location.search);

// ---------------------------------------------------------------- graph

const elements = [
  ...graph.classes.map((c) => ({ data: { id: c.id, label: c.name, layer: c.layer, kind: c.kind, color: color(c.layer) } })),
  ...graph.edges.map((e, i) => ({ data: {
    id: `e${i}`, source: e.source, target: e.target, predicate: e.predicate, layer: e.layer,
    label: e.qualifier ? `${e.predicate} (${e.qualifier})` : e.predicate,
  } })),
];

const cy = cytoscape({
  container: $("kg-cy"),
  elements,
  wheelSensitivity: 0.25,
  style: [
    { selector: "node", style: {
      "background-color": "data(color)", label: "data(label)", color: "#1f2328", "font-size": 10,
      "text-valign": "bottom", "text-margin-y": 3, width: 18, height: 18,
      "text-background-color": "#fbfcfd", "text-background-opacity": 0.8, "text-background-padding": 1,
    } },
    { selector: "edge", style: {
      width: 1.2, "line-color": "#aab4be", "target-arrow-color": "#aab4be", "target-arrow-shape": "triangle",
      "curve-style": "bezier", "arrow-scale": 0.8, "font-size": 8, color: "#5c6670",
      "text-rotation": "autorotate", "text-background-color": "#fbfcfd", "text-background-opacity": 0.8,
    } },
    { selector: "edge.labelled", style: { label: "data(label)" } },
    { selector: ".faded", style: { opacity: 0.12 } },
    { selector: ".hidden", style: { display: "none" } },
    { selector: "node.hit", style: { "border-width": 3, "border-color": "#f2b705", width: 24, height: 24 } },
    { selector: "node:selected", style: { "border-width": 3, "border-color": "#1f2328", width: 26, height: 26 } },
    { selector: "edge.focus", style: { width: 2.2, "line-color": "#1f2328", "target-arrow-color": "#1f2328", label: "data(label)", "z-index": 10 } },
  ],
  layout: {
    name: "cose", animate: false, randomize: true, padding: 20, numIter: 2500, nodeOverlap: 20,
    nodeRepulsion: () => 60000, idealEdgeLength: () => 110, edgeElasticity: () => 60, gravity: 0.4, componentSpacing: 80,
  },
});

// Layer toggles
const layerBox = $("kg-layers");
const wanted = params.get("layer");
for (const L of graph.layers) {
  const n = graph.classes.filter((c) => c.layer === L.id).length;
  const lab = document.createElement("label");
  lab.innerHTML = `<input type="checkbox" value="${esc(L.id)}" ${!wanted || wanted === L.id ? "checked" : ""}>` +
    `<span class="kg-swatch" style="background:${color(L.id)}"></span>${esc(L.id)} <span class="kg-hint">(${n})</span>`;
  lab.title = L.note;
  layerBox.append(lab);
}
const preds = [...new Set(graph.edges.map((e) => e.predicate))].sort();
for (const p of preds) $("kg-predicate").insertAdjacentHTML("beforeend", `<option>${esc(p)}</option>`);

function applyFilters() {
  const layers = new Set([...layerBox.querySelectorAll("input:checked")].map((i) => i.value));
  const pred = $("kg-predicate").value;
  const q = $("kg-search").value.trim().toLowerCase();
  cy.batch(() => {
    cy.nodes().forEach((n) => n.toggleClass("hidden", !layers.has(n.data("layer"))));
    cy.edges().forEach((e) => {
      const hide = e.source().hasClass("hidden") || e.target().hasClass("hidden") || (pred && e.data("predicate") !== pred);
      e.toggleClass("hidden", hide);
    });
    if (pred) cy.nodes().forEach((n) => { if (!n.hasClass("hidden") && n.connectedEdges(":visible").length === 0) n.addClass("hidden"); });
    cy.elements().removeClass("faded hit");
    if (q) {
      const match = cy.nodes(":visible").filter((n) => {
        const c = byId.get(n.id());
        return [c.id, c.name, c.kind, ...c.properties].some((s) => s.toLowerCase().includes(q));
      });
      cy.elements(":visible").addClass("faded");
      match.removeClass("faded").addClass("hit");
      match.connectedEdges(":visible").removeClass("faded");
    }
  });
  status();
}

function status() {
  const nv = cy.nodes(":visible").length, ev = cy.edges(":visible").length;
  $("kg-status").textContent = `${nv} of ${graph.classes.length} classes, ${ev} of ${graph.edges.length} licensed edges shown. Scroll to zoom, drag to pan.`;
}

function edgeItem(e, dir) {
  const other = dir === "out" ? e.target : e.source;
  const c = byId.get(other);
  const label = e.qualifier ? `${e.predicate} (${e.qualifier})` : e.predicate;
  return `<li>${dir === "out" ? "→" : "←"} <code title="${esc(graph.predicates[e.predicate])}">${esc(label)}</code> ` +
    `<a data-focus="${esc(other)}">${esc(c?.name ?? other)}</a> <span class="kg-hint">${esc(c?.layer ?? "")}</span></li>`;
}

function focus(id, { center = true } = {}) {
  const c = byId.get(id);
  if (!c) return;
  const node = cy.getElementById(id);
  if (node.hasClass("hidden")) {
    const box = layerBox.querySelector(`input[value="${CSS.escape(c.layer)}"]`);
    if (box) { box.checked = true; applyFilters(); }
  }
  cy.elements().unselect().removeClass("focus faded");
  node.select();
  const hood = node.closedNeighborhood();
  cy.elements(":visible").not(hood).addClass("faded");
  node.connectedEdges().addClass("focus");
  if (center) cy.animate({ center: { eles: node }, zoom: Math.max(cy.zoom(), 1.1) }, { duration: 250 });
  const out = graph.edges.filter((e) => e.source === id), inn = graph.edges.filter((e) => e.target === id);
  $("kg-detail").innerHTML =
    `<h3>${esc(c.name)}</h3>` +
    `<p><span class="kg-tag" style="background:${color(c.layer)}">${esc(c.layer)}</span><span class="kg-tag" style="background:#5c6670">${esc(c.kind)}</span>` +
    ` <code>${esc(c.id)}</code></p>` +
    `<p><a href="schema/${esc(c.layer)}.html#class-${esc(c.id)}">Schema page</a> · <span class="kg-hint">${esc(c.iri)}</span></p>` +
    (c.elaborates ? `<p>Elaborates <a data-focus="${esc(c.elaborates)}">${esc(byId.get(c.elaborates)?.name ?? c.elaborates)}</a></p>` : "") +
    `<p>${esc(c.note)}</p>` +
    (c.properties.length ? `<strong>Properties (${c.properties.length})</strong><ul>${c.properties.map((p) => `<li><code>${esc(p)}</code></li>`).join("")}</ul>` : "") +
    `<strong>Outgoing (${out.length})</strong><ul>${out.map((e) => edgeItem(e, "out")).join("") || "<li class=kg-hint>none — nothing may point out of this class</li>"}</ul>` +
    `<strong>Incoming (${inn.length})</strong><ul>${inn.map((e) => edgeItem(e, "in")).join("") || "<li class=kg-hint>none</li>"}</ul>`;
  const u = new URL(location.href); u.searchParams.set("class", id); history.replaceState(null, "", u);
}

document.addEventListener("click", (ev) => {
  const a = ev.target.closest("[data-focus]");
  if (a) { ev.preventDefault(); focus(a.dataset.focus); }
});
cy.on("tap", "node", (ev) => focus(ev.target.id(), { center: false }));
cy.on("tap", (ev) => { if (ev.target === cy) cy.elements().removeClass("focus faded"); });
cy.on("mouseover", "edge", (ev) => ev.target.addClass("labelled"));
cy.on("mouseout", "edge", (ev) => { if (!$("kg-labels").checked) ev.target.removeClass("labelled"); });

layerBox.addEventListener("change", () => { applyFilters(); cy.fit(cy.elements(":visible"), 20); });
$("kg-predicate").addEventListener("change", applyFilters);
$("kg-search").addEventListener("input", applyFilters);
$("kg-labels").addEventListener("change", (e) => cy.edges().toggleClass("labelled", e.target.checked));
$("kg-fit").addEventListener("click", () => cy.fit(cy.elements(":visible"), 20));
$("kg-reset").addEventListener("click", () => {
  layerBox.querySelectorAll("input").forEach((i) => (i.checked = true));
  $("kg-predicate").value = ""; $("kg-search").value = "";
  cy.elements().unselect().removeClass("focus faded hit");
  $("kg-detail").innerHTML = `<p class="kg-hint">Click a class to see its properties and licensed edges.</p>`;
  applyFilters(); cy.fit(undefined, 20);
});

applyFilters();
cy.fit(cy.elements(":visible"), 20);
if (params.get("class")) focus(params.get("class"));

// ---------------------------------------------------------------- SPARQL

const PREFIXES = `PREFIX sgkg: <http://smart.who.int/kg/>
PREFIX owl:  <http://www.w3.org/2002/07/owl#>
PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
PREFIX skos: <http://www.w3.org/2004/02/skos/core#>
`;
const EXAMPLES = [
  ["Every licensed edge", `SELECT ?source ?predicate ?target WHERE {
  ?edge rdfs:subPropertyOf ?predicate ; rdfs:domain ?source ; rdfs:range ?target .
} ORDER BY ?source ?predicate ?target`],
  ["What may point at a terminology code?", `SELECT ?source ?predicate WHERE {
  ?edge rdfs:subPropertyOf ?predicate ; rdfs:domain ?source ; rdfs:range sgkg:TerminologyCode .
} ORDER BY ?source`],
  ["What may a terminology code point at? (nothing — it is a leaf)", `SELECT ?predicate ?target WHERE {
  ?edge rdfs:subPropertyOf ?predicate ; rdfs:domain sgkg:TerminologyCode ; rdfs:range ?target .
}`],
  ["Classes and their kind", `SELECT ?class ?label ?kind WHERE {
  ?class a owl:Class ; skos:notation ?id ; rdfs:label ?label ; rdfs:subClassOf ?kind .
} ORDER BY ?kind ?label`],
  ["Licensed edges per predicate", `SELECT ?predicate (COUNT(?edge) AS ?edges) WHERE {
  ?edge rdfs:subPropertyOf ?predicate .
} GROUP BY ?predicate ORDER BY DESC(?edges)`],
  ["Classes nothing may point at", `SELECT ?class ?label WHERE {
  ?class a owl:Class ; skos:notation ?id ; rdfs:label ?label .
  FILTER NOT EXISTS { ?edge rdfs:range ?class }
} ORDER BY ?label`],
  ["Two hops from Recommendation", `SELECT ?p1 ?mid ?p2 ?end WHERE {
  ?e1 rdfs:subPropertyOf ?p1 ; rdfs:domain sgkg:Recommendation ; rdfs:range ?mid .
  ?e2 rdfs:subPropertyOf ?p2 ; rdfs:domain ?mid ; rdfs:range ?end .
} ORDER BY ?mid ?end`],
  ["Search descriptions for a word", `SELECT ?thing ?label ?comment WHERE {
  ?thing rdfs:label ?label ; rdfs:comment ?comment .
  FILTER(CONTAINS(LCASE(?comment), "citation"))
} ORDER BY ?label`],
];
for (const [i, [name]] of EXAMPLES.entries()) $("kg-examples").insertAdjacentHTML("beforeend", `<option value="${i}">${esc(name)}</option>`);
const setExample = () => ($("kg-query").value = PREFIXES + "\n" + EXAMPLES[+$("kg-examples").value][1]);
$("kg-examples").addEventListener("change", setExample);
setExample();

let storePromise;
async function store() {
  storePromise ??= (async () => {
    $("kg-sparql-status").textContent = "Loading Oxigraph and all.ttl…";
    const ox = await import(OXIGRAPH);
    await ox.default();
    const ttl = await (await fetch("assets/kg/all.ttl")).text();
    const s = new ox.Store();
    s.load(ttl, { format: "text/turtle" });
    // Turtle class IRIs are CamelCase; graph.json ids are kebab-case. skos:notation joins them.
    const iriToId = new Map();
    for (const b of s.query(`${PREFIXES} SELECT ?c ?n WHERE { ?c a owl:Class ; skos:notation ?n }`)) iriToId.set(b.get("c").value, b.get("n").value);
    return { s, iriToId, size: s.size };
  })();
  return storePromise;
}

const shortIri = (v) => v.replace("http://smart.who.int/kg/", "sgkg:").replace("http://www.w3.org/2002/07/owl#", "owl:")
  .replace("http://www.w3.org/2000/01/rdf-schema#", "rdfs:").replace("http://www.w3.org/2004/02/skos/core#", "skos:");

async function run() {
  const out = $("kg-results");
  out.innerHTML = "";
  try {
    const { s, iriToId, size } = await store();
    const t0 = performance.now();
    const res = s.query($("kg-query").value);
    const ms = Math.round(performance.now() - t0);
    if (typeof res === "boolean") { out.innerHTML = `<p><strong>${res}</strong></p>`; $("kg-sparql-status").textContent = `ASK in ${ms} ms`; return; }
    if (typeof res === "string") { out.innerHTML = `<pre>${esc(res)}</pre>`; return; }
    const rows = [...res];
    if (rows.length && !(rows[0] instanceof Map)) {
      out.innerHTML = `<pre>${esc(rows.map((q) => `${q.subject.value} ${q.predicate.value} ${q.object.value}`).join("\n"))}</pre>`;
      $("kg-sparql-status").textContent = `${rows.length} triples in ${ms} ms`;
      return;
    }
    const vars = [...new Set(rows.flatMap((r) => [...r.keys()]))];
    const hits = new Set();
    const cell = (t) => {
      if (!t) return "";
      if (t.termType === "NamedNode") {
        const id = iriToId.get(t.value);
        if (id) { hits.add(id); return `<a data-focus="${esc(id)}" title="${esc(t.value)}">${esc(shortIri(t.value))}</a>`; }
        return `<code>${esc(shortIri(t.value))}</code>`;
      }
      return esc(t.value);
    };
    out.innerHTML = `<table><thead><tr>${vars.map((v) => `<th>?${esc(v)}</th>`).join("")}</tr></thead><tbody>` +
      rows.map((r) => `<tr>${vars.map((v) => `<td>${cell(r.get(v))}</td>`).join("")}</tr>`).join("") + "</tbody></table>";
    $("kg-sparql-status").textContent = `${rows.length} row(s) in ${ms} ms over ${size} triples` + (hits.size ? ` · ${hits.size} class(es) highlighted in the graph` : "");
    cy.elements().removeClass("hit faded focus");
    if (hits.size) {
      const sel = cy.nodes().filter((n) => hits.has(n.id()));
      cy.elements(":visible").addClass("faded");
      sel.removeClass("faded").addClass("hit");
      sel.edgesWith(sel).removeClass("faded");
    }
  } catch (e) {
    $("kg-sparql-status").textContent = "";
    out.innerHTML = `<p style="color:#b23a48"><strong>Query failed:</strong> ${esc(e.message ?? e)}</p>`;
  }
}
$("kg-run").addEventListener("click", run);
$("kg-query").addEventListener("keydown", (e) => { if ((e.ctrlKey || e.metaKey) && e.key === "Enter") run(); });
