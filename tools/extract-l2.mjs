#!/usr/bin/env node
// Extracts an L2 graph from the artefacts a DAK actually ships: a BPMN collaboration, a DMN
// decision table, and the ActorDefinition instances that define its personas.
//
// The reason this exists is narrow. WHO's own L2 logical models address these files and stop at
// their boundary -- BusinessProcessWorkflow carries `source 1..1 uri`, DecisionSupportLogic carries
// `source 1..1 uri` and nothing else -- so three joins survive today only as string equality across
// three file formats, and break silently on a rename:
//
//   BPMN participant @name    ==  ActorDefinition title      -> which role runs this process
//   DMN usingTask @href       ==  BPMN task @name            -> which task invokes this decision
//   DMN input expression text ==  data dictionary element    -> what this decision reads
//
// Every edge produced from one of those carries a resolutionStatus. An extractor that emitted them
// as plain facts would be asserting a match it cannot verify.
//
//   node tools/extract-l2.mjs --bpmn <f.bpmn> --dmn <f.dmn> --personas <dir> [--out <path>]

import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, basename } from "node:path";
import {
  sha256, dakNamespace, artifactId, elementId, citationId, personaId, dataElementId,
} from "./kgid.mjs";

const dec = (s) => String(s).replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
                            .replace(/&#39;/g, "'").replace(/&amp;/g, "&");
const attr = (tag, name) => {
  const m = new RegExp(`${name}="([^"]*)"`).exec(tag);
  return m ? dec(m[1]) : null;
};
const inner = (block, tag) => {
  const m = new RegExp(`<[a-z]+:${tag}>([\\s\\S]*?)</[a-z]+:${tag}>`).exec(block);
  return m ? dec(m[1].trim()) : null;
};

const SKILL = "kg/extract-l2";
const node = (id, type, label, properties, extra = {}) =>
  ({ id, type, label, properties, derivation: "derived", skill: SKILL, ...extra });
const edge = (predicate, source, target, extra = {}) =>
  ({ type: "Statement", predicate, source, target, derivation: "derived", skill: SKILL, ...extra });

// ---------------------------------------------------------------------------------------------
// Data element names, recovered from a DMN input expression.
//
// The expressions are free text of two shapes. Some are just a name ("HIV status"). Others embed
// names in quotes inside a larger expression: `Today's date - "Date of birth"`, or
// `Count of vaccines administered (where "Vaccine type" = "BCG vaccines")`.
//
// In the second shape a quoted token is a name or a VALUE depending on which side of a comparison
// it sits: "Vaccine type" is a field, "BCG vaccines" is what it is compared to. Taking every quoted
// token would invent a data element called "BCG vaccines". The side test is what stops that -- and
// because it is a heuristic over prose, every name it yields is recorded with the rule that found
// it and a resolutionStatus of `unresolved`.
// ---------------------------------------------------------------------------------------------
const CMP = "=|≠|!=|<>|≤|≥|<=|>=|<|>";

export function dataElementsIn(expression) {
  const expr = String(expression ?? "").trim();
  if (!expr) return [];
  const quoted = [...expr.matchAll(/"([^"]+)"/g)];

  // No quotes and no comparison: the expression IS the element name.
  if (quoted.length === 0) {
    if (new RegExp(CMP).test(expr)) return [];
    return [{ name: expr, extractionRule: "bare-expression" }];
  }

  const out = [];
  for (const m of quoted) {
    const before = expr.slice(0, m.index).trimEnd();
    const after = expr.slice(m.index + m[0].length).trimStart();
    const precededByComparison = new RegExp(`(${CMP})$`).test(before);
    const followedByComparison = new RegExp(`^(${CMP})`).test(after);

    if (precededByComparison && !followedByComparison) continue;   // a value, not a field
    out.push({
      name: dec(m[1]).trim(),
      extractionRule: followedByComparison ? "quoted-left-of-comparison" : "quoted-operand",
    });
  }
  // One expression can name the same element twice; the node is minted once.
  const seen = new Set();
  return out.filter((d) => d.name && !seen.has(d.name) && seen.add(d.name));
}

// ---------------------------------------------------------------------------------------------
// Personas -- ActorDefinition instances. `title` is what a BPMN pool matches on; `name` is the
// CamelCase identifier and does not match, which is exactly the kind of near-miss worth being
// explicit about.
// ---------------------------------------------------------------------------------------------
export function readPersonas(dir, ns) {
  if (!existsSync(dir)) return { personas: [], sha256: null, files: 0 };
  const out = [];
  // Hash-pin the whole directory, not just the files that yielded a persona. The provenance rule
  // is that an upstream edit expires this projection; hashing only the matches would let a NEW
  // ActorDefinition appear upstream without changing the hash, and the graph would look current
  // while missing a role.
  const names = readdirSync(dir).filter((f) => f.endsWith(".fsh")).sort();
  const digest = createHash("sha256");
  for (const file of names) {
    digest.update(file).update("\0").update(readFileSync(join(dir, file)));
  }
  for (const file of names) {
    const fsh = readFileSync(join(dir, file), "utf8");
    if (!/^InstanceOf:\s*ActorDefinition\s*$/m.test(fsh)) continue;
    const val = (k) => {
      const m = new RegExp(`^\\*\\s+${k}\\s*=\\s*"([^"]*)"`, "m").exec(fsh);
      return m ? m[1] : null;
    };
    const instance = /^Instance:\s*(\S+)/m.exec(fsh)?.[1] ?? basename(file, ".fsh");
    const title = val("title");
    if (!title) continue;   // no title means nothing a BPMN pool could match; skip rather than guess
    out.push({
      instance,
      name: val("name"),
      title,
      personaType: /^\*\s+type\s*=\s*#(\S+)/m.exec(fsh)?.[1] ?? null,
      // ISCO codes are declared on Persona.fsh but the committed instances write them into prose.
      // Read them where they actually are, and say so, rather than reporting the field as empty.
      isco: [...(/\*\*ISCO(?:-08)?\*\*:([^\n]*)/.exec(fsh)?.[1] ?? "").matchAll(/\b(\d{4})\b/g)]
              .map((m) => m[1]),
      source: `${dir}/${file}`,
      id: personaId(ns, title),
    });
  }
  return { personas: out, sha256: digest.digest("hex"), files: names.length };
}

// ---------------------------------------------------------------------------------------------
// BPMN
// ---------------------------------------------------------------------------------------------
export function extractBpmn(xml, path, personas) {
  const ns = dakNamespace(attr(xml, "targetNamespace"));
  const fileId = /<bpmn:definitions[^>]*\sid="([^"]+)"/.exec(xml)?.[1] ?? basename(path);
  const fileIri = artifactId(ns, fileId);
  const eid = (id) => elementId(ns, fileId, id);

  const nodes = [];
  const edges = [];
  const warnings = [];
  const taskNames = new Map();   // name -> element IRI, for the DMN usingTask join

  nodes.push(node(fileIri, "business-process",
    /<!--\s*COLLABORATION:\s*([^\n]*?)\s*-->/.exec(xml)?.[1] ?? fileId,
    {
      id: fileId,
      name: fileId,
      source: path,
      sha256: sha256(readFileSync(path)),
      targetNamespace: attr(xml, "targetNamespace"),
      exporter: attr(xml, "exporter"),
    }));

  // Which participant owns which process, so every element can be attributed to a role.
  const participantOfProcess = new Map();
  for (const [tag] of xml.matchAll(/<bpmn:participant\b[^>]*\/?>/g)) {
    const id = attr(tag, "id");
    const name = attr(tag, "name");
    const processRef = attr(tag, "processRef");
    const iri = eid(id);
    if (processRef) participantOfProcess.set(processRef, iri);
    nodes.push(node(iri, "process-participant", name, { id, name, processRef }));
    edges.push(edge("contains", fileIri, iri));

    // THE JOIN. A pool's @name against an ActorDefinition title, across two file formats with no
    // shared identifier.
    const hit = personas.filter((p) => p.title === name);
    if (hit.length === 1) {
      edges.push(edge("performedBy", iri, hit[0].id, {
        properties: { resolutionStatus: "resolved", matchedOn: "participant @name == ActorDefinition title" },
        derivation: "inferred",
        note: `Matched by exact name equality against the ActorDefinition at evidence.location. ` +
              `There is no shared identifier between a BPMN pool and an ActorDefinition, so ` +
              `renaming either side breaks this and nothing in the BPMN or the FSH would report it.`,
        evidence: { location: hit[0].source, quote: `* title = "${hit[0].title}"` },
      }));
    } else {
      const status = hit.length ? "ambiguous" : "unresolved";
      warnings.push(`participant "${name}" -> persona ${status}` +
                    (hit.length ? ` (${hit.length} candidates)` : ""));
      // Mint the target. A dangling edge would be dropped by any store and the finding with it;
      // a node marked unresolved makes "roles a process names but nothing defines" a query.
      const placeholder = personaId(ns, name);
      if (!personas.some((p) => p.id === placeholder)) {
        nodes.push(node(placeholder, "persona", name,
          { title: name, resolutionStatus: status },
          {
            derivation: "inferred",
            note: `Referenced by a BPMN participant but not defined by any ActorDefinition read. ` +
                  `Carries the referenced title and nothing else -- inventing a description or a ` +
                  `type would turn a gap into apparent content.`,
            evidence: { location: path, quote: `<bpmn:participant name="${name}"/>` },
          }));
      }
      edges.push(edge("performedBy", iri, placeholder, {
        properties: { resolutionStatus: status, matchedOn: "participant @name == ActorDefinition title" },
        derivation: "inferred",
        note: hit.length
          ? `${hit.length} ActorDefinition instances share this title. Ambiguity is a question for ` +
            `a person; it must not be tie-broken by a matcher.`
          : `No ActorDefinition carries this title. Either the persona is undefined or it is ` +
            `named differently -- both are findings, and neither is safe to guess at.`,
        evidence: { location: path, quote: `<bpmn:participant name="${name}"/>` },
      }));
    }
  }

  // Tasks inside a sub-process, so the flat scan below can record a parent rather than lose it.
  const parentOf = new Map();
  for (const [block, subTag] of xml.matchAll(/(<bpmn:subProcess\b([^>]*)>[\s\S]*?<\/bpmn:subProcess>)/g)) {
    const subId = attr(subTag, "id");
    for (const [, childTag] of block.matchAll(/<bpmn:(?:task|exclusiveGateway|startEvent|endEvent)\b([^>]*)[/>]/g)) {
      const childId = attr(childTag, "id");
      if (childId && childId !== subId) parentOf.set(childId, subId);
    }
  }

  for (const [, procTag, procBody] of xml.matchAll(/<bpmn:process\b([^>]*)>([\s\S]*?)<\/bpmn:process>/g)) {
    const procId = attr(procTag, "id");
    const owner = participantOfProcess.get(procId) ?? fileIri;

    const emit = (tag, type, props) => {
      const id = attr(tag, "id");
      const name = attr(tag, "name");
      const iri = eid(id);
      const parent = parentOf.get(id);
      nodes.push(node(iri, type, name ?? id, {
        id, name, ...props, ...(parent ? { parent: eid(parent) } : {}),
      }));
      edges.push(edge("contains", parent ? eid(parent) : owner, iri));
      return { id, name, iri };
    };

    for (const [, tag] of procBody.matchAll(/<bpmn:task\b([^>]*)[/>]/g)) {
      const t = emit(tag, "process-task", { taskType: "task", isSubProcess: false });
      if (t.name) {
        if (taskNames.has(t.name)) {
          warnings.push(`duplicate task name "${t.name}" -- a usingTask href naming it is ambiguous`);
          taskNames.set(t.name, null);
        } else taskNames.set(t.name, t.iri);
      }
    }
    for (const [, tag] of procBody.matchAll(/<bpmn:subProcess\b([^>]*)>/g)) {
      const t = emit(tag, "process-task", { taskType: "subProcess", isSubProcess: true });
      if (t.name && !taskNames.has(t.name)) taskNames.set(t.name, t.iri);
    }
    for (const [, tag] of procBody.matchAll(/<bpmn:exclusiveGateway\b([^>]*)[/>]/g)) {
      emit(tag, "process-gateway", { gatewayType: "exclusive" });
    }
    for (const [, kind, tag] of procBody.matchAll(/<bpmn:(startEvent|endEvent)\b([^>]*)[/>]/g)) {
      emit(tag, "process-event", { eventType: kind.replace("Event", "") });
    }

    for (const [, tag] of procBody.matchAll(/<bpmn:sequenceFlow\b([^>]*)[/>]/g)) {
      const name = attr(tag, "name");
      edges.push(edge("flowsTo", eid(attr(tag, "sourceRef")), eid(attr(tag, "targetRef")), {
        ...(name ? { qualifier: name } : {}),
        properties: {
          flowId: attr(tag, "id"),
          // No sequence flow in the lifecycle BPMN carries a conditionExpression. Where a branch
          // has a label and no condition, the label is all there is, and claiming it as a
          // condition would be reading logic into a caption.
          hasConditionExpression: false,
        },
      }));
    }
  }

  for (const [, tag] of xml.matchAll(/<bpmn:messageFlow\b([^>]*)[/>]/g)) {
    edges.push(edge("messageTo", eid(attr(tag, "sourceRef")), eid(attr(tag, "targetRef")), {
      properties: { flowId: attr(tag, "id") },
      note: "Crosses participants, so it is a handoff between roles rather than a step within one.",
    }));
  }

  return { ns, fileIri, nodes, edges, warnings, taskNames };
}

// ---------------------------------------------------------------------------------------------
// DMN
// ---------------------------------------------------------------------------------------------
export function extractDmn(xml, path, bpmn) {
  const ns = dakNamespace(attr(xml, "namespace"));
  const tableId = /<dmn:decision\b[^>]*\sid="([^"]+)"/.exec(xml)?.[1] ?? basename(path);
  const tableIri = artifactId(ns, tableId);
  const eid = (id) => elementId(ns, tableId, id);

  const nodes = [];
  const edges = [];
  const warnings = [];

  nodes.push(node(tableIri, "decision-table", attr(xml, "label") ?? tableId, {
    id: tableId,
    label: attr(xml, "label"),
    question: inner(xml, "question"),
    // Absent from this file. Recorded as null rather than defaulted, because DMN's default hit
    // policy is UNIQUE and asserting it would be putting words in the author's mouth.
    hitPolicy: /<dmn:decisionTable\b[^>]*hitPolicy="([^"]+)"/.exec(xml)?.[1] ?? null,
    source: path,
    sha256: sha256(readFileSync(path)),
    namespace: attr(xml, "namespace"),
  }));
  // Note there is no `elaborates` edge to L1 here. This node and the l1:external-artifact for the
  // same file ARE one resource -- they share this IRI -- so an edge would run from the node to
  // itself. The relationship is declared once, on the class.

  // --- the BPMN join -------------------------------------------------------------------------
  const usingTask = /<dmn:usingTask\b[^>]*href="([^"]+)"/.exec(xml)?.[1] ?? null;
  if (usingTask) {
    const [href, frag] = usingTask.split("#");
    const taskName = frag ? decodeURIComponent(frag) : null;
    const hit = taskName && bpmn ? bpmn.taskNames.get(taskName) : undefined;
    const status = hit ? "resolved" : bpmn ? "unresolved" : "unresolved";
    if (!hit) {
      warnings.push(
        `usingTask -> BPMN task ${status}: ${bpmn ? "no task with this name in the BPMN read" : "no BPMN supplied"}` +
        `\n    href: ${decodeURIComponent(usingTask)}`);
    }
    let target = hit;
    if (!target) {
      target = `${ns}/artifact/${basename(href)}${frag ? `#${frag}` : ""}`;
      nodes.push(node(target, "external-artifact", taskName ?? href,
        { iri: target, targetKind: "bpmn:Task" },
        {
          derivation: "inferred",
          note: `The task named by this href is in a BPMN file this graph does not hold, so it is ` +
                `recorded as an opaque pointer. Nothing is claimed about the task itself.`,
          evidence: { location: path, quote: `<dmn:usingTask href="${usingTask}"/>` },
        }));
    }
    edges.push(edge("invokedBy", tableIri, target, {
      properties: {
        resolutionStatus: status,
        href: usingTask,
        // The fragment is the task's NAME, not its id. It resolves only if that prose is
        // byte-identical in the BPMN -- punctuation, spacing and the en dash in "Calmette-Guerin"
        // included.
        matchedOn: "usingTask @href fragment == BPMN task @name",
        taskName,
      },
      derivation: "inferred",
      note: hit
        ? "Matched by exact name equality against the supplied BPMN."
        : "The href names a BPMN file and a task by name. Nothing was available to resolve it " +
          "against, so the target IRI is a placeholder and the edge is explicitly unresolved.",
      evidence: { location: path, quote: `<dmn:usingTask href="${usingTask}"/>` },
    }));
  }

  // --- clauses -------------------------------------------------------------------------------
  const inputs = [...xml.matchAll(/<dmn:input\b([^>]*)>([\s\S]*?)<\/dmn:input>/g)]
    .map(([, tag, body], i) => ({
      id: attr(tag, "id"), label: attr(tag, "label"), ordinal: i,
      expression: inner(body, "text"),
      typeRef: /<dmn:inputExpression\b[^>]*typeRef="([^"]+)"/.exec(body)?.[1] ?? null,
    }));
  const outputs = [...xml.matchAll(/<dmn:output\b([^>]*)>([\s\S]*?)<\/dmn:output>/g)]
    .map(([, tag, body], i) => ({
      id: attr(tag, "id"), label: attr(tag, "label"), ordinal: i,
      description: inner(body, "description"),
    }));

  const elements = new Map();
  for (const c of inputs) {
    const iri = eid(c.id);
    nodes.push(node(iri, "input-clause", c.label, {
      id: c.id, label: c.label, expression: c.expression, typeRef: c.typeRef, ordinal: c.ordinal,
    }));
    edges.push(edge("contains", tableIri, iri));

    // --- the data dictionary join ------------------------------------------------------------
    for (const d of dataElementsIn(c.expression)) {
      const deIri = dataElementId(ns, d.name);
      if (!elements.has(deIri)) {
        elements.set(deIri, true);
        nodes.push(node(deIri, "data-element", d.name, {
          name: d.name,
          extractionRule: d.extractionRule,
          // smart-base ships no data dictionary instance, so this is a name that was referenced,
          // not a definition that was found. Saying `resolved` would invent the definition.
          resolutionStatus: "unresolved",
        }, {
          derivation: "inferred",
          note: `Recovered from a DMN input expression by the "${d.extractionRule}" rule. No data ` +
                `dictionary was available to resolve it against, so no dataType, cardinality or ` +
                `canonical is claimed.`,
          evidence: { location: `${path}#${c.id}`, quote: c.expression },
        }));
      }
      edges.push(edge("reads", iri, deIri, {
        properties: { resolutionStatus: "unresolved", extractionRule: d.extractionRule },
        derivation: "inferred",
        note: "The element name was read out of free text. Until a dictionary resolves it, this " +
              "records that the decision refers to something by that name, not that the thing exists.",
        evidence: { location: `${path}#${c.id}`, quote: c.expression },
      }));
    }
  }

  const refCol = outputs.findIndex((o) => /source content \(L1\)/i.test(o.description ?? "")
                                       || /^reference/i.test(o.label ?? ""));
  for (const c of outputs) {
    const iri = eid(c.id);
    nodes.push(node(iri, "output-clause", c.label, {
      id: c.id, label: c.label, description: c.description, ordinal: c.ordinal,
      isReferenceColumn: c.ordinal === refCol,
    }));
    edges.push(edge("contains", tableIri, iri));
  }

  // --- rules ---------------------------------------------------------------------------------
  // Cells are properties, not nodes. 250 of them in this table, none the target of a cross-model
  // edge; turning them into nodes would re-represent the table instead of joining it.
  const nOutputEntry = outputs.length - Math.max(0, outputs.length - 2);
  const refAnnotationIndex = refCol === -1 ? -1 : refCol - nOutputEntry;
  const cov = { rules: 0, cited: 0 };

  let ordinal = 0;
  for (const [, ruleId, body] of xml.matchAll(/<dmn:rule\b[^>]*\sid="([^"]+)"[^>]*>([\s\S]*?)<\/dmn:rule>/g)) {
    cov.rules++;
    const cells = (tag) => [...body.matchAll(new RegExp(`<dmn:${tag}>([\\s\\S]*?)</dmn:${tag}>`, "g"))]
      .map((m) => ({ description: inner(m[1], "description"), text: inner(m[1], "text") }));
    const conditions = cells("inputEntry").map((c, i) => ({ clause: inputs[i]?.label ?? null, ...c }));
    const results = cells("outputEntry").map((c, i) => ({ clause: outputs[i]?.label ?? null, ...c }));
    const annotations = cells("annotationEntry")
      .map((c, i) => ({ clause: outputs[i + nOutputEntry]?.label ?? null, text: c.text ?? c.description }));

    const iri = eid(ruleId);
    nodes.push(node(iri, "decision-rule", `rule ${ordinal + 1}`, {
      id: ruleId, ordinal, conditions, outputs: results, annotations,
    }));
    edges.push(edge("contains", tableIri, iri));
    ordinal++;

    // --- the L1 join -------------------------------------------------------------------------
    const citationText = refAnnotationIndex >= 0 ? annotations[refAnnotationIndex]?.text : null;
    if (citationText && citationText !== "–" && citationText !== "-") {
      cov.cited++;
      edges.push(edge("citesSource", iri, citationId(ns, citationText), {
        properties: { text: citationText },
        note: "Target is an l1:citation minted by tools/extract-citations.mjs from this same " +
              "string, so the L1 and L2 documents join on it without either knowing about the other.",
        evidence: { location: `${path}#${ruleId}`, quote: citationText },
      }));
    }
  }
  if (cov.cited < cov.rules) {
    warnings.push(`${cov.rules - cov.cited} of ${cov.rules} rules cite no L1 source ` +
                  `(coverage ${cov.cited}/${cov.rules})`);
  }

  return { ns, tableIri, nodes, edges, warnings, coverage: cov };
}

// ---------------------------------------------------------------------------------------------
function main() {
  const arg = (flag) => {
    const i = process.argv.indexOf(flag);
    return i === -1 ? null : process.argv[i + 1];
  };
  const bpmnPath = arg("--bpmn");
  const dmnPath = arg("--dmn");
  const personaDir = arg("--personas");
  const out = arg("--out");
  if (!bpmnPath && !dmnPath) {
    console.error("usage: extract-l2.mjs [--bpmn <f.bpmn>] [--dmn <f.dmn>] [--personas <dir>] [--out <path>]");
    process.exit(2);
  }

  const nodes = [];
  const edges = [];
  const warnings = [];
  const derivedFrom = [];
  let ns = null;
  let bpmn = null;

  if (bpmnPath) {
    const xml = readFileSync(bpmnPath, "utf8");
    ns = dakNamespace(attr(xml, "targetNamespace"));
    const read = personaDir ? readPersonas(personaDir, ns) : { personas: [], sha256: null, files: 0 };
    const personas = read.personas;
    for (const p of personas) {
      nodes.push(node(p.id, "persona", p.title, {
        id: p.instance, name: p.name, title: p.title, personaType: p.personaType,
        isco: p.isco, source: p.source,
      }, {
        note: p.isco.length
          ? "ISCO codes were read from the description prose, where the committed instances put " +
            "them; Persona.fsh declares a structured ISCO field that these instances do not use."
          : undefined,
      }));
    }
    bpmn = extractBpmn(xml, bpmnPath, personas);
    nodes.push(...bpmn.nodes);
    edges.push(...bpmn.edges);
    warnings.push(...bpmn.warnings);
    derivedFrom.push({ path: bpmnPath, sha256: sha256(readFileSync(bpmnPath)) });
    if (personaDir) {
      derivedFrom.push({
        path: personaDir,
        sha256: read.sha256,
        note: `${read.files} .fsh files, ${personas.length} of them ActorDefinition instances ` +
              `with a title. The hash covers every .fsh in the directory, so a persona added ` +
              `upstream expires this projection rather than being silently absent from it.`,
      });
    }
    console.error(`bpmn: ${bpmn.nodes.length} nodes, ${bpmn.edges.length} edges, ` +
                  `${personas.length} personas read`);
  }

  if (dmnPath) {
    const dmn = extractDmn(readFileSync(dmnPath, "utf8"), dmnPath, bpmn);
    ns ??= dmn.ns;
    nodes.push(...dmn.nodes);
    edges.push(...dmn.edges);
    warnings.push(...dmn.warnings);
    derivedFrom.push({ path: dmnPath, sha256: sha256(readFileSync(dmnPath)) });
    console.error(`dmn:  ${dmn.nodes.length} nodes, ${dmn.edges.length} edges, ` +
                  `citation coverage ${dmn.coverage.cited}/${dmn.coverage.rules}`);
  }

  const doc = {
    "@context": "http://smart.who.int/kg/l2.context.jsonld",
    id: `${ns}/kg/l2`,
    type: "Entity",
    ontologyVersion: "1.0",
    generatedAt: new Date().toISOString().replace(/\.\d+Z$/, "Z"),
    wasDerivedFrom: derivedFrom,
    nodes,
    edges,
  };

  if (out) writeFileSync(out, JSON.stringify(doc, null, 2) + "\n");
  else console.log(JSON.stringify(doc, null, 2));

  const unresolved = edges.filter((e) => e.properties?.resolutionStatus
                                      && e.properties.resolutionStatus !== "resolved").length;
  const resolved = edges.filter((e) => e.properties?.resolutionStatus === "resolved").length;
  console.error(`total: ${nodes.length} nodes, ${edges.length} edges ` +
                `(${resolved} cross-format joins resolved, ${unresolved} not)`);
  for (const w of warnings) console.error(`  warning: ${w}`);
}

if (process.argv[1] && import.meta.url.endsWith(basename(process.argv[1]))) main();
