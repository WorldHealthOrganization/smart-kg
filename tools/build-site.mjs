#!/usr/bin/env node
// Builds the GitHub Pages site for the type graph into site/ (not committed).
//
// The site is a VIEW of ontology/<layer>/<layer>.json, like the .ttl and .cypher beside it, so it is
// generated rather than authored and is never checked in: .github/workflows/pages.yml runs this,
// renders the PlantUML, and hands the result to Jekyll (just-the-docs).
//
// What it writes:
//   site/index.md, site/docs/*.md     the README and docs/, with repository links made to resolve
//   site/schema/<layer>.md            one page per layer: classes, licensed edges, predicates
//   site/diagrams/<layer>.puml        PlantUML class diagram per layer, plus layers.puml and all.puml
//   site/explorer.md                  interactive nodes-and-edges view with a SPARQL console
//   site/assets/kg/graph.json         every class and licensed edge, for the explorer
//   site/assets/kg/all.ttl            the merged Turtle the SPARQL console queries
//
// Plain Node, no dependencies, like every other tool here.
//
//   node tools/build-site.mjs [--out site] [--repo owner/name] [--ref main]

import { readFileSync, writeFileSync, mkdirSync, readdirSync, rmSync, copyFileSync, existsSync } from "node:fs";
import { join, dirname, posix } from "node:path";
import { fileURLToPath } from "node:url";
import { loadLayer, borrowedClassIds } from "./ontology.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const LAYERS = ["l1", "l2", "l2-bpmn", "l2-dmn", "l3"];

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : dflt;
};
const OUT = join(ROOT, arg("out", "site"));
const REPO = arg("repo", process.env.GITHUB_REPOSITORY || "WorldHealthOrganization/smart-kg");
const REF = arg("ref", "main");
const BLOB = `https://github.com/${REPO}/blob/${REF}/`;
const TREE = `https://github.com/${REPO}/tree/${REF}/`;

rmSync(OUT, { recursive: true, force: true });
const write = (rel, text) => {
  const p = join(OUT, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, text);
};

// ---------------------------------------------------------------------------------------------
// Load every layer once. A class belongs to the layer that declares it; an edge to the layer whose
// JSON licenses it -- which may name a class from an import (l2-dmn licenses dmn-rule -> citation).

const layers = LAYERS.map((id) => ({ id, ...loadLayer(id) }));
const classLayer = new Map();
for (const L of layers) for (const c of L.own.classes) classLayer.set(c.id, L.id);
const classById = new Map(layers.flatMap((L) => L.own.classes.map((c) => [c.id, c])));

const md = (s) => String(s ?? "").replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
const anchor = (id) => `class-${id}`;
const classLink = (id, from) => {
  const l = classLayer.get(id);
  const name = classById.get(id)?.name ?? id;
  return l === from ? `[${name}](#${anchor(id)})` : `[${name}](${l}.html#${anchor(id)}) <sub>${l}</sub>`;
};

// ---------------------------------------------------------------------------------------------
// PlantUML. One class diagram per layer: own classes with their properties, imported classes the
// layer's edges reach shown as greyed stubs, so the diagram says where the layer touches its
// imports without redrawing them. Smetana layout, so rendering needs Java and nothing else.

const pumlId = (id) => id.replace(/[^A-Za-z0-9]/g, "_");
const PUML_HEAD = [
  "!pragma layout smetana",
  "skinparam shadowing false",
  "skinparam classAttributeIconSize 0",
  "skinparam defaultFontName sans-serif",
  "skinparam class {",
  "  BackgroundColor #FDFDFD",
  "  BorderColor #2E5C8A",
  "  ArrowColor #555555",
  "}",
  "skinparam class<<imported>> {",
  "  BackgroundColor #EEEEEE",
  "  BorderColor #999999",
  "  FontColor #666666",
  "}",
  "hide empty members",
];

function pumlClass(c, { fields = true, stereo } = {}) {
  const s = stereo ?? c.kind;
  const lines = [`class "${c.name}" as ${pumlId(c.id)} <<${s}>>${fields && c.properties?.length ? " {" : ""}`];
  if (fields && c.properties?.length) {
    for (const p of c.properties) {
      const vs = c.valueSets?.[p];
      lines.push(`  ${p}${vs ? ` : ${typeof vs === "string" ? vs : vs.set}` : ""}`);
    }
    lines.push("}");
  }
  return lines;
}

function pumlEdge(e) {
  const label = e.qualifier ? `${e.predicate} (${e.qualifier})` : e.predicate;
  return `${pumlId(e.source)} --> ${pumlId(e.target)} : ${label}`;
}

function layerPuml(L) {
  const out = ["@startuml", ...PUML_HEAD, `title ${L.own.layer} — ${L.own.classes.length} classes, ${L.own.edges.length} licensed edges`];
  out.push(`package "${L.id}" {`);
  for (const c of L.own.classes) out.push(...pumlClass(c).map((x) => "  " + x));
  out.push("}");
  for (const id of borrowedClassIds(L)) {
    const c = classById.get(id);
    out.push(...pumlClass(c, { fields: false, stereo: `imported from ${classLayer.get(id)}` }).map((x) => x.replace(/<<imported from [^>]+>>/, `<<imported>>`)));
  }
  for (const e of L.own.edges) out.push(pumlEdge(e));
  out.push("@enduml", "");
  return out.join("\n");
}

function allPuml() {
  const out = ["@startuml", ...PUML_HEAD, "title All layers — classes and licensed edges (properties omitted)"];
  for (const L of layers) {
    out.push(`package "${L.id}" {`);
    for (const c of L.own.classes) out.push("  " + pumlClass(c, { fields: false })[0]);
    out.push("}");
  }
  for (const L of layers) for (const e of L.own.edges) out.push(pumlEdge(e));
  out.push("@enduml", "");
  return out.join("\n");
}

function layersPuml() {
  const out = ["@startuml", ...PUML_HEAD, "title Layer imports"];
  for (const L of layers) {
    out.push(`package "${L.id}" as ${pumlId(L.id)} {`, `  class "${L.own.classes.length} classes, ${L.own.edges.length} edges" as ${pumlId(L.id)}_n <<${L.own.layer}>>`, "}");
  }
  for (const L of layers) for (const dep of L.own.imports ?? []) out.push(`${pumlId(L.id)} ..> ${pumlId(dep)} : imports`);
  out.push("@enduml", "");
  return out.join("\n");
}

for (const L of layers) write(`diagrams/${L.id}.puml`, layerPuml(L));
write("diagrams/all.puml", allPuml());
write("diagrams/layers.puml", layersPuml());

// ---------------------------------------------------------------------------------------------
// Markdown pages, one per layer.

function layerPage(L, order) {
  const o = L.own;
  const P = [];
  P.push("---", `title: ${L.id}`, `parent: Schema`, `nav_order: ${order}`, "---", "");
  P.push(`# ${o.layer} — \`ontology/${L.id}/\``, "");
  P.push(`${o.classes.length} classes · ${o.edges.length} licensed edges · ${o.predicates.length} predicates` +
    (o.imports?.length ? ` · imports ${o.imports.map((d) => `[${d}](${d}.html)`).join(", ")}` : ""), "");
  P.push(`[Open in the explorer](../explorer.html?layer=${L.id}){: .btn .btn-primary }` +
    ` [${L.id}.json](${BLOB}ontology/${L.id}/${L.id}.json){: .btn }` +
    ` [.ttl](${BLOB}ontology/${L.id}/${L.id}.ttl){: .btn }` +
    ` [.cypher](${BLOB}ontology/${L.id}/${L.id}.cypher){: .btn }` +
    ` [.puml](../diagrams/${L.id}.puml){: .btn }`, "");
  if (o.note) P.push(`> ${md(o.note)}`, "");
  P.push("## Diagram", "", `[![${L.id} class diagram](../diagrams/${L.id}.svg)](../diagrams/${L.id}.svg)`, "",
    "Grey classes are declared by an imported layer and shown only where this layer's edges reach them.", "");

  P.push("## Classes", "");
  for (const c of o.classes) {
    P.push(`### ${c.name} {#${anchor(c.id)}}`, "");
    P.push(`\`${c.id}\` · kind **${c.kind}** · <${c.iri}>` + (c.elaborates ? ` · elaborates ${classLink(c.elaborates, L.id)}` : ""), "");
    if (c.note) P.push(md(c.note), "");
    if (c.properties?.length) {
      P.push("| Property | Value set |", "|---|---|");
      for (const p of c.properties) {
        const vs = c.valueSets?.[p];
        P.push(`| \`${p}\` | ${vs ? `\`${typeof vs === "string" ? vs : vs.set}\`` : ""} |`);
      }
      P.push("");
    }
    if (c.propertyNote) P.push(`*${md(c.propertyNote)}*`, "");
    const outE = layers.flatMap((X) => X.own.edges).filter((e) => e.source === c.id);
    const inE = layers.flatMap((X) => X.own.edges).filter((e) => e.target === c.id);
    if (outE.length || inE.length) {
      P.push("| Direction | Predicate | Class |", "|---|---|---|");
      for (const e of outE) P.push(`| → out | \`${e.predicate}\`${e.qualifier ? ` (${e.qualifier})` : ""} | ${classLink(e.target, L.id)} |`);
      for (const e of inE) P.push(`| ← in | \`${e.predicate}\`${e.qualifier ? ` (${e.qualifier})` : ""} | ${classLink(e.source, L.id)} |`);
      P.push("");
    }
  }

  P.push("## Licensed edges", "", "| Source | Predicate | Target | Note |", "|---|---|---|---|");
  for (const e of o.edges) {
    P.push(`| ${classLink(e.source, L.id)} | \`${e.predicate}\`${e.qualifier ? ` (${e.qualifier})` : ""} | ${classLink(e.target, L.id)} | ${md(e.note)} |`);
  }
  P.push("");

  P.push("## Predicates", "", "| Predicate | Note |", "|---|---|");
  for (const p of o.predicates) P.push(`| \`${p.predicate}\` | ${md(p.note)} |`);
  P.push("");

  if (o.valueSets?.length) {
    P.push("## Value sets", "");
    for (const v of o.valueSets) {
      P.push(`### \`${v.id}\``, "", md(v.note), "", "| Code | Definition |", "|---|---|");
      for (const c of v.codes ?? []) P.push(`| \`${c.code}\` | ${md(c.definition ?? c.display)} |`);
      P.push("");
    }
  }

  if (o.groundedIn?.length) {
    P.push("## Grounded in", "", "| What | Where | Detail |", "|---|---|---|");
    for (const g of o.groundedIn) P.push(`| ${md(g.what)} | ${md(g.where)} | ${md(g.detail)} |`);
    P.push("");
  }
  if (o.deliberatelyOmitted?.length) {
    P.push("## Deliberately omitted", "", "| What | Why |", "|---|---|");
    for (const d of o.deliberatelyOmitted) P.push(`| ${md(d.what)} | ${md(d.why)} |`);
    P.push("");
  }
  return P.join("\n");
}

layers.forEach((L, i) => write(`schema/${L.id}.md`, layerPage(L, i + 1)));

const totals = layers.reduce((a, L) => ({ c: a.c + L.own.classes.length, e: a.e + L.own.edges.length }), { c: 0, e: 0 });
write("schema/index.md", [
  "---", "title: Schema", "nav_order: 2", "has_children: true", "---", "",
  "# The type graph", "",
  `${layers.length} layers, ${totals.c} classes, ${totals.e} licensed edges. Generated from ` +
  `\`ontology/<layer>/<layer>.json\` on every push to \`main\`; this site holds no DAK data.`, "",
  "[Open the explorer](../explorer.html){: .btn .btn-primary } [Download all.ttl](../assets/kg/all.ttl){: .btn }", "",
  "## Layers", "",
  "| Layer | Classes | Edges | Imports |", "|---|---|---|---|",
  ...layers.map((L) => `| [${L.id}](${L.id}.html) | ${L.own.classes.length} | ${L.own.edges.length} | ${(L.own.imports ?? []).join(", ")} |`),
  "", "[![Layer imports](../diagrams/layers.svg)](../diagrams/layers.svg)", "",
  "## Every layer", "", "Properties omitted; each layer's page carries them.", "",
  "[![All layers](../diagrams/all.svg)](../diagrams/all.svg)", "",
  "## Notation", "",
  "UML class diagrams, drawn with [PlantUML](https://plantuml.com/class-diagram). A box is a class " +
  "with its declared properties (and the value set a property is bound to, after the colon); the " +
  "stereotype is its `kind`. An arrow is a **licensed edge**: an instance of the source class may " +
  "point at an instance of the target class with that predicate. The `.puml` sources are linked " +
  "from each layer page.", "",
].join("\n"));

// ---------------------------------------------------------------------------------------------
// Explorer data and page.

const graph = {
  generatedFrom: LAYERS.map((l) => `ontology/${l}/${l}.json`),
  layers: layers.map((L) => ({ id: L.id, label: L.own.layer, imports: L.own.imports ?? [], note: L.own.note ?? "" })),
  classes: layers.flatMap((L) => L.own.classes.map((c) => ({
    id: c.id, name: c.name, kind: c.kind, layer: L.id, iri: c.iri, note: c.note ?? "",
    properties: c.properties ?? [], elaborates: c.elaborates ?? null,
  }))),
  edges: layers.flatMap((L) => L.own.edges.map((e) => ({
    predicate: e.predicate, source: e.source, target: e.target, qualifier: e.qualifier ?? null,
    note: e.note ?? "", layer: L.id,
  }))),
  predicates: Object.fromEntries(layers.flatMap((L) => L.own.predicates.map((p) => [p.predicate, p.note ?? ""]))),
};
write("assets/kg/graph.json", JSON.stringify(graph, null, 1));
mkdirSync(join(OUT, "assets/kg"), { recursive: true });
copyFileSync(join(ROOT, "ontology/all.ttl"), join(OUT, "assets/kg/all.ttl"));
for (const f of ["explorer.js", "explorer.css"]) copyFileSync(join(ROOT, "site-src", f), join(OUT, "assets/kg", f));
write("explorer.md", readFileSync(join(ROOT, "site-src/explorer.md"), "utf8"));
write("_config.yml", readFileSync(join(ROOT, "site-src/_config.yml"), "utf8"));
write("Gemfile", readFileSync(join(ROOT, "site-src/Gemfile"), "utf8"));

// ---------------------------------------------------------------------------------------------
// README and docs/. Links written for browsing the repository are rewritten so they resolve on the
// site: a markdown file this site renders goes to its page, anything else to GitHub.

const pages = new Map([["README.md", "index.html"]]);
for (const f of readdirSync(join(ROOT, "docs")).filter((f) => f.endsWith(".md"))) pages.set(`docs/${f}`, `docs/${f.replace(/\.md$/, ".html")}`);
for (const L of LAYERS) pages.set(`ontology/${L}/`, `schema/${L}.html`), pages.set(`ontology/${L}`, `schema/${L}.html`);

function relinked(text, fromRel) {
  const fromDir = posix.dirname(fromRel);
  const fromPage = pages.get(fromRel);
  const up = "../".repeat(fromPage.split("/").length - 1);
  return text.replace(/\]\(([^)\s]+)\)/g, (m, target) => {
    if (/^([a-z]+:|#|mailto:)/i.test(target)) return m;
    const [path, frag] = target.split("#");
    const resolved = posix.normalize(posix.join(fromDir, path));
    const hit = pages.get(resolved) ?? pages.get(resolved.replace(/\/$/, ""));
    if (hit) return `](${up}${hit}${frag ? "#" + frag : ""})`;
    const isDir = path.endsWith("/") || (existsSync(join(ROOT, resolved)) && !resolved.includes("."));
    return `](${isDir ? TREE : BLOB}${resolved.replace(/\/$/, "")}${frag ? "#" + frag : ""})`;
  });
}

const firstHeading = (t) => (t.match(/^#\s+(.+)$/m)?.[1] ?? "").replace(/[`*]/g, "").trim();
const readme = readFileSync(join(ROOT, "README.md"), "utf8");
write("index.md", ["---", "title: Home", "nav_order: 1", "---", "", relinked(readme, "README.md")].join("\n"));
write("docs/index.md", ["---", "title: Guides", "nav_order: 4", "has_children: true", "---", "", "# Guides", "",
  "The repository's `docs/`, rendered.", ""].join("\n"));
[...pages.keys()].filter((k) => k.startsWith("docs/")).sort().forEach((rel, i) => {
  const t = readFileSync(join(ROOT, rel), "utf8");
  const title = firstHeading(t) || posix.basename(rel, ".md");
  write(rel, ["---", `title: "${title.replace(/"/g, '\\"')}"`, "parent: Guides", `nav_order: ${i + 1}`, "---", "", relinked(t, rel)].join("\n"));
});

console.log(`site/ written: ${layers.length} layer pages, ${graph.classes.length} classes, ${graph.edges.length} edges, ` +
  `${layers.length + 2} PlantUML diagrams. Render them with: java -jar plantuml.jar -tsvg site/diagrams/*.puml`);
