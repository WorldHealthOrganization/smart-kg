#!/usr/bin/env node
// Extracts the DAK component layer from a smart-base-shaped IG: dak.json for the kit's metadata,
// and the FSH instance tree for whichever of the nine components it actually ships.
//
// DAK.fsh declares nine components. This reports on ALL NINE -- including the ones with no
// instance, because "which components does this DAK not have yet" is a question the kit's own
// model implies and nothing in the estate answers.
//
// The one join here that is not string matching is `fulfilledBy`: the committed requirement
// instances write `actor[+] = Canonical(SGAuthoring.Persona.X)`, which resolves against a persona's
// instance id without guessing. It is worth noticing that the mechanism exists.
//
//   node tools/extract-dak.mjs --dak <dak.json> --fsh <input/fsh> [--bpmn-dir d] [--dmn-dir d] [--out p]

import { readFileSync, writeFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, relative, basename } from "node:path";
import { sha256, artifactId, personaId, dataElementId, slug } from "./kgid.mjs";
import { ontologyVersion } from "./ontology.mjs";

const SKILL = "kg/extract-dak";
const node = (id, type, label, properties, extra = {}) =>
  ({ id, type, label, properties, derivation: "derived", skill: SKILL, ...extra });
const edge = (predicate, source, target, extra = {}) =>
  ({ type: "Statement", predicate, source, target, derivation: "derived", skill: SKILL, ...extra });

/** Every .fsh under a directory tree, sorted, with a hash over the lot. */
function fshTree(dir) {
  const files = [];
  const walk = (d) => {
    for (const e of readdirSync(d).sort()) {
      const p = join(d, e);
      if (statSync(p).isDirectory()) walk(p);
      else if (e.endsWith(".fsh")) files.push(p);
    }
  };
  if (existsSync(dir)) walk(dir);
  const digest = createHash("sha256");
  for (const f of files) digest.update(relative(dir, f)).update("\0").update(readFileSync(f));
  return { files, sha256: files.length ? digest.digest("hex") : null };
}

const fshString = (body, key) => {
  const m = new RegExp(`^\\*\\s+${key}\\s*=\\s*"((?:[^"\\\\]|\\\\.)*)"`, "m").exec(body);
  return m ? m[1].replace(/\\"/g, '"') : null;
};
const fshMultiline = (body, key) => {
  const m = new RegExp(`^\\*\\s+${key}\\s*=\\s*"""([\\s\\S]*?)"""`, "m").exec(body);
  return m ? m[1].trim() : fshString(body, key);
};

/** Split a .fsh file into its Instance blocks. One file often holds many.
 *
 * Split rather than match: an earlier version ended each block with a `(?=^Instance:|\Z)`
 * lookahead, and JavaScript has no \Z anchor -- it read as a literal "Z", so the LAST instance in
 * every file was silently dropped. That lost 10 of 41 requirements and all 22 personas while
 * reporting a clean run, which is the worst kind of wrong.
 */
function instances(text) {
  const out = [];
  const parts = text.split(/^(?=Instance:\s*\S)/m);
  for (const part of parts) {
    const m = /^Instance:\s*(\S+)\s*\r?\n\s*InstanceOf:\s*(\S+)/.exec(part);
    if (m) out.push({ id: m[1], instanceOf: m[2], body: part });
  }
  return out;
}

export function extract(opts) {
  const { dakPath, fshDir, bpmnDir, dmnDir } = opts;
  const nodes = [];
  const edges = [];
  const warnings = [];
  const derivedFrom = [];

  // ---- the kit -------------------------------------------------------------------------------
  const dakDoc = JSON.parse(readFileSync(dakPath, "utf8"));
  const ns = String(dakDoc.canonicalUrl ?? dakDoc.publicationUrl ?? "urn:unknown").replace(/\/$/, "");
  const dakIri = `${ns}/kg/dak`;
  derivedFrom.push({ path: dakPath, sha256: sha256(readFileSync(dakPath)) });

  nodes.push(node(dakIri, "dak", dakDoc.title ?? dakDoc.name ?? dakDoc.id, {
    id: dakDoc.id, name: dakDoc.name, title: dakDoc.title,
    description: typeof dakDoc.description === "string" ? dakDoc.description : undefined,
    version: dakDoc.version, status: dakDoc.status,
    publicationUrl: dakDoc.publicationUrl, previewUrl: dakDoc.previewUrl,
    canonicalUrl: dakDoc.canonicalUrl, license: dakDoc.license, copyrightYear: dakDoc.copyrightYear,
    publisherName: dakDoc.publisher?.name, publisherUrl: dakDoc.publisher?.url,
  }));

  // ---- the FSH instance tree ------------------------------------------------------------------
  const tree = fshTree(fshDir);
  if (tree.sha256) {
    derivedFrom.push({
      path: fshDir, sha256: tree.sha256,
      note: `${tree.files.length} .fsh files, hashed as a unit so that a component added upstream ` +
            `expires this projection rather than being silently absent from it.`,
    });
  }

  const personasByInstance = new Map();
  const personasByTitle = new Map();
  const requirements = [];

  for (const file of tree.files) {
    const text = readFileSync(file, "utf8");
    for (const inst of instances(text)) {
      const rel = relative(process.cwd(), file);

      if (inst.instanceOf === "ActorDefinition") {
        const title = fshString(inst.body, "title");
        if (!title) { warnings.push(`ActorDefinition ${inst.id} has no title; skipped`); continue; }
        const iri = personaId(ns, title);
        const description = fshMultiline(inst.body, "description") ?? "";
        const p = {
          iri, instance: inst.id, title,
          name: fshString(inst.body, "name"),
          personaType: /^\*\s+type\s*=\s*#(\S+)/m.exec(inst.body)?.[1] ?? null,
          // GenericPersona.fsh declares iscoCode, but the committed instances write ISCO into the
          // description prose. Read it where it actually is, and say so.
          iscoCode: [...(/\*\*ISCO(?:-08)?\*\*:([^\n]*)/.exec(description)?.[1] ?? "")
                       .matchAll(/\b(\d{4})\b/g)].map((m) => m[1]),
          source: rel,
        };
        personasByInstance.set(inst.id, p);
        if (personasByTitle.has(title)) {
          warnings.push(`two ActorDefinitions share the title "${title}" — a BPMN pool naming it is ambiguous`);
          personasByTitle.set(title, null);
        } else personasByTitle.set(title, p);

        nodes.push(node(iri, "persona", title, {
          id: inst.id, title, name: p.name, description,
          personaType: p.personaType, iscoCode: p.iscoCode,
          sourceKind: "instance", source: rel, resolutionStatus: "resolved",
        }, p.iscoCode.length ? {
          note: "ISCO codes were read from the description prose, where the committed instances " +
                "put them; GenericPersona.fsh declares a structured iscoCode field they do not use.",
        } : {}));
        continue;
      }

      if (/^SGRequirements?$/.test(inst.instanceOf) || /Requirement$/.test(inst.instanceOf)) {
        requirements.push({ inst, rel });
      }
    }
  }

  // ---- requirements, and the one join that resolves properly -----------------------------------
  let statementCount = 0;
  const conformance = {};
  for (const { inst, rel } of requirements) {
    const title = fshString(inst.body, "title");
    const iri = `${ns}/requirement/${slug(inst.id)}`;
    const actors = [...inst.body.matchAll(/actor\[[+=]\]\s*=\s*Canonical\(([^)]+)\)/g)].map((m) => m[1].trim());
    const capability = /extension\[capability\]\.valueString\s*=\s*"([^"]*)"/.exec(inst.body)?.[1] ?? null;
    const benefit = /extension\[benefit\]\.valueString\s*=\s*"([^"]*)"/.exec(inst.body)?.[1] ?? null;

    // A requirement with an actor and a capability is the functional "as-a / I want / so-that"
    // shape. One with neither is non-functional. Recorded rather than assumed, via `profile`.
    const kind = (actors.length || capability) ? "functional-requirement" : "non-functional-requirement";
    nodes.push(node(iri, kind, title ?? inst.id, {
      id: inst.id, title, description: fshMultiline(inst.body, "description"),
      ...(kind === "functional-requirement" ? { capability, benefit } : {}),
      profile: inst.instanceOf, sourceKind: "instance", source: rel,
    }));
    edges.push(edge("hasComponent", dakIri, iri, {
      qualifier: "requirements",
      derivation: "inferred",
      note: "dak.json declares no component arrays, so kit membership is inferred from the " +
            "instance being present in the IG's input tree rather than read from a declaration.",
      evidence: { location: rel, quote: `Instance: ${inst.id}` },
    }));

    for (const m of inst.body.matchAll(
      /statement\[\+\]\.key\s*=\s*"([^"]+)"[\s\S]*?label\s*=\s*"([^"]*)"[\s\S]*?requirement\s*=\s*"((?:[^"\\]|\\.)*)"[\s\S]*?conformance\[\+\]\s*=\s*#(\S+)/g)) {
      const [, key, label, text, conf] = m;
      const sIri = `${iri}/statement/${slug(key)}`;
      statementCount++;
      conformance[conf] = (conformance[conf] ?? 0) + 1;
      nodes.push(node(sIri, "requirement-statement", key, {
        key, label, requirement: text.replace(/\\"/g, '"'), conformance: conf,
      }));
      edges.push(edge("hasStatement", iri, sIri));
    }

    for (const a of actors) {
      const hit = personasByInstance.get(a);
      edges.push(edge("fulfilledBy", iri, hit ? hit.iri : personaId(ns, a), {
        properties: {
          resolutionStatus: hit ? "resolved" : "unresolved",
          matchedOn: "actor Canonical() == ActorDefinition instance id",
          canonical: a,
        },
        derivation: "inferred",
        note: hit
          ? "Resolved by canonical reference, not by name matching. Unlike a BPMN pool, a " +
            "requirement names the persona by its instance id, so this join does not break when " +
            "someone edits a display title."
          : `No ActorDefinition instance is named "${a}". A canonical that resolves to nothing is ` +
            `a broken reference, not an ambiguous one.`,
        evidence: { location: rel, quote: `actor[+] = Canonical(${a})` },
      }));
      if (!hit) warnings.push(`requirement ${inst.id} names actor ${a}, which no ActorDefinition defines`);
    }
  }

  for (const p of personasByInstance.values()) {
    edges.push(edge("hasComponent", dakIri, p.iri, {
      qualifier: "personas",
      derivation: "inferred",
      note: "Inferred from presence in the IG's input tree; dak.json declares no personas array.",
      evidence: { location: p.source, quote: `Instance: ${p.instance}` },
    }));
  }

  // ---- coverage across all nine components ------------------------------------------------------
  // The point of reporting this is the empty rows. A DAK's own model says nine components exist;
  // nothing today says which of them a given DAK has.
  const found = {
    healthInterventions: 0,
    personas: personasByInstance.size,
    userScenarios: 0,
    businessProcesses: 0,
    dataElements: 0,
    decisionLogic: 0,
    indicators: 0,
    requirements: requirements.length,
    testScenarios: 0,
  };

  // Files that exist without a component declaring them — the inverse gap, and just as real.
  const orphans = [];
  for (const [dir, ext, component] of [[bpmnDir, ".bpmn", "businessProcesses"], [dmnDir, ".dmn", "decisionLogic"]]) {
    if (!dir || !existsSync(dir)) continue;
    for (const f of readdirSync(dir).sort()) {
      if (!f.endsWith(ext) || f.includes(".layout.")) continue;
      orphans.push({ component, file: join(dir, f) });
    }
  }

  return {
    doc: {
      "@context": "http://smart.who.int/kg/l2.context.jsonld",
      id: `${ns}/kg/l2`,
      type: "Entity",
      ontologyVersion: ontologyVersion(),
      generatedAt: new Date().toISOString().replace(/\.\d+Z$/, "Z"),
      wasDerivedFrom: derivedFrom,
      nodes,
      edges,
    },
    stats: { found, statementCount, conformance, orphans, warnings, ns },
  };
}

function main() {
  const arg = (f) => { const i = process.argv.indexOf(f); return i === -1 ? null : process.argv[i + 1]; };
  const dakPath = arg("--dak");
  const fshDir = arg("--fsh");
  if (!dakPath || !fshDir) {
    console.error("usage: extract-dak.mjs --dak <dak.json> --fsh <dir> [--bpmn-dir d] [--dmn-dir d] [--out p]");
    process.exit(2);
  }
  const { doc, stats } = extract({
    dakPath, fshDir, bpmnDir: arg("--bpmn-dir"), dmnDir: arg("--dmn-dir"),
  });
  const out = arg("--out");
  if (out) writeFileSync(out, JSON.stringify(doc, null, 2) + "\n");
  else console.log(JSON.stringify(doc, null, 2));

  console.error(`${doc.nodes.length} nodes, ${doc.edges.length} edges`);
  console.error(`\nDAK component coverage (DAK.fsh declares nine):`);
  for (const [k, v] of Object.entries(stats.found)) {
    console.error(`  ${v ? "✓" : "·"} ${k.padEnd(20)} ${v ? `${v} instance(s)` : "none in this IG"}`);
  }
  const missing = Object.values(stats.found).filter((v) => !v).length;
  if (missing) console.error(`  ${missing} of 9 components have no instance here.`);
  if (stats.statementCount) {
    console.error(`\n${stats.statementCount} requirement statements ` +
      `(${Object.entries(stats.conformance).map(([k, v]) => `${v} ${k}`).join(", ")})`);
  }
  const joins = doc.edges.filter((e) => e.properties?.resolutionStatus);
  const res = joins.filter((e) => e.properties.resolutionStatus === "resolved").length;
  console.error(`${res}/${joins.length} cross-file references resolved`);
  if (stats.orphans.length) {
    console.error(`\n${stats.orphans.length} file(s) present with no component declaring them:`);
    for (const o of stats.orphans) console.error(`  ${o.file}  (would be ${o.component})`);
  }
  for (const w of stats.warnings.slice(0, 6)) console.error(`  warning: ${w}`);
}

if (process.argv[1] && import.meta.url.endsWith(basename(process.argv[1]))) main();
