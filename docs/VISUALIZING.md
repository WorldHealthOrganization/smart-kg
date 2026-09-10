# Seeing the graphs in Neo4j

Everything in `ontology/generated/` is Cypher, Turtle or a JSON-LD context. This page is about the
Cypher.

## Two graphs in one database, kept apart by label

| Label | What it is | Comes from |
|---|---|---|
| `:KGClass` | a **class** in the ontology — what may exist | `generated/<layer>.cypher` |
| `:Instance` | a **thing found in a real artefact** — what does exist | `generated/instances.cypher` |

They are deliberately never mixed. A query cannot accidentally traverse from a persona to *the idea
of* a persona, because no relationship joins the two sets. Load one, the other, or both.

Every node of either kind carries `layer` — `l1`, `l2`, `l2-bpmn` or `l2-dmn` — which is what makes
a single subgraph selectable.

> On an `:Instance`, `id` is the IRI and is the node's identity. Where a class also declares a
> domain property called `id` (a DAK's is `smart.who.int.base`), that value is stored as `localId`.

---

## Loading

Order matters for the ontology: each layer licenses edges onto classes from the ones it imports,
and Cypher does not treat a `MATCH` that finds nothing as an error — the edges would simply be
missing, silently.

```bash
cd ontology/generated

cypher-shell -f l1.cypher
cypher-shell -f l2.cypher
cypher-shell -f l2-bpmn.cypher
cypher-shell -f l2-dmn.cypher

cypher-shell -f instances.cypher      # the extracted data
```

In **Neo4j Desktop / Browser** without `cypher-shell`: open each file, paste, and run. The Browser
runs one statement at a time unless multi-statement is enabled, so `:auto` or the shell is easier
for the larger files. `instances.cypher` is ~900 statements.

Everything is `MERGE`, so re-running is safe.

### Check it loaded

```cypher
MATCH (n:Instance) RETURN n.layer AS layer, count(*) AS nodes ORDER BY layer;
```

```
l1        │   2
l2        │ 234
l2-bpmn   │ 100
l2-dmn    │  50
```

---

## Seeing one subgraph at a time

**The whole of L1** — small enough to show in full:

```cypher
MATCH (n:Instance {layer:'l1'})-[r]-(m) RETURN n, r, m;
```

**The DAK component layer**, without the 170 requirement statements swamping it:

```cypher
MATCH (n:Instance {layer:'l2'})-[r]->(m:Instance)
WHERE NOT m:`requirement-statement`
RETURN n, r, m;
```

**The BPMN subgraph** — 100 nodes, which the browser will lay out but not pleasantly. Start with
the pools and their personas:

```cypher
MATCH (p:`bpmn-participant`)-[r:PERFORMEDBY]->(persona)
RETURN p, r, persona;
```

Then one pool's process in full:

```cypher
MATCH (p:`bpmn-participant` {name:'FHIR Modeller'})-[:CONTAINS]->(proc)
MATCH path = (proc)-[:CONTAINS|FLOWSTO*1..12]->()
RETURN path;
```

**The DMN subgraph** — one decision table, its clauses and rules:

```cypher
MATCH (d:`dmn-decision`)-[r:CONTAINS|INVOKEDBY*1..3]->(m)
RETURN d, r, m;
```

---

## The queries the graphs were built for

**Which roles does a process name that nothing defines?** The two-line answer that no other tool in
the estate gives:

```cypher
MATCH (p:`bpmn-participant`)-[r:PERFORMEDBY]->(persona)
WHERE r.resolutionStatus <> 'resolved'
RETURN p.name AS pool, r.resolutionStatus AS status, persona.title AS looked_for;
```

**Every cross-file reference, by how well it resolves** — this is the finding the L2 layer exists to
make visible:

```cypher
MATCH ()-[r]->()
WHERE r.resolutionStatus IS NOT NULL
RETURN type(r) AS link, r.matchedOn AS mechanism, r.resolutionStatus AS status, count(*) AS n
ORDER BY link, status;
```

```
FULFILLEDBY  │ actor Canonical() == ActorDefinition instance id │ resolved   │ 46
PERFORMEDBY  │ participant @name == ActorDefinition title       │ resolved   │  6
PERFORMEDBY  │ participant @name == ActorDefinition title       │ unresolved │  2
INVOKEDBY    │ usingTask @href fragment == BPMN task @name      │ unresolved │  1
READS        │ (extraction rule on the edge)                    │ unresolved │ 10
```

**Which decision rules cite no L1 source?**

```cypher
MATCH (r:`dmn-rule`)
WHERE NOT (r)-[:CITESSOURCE]->()
RETURN count(r) AS rules_with_no_source;
```

**Every SHALL in the kit, and who fulfils it:**

```cypher
MATCH (req)-[:HASSTATEMENT]->(s:`requirement-statement` {conformance:'SHALL'})
OPTIONAL MATCH (req)-[:FULFILLEDBY]->(p:persona)
RETURN req.title AS requirement, s.key AS key, s.label AS statement,
       collect(DISTINCT p.title) AS personas
ORDER BY key;
```

**One artefact, described at two layers** — the shared-IRI mechanism, visible:

```cypher
MATCH (n:Instance)
WHERE size(labels(n)) > 2
RETURN n.id AS iri, labels(n) AS described_as, n.layers AS layers;
```

---

## Making it readable in the browser

Neo4j Browser labels nodes by an arbitrary property until told otherwise. Click a label in the
left-hand sidebar and set the caption:

| Label | Caption |
|---|---|
| `persona` | `title` |
| `bpmn-task`, `bpmn-participant` | `name` |
| `dmn-rule` | `label` |
| `requirement-statement` | `key` |
| `citation` | `numbering` |

Colour by `layer` rather than by label if you want the four subgraphs to read as four subgraphs.

Two settings worth changing before loading the BPMN subgraph: raise the *Initial Node Display*
limit above its default of 300, and turn *Connect result nodes* off — with it on, every returned
node pulls in its neighbours and a 60-task process becomes unreadable.

---

## The ontology on its own

Without instances loaded, the class graph is small enough to see whole — 40 classes, 95 licensed
edges:

```cypher
MATCH (c:KGClass)-[r]->(d:KGClass) RETURN c, r, d;
```

One layer's classes:

```cypher
MATCH (c:KGClass {layer:'l2-bpmn'}) RETURN c;
```

Which classes may point at a terminology code — and, more usefully, that none may point *out* of
one, because terminology is a structural leaf:

```cypher
MATCH (c:KGClass)-[r]->(t:KGClass {id:'terminology-code'}) RETURN c.name, type(r);
MATCH (t:KGClass {id:'terminology-code'})-[r]->(c) RETURN c;   // returns nothing, by design
```

---

## Protégé

`ontology/generated/*.ttl` open directly. Each declares `owl:imports` on its parents, so opening
`l2-dmn.ttl` in a workspace containing the others gives the full 835-triple model. Pairwise edge
licensing is carried as qualified sub-properties — a single global domain and range on
`sgkg:contains` would permit `dmn-rule contains persona`, which the model does not.
