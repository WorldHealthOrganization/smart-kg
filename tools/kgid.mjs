#!/usr/bin/env node
// The identity scheme. One place, because two tools minting ids for the same thing is how a graph
// quietly splits in half.
//
// The rule that matters: AN ARTEFACT HAS ONE ADDRESS ACROSS LAYERS. The L1 extractor emits an
// `external-artifact` node for a DMN table and the L2 extractor emits a `decision-table` node for
// the same file; both call artifactId() and both get the same IRI, so loading the two documents
// into one store yields one node described at two layers rather than two nodes describing one file.

import { createHash } from "node:crypto";

export const sha256 = (b) => createHash("sha256").update(b).digest("hex");

/** A stable short hash for content-addressed nodes (citations, recovered names). */
export const shortHash = (s) => sha256(Buffer.from(s)).slice(0, 12);

/** Lowercase, hyphenated, punctuation-stripped. For names used inside an IRI path segment. */
export const slug = (s) =>
  String(s).normalize("NFKD").replace(/[̀-ͯ]/g, "")
    .toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

/**
 * The DAK namespace a file belongs to.
 *
 * BPMN carries targetNamespace="http://smart.who.int/base/bpmn" and DMN carries
 * namespace="http://smart.who.int/immunizations". The trailing format segment on the BPMN one is
 * a serialisation detail, not a different DAK, and leaving it in would file a DAK's BPMN and its
 * DMN under two namespaces.
 */
export const dakNamespace = (raw) =>
  String(raw ?? "urn:unknown").replace(/\/$/, "").replace(/\/(bpmn|dmn|cql|fsh)$/i, "");

/** A file a DAK ships. Shared by l1:external-artifact and its l2 elaboration. */
export const artifactId = (ns, fileId) => `${ns}/artifact/${fileId}`;

/** An element inside a file. BPMN and DMN ids are file-scoped, so the file IRI is the scope. */
export const elementId = (ns, fileId, id) => `${artifactId(ns, fileId)}#${id}`;

/** A citation string. Content-addressed: many rules citing one source get one node. */
export const citationId = (ns, text) => `${ns}/citation/${shortHash(text)}`;

/** A role, defined once and referenced by name from every process that involves it. */
export const personaId = (ns, name) => `${ns}/persona/${slug(name)}`;

/** A named item of information a decision reads. */
export const dataElementId = (ns, name) => `${ns}/data-element/${slug(name)}`;
