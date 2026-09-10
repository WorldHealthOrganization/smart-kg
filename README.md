# WHO SMART Guidelines knowledge graph

A governance, traceability and discoverability layer over the SMART Guidelines artefacts — **not a
replacement for them**. BPMN XML, DMN XML and FHIR JSON stay authoritative; this graph carries
identity, cross-model edges and provenance, and points at those artefacts by URL.

**L1 first**, because L1 is the layer nothing currently represents. A WHO recommendation is prose in
a PDF: no identifier, no structure, and no way for a tool to follow a citation to it.

**L2 second**, because L2 has plenty of representation and no joins. BPMN, DMN and the persona
definitions each describe part of a DAK, and the links between them are string equality across
three file formats.

---

## The problem, concretely

`smart-base` ships a real immunization decision table,
`input/dmn/DAK.DT.IMMZ.D2.DT.BCG.dmn`. It declares an output column whose description reads:

> *"Reference for the source content (L1)"*

**L1 traceability is provided for at decision-rule granularity, by WHO's own tooling — as a free-text
string no tool can follow.** One rule has it filled in:

> *"WHO recommendations for routine immunization – summary tables (March 2023) (1)"*

The other 24 do not. Both halves of that matter: turning the string into a resolvable, versioned,
hash-pinned link is what this repository is for, and **counting how many rules have no source at all
is a question nothing can answer today.**

```bash
node tools/extract-citations.mjs ../smart-base/input/dmn/DAK.DT.IMMZ.D2.DT.BCG.dmn
# 25 rules, 1 distinct L1 citation(s), 2 nodes, 1 edges
# coverage: 1/25 rules cite an L1 source (16 carry no annotation at all, 8 stop short of the reference column)
#   ^ a gap in the source, not in this tool. Reported so it can be fixed upstream.
# bpmn link present: http://smart.who.int/immunizations/bpmn/Determine.bpmn#if the client is due for a bacille...
```

Note the second line: the DMN also carries a `dmn:usingTask` href into the BPMN. The BPMN↔DMN
cross-model edge everyone wants **already exists in the artefact** — it just has no graph to live in.

---

## Layout

| Path | Contents |
|---|---|
| [`ontology/l1.json`](ontology/l1.json) | **The L1 ontology.** 16 classes, 35 licensed edges. Authored |
| [`ontology/l2.json`](ontology/l2.json) | **The L2 ontology.** 11 classes, 30 licensed edges. Imports L1 |
| `ontology/*.ttl` · `*.cypher` · `*.context.jsonld` | Generated views — Protégé, Neo4j, JSON-LD |
| [`shapes/recommendation-graph.schema.json`](shapes/recommendation-graph.schema.json) | Graph document shape — tier 1, both layers |
| [`docs/SCOPE.md`](docs/SCOPE.md) | **Read first.** What this graph refuses to hold, and why |
| [`docs/STORAGE.md`](docs/STORAGE.md) · [`docs/RAG.md`](docs/RAG.md) | Where instances live; the ingestion contract |
| [`examples/`](examples/) | Fixtures extracted from real artefacts, checked in CI |
| [`tools/`](tools/) | Extractors, exporter, validator, negative tests. Plain Node, no dependencies |

---

## The L1 model

Sixteen classes in four groups. Every one is grounded in an artefact that exists today —
`ontology/l1.json` records which, per class, in its `groundedIn` and `note` fields.

**Source** — `publication`, `publication-section`. Dublin Core metadata, because
`HealthInterventions.fsh` already carries `reference 1..* DublinCore`. `identifier` holds ISBN/DOI,
as `CDHIv2.fsh` already does with `ISBN 978-92-4-008194-9`.

**Normative content** — `recommendation` (verbatim statement, GRADE strength and certainty,
conditionality), `remark`, `evidence`, and PICO as `population` / `intervention` / `comparator` /
`outcome`.

**What DAKs consume** — `health-intervention` (the hinge to L2), `schedule` and `schedule-entry`
(antigen, dose, target age, minimum interval — the granularity BCG's rules actually turn on), and
`indicator`.

**References out** — `terminology-code`, `citation`, `external-artifact`. All three are deliberately
thin; see below.

### Three boundaries, structurally enforced

**Terminology is a leaf.** `terminology-code` carries `system`, `code`, `display`, `version` and
nothing else. The ontology licenses edges *into* it and none *out of* it:

```
-- what may a terminology code point AT? --
   nothing — terminology is a leaf, as intended
```

ICD-10, SNOMED and ATC have their own authority and release cycle. This graph records that a code
was cited, never what it means.

**External artefacts are opaque.** `external-artifact` carries an IRI and a free-text kind. L1
points at a DMN table or a PlanDefinition; it asserts nothing about the inside. The L2 and L3
subgraphs model those properly.

**Citations can stay unresolved.** `resolutionStatus` is `unresolved | resolved | ambiguous`.
`ambiguous` is a terminal state, not a failure — two publications with similar titles is a question
for a person.

---

## The L2 model

Eleven classes in three kinds — **Artefact** (a file a DAK ships), **Structure** (an element inside
one), **Definition** (something defined once and referenced by name from many). It exists for three
joins, and everything else in it is there to make those joins addressable.

| Join | How it survives today |
|---|---|
| Which role runs a process | BPMN participant `@name` == ActorDefinition `title` |
| Which task invokes a decision | DMN `usingTask/@href` fragment == BPMN task `@name` |
| What a decision reads | element names inside DMN input-expression prose |

None has a shared identifier. Each breaks silently on a rename, and every edge produced from one
carries a `resolutionStatus` of `unresolved`, `resolved` or `ambiguous` — never an unqualified fact.

Run against WHO's committed artefacts, that is not a hypothetical:

```
warning: participant "Clinical SME" -> persona unresolved
warning: participant "QC Reviewer"  -> persona unresolved
```

Both personas exist. They are titled *"Clinical Subject Matter Expert"* and *"Quality Control
Reviewer"*. Two of the eight role assignments in the DAK lifecycle BPMN point at nothing, and
nothing in the estate reports it.

### One artefact, one address

`external-artifact` (L1) and `decision-table` (L2) describe the same DMN file **at the same IRI** —
L1 opaquely, L2 structurally. That is declared by `elaborates` on the L2 class, and
`tools/validate.mjs` rejects any other pair of types sharing an IRI. It is also what makes the
cross-layer edge work without machinery: `citesSource` runs from an L2 decision rule to an L1
citation, and neither document knows the other exists.

---

## Using it

```bash
# DMN -> L1 citation nodes, with coverage
node tools/extract-citations.mjs <file.dmn> --out examples/x.json

# BPMN + DMN + personas -> L2, with the three joins resolved as far as they can be
node tools/extract-l2.mjs --bpmn <f.bpmn> --dmn <f.dmn> --personas <dir> --out examples/y.json

node tools/build-exports.mjs          # regenerate ttl/cypher/context for every layer
node tools/build-exports.mjs --check  # fail if stale
node tools/validate.mjs               # tier 2, each document against its layer
node tools/negative-test.mjs          # prove tier 2 fails on what it claims to catch
```

Plain Node, no dependencies, no install step.

**Neo4j** — `cypher-shell -f ontology/l1.cypher` then `-f ontology/l2.cypher`. L2 licenses edges
onto L1 classes, so loading it alone leaves those edges silently absent; `l2.cypher` ends with a
verification query that returns the imported classes it expects to find.

**Protégé** — open `ontology/l1.ttl` (326 triples) or `ontology/l2.ttl` (243), which declares
`owl:imports` on L1. Pairwise edge licensing is carried as qualified sub-properties, since licensing
here is per class-pair while an OWL object property has one global domain and range.

---

## Validation

| Tier | Checks | By |
|---|---|---|
| **T1 Shape** | Document matches the graph schema | JSON Schema 2020-12 |
| **T2 Conformance** | Node types are declared classes; edges are licensed; references resolve across the document set; properties are declared; a `resolved` citation or join actually resolves | `tools/validate.mjs` |
| **T3 Fidelity** | Does the graph faithfully represent the PDF, the BPMN, the DMN? | Human. Never auto-passed |

T2 is negative-tested by [`tools/negative-test.mjs`](tools/negative-test.mjs) — 13 cases, run in CI.
Unknown classes, unlicensed edges, undeclared properties, citations falsely claiming resolution, a
join resolved against a placeholder, a resolved join with no evidence, and an invented
`resolutionStatus` are each rejected with a located message. Two cases assert the opposite: a
free-text BPMN branch label and an unresolved join must **not** be reported, because a check that
fires on the normal case trains people to ignore it.

---

## Status

**The extractor works on real data.** It reads a DMN, finds the L1 reference column by its
description rather than by column index, deduplicates citations across rules, preserves the `(1)`
back-reference into the source bibliography, and hash-pins the source file.

**It deliberately does not resolve citations.** Matching *"WHO recommendations for routine
immunization – summary tables (March 2023)"* to a publication node is a judgement, and the schema
requires a note and evidence for a judgement. An extractor that resolved silently would be
manufacturing provenance.

**The L2 extractor works on real data too.** Against `SGAuthoring.DAKLifecycle.bpmn` (8 participants,
61 tasks, 70 flows, 10 message flows), the BCG decision table and the 22 committed ActorDefinition
instances, it produces 163 nodes and 226 edges, resolves 6 of 19 cross-format joins, and names all
13 it could not.

**Not built yet:** no PDF extractor, so `publication` and `recommendation` nodes must currently be
authored by hand; the L3 subgraph; and the FHIR projection (CPG-on-FHIR is already a smart-base
dependency, EBM-on-FHIR is not — the mapping is intent until checked against the installed IG
packages).

**Known limits, stated rather than hidden.** No data dictionary instance ships in smart-base, so
every `data-element` is a name that was referenced rather than a definition that was found. The BCG
table's `usingTask` points into `Determine.bpmn` in the immunizations DAK, which is not in this
clone, so that join is recorded unresolved rather than guessed at.
