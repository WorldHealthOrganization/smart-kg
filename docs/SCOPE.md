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

## What L1 is for

Three questions, in priority order. Generation is not among them.

1. **Impact analysis.** A recommendation changes — which artefacts are affected? Today this is
   answered by reading PDFs and grepping.
2. **Coverage.** Which recommendations have no DAK representation at all? Currently unanswerable.
3. **Citation resolution.** WHO's own tooling already emits an L1 reference per decision-table rule.
   In `DAK.DT.IMMZ.D2.DT.BCG.dmn` the output column's description reads *"Reference for the source
   content (L1)"* and all 25 rules carry the string *"WHO recommendations for routine immunization –
   summary tables (March 2023) (1)"*. No tool can follow it. Making it followable is the cheapest
   large win available.

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
