# Where the schema lives, and where the data lives

**This repository holds the schema. It holds no DAK data, and it should not start.**

That is the one rule this document exists to state, and everything below is why.

---

## Three layers

| Layer | What it is | Size | Changes | Lives in |
|---|---|---|---|---|
| **T-Box** — ontology | Classes and the relationships permitted between them | 102 classes, 191 edges | When the ArchiMate model does | **here**, `ontology/` |
| **Shapes** — constraints | What a graph document must satisfy to be valid | 2 files | With the T-Box | **here**, `shapes/` |
| **A-Box** — instances | The actual nodes and edges of one DAK | Hundreds to thousands of nodes, per DAK | Every DAK release | **the DAK's own IG build** |

The names come from description logic, where the terminological box holds what kinds of thing exist
and the assertional box holds what is actually the case. The distinction is worth keeping because
the two have almost nothing in common operationally: one is small, slow and reviewed by people; the
other is large, regenerated, and read by machines.

---

## Why instance data does not belong in git

**A DAK graph is derived.** Every node in it comes from a BPMN element, a spreadsheet row, a DMN
rule. Committing the graph creates a second copy of the DAK — one that will disagree with the first
the moment someone edits a spreadsheet and does not re-run the extract. [`RAG.md`](RAG.md) already
forbids the consequence: *the graph is derived data and is never the citation; where a graph node
and its source disagree, the source is right.* A committed A-Box makes that rule unenforceable in
practice, because the stale copy is the one sitting in the repository looking authoritative.

**Scale.** A single DAK's data dictionary runs to hundreds of rows, each becoming a node with its
edges. Across the SMART Guidelines estate that is a large amount of generated JSON in version
control, diffed on every regeneration, reviewed by nobody.

**Lifecycle mismatch.** The ontology changes when the methodology changes — rarely, deliberately,
with review. A DAK graph changes whenever its DAK does. Putting them in one repository means every
DAK release churns the repository that IGs pin for their schema.

**There is already a precedent in this estate.** smart-base's
`input/scripts/generate_jsonld_vocabularies.py` runs *after* the IG Publisher and writes JSON-LD
vocabularies into the **built** Implementation Guide, published at a canonical URL. They are not
committed. A DAK graph is the same kind of artifact and should travel the same path.

---

## The shape of the whole thing

```
smart-ig-starter-kit          smart-base                    smart-kg  (here)
  archimate/*.archimate         input/fsh/models/*.fsh         ontology/   T-Box
        │                             │                        shapes/     constraints
        │  hash-pinned                │  hash-pinned           docs/
        └──────────────┬──────────────┘                        tools/
                       ▼                                       examples/   one fixture
                    smart-kg
                       │
                       │  ontology + shapes, fetched by URL or pinned by version
                       ▼
        ┌──────────────────────────────────────────┐
        │  a DAK IG build  (smart-immunizations …) │
        │    extract  →  dak.kg.jsonld             │   ← the A-Box, published not committed
        └──────────────────────────────────────────┘
                       │
                       ▼
         triplestore / Neo4j  ←  where cross-DAK queries actually happen
```

### For a DAK Implementation Guide

Generate the graph during the IG build, beside the JSON-LD vocabularies smart-base already emits,
and publish it with the IG:

```
https://smart.who.int/<dak>/dak.kg.jsonld
```

It should declare the `ontologyVersion` it was built against and carry `wasDerivedFrom` hashes for
every DAK source it read. Both are already required by
[`shapes/recommendation-graph.schema.json`](../shapes/recommendation-graph.schema.json), and both are what make a published
graph checkable rather than merely recent.

Add it to `.gitignore`. A graph that appears in a diff is a graph someone will eventually edit by
hand.

### For a query layer

Load the published graphs into a triplestore or Neo4j. That is where a question spanning several
DAKs gets answered, and git is the wrong tool for it — git stores versions of files, not a
queryable graph. The store is a cache: rebuild it from the published documents rather than treating
it as a system of record.

### For this repository

One fixture in [`examples/`](../examples/), small enough to read, exercised by
[`tools/validate.mjs`](../tools/validate.mjs) in CI. It exists to prove the ontology and the shapes
still agree with each other, not to be data.

If a real DAK graph ever appears in `examples/`, something has gone wrong: the fixture has become a
dataset, and the rule at the top of this page has quietly stopped holding.

---

## The one case for committing a graph

A **frozen snapshot accompanying a publication** — a graph as it stood for a named DAK release,
kept so a result can be reproduced years later. That is an archival artifact, not working data, and
it belongs with the release it documents: a release asset, or a tagged directory in the DAK's own
repository. Not here, and not on a branch anyone is expected to keep up to date.
