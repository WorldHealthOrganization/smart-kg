# Where the schema lives, and where the data lives

**This repository holds the schema. It holds no DAK data, and it should not start.**

That is the one rule this document exists to state, and everything below is why.

---

## Three layers

| Layer | What it is | Size | Changes | Lives in |
|---|---|---|---|---|
| **T-Box** — ontology | Classes and the relationships permitted between them | 40 classes, 95 edges across 4 layers (l1, l2, l2-bpmn, l2-dmn) | When the model does — rarely, with review | **here**, `ontology/` |
| **Shapes** — constraints | What a graph document must satisfy to be valid | 1 file | With the T-Box | **here**, `shapes/` |
| **A-Box** — instances | The recommendations of one guideline; the processes, decisions and personas of one DAK | Hundreds of nodes per publication or DAK | Every guideline revision, every DAK release | **published with its source** |

The names come from description logic, where the terminological box holds what kinds of thing exist
and the assertional box holds what is actually the case. The distinction is worth keeping because
the two have almost nothing in common operationally: one is small, slow and reviewed by people; the
other is large, regenerated, and read by machines.

---

## Why instance data does not belong in git

**An extracted graph is derived.** Every node comes from a page of a PDF, a DMN rule, or a
spreadsheet row. Committing it creates a second copy of the source — one that will disagree with the
first the moment someone revises the guideline and does not re-run the extract. [`RAG.md`](RAG.md) already
forbids the consequence: *the graph is derived data and is never the citation; where a graph node
and its source disagree, the source is right.* A committed A-Box makes that rule unenforceable in
practice, because the stale copy is the one sitting in the repository looking authoritative.

**Scale.** A single guideline carries tens to hundreds of recommendations, each with PICO,
evidence and remarks; a DAK's data dictionary runs to hundreds of rows. Across the estate that is a
large amount of generated JSON in version control, diffed on every regeneration, reviewed by nobody.

**Lifecycle mismatch.** The ontology changes when the model changes — rarely, deliberately, with
review. An extracted graph changes whenever its source does. Putting them in one repository means
every guideline revision and every DAK release churns the repository that consumers pin for their
schema.

**There is already a precedent in this estate.** smart-base's
`input/scripts/generate_jsonld_vocabularies.py` runs *after* the IG Publisher and writes JSON-LD
vocabularies into the **built** Implementation Guide, published at a canonical URL. They are not
committed. A DAK graph is the same kind of artifact and should travel the same path.

---

## The shape of the whole thing

```
                        smart-kg  (here)
                          ontology/   T-Box — l1, l2, l2-bpmn, l2-dmn (authored)
                          ontology/generated/   projections; never edited
                          shapes/     constraints
                          docs/  tools/  examples/   one fixture
                             │
                             │  ontology + shapes, fetched by URL or pinned by version
              ┌──────────────┴───────────────┐
              ▼                              ▼
  ┌───────────────────────┐    ┌──────────────────────────────┐
  │ a guideline           │    │ a DAK IG build               │
  │  PDF → recommendations│    │  DMN  → citations      (l1)  │   ← the A-Box,
  │                       │    │  FSH  → nine components(l2)  │     published not committed
  │                       │    │  BPMN → interiors (l2-bpmn)  │
  │                       │    │  DMN  → interiors  (l2-dmn)  │
  └───────────────────────┘    └──────────────────────────────┘
              │                              │
              └──────────────┬───────────────┘
                             ▼
              triplestore / Neo4j  ←  where cross-guideline queries happen
```


### For a publisher of extracted graphs

Generate the graph during the build, beside the JSON-LD vocabularies smart-base already emits, and
publish it with its source:

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
guidelines or DAKs gets answered, and git is the wrong tool for it — git stores versions of files, not a
queryable graph. The store is a cache: rebuild it from the published documents rather than treating
it as a system of record.

### For this repository

Fixtures in [`examples/`](../examples/), small enough to read, exercised by
[`tools/validate.mjs`](../tools/validate.mjs) in CI. They exist to prove the ontology and the shapes
still agree with each other, not to be data — and, because they are extracted from real committed
artefacts rather than invented, to prove the extractors still work on the shapes WHO actually ships.

They are also what makes the cross-layer join testable: the L1 and L2 fixtures come from the same
DMN file, share one IRI for it, and are validated together as one graph.

If a real guideline or DAK graph ever appears in `examples/`, something has gone wrong: the fixture has become a
dataset, and the rule at the top of this page has quietly stopped holding.

---

## The one case for committing a graph

A **frozen snapshot accompanying a publication** — a graph as it stood for a named release,
kept so a result can be reproduced years later. That is an archival artifact, not working data, and
it belongs with the release it documents: a release asset, or a tagged directory in the source's
own repository. Not here, and not on a branch anyone is expected to keep up to date.
