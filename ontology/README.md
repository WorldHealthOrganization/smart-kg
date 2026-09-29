# The ontologies

One directory per subgraph. Each is self-contained and every file inside is named after its layer,
so a file stays identifiable once downloaded and handed to a tool.

```
ontology/
  l1/        l1.json  l1.ttl  l1.cypher  l1.context.jsonld      16 classes · 35 edges
  l2/        …                                                  13 classes · 41 edges
  l2-bpmn/   …                                                   6 classes · 20 edges
  l2-dmn/    …                                                   6 classes · 10 edges
  l3/        …                                                  14 classes · 39 edges
  all.cypher   every layer, in dependency order
  all.ttl      every layer, merged into one document
```

In each directory the **`.json` is the authored source**; the other three are projections of it and
say so in their first line. `node tools/build-exports.mjs` regenerates them; CI fails if they drift.

**This is the type graph — classes and the edges licensed between them. There is no DAK data here,
and there should not be.** See [`../docs/STORAGE.md`](../docs/STORAGE.md).

## What each layer is

| Layer | Holds | Vocabulary | Imports |
|---|---|---|---|
| `l1` | WHO recommendations, evidence, PICO, citations | authored for this estate | — |
| `l2` | the nine DAK components and their cross-references | WHO's, from `DAK.fsh` | `l1` |
| `l2-bpmn` | one BPMN file's interior | OMG's | `l2` |
| `l2-dmn` | one DMN file's interior | OMG's | `l2-bpmn` |
| `l3` | FHIR artefacts, indexed by canonical URL | HL7's | `l2-dmn` |

The import chain is `l1 → l2 → l2-bpmn → l2-dmn → l3`. It follows the artefacts: `dmn:usingTask`
names the BPMN task that invokes a decision, so DMN depends on BPMN and not the reverse; and an L3
artefact implements an L2 component, so L3 sits at the end.

`l3` is an **index, not a model**. Each class carries a canonical URL, a resource type, the profile
the artefact declares and status metadata — no action trees, no element definitions, no CQL. It
asserts no profile as correct, because WHO's sources disagree: smart-base defines 15 `SG*` profiles,
the published SOP names CRMI/CPG/CQFM/SDC instead, and the immunizations IG uses CPG and CQFM
exclusively. `profile` records what the artefact carries.

## Loading

**Run against a user database, not `system`.** The first statement is a `CREATE CONSTRAINT`, which
`system` rejects — and `system` is where Neo4j Browser can land you after connecting.

```cypher
:use neo4j          -- in Browser, before pasting; or your database's name
```

In Browser, also turn on **Enable multi statement query editor** in Settings, or only the first
statement runs.

**Everything at once** — the safe default:

```bash
cypher-shell -d neo4j -f ontology/all.cypher
```

**One subgraph, or a few** — load in dependency order. A layer licenses edges onto classes from the
ones it imports, and Cypher does **not** treat a `MATCH` that finds nothing as an error, so loading
out of order silently drops those edges rather than failing:

```bash
cypher-shell -d neo4j -f ontology/l1/l1.cypher
cypher-shell -d neo4j -f ontology/l2/l2.cypher
cypher-shell -d neo4j -f ontology/l2-bpmn/l2-bpmn.cypher
```

Every statement is `MERGE`; re-running is safe. Each importing layer's file ends with a commented
verification query returning the imported classes it expects to find.

**Protégé** — open `all.ttl` for the whole model, or a single `<layer>/<layer>.ttl`. The per-layer
files declare `owl:imports`, which a reasoner can follow only if the IRIs resolve; `all.ttl` is the
offline merge, and parses as one 835-triple document.

**JSON-LD** — `<layer>.context.jsonld` expands a graph document of that layer. It covers imported
terms too, so an L2-DMN document naming an `l1:citation` still expands.

See [`../docs/VISUALIZING.md`](../docs/VISUALIZING.md) for queries.
