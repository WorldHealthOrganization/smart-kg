# What this graph holds, and what it refuses to

Read this before adding anything.

## The rule

> Graph a relationship only when it has **no other representation** *and* a **named consumer that
> will traverse it**. Cheap generation is not justification. An artefact with no reader is a
> liability regardless of how it was produced.

The second clause is the one that gets skipped. A relationship can be genuinely unrepresented
elsewhere and still not belong here, if nobody will ever query it. This repository has already been
rebuilt once for failing exactly that test: an earlier version generated a 102-class ontology from
WHO's ArchiMate model, faithfully and at almost no cost, and every reference to it was inside this
repository. It was deleted.

### The corollary

> **Graph what has no other query layer; index what does.**

BPMN and DMN internals live only in XML, which nothing can query across files — so they may be
graphed. FHIR internals live in FHIR, which has canonical references, a validator and a publisher —
so they are indexed by URL and never re-represented. Applying this consistently is what stops the
graph becoming a worse copy of the artefacts it points at.

---

## Three hard boundaries

### 1. Terminology is cross-referenced, never modelled

The `terminology-code` class carries `system`, `code`, `display` and `version`. Nothing else.

It is a **leaf**: the ontology licenses edges *into* it and none *out of* it, and
`tools/validate.mjs` enforces that. No hierarchy, no subsumption, no synonyms, no post-coordination,
no expansions.

ICD-10, ICD-11, SNOMED CT and ATC each have their own authority, release cycle, licensing and
tooling. A partial copy here would be wrong within one release and would be trusted anyway, because
it would look authoritative. Resolve meaning against a terminology server. This graph records only
that a code was *cited*.

The same applies to WHO's own classifications. CDHI gets a `classifiedAs` edge — kept separate from
`crossReferences` because classification is an assertion about the intervention rather than a
mention of a code — but it is still just a code, not a copy of the classification.

### 2. No patient data, ever

A `PlanDefinition` is a definition. A `CarePlan` is its execution against a real person. The moment
a graph reaches that layer it stops being a documentation artefact and becomes a data-governance
problem with an entirely different review process, legal basis and threat model.

L4 execution artefacts — `CarePlan`, `ServiceRequest`, `Observation`, `Patient`,
`QuestionnaireResponse` holding real answers — are out of scope permanently, not pending a decision.

### 3. No DAK instance data in this repository

The schema lives here. A DAK's own graph is produced by that DAK's Implementation Guide build and
published with it. See [`STORAGE.md`](STORAGE.md).

`examples/` holds fixtures small enough to read, exercised in CI. If a real DAK graph appears there,
the fixture has become a dataset and this rule has quietly stopped holding.

---

## What L2 holds

L2 is the opposite problem to L1. L1 has no representation; L2 has three of them — BPMN XML, DMN XML
and FSH — and no joins between them.

Applying the rule and its corollary gives the whole answer:

| | Other representation? | Other query layer? | Verdict |
|---|---|---|---|
| BPMN flows, pools, gateways | No — only the XML | No | **Graph** |
| DMN clauses and rules | No — only the XML | No | **Graph** |
| The three cross-format joins | Only as string equality | No | **Graph.** This is the point |
| A FHIR canonical's contents | Yes — FHIR | Yes — validator, publisher, canonical refs | **Index by URL** |
| Decision-table cells | Yes — the table itself | The table | **Carry as properties** |

What that excludes is as load-bearing as what it includes. `CoreDataElement` is a canonical URI to a
ValueSet, CodeSystem, ConceptMap or logical model; L2 records the URL and nothing about the target.
The BCG table's 250 input and output cells are properties of their rule, not 250 nodes. BPMN diagram
interchange is dropped entirely — coordinates answer no question this graph exists to answer.

### An edge with no instance is not licensed

`ontology/l2.json` carries a `deliberatelyOmitted` list, and the first entry is a `writes` edge from
an output clause to a data element. It is plausible, it is the natural mirror of `reads`, and no
committed artefact exhibits it: the BCG table's four outputs are Care Plan, Guidance displayed to
health worker, Annotations and Reference(s), none of them a dictionary element. Licensing it would
be inventing vocabulary — the failure this repository was rebuilt to avoid.

### Every join says how confident it is

A join made by string equality across two file formats is a **judgement**, so it is `inferred` and
never `derived`, and it carries `resolutionStatus`: `unresolved`, `resolved` or `ambiguous`.
`ambiguous` is terminal, exactly as for a citation — two ActorDefinitions with one title is a
question for a person, not a tie-break for a matcher.

An unresolved reference still gets a node, marked unresolved. A dangling edge would be dropped by
any store and the finding with it; a placeholder makes *"roles a process names that nothing
defines"* a query rather than a warning nobody kept.

### A Care Plan column is not a care plan

The BCG table declares an output column labelled "Care Plan". That is a column definition inside a
decision table — a definition, like a `PlanDefinition`. Boundary 2 above is unaffected and
unchanged: nothing in L2 reaches an execution artefact, and `output-clause` has no edge that could.

---

## What L1 is for

Three questions, in priority order. Generation is not among them.

1. **Impact analysis.** A recommendation changes — which artefacts are affected? Today this is
   answered by reading PDFs and grepping.
2. **Coverage.** Which recommendations have no DAK representation at all? Currently unanswerable.
3. **Citation resolution.** WHO's own tooling already provides an L1 reference column per
   decision-table rule. In `DAK.DT.IMMZ.D2.DT.BCG.dmn` the output column's description reads
   *"Reference for the source content (L1)"*, and one of its 25 rules carries *"WHO recommendations
   for routine immunization – summary tables (March 2023) (1)"*. No tool can follow that string —
   and no tool reports the 24 rules that have none. Making the first followable and the second
   countable is the cheapest large win available.

   Note which of these is which: turning a citation into a link is *citation resolution*; finding
   the rules with no citation is *coverage*, question 2 above, measured over the same data.

### What L1 is explicitly not for

**Deriving L2 from L1.** The step from a recommendation to a business process with lanes, tasks and
a data dictionary is *adaptation* — the "A" in Digital Adaptation Kit. It requires contextual
judgement about who acts, in what order, with what data, under which local constraints. A
recommendation that derived predictably into a workflow would not need adapting.

The graph makes that step **traceable and reviewable**. It does not make it automatic, and no
document here should imply otherwise.

---

## Provenance is stricter here than anywhere else in the estate

Everywhere else the source is structured. Here it is a PDF.

Extraction from prose is **`inferred` at minimum, never `derived`**. Every recommendation node
carries:

- `statement` — a **verbatim** quote. A paraphrased recommendation is a different recommendation.
- `evidence.location` — the publication and page.
- the guideline PDF's SHA-256, in the document's `wasDerivedFrom`.

`shapes/recommendation-graph.schema.json` rejects an `inferred` or `decided` node without a `note`
and `evidence`, and `tools/validate.mjs` rejects a `citation` that claims `resolved` without a
`resolvesTo` edge. `ambiguous` is a legitimate terminal state for a citation and must never be
collapsed to `resolved` — two publications with similar titles is a question for a person, not a
tie-break for a matcher.
