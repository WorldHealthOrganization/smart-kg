#!/usr/bin/env node
// Loads an ontology layer and resolves its `imports`.
//
// L2 licenses edges whose target is an L1 class -- a decision rule cites an l1:citation, a data
// element is defined by an l1:external-artifact. Rather than copying those class definitions into
// l2.json, where they would drift, l2.json declares `imports: ["l1"]` and this module resolves it.
//
// Both build-exports.mjs and validate.mjs load through here so that "what the ontology permits"
// means the same thing to the exporter and to the checker. They disagreed once before, when the
// shape file carried its own copy of the predicate list.

import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Read one ontology file. No import resolution. */
export function readLayer(layer) {
  const src = join(ROOT, "ontology", `${layer}.json`);
  if (!existsSync(src)) throw new Error(`ontology/${layer}.json is missing`);
  return JSON.parse(readFileSync(src, "utf8"));
}

/**
 * Load a layer with its imports resolved transitively.
 *
 * Returns the layer's own ontology plus `imported`, holding everything reachable through
 * `imports`. They are kept apart rather than merged into one bag because the two are treated
 * differently: the Turtle export declares own classes and only references imported ones, and a
 * stale-export check must not fire because an imported layer changed.
 */
export function loadLayer(layer, seen = new Set()) {
  if (seen.has(layer)) throw new Error(`circular ontology import at "${layer}"`);
  seen.add(layer);

  const own = readLayer(layer);
  const imported = { classes: [], predicates: [], edges: [], layers: [] };

  for (const dep of own.imports ?? []) {
    const sub = loadLayer(dep, seen);
    if (sub.own.schemaVersion !== own.schemaVersion) {
      throw new Error(
        `${layer}.json is schemaVersion ${own.schemaVersion} but imports ${dep}.json at ` +
        `${sub.own.schemaVersion}. A document validated against one would be checked against ` +
        `classes from the other; bring them to the same version before importing.`);
    }
    if (sub.own.namespace !== own.namespace) {
      throw new Error(
        `${layer}.json namespace ${own.namespace} differs from imported ${dep}.json ` +
        `${sub.own.namespace}. Imported class IRIs would not resolve.`);
    }
    imported.layers.push(dep, ...sub.imported.layers);
    imported.classes.push(...sub.own.classes, ...sub.imported.classes);
    imported.predicates.push(...sub.own.predicates, ...sub.imported.predicates);
    imported.edges.push(...sub.own.edges, ...sub.imported.edges);
  }

  // An imported id that the layer also declares is a genuine conflict, not an override: two
  // definitions of one IRI, and nothing says which the store should keep.
  const ownIds = new Set(own.classes.map((c) => c.id));
  for (const c of imported.classes) {
    if (ownIds.has(c.id)) {
      throw new Error(
        `class "${c.id}" is declared in ${layer}.json and also imported. One IRI, two ` +
        `definitions -- rename one, or drop the local copy and rely on the import.`);
    }
  }

  return { own, imported };
}

/** Class and predicate lookup across a layer and everything it imports. */
export function scopeOf({ own, imported }) {
  const classes = new Map();
  for (const c of [...imported.classes, ...own.classes]) classes.set(c.id, c);
  const predicates = new Map();
  for (const p of [...imported.predicates, ...own.predicates]) predicates.set(p.predicate, p);
  return { classes, predicates, edges: [...imported.edges, ...own.edges] };
}

/** Which class ids a layer's own edges borrow from an import. */
export function borrowedClassIds({ own, imported }) {
  const ownIds = new Set(own.classes.map((c) => c.id));
  const importedIds = new Set(imported.classes.map((c) => c.id));
  const out = new Set();
  for (const e of own.edges) {
    for (const id of [e.source, e.target]) {
      if (!ownIds.has(id) && importedIds.has(id)) out.add(id);
    }
  }
  return [...out].sort();
}
