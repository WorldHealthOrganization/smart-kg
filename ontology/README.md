# The ontologies

One directory per subgraph. Each is self-contained and every file inside is named after its layer,
so a file stays identifiable once downloaded and handed to a tool.

```
ontology/
  l1/        l1.json  l1.ttl  l1.cypher  l1.context.jsonld      16 classes · 35 edges
  l2/        …                                                  12 classes · 32 edges
  l2-bpmn/   …                                                   6 classes · 19 edges
  l2-dmn/    …                                                   6 classes ·  9 edges
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

The import chain is `l1 → l2 → l2-bpmn → l2-dmn`. It follows the artefacts: `dmn:usingTask` names
the BPMN task that invokes a decision, so DMN depends on BPMN and not the reverse.

## Loading

**Everything at once** — the safe default:

```bash
cypher-shell -f ontology/all.cypher
```

**One subgraph, or a few** — load in dependency order. A layer licenses edges onto classes from the
ones it imports, and Cypher does **not** treat a `MATCH` that finds nothing as an error, so loading
out of order silently drops those edges rather than failing:

```bash
cypher-shell -f ontology/l1/l1.cypher
cypher-shell -f ontology/l2/l2.cypher
cypher-shell -f ontology/l2-bpmn/l2-bpmn.cypher
```

Every statement is `MERGE`; re-running is safe. Each importing layer's file ends with a commented
verification query returning the imported classes it expects to find.

**Protégé** — open `all.ttl` for the whole model, or a single `<layer>/<layer>.ttl`. The per-layer
files declare `owl:imports`, which a reasoner can follow only if the IRIs resolve; `all.ttl` is the
offline merge, and parses as one 835-triple document.

**JSON-LD** — `<layer>.context.jsonld` expands a graph document of that layer. It covers imported
terms too, so an L2-DMN document naming an `l1:citation` still expands.

See [`../docs/VISUALIZING.md`](../docs/VISUALIZING.md) for queries.
