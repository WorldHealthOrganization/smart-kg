# WHO SMART Guidelines knowledge graph

A governance, traceability and discoverability layer over the SMART Guidelines artefacts — **not a
replacement for them**. BPMN XML, DMN XML and FHIR JSON stay authoritative; this graph carries
identity, cross-model edges and provenance, and points at those artefacts by URL.

**L1 first**, because L1 is the layer nothing currently represents. A WHO recommendation is prose in
a PDF: no identifier, no structure, and no way for a tool to follow a citation to it.

**L2 second**, in three parts, because L2 is not one thing. `DAK.fsh` declares a Digital Adaptation
Kit as **nine components**, each pointing at a file by URI and saying nothing about its interior.
So the DAK component layer is one graph, and the interiors of BPMN and DMN files are two more —
different vocabularies (OMG's, not WHO's), different extractors, different failure modes.

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
| [`ontology/l2.json`](ontology/l2.json) | **DAK components.** All nine, 12 classes, 32 edges. Imports L1 |
| [`ontology/l2-bpmn.json`](ontology/l2-bpmn.json) | **BPMN interiors.** 6 classes, 19 edges. Imports L2 |
| [`ontology/l2-dmn.json`](ontology/l2-dmn.json) | **DMN interiors.** 6 classes, 9 edges. Imports L2-BPMN |
| [`ontology/generated/`](ontology/generated/) | **Never edit.** Turtle, Cypher and JSON-LD contexts, plus `instances.cypher` — the extracted data as Cypher |
| [`docs/VISUALIZING.md`](docs/VISUALIZING.md) | Loading and querying it all in Neo4j |
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

## The L2 models

`DAK.fsh` describes itself as "a complete Digital Adaptation Kit with metadata and all 9 DAK
components". The component layer carries all nine — eight as classes, and `healthInterventions` as
`l1:health-intervention`, which L1 already declares as its hinge to L2.

| # | Component | Class | Points at |
|---|---|---|---|
| 1 | healthInterventions | `l1:health-intervention` | Dublin Core references |
| 2 | personas | `persona` | ActorDefinition / GenericPersona |
| 3 | userScenarios | `user-scenario` | narrative, plus persona ids |
| 4 | businessProcesses | `business-process` | a BPMN file, by URI |
| 5 | dataElements | `data-element` | a FHIR canonical |
| 6 | decisionLogic | `decision-support-logic` | a DMN file, by URI |
| 7 | indicators | `program-indicator` | numerator/denominator prose |
| 8 | requirements | `functional-requirement` · `non-functional-requirement` | statements, actors |
| 9 | testScenarios | `test-scenario` | a Gherkin feature file, by URI |

Every component reaches its file through `sourcedFrom`, whose target is an `l1:external-artifact`.
The BPMN and DMN subgraphs then describe that file's interior **at the same IRI** — so opening a
file never creates a second name for it.

### Two mechanisms for one problem

A DAK links its components together four times, and it does so two different ways:

| Link | Mechanism | Resolves |
|---|---|---|
| requirement → persona | `actor = Canonical(SGAuthoring.Persona.X)` | **46 / 46** |
| BPMN pool → persona | `@name` == ActorDefinition `title` | 6 / 8 |
| DMN decision → BPMN task | `usingTask/@href` fragment == task `@name` | 0 / 1 |
| DMN clause → data element | names inside expression prose | 0 / 10 |

The first is a canonical reference and it resolves exactly. The rest are string matching, and they
resolve when the strings happen to agree. Same estate, same personas — **the mechanism that works
already exists; BPMN and DMN just do not use it.** That is the finding this layer makes visible,
and it is more useful than any individual broken link.

```
warning: participant "Clinical SME" -> persona unresolved
warning: participant "QC Reviewer"  -> persona unresolved
```

Both personas exist, titled *"Clinical Subject Matter Expert"* and *"Quality Control Reviewer"*.

### Coverage is the other half

```
DAK component coverage (DAK.fsh declares nine):
  · healthInterventions  none in this IG
  ✓ personas             22 instance(s)
  · userScenarios        none in this IG
  · businessProcesses    none in this IG
  ...
  ✓ requirements         41 instance(s)
  7 of 9 components have no instance here.

2 file(s) present with no component declaring them:
  input/bpmn/SGAuthoring.DAKLifecycle.bpmn  (would be businessProcesses)
  input/dmn/DAK.DT.IMMZ.D2.DT.BCG.dmn       (would be decisionLogic)
```

smart-base defines the model rather than instantiating a DAK, so most components being empty is
expected there. The gap that is **not** expected is the last two lines: a BPMN and a DMN sit in the
input tree with no component declaring them. Nothing else in the estate reports either direction.

---

## Using it

```bash
# DMN -> L1 citation nodes, with coverage
node tools/extract-citations.mjs <file.dmn> --out examples/l1.json

# dak.json + the FSH tree -> the nine components, with coverage across all of them
node tools/extract-dak.mjs --dak <dak.json> --fsh <input/fsh> \
  --bpmn-dir <input/bpmn> --dmn-dir <input/dmn> --out examples/dak.json

# one BPMN file's interior
node tools/extract-bpmn.mjs <f.bpmn> --personas <dir> --out examples/bpmn.json

# one DMN file's interior; pass --bpmn to resolve usingTask instead of recording it unresolved
node tools/extract-dmn.mjs <f.dmn> --bpmn <f.bpmn> --out examples/dmn.json

node tools/build-exports.mjs          # regenerate everything in ontology/generated/,
                                      # including instances.cypher from examples/
node tools/build-exports.mjs --check  # fail if any of it is stale
node tools/validate.mjs               # tier 2, each document against its layer, references
                                      # resolved across the whole set
node tools/negative-test.mjs          # prove tier 2 fails on what it claims to catch
```

Plain Node, no dependencies, no install step.

**Neo4j** — see [`docs/VISUALIZING.md`](docs/VISUALIZING.md). In short: load
`ontology/generated/{l1,l2,l2-bpmn,l2-dmn}.cypher` in that order for the **schema**, and
`instances.cypher` for the **data**. The two never mix — schema nodes are `:KGClass`, extracted
nodes are `:Instance`, no relationship joins them — and every node carries `layer`, so one subgraph
is selectable on its own.

**Protégé** — open any `ontology/generated/*.ttl`; the four merge to 835 triples and each declares
`owl:imports` on its parents. Pairwise edge licensing is carried as qualified sub-properties, since
licensing here is per class-pair while an OWL object property has one global domain and range.

---

## Validation

| Tier | Checks | By |
|---|---|---|
| **T1 Shape** | Document matches the graph schema | JSON Schema 2020-12 |
| **T2 Conformance** | Node types are declared classes; edges are licensed; references resolve across the document set; properties are declared; a `resolved` citation or join actually resolves | `tools/validate.mjs` |
| **T3 Fidelity** | Does the graph faithfully represent the PDF, the BPMN, the DMN? | Human. Never auto-passed |

T2 is negative-tested by [`tools/negative-test.mjs`](tools/negative-test.mjs) — 18 cases, run in CI.
Unknown classes, unlicensed edges, undeclared properties, citations falsely claiming resolution, a
join resolved against a placeholder, a resolved join with no evidence, and an invented
`resolutionStatus` are each rejected with a located message, in the subgraphs as well as the base
layers. Four cases assert the opposite — a free-text BPMN branch label, an unresolved join, and a
cross-document reference must **not** be reported — because a check that fires on the normal case
trains people to ignore it.

Loading an ontology also checks it: every class an edge names and every predicate it uses must be
declared in that layer or something it imports. That check caught a real typo the first time it ran.

---

## Status

**The extractor works on real data.** It reads a DMN, finds the L1 reference column by its
description rather than by column index, deduplicates citations across rules, preserves the `(1)`
back-reference into the source bibliography, and hash-pins the source file.

**It deliberately does not resolve citations.** Matching *"WHO recommendations for routine
immunization – summary tables (March 2023)"* to a publication node is a judgement, and the schema
requires a note and evidence for a judgement. An extractor that resolved silently would be
manufacturing provenance.

**All three L2 extractors work on real data.** Against smart-base they produce 385 nodes and 515
edges across three documents: 234 from `dak.json` and the FSH tree (22 personas, 41 requirements,
170 statements, 46/46 canonical references resolved), 100 from the lifecycle BPMN, 51 from the BCG
decision table.

**smart-base disagrees with itself about scheme.** `dak.json` declares `https://smart.who.int/base`;
the BPMN's `targetNamespace` is `http://smart.who.int/base/bpmn` and the DMN's is
`http://smart.who.int/immunizations`. An IRI is an identity key, so two schemes for one authority
split every persona into two unconnected nodes. `kgid.mjs` normalises to https and every extractor
warns that it did — the graph joins, and the inconsistency stays visible for someone to fix.

**Not built yet:** no PDF extractor, so `publication` and `recommendation` nodes must currently be
authored by hand; the L3 subgraph; and the FHIR projection (CPG-on-FHIR is already a smart-base
dependency, EBM-on-FHIR is not — the mapping is intent until checked against the installed IG
packages).

**Known limits, stated rather than hidden.** No data dictionary instance ships in smart-base, so
every `data-element` recovered from a DMN is a name that was referenced rather than a definition
that was found. The BCG table's `usingTask` points into `Determine.bpmn` in the immunizations DAK,
which is not in this clone, so that join is recorded unresolved rather than guessed at. No DAK in
the estate ships a Gherkin feature file, so `test-scenario` has no instance and the feature file's
interior is deliberately unmodelled.
