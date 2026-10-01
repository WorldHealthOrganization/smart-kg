#!/usr/bin/env node
// The identity scheme. One place, because two tools minting ids for the same thing is how a graph
// quietly splits in half.
//
// The rule that matters: AN ARTEFACT HAS ONE ADDRESS ACROSS LAYERS. The citation extractor emits an
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
export const dakNamespace = (raw) => {
  const ns = String(raw ?? "urn:unknown").replace(/\/$/, "").replace(/\/(bpmn|dmn|cql|fsh)$/i, "");
  // smart-base's own files disagree about scheme: dak.json declares
  // https://smart.who.int/base while the BPMN's targetNamespace is http://smart.who.int/base/bpmn
  // and the DMN's is http://smart.who.int/immunizations. An IRI is an identity key, so two schemes
  // for one authority split every persona and every artefact into two unconnected nodes. Normalise
  // to https for smart.who.int, and let the caller report that it happened -- normalisedScheme()
  // below exists so the inconsistency is surfaced upstream rather than quietly absorbed here.
  return ns.replace(/^http:\/\/(smart\.who\.int\b)/, "https://$1");
};

/** True when dakNamespace() had to rewrite the scheme -- worth reporting, not worth failing on. */
export const normalisedScheme = (raw) =>
  /^http:\/\/smart\.who\.int\b/.test(String(raw ?? ""));

/** A file a DAK ships. Shared by l2:external-artifact and its interior elaborations. */
export const artifactId = (ns, fileId) => `${ns}/artifact/${fileId}`;

/** An element inside a file. BPMN and DMN ids are file-scoped, so the file IRI is the scope. */
export const elementId = (ns, fileId, id) => `${artifactId(ns, fileId)}#${id}`;

/** A citation string. Content-addressed: many rules citing one source get one node. */
export const citationId = (ns, text) => `${ns}/citation/${shortHash(text)}`;

/** A role, defined once and referenced by name from every process that involves it. */
export const personaId = (ns, name) => `${ns}/persona/${slug(name)}`;

/** A named item of information a decision reads. */
export const dataElementId = (ns, name) => `${ns}/data-element/${slug(name)}`;

// ---- L1 ------------------------------------------------------------------------------------------
// L1 content is WHO's, not a DAK's: the ANC recommendations are cited by many DAKs, and minting them
// under each DAK's namespace would give every DAK its own copy. So L1 IRIs live under one WHO-wide
// namespace and are built from what WHO prints -- the ISBN, the published number -- so that two
// extractions of one guideline, by different people on different days, yield the same nodes.

export const L1_NAMESPACE = "https://smart.who.int/kg/l1";

/** Identifier types that may build a publication IRI, in order of preference. */
const IRI_IDENTIFIERS = ["isbn", "iris-handle", "doi", "issn"];

/** Strips everything an identifier is commonly printed with and keeps what identifies. */
const idValue = (type, value) => {
  const v = String(value).trim();
  if (type === "isbn" || type === "issn") return v.replace(/[^0-9Xx]/g, "").toUpperCase();
  return slug(v);
};

/**
 * A publication, from its typed identifiers: [{type: "isbn", value: "978-92-4-154991-2"}, …].
 * The first of isbn, iris-handle, doi, issn wins. A new edition carries a new ISBN and so is a new
 * publication, linked to the old one by supersedes -- renumbering between editions cannot collide.
 */
export const publicationId = (identifiers) => {
  for (const type of IRI_IDENTIFIERS) {
    const found = (identifiers ?? []).find((i) => i.type === type && i.value);
    if (found) return `${L1_NAMESPACE}/publication/${type}-${idValue(type, found.value)}`;
  }
  throw new Error("a publication needs an isbn, iris-handle, doi or issn to have a stable IRI");
};

/** A published number (A.1.1, PRV.3, 3.2) kept readable; anything outside [A-Za-z0-9.-] dropped. */
const num = (s) => String(s).trim().replace(/\s+/g, "-").replace(/[^A-Za-z0-9.\-]/g, "");

export const sectionId = (pub, number) => `${pub}/section/${num(number)}`;
/** An element by its printed label, and a row or footnote within it by position. */
export const publicationElementId = (pub, label, ...parts) =>
  [`${pub}/element/${slug(label)}`, ...parts.map((p) => slug(p))].join("/");
/** By published number; a recommendation with none is content-addressed by its statement. */
export const recommendationId = (pub, number, statement) =>
  `${pub}/recommendation/${number ? num(number) : "h-" + shortHash(norm(statement))}`;
export const subRecommendationId = (parent, letter) => `${parent}/${num(letter)}`;
export const remarkId = (rec, ordinal) => `${rec}/remark/${ordinal}`;
export const keyQuestionId = (pub, number) => `${pub}/key-question/${num(number)}`;
export const outcomeId = (pub, name) => `${pub}/outcome/${slug(name)}`;
export const evidenceId = (pub, keyQuestion, outcomeName) =>
  `${pub}/evidence/${num(keyQuestion)}/${slug(outcomeName)}`;
export const indicatorId = (pub, refNo) => `${pub}/indicator/${num(refNo)}`;
/** A catalogued intervention, from its catalogue code: UHC, ICHI or CDHI. */
export const healthInterventionId = (system, code) =>
  `${L1_NAMESPACE}/health-intervention/${slug(system)}-${num(code)}`;
/** A row of a DAK artefact's own reference list. DAK-side, so in the artefact's namespace. */
export const referenceEntryId = (artifact, number) => `${artifact}/reference/${num(number)}`;

/** Whitespace-normalised, NFC, for hashing and for quoting checks. Case is kept for hashing. */
export const normText = (s) => String(s ?? "").normalize("NFC").replace(/\s+/g, " ").trim();
/** Case-folded as well, for "is this slot quoted from the statement". */
export const norm = (s) => normText(s).toLowerCase();

/** The text a content node's hash covers: its contentFields, normalised and joined. Null when all
 *  are empty. Hash this with contentHash(). */
export const contentText = (node, fields) => {
  const parts = fields.map((f) => node.properties?.[f]).filter((v) => v !== undefined && v !== null);
  return parts.length ? parts.map(normText).join("\n") : null;
};

/** sha256 of the normalised content text. Unchanged hash on re-extraction: the node is current. */
export const contentHash = (text) => sha256(Buffer.from(text, "utf8"));
