#!/usr/bin/env node
// The three questions L1 exists to answer (docs/SCOPE.md), as functions over a set of graph
// documents. They are the consumers the ontology is justified by, so they are code rather than
// prose: tools/goal-test.mjs runs them in CI, and a model change that stops one of them answering
// fails the build instead of being noticed later.
//
//   impact(graph, id)          a recommendation changed -- what is affected?
//   coverage(graph)            which recommendations have no DAK representation, which DAK rules
//                              cite nothing, and which citations are placeholders?
//   resolveCitation(graph, id) where does this citation string lead, and how sure is each step?
//
// A graph is several documents read as one: L1 holds WHO content, and every higher layer points down
// into it, so no single document answers any of these.

/** Several documents read as one graph. */
export function graphOf(docs) {
  const nodes = new Map();
  const edges = [];
  for (const d of docs) {
    for (const n of d.nodes ?? []) if (!nodes.has(n.id)) nodes.set(n.id, n);
    edges.push(...(d.edges ?? []));
  }
  return { nodes, edges };
}

const out = (g, id, p) => g.edges.filter((e) => e.source === id && (!p || e.predicate === p));
const into = (g, id, p) => g.edges.filter((e) => e.target === id && (!p || e.predicate === p));
const typeOf = (g, id) => g.nodes.get(id)?.type;

/** Edges a DAK uses to point down at an L1 recommendation. All are declared above L1. */
const IMPLEMENTS = new Set(["implementedBy"]);

/**
 * Everything affected when recommendation `id` changes: what replaces it, where it is printed, what
 * it rests on, the indicators justified by or measuring it, the DAK artefacts implementing it, and
 * the citations that resolve to it. Follows supersedes forward, so asking about a superseded
 * recommendation reaches its replacement and everything hanging off that too.
 */
export function impact(g, id) {
  const result = { recommendations: [], supersededBy: [], presentedIn: [], evidence: [], outcomes: [],
                   remarks: [], indicators: [], implementedBy: [], citedBy: [] };
  const queue = [id];
  const seen = new Set();
  while (queue.length) {
    const r = queue.shift();
    if (seen.has(r)) continue;
    seen.add(r);
    result.recommendations.push(r);
    for (const e of into(g, r, "supersedes")) { result.supersededBy.push(e.source); queue.push(e.source); }
    result.presentedIn.push(...out(g, r, "presentedIn").map((e) => e.target));
    result.remarks.push(...out(g, r, "hasRemark").map((e) => e.target));
    for (const s of out(g, r, "supportedBy")) {
      result.evidence.push(s.target);
      result.outcomes.push(...out(g, s.target, "forOutcome").map((e) => e.target));
    }
    result.indicators.push(...into(g, r, "justifiedBy").map((e) => e.source),
                           ...into(g, r, "measures").map((e) => e.source));
    result.implementedBy.push(...out(g, r).filter((e) => IMPLEMENTS.has(e.predicate)).map((e) => e.target));
    for (const c of into(g, r, "resolvesTo")) {
      result.citedBy.push(c.source);
      for (const n of into(g, c.source, "numberedAs")) result.citedBy.push(n.source);
    }
  }
  for (const k of Object.keys(result)) result[k] = [...new Set(result[k])];
  return result;
}

/**
 * Coverage over everything loaded. A recommendation is represented in a DAK when something above
 * L1 points at it. A DMN rule is sourced when it cites a citation that is not a placeholder; a
 * placeholder is counted apart, because "[Add appropriate reference]" is the author saying a
 * source is missing -- a different finding from a blank cell.
 */
export function coverage(g) {
  const recs = [...g.nodes.values()].filter((n) => n.type === "recommendation").map((n) => n.id);
  const represented = (id) => out(g, id).some((e) => IMPLEMENTS.has(e.predicate));
  const rules = [...g.nodes.values()].filter((n) => n.type === "dmn-rule").map((n) => n.id);
  const ruleCitations = (id) => out(g, id, "citesSource").map((e) => g.nodes.get(e.target)).filter(Boolean);
  const cited = [], placeholder = [], none = [];
  for (const r of rules) {
    const cs = ruleCitations(r);
    if (cs.some((c) => c.properties?.citationKind !== "placeholder")) cited.push(r);
    else if (cs.length) placeholder.push(r);
    else none.push(r);
  }
  return {
    recommendations: recs.length,
    unrepresented: recs.filter((id) => !represented(id)),
    rules: { total: rules.length, cited, placeholder, none },
  };
}

/**
 * The path a citation string takes to WHO content, step by step, with how each step was made. A
 * reader can see which step was mechanical and which was somebody's judgement.
 */
export function resolveCitation(g, id) {
  const steps = [];
  let at = id;
  const seen = new Set();
  while (at && !seen.has(at)) {
    seen.add(at);
    const direct = out(g, at, "resolvesTo")[0];
    if (direct) {
      steps.push({ from: at, predicate: "resolvesTo", to: direct.target, derivation: direct.derivation });
      break;
    }
    const numbered = out(g, at, "numberedAs")[0];
    if (!numbered) break;
    steps.push({ from: at, predicate: "numberedAs", to: numbered.target, derivation: numbered.derivation });
    at = numbered.target;
  }
  const end = steps.length ? steps[steps.length - 1].to : null;
  return { steps, target: end && typeOf(g, end) !== "reference-entry" && typeOf(g, end) !== "citation" ? end : null };
}
