#!/usr/bin/env node
// Extracts the L3 index from a published SMART Guidelines Implementation Guide.
//
// One thin node per FHIR artefact -- canonical, resource type, the profile it declares, status --
// and nothing about its interior. What this adds that FHIR cannot answer is which L2 component an
// artefact implements, and so which L1 recommendation it rests on.
//
// THE JOINS ARE MOSTLY CONVENTIONS. No extension anywhere in the estate carries an L2-to-L3
// back-pointer, so a PlanDefinition is tied to its decision table by its Title and its id
// (`IMMZ.D2.DT.Dengue.3 doses...` on `IMMZD2DTDengue3DosesWithPreVaccinationScreening`). Every such
// edge records the rule that matched it and stays `unresolved`. Where a REAL canonical reference
// exists -- `library`, `definitionCanonical`, `relatedArtifact` -- it is preferred and is `derived`.
//
//   node tools/extract-l3.mjs --ig <path-to-IG> [--out <path>]

import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, relative, basename } from "node:path";
import { sha256, dakNamespace, citationId, slug, normalisedScheme } from "./kgid.mjs";

const SKILL = "kg/extract-l3";
const node = (id, type, label, properties, extra = {}) =>
  ({ id, type, label, properties, derivation: "derived", skill: SKILL, ...extra });
const edge = (predicate, source, target, extra = {}) =>
  ({ type: "Statement", predicate, source, target, derivation: "derived", skill: SKILL, ...extra });

/** FHIR resource type -> our class id. Only types with committed instances are modelled. */
const CLASS = {
  PlanDefinition: "plan-definition", ActivityDefinition: "activity-definition",
  Library: "library", Measure: "measure", Questionnaire: "questionnaire",
  StructureMap: "structure-map", ValueSet: "value-set", CodeSystem: "code-system",
  ConceptMap: "concept-map", ActorDefinition: "actor-definition", Requirements: "requirements",
};
/**
 * Which L2 component a FHIR resource type implements, per the published mapping table in
 * l2_l3_overview.md. This is NOT guessable from the artefact: a Questionnaire comes from Data
 * Elements, a Measure from Indicators, a PlanDefinition from either Processes or Decision Tables.
 * Where the mapping gives one answer, use it; where it gives two, the artefact's profile decides,
 * and where nothing decides, emit no edge rather than pick.
 */
const L2_OF = {
  Measure: "program-indicator",
  Questionnaire: "data-element", StructureMap: "data-element", ValueSet: "data-element",
  CodeSystem: "data-element", ConceptMap: "data-element", Profile: "data-element",
  Logical: "data-element",
  ActorDefinition: "persona", Requirements: "functional-requirement",
  ActivityDefinition: "decision-support-logic",
};
/** PlanDefinition has two sources; the profile says which. */
function planDefL2(profile) {
  const p = String(profile ?? "").toLowerCase();
  if (/recommendationdefinition|strategydefinition/.test(p)) return "decision-support-logic";
  if (/workflow|shareableplandefinition/.test(p)) return "business-process";
  return null;                                  // ambiguous: no edge rather than a guess
}
/** A Library serves decisions, indicators or elements; the id suffix is the only signal. */
function libraryL2(name) {
  if (/IndicatorLogic$/i.test(name)) return "program-indicator";
  if (/Elements$/i.test(name)) return "data-element";
  if (/Logic$/i.test(name)) return "decision-support-logic";
  return null;
}

/** Types the published mapping names but that no IG in the estate has. Reported, never invented. */
const EXPECTED_ABSENT = ["ExampleScenario", "TestPlan", "TestScript"];

const walk = (dir, out = []) => {
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir).sort()) {
    const p = join(dir, e);
    if (e === ".git") continue;
    statSync(p).isDirectory() ? walk(p, out) : out.push(p);
  }
  return out;
};

/** Profile URL or alias -> FHIR resource type. The IG declares profiles, not resource types. */
function resourceTypeOf(instanceOf, aliases) {
  const s = String(aliases[instanceOf] ?? instanceOf).toLowerCase();
  if (/recommendationdefinition|strategydefinition|plandefinition/.test(s)) return "PlanDefinition";
  if (/measure/.test(s)) return "Measure";
  if (/questionnaireresponse/.test(s)) return null;          // an example, not a definition
  if (/questionnaire|extr-smap/.test(s)) return "Questionnaire";
  if (/immunizationactivity|communicationactivity|activitydefinition/.test(s)) return "ActivityDefinition";
  if (/structuremap/.test(s)) return "StructureMap";
  if (/actordefinition/.test(s)) return "ActorDefinition";
  if (/requirements/.test(s)) return "Requirements";
  if (/conceptmap/.test(s)) return "ConceptMap";
  if (/\blibrary\b/.test(s)) return "Library";
  return CLASS[instanceOf] ? instanceOf : null;
}

const fshField = (b, k) => (new RegExp(`^\\*\\s+${k}\\s*=\\s*"((?:[^"\\\\]|\\\\.)*)"`, "m").exec(b)?.[1] ?? null);
const fshHeader = (b, k) => (new RegExp(`^${k}:\\s*"?([^"\\n]*)"?`, "m").exec(b)?.[1]?.trim() ?? null);

export function extract(igPath) {
  const nodes = [], edges = [], warnings = [];
  const counts = {}, seen = new Set(), unmapped = new Set();
  for (const t of [...Object.keys(CLASS), ...EXPECTED_ABSENT]) counts[t] = 0;
  for (const t of ["Logical", "Profile", "cql"]) counts[t] = 0;

  const cfg = existsSync(join(igPath, "sushi-config.yaml"))
    ? readFileSync(join(igPath, "sushi-config.yaml"), "utf8") : "";
  const rawNs = /^canonical:\s*(\S+)/m.exec(cfg)?.[1] ?? "urn:unknown";
  const ns = dakNamespace(rawNs);
  if (normalisedScheme(rawNs)) {
    warnings.push(`canonical "${rawNs}" uses http; normalised to "${ns}" so nodes join across layers.`);
  }
  const igVersion = /^version:\s*(\S+)/m.exec(cfg)?.[1] ?? null;

  const files = walk(join(igPath, "input"));
  const aliases = {};
  // RuleSets matter more than they look. The immunizations IG puts `library = Canonical({library}Logic)`
  // and the relatedArtifact citation inside `RuleSet: PlanDefMain`, and every PlanDefinition reaches
  // them only through `* insert PlanDefMain(...)`. Read the source without expanding rulesets and
  // those two links -- the Library join and the entire L1 citation -- are invisible.
  const rulesets = new Map();
  for (const f of files.filter((x) => x.endsWith(".fsh"))) {
    const t = readFileSync(f, "utf8");
    for (const m of t.matchAll(/^Alias:\s*(\$\S+)\s*=\s*(\S+)/gm)) aliases[m[1]] = m[2];
    for (const blk of t.split(/^(?=RuleSet:\s*\S)/m)) {
      const h = /^RuleSet:\s*([A-Za-z0-9_.-]+)\s*(?:\(([^)]*)\))?/.exec(blk);
      if (!h) continue;
      rulesets.set(h[1], {
        params: (h[2] ?? "").split(",").map((x) => x.trim()).filter(Boolean),
        body: blk.slice(blk.indexOf("\n") + 1).split(/^(?=RuleSet:|Instance:|Profile:)/m)[0],
      });
    }
  }

  /** Splice each `* insert Name(a, b)` into the block, substituting {param} in the RuleSet body. */
  const expand = (blk, depth = 0) => {
    if (depth > 3) return blk;                       // rulesets may insert rulesets; bound it
    return blk.replace(/^\*\s+insert\s+([A-Za-z0-9_.-]+)\s*(?:\(([\s\S]*?)\))?\s*$/gm,
      (whole, name, args) => {
        const rs = rulesets.get(name);
        if (!rs) return whole;
        // Arguments may contain [[...]] blocks and commas inside them; split on top-level commas.
        const parts = [];
        let buf = "", brackets = 0;
        for (const ch of (args ?? "")) {
          if (ch === "[") brackets++;
          if (ch === "]") brackets--;
          if (ch === "," && brackets === 0) { parts.push(buf.trim()); buf = ""; continue; }
          buf += ch;
        }
        if (buf.trim()) parts.push(buf.trim());
        let out = rs.body;
        rs.params.forEach((prm, i) => {
          out = out.split(`{${prm}}`).join((parts[i] ?? "").replace(/^\[\[|\]\]$/g, ""));
        });
        return expand(out, depth + 1);
      });
  };

  const emit = (rt, id, label, props, src, body) => {
    const canonical = `${ns}/${rt}/${id}`;
    if (seen.has(canonical)) return null;
    seen.add(canonical);
    counts[rt] = (counts[rt] ?? 0) + 1;
    nodes.push(node(canonical, CLASS[rt], label ?? id, {
      canonical, resourceType: rt, ...props, source: relative(igPath, src),
    }));
    return canonical;
  };

  for (const f of files) {
    const rel = relative(igPath, f);

    // ---- CQL files. Not FHIR resources, so no canonical; reached through the Library. ----------
    if (f.endsWith(".cql")) {
      const name = basename(f, ".cql");
      const iri = `${ns}/cql/${slug(name)}`;
      if (seen.has(iri)) continue;
      seen.add(iri);
      counts["cql"] = (counts["cql"] ?? 0) + 1;
      nodes.push(node(iri, "cql-library", name, {
        name, path: rel, source: rel, sha256: sha256(readFileSync(f)),
      }, { note: "Indexed by name and hash only. Its expressions belong to a future l3-cql subgraph." }));
      continue;
    }

    if (f.endsWith(".fml")) {
      const name = basename(f, ".fml");
      emit("StructureMap", name, name, { status: null, version: igVersion,
        sha256: sha256(readFileSync(f)) }, f);
      continue;
    }

    if (f.endsWith(".fsh")) {
      const text = readFileSync(f, "utf8");
      for (const blk of text.split(/^(?=Instance:\s*\S)/m)) {
        const m = /^Instance:\s*(\S+)\s*\r?\n\s*InstanceOf:\s*(\S+)/.exec(blk);
        if (!m) continue;
        const rt = resourceTypeOf(m[2], aliases);
        if (!rt || !CLASS[rt]) continue;
        const title = fshHeader(blk, "Title");
        const expanded = expand(blk);
        const canonical = emit(rt, m[1], title ?? m[1], {
          profile: aliases[m[2]] ?? m[2],
          status: fshField(blk, "status") ?? /^\*\s+status\s*=\s*#(\S+)/m.exec(blk)?.[1] ?? null,
          version: fshField(blk, "version") ?? igVersion,
          title, name: fshField(blk, "name") ?? m[1],
          publisher: fshField(blk, "publisher"),
          experimental: /^\*\s+experimental\s*=\s*true/m.test(blk) ? true
                      : /^\*\s+experimental\s*=\s*false/m.test(blk) ? false : null,
          sha256: sha256(readFileSync(f)),
        }, f, blk);
        if (!canonical) continue;

        // ---- real canonical references, preferred over conventions --------------------------
        for (const lm of expanded.matchAll(/^\*\s+library\s*=\s*Canonical\(([^)]+)\)/gm)) {
          edges.push(edge("uses", canonical, `${ns}/Library/${lm[1].trim()}`, {
            note: "Read from PlanDefinition.library, a real canonical reference.",
          }));
        }
        for (const dm of expanded.matchAll(/definitionCanonical\s*=\s*Canonical\(([^)]+)\)/g)) {
          edges.push(edge("uses", canonical, `${ns}/ActivityDefinition/${dm[1].trim()}`, {
            properties: { targetPath: "PlanDefinition.action.definitionCanonical" },
          }));
        }

        // ---- the L1 link: relatedArtifact citation ------------------------------------------
        for (const cm of expanded.matchAll(/citation\s*=\s*"((?:[^"\\]|\\.)*)"/g)) {
          const t = cm[1].replace(/\\"/g, '"');
          const cid = citationId(ns, t);
          // Mint the citation. tools/extract-citations.mjs mints the same IRI from the same string,
          // so when both documents load they are one node; minting it here means the edge does not
          // dangle when only the IG was read.
          if (!seen.has(cid)) {
            seen.add(cid);
            counts["citation"] = (counts["citation"] ?? 0) + 1;
            nodes.push(node(cid, "citation", t.length > 80 ? t.slice(0, 77) + "..." : t, {
              text: t, location: `${rel}#${m[1]}`,
              numbering: /\((\d+)\)\s*$/.exec(t)?.[1] ?? undefined,
              resolutionStatus: "unresolved",
            }, { note: "Copied verbatim from relatedArtifact. Resolution to a publication is a " +
                       "judgement and is deliberately not attempted here." }));
          }
          edges.push(edge("citesSource", canonical, cid, {
            properties: { text: t },
            note: "Target is an l1:citation minted by tools/extract-citations.mjs from this same " +
                  "string, so L3 and L1 join without either extractor knowing the other.",
            evidence: { location: `${rel}#${m[1]}`, quote: t },
          }));
        }

        // ---- the L2 join, by convention ------------------------------------------------------
        // A dotted Title is the L2 component id; the resource id is that title with dots and
        // spaces stripped. That is the whole of the traceability and it is not a reference.
        // The L2 id the artefact claims. A dotted Title carries it directly. A Measure in this IG
        // does NOT: the SOP says its title should be the L2 indicator id (`IMMZ.IND.08 ...`) and the
        // immunizations IG titles them `IMMZIND29` instead, so the id is recovered by inverting the
        // strip -- a stated heuristic, recorded on the edge, never silently resolved.
        let l2id = null, l2class = null, rule = null;
        l2class = rt === "PlanDefinition" ? planDefL2(aliases[m[2]] ?? m[2])
                : rt === "Library" ? libraryL2(m[1])
                : L2_OF[rt] ?? null;
        if (!l2class) {
          unmapped.add(rt);
        } else if (title && /^[A-Z]{2,}\./.test(title)) {
          l2id = title;
          rule = "Title is the L2 component id; resource id is the title with dots and spaces removed";
        } else if (rt === "Measure") {
          const im = /^([A-Z]+)IND(\d+)$/.exec(title ?? m[1]);
          if (im) {
            l2id = `${im[1]}.IND.${im[2]}`;
            rule = "Measure title is not the dotted L2 indicator id the SOP specifies; id recovered " +
                   "by re-inserting the separators (IMMZIND29 -> IMMZ.IND.29)";
          }
        }
        if (l2id) {
          const l2iri = `${ns}/${l2class}/${slug(l2id)}`;
          if (!seen.has(l2iri)) {
            seen.add(l2iri);
            nodes.push(node(l2iri, l2class, l2id, {
              id: l2id, sourceKind: "url", source: rel, resolutionStatus: "unresolved",
            }, {
              derivation: "inferred",
              note: `Referenced by an L3 artefact's Title but not read from a DAK. Carries the ` +
                    `referenced id and nothing else; resolving it needs the L2 repository.`,
              evidence: { location: `${rel}#${m[1]}`, quote: `Title: "${title ?? m[1]}"` },
            }));
          }
          edges.push(edge("implementedBy", l2iri, canonical, {
            properties: {
              resolutionStatus: "unresolved",
              extractionRule: rule,
              matchedOn: `"${title ?? m[1]}" -> L2 id "${l2id}"`,
            },
            derivation: "inferred",
            note: "No back-pointer extension exists in this estate, so the join is the SOP's id " +
                  "convention. Unresolved until the L2 component it names is actually read.",
            evidence: { location: `${rel}#${m[1]}`, quote: `Title: "${title ?? m[1]}"` },
          }));
        }
      }
      // FSH definitional keywords are not Instance: blocks. 192 ValueSets and 6 CodeSystems in the
      // immunizations IG are declared this way and an Instance-only scan misses every one.
      const DEFKW = { ValueSet: "ValueSet", CodeSystem: "CodeSystem", Logical: "StructureDefinition",
                      Profile: "Profile" };
      for (const blk of text.split(/^(?=(?:ValueSet|CodeSystem|Logical|Profile):\s*\S)/m)) {
        const m = /^(ValueSet|CodeSystem|Logical|Profile):\s*(\S+)/.exec(blk);
        if (!m) continue;
        const rt = DEFKW[m[1]];
        const cls = m[1] === "Logical" ? "structure-definition"
                  : m[1] === "Profile" ? "profile" : CLASS[rt];
        const canonical = `${ns}/${rt === "Profile" ? "StructureDefinition" : rt}/${m[2]}`;
        if (seen.has(canonical)) continue;
        seen.add(canonical);
        counts[m[1]] = (counts[m[1]] ?? 0) + 1;
        nodes.push(node(canonical, cls, fshHeader(blk, "Title") ?? m[2], {
          canonical, resourceType: rt === "Profile" ? "StructureDefinition" : rt,
          status: /\^status\s*=\s*#(\S+)/.exec(blk)?.[1] ?? null,
          version: igVersion, title: fshHeader(blk, "Title"), name: m[2],
          ...(m[1] === "Logical" ? { kind: "logical" } : {}),
          ...(m[1] === "Profile" ? { baseDefinition: /^Parent:\s*(\S+)/m.exec(blk)?.[1] ?? null } : {}),
          source: rel, sha256: sha256(readFileSync(f)),
        }));
      }
      continue;
    }

    if (f.endsWith(".json")) {
      let j; try { j = JSON.parse(readFileSync(f, "utf8")); } catch { continue; }
      const rt = j.resourceType;
      if (!rt || !CLASS[rt]) { if (EXPECTED_ABSENT.includes(rt)) counts[rt]++; continue; }
      emit(rt, j.id ?? basename(f, ".json"), j.title ?? j.name, {
        profile: j.meta?.profile?.[0] ?? null, status: j.status ?? null,
        version: j.version ?? igVersion, title: j.title ?? null, name: j.name ?? null,
        publisher: j.publisher ?? null, experimental: j.experimental ?? null,
        sha256: sha256(readFileSync(f)),
      }, f);
    }
  }

  return {
    doc: {
      "@context": "http://smart.who.int/kg/l3.context.jsonld",
      id: `${ns}/kg/l3`, type: "Entity", ontologyVersion: "1.0",
      generatedAt: new Date().toISOString().replace(/\.\d+Z$/, "Z"),
      wasDerivedFrom: [{ path: igPath, sha256: sha256(Buffer.from(igPath)),
        note: "The IG as a whole; each node carries the SHA-256 of the file it came from." }],
      nodes, edges,
    },
    stats: { counts, warnings, ns, unmapped: [...unmapped] },
  };
}

function main() {
  const i = process.argv.indexOf("--ig");
  const igPath = i === -1 ? null : process.argv[i + 1];
  if (!igPath) { console.error("usage: extract-l3.mjs --ig <path> [--out <path>]"); process.exit(2); }
  const { doc, stats } = extract(igPath);
  const o = process.argv.indexOf("--out");
  if (o !== -1) writeFileSync(process.argv[o + 1], JSON.stringify(doc, null, 2) + "\n");
  else console.log(JSON.stringify(doc, null, 2));

  console.error(`${doc.nodes.length} nodes, ${doc.edges.length} edges`);
  console.error(`\nL3 artefact coverage:`);
  for (const [k, v] of Object.entries(stats.counts).sort((a, b) => b[1] - a[1])) {
    console.error(`  ${v ? "✓" : "·"} ${k.padEnd(22)} ${v || "none in this IG"}`);
  }
  const absent = EXPECTED_ABSENT.filter((t) => !stats.counts[t]);
  if (absent.length) {
    console.error(`\n  ${absent.join(", ")}: named by the published mapping under User Scenarios,`);
    console.error(`  and absent here. A gap in the IG, not in this tool.`);
  }
  const byPred = {};
  for (const e of doc.edges) byPred[e.predicate] = (byPred[e.predicate] ?? 0) + 1;
  console.error(`\nedges: ${Object.entries(byPred).map(([k, v]) => `${k} ${v}`).join(", ")}`);
  if (stats.unmapped.length) {
    console.error(`\n  no L2 component could be decided for: ${stats.unmapped.join(", ")}.`);
    console.error(`  No edge was emitted rather than one guessed.`);
  }
  for (const w of stats.warnings) console.error(`  warning: ${w}`);
}

if (process.argv[1] && import.meta.url.endsWith(basename(process.argv[1]))) main();
