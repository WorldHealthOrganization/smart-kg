---
title: Explorer
nav_order: 3
---

# Explorer
{: .no_toc }

Every class in the type graph is a node; every **licensed edge** is an arrow — an instance of the
source class may point at an instance of the target with that predicate. Click a node for its
properties and edges. Filter by layer, predicate or text, or ask the model a question in SPARQL
below. Nothing here is DAK data; it is the schema.

<div id="kg-explorer" markdown="0">
  <div class="kg-stage">
  <div class="kg-toolbar">
    <fieldset id="kg-layers" class="kg-layers"><legend>Layers</legend></fieldset>
    <label>Predicate
      <select id="kg-predicate"><option value="">all</option></select>
    </label>
    <label>Find
      <input id="kg-search" type="search" placeholder="class, id or property">
    </label>
    <label class="kg-check"><input id="kg-labels" type="checkbox"> edge labels</label>
    <button id="kg-zoom-in" type="button" class="btn" title="Zoom in" aria-label="Zoom in">+</button>
    <button id="kg-zoom-out" type="button" class="btn" title="Zoom out" aria-label="Zoom out">−</button>
    <button id="kg-fit" type="button" class="btn">Fit</button>
    <button id="kg-full" type="button" class="btn" title="Full screen" aria-label="Full screen">⛶</button>
    <button id="kg-reset" type="button" class="btn">Reset</button>
  </div>
  <div class="kg-main">
    <div id="kg-cy" aria-label="Class graph"></div>
    <aside id="kg-detail"><p class="kg-hint">Click a class to see its properties and licensed edges.</p></aside>
  </div>
  <p id="kg-status" class="kg-status"></p>
  </div>

  <h2 id="sparql">Query the ontology (SPARQL)</h2>
  <p>Runs in your browser with <a href="https://github.com/oxigraph/oxigraph">Oxigraph</a> over
  <a href="assets/kg/all.ttl"><code>all.ttl</code></a>, the merged Turtle export. Licensed edges are
  <code>rdfs:subPropertyOf</code> a predicate, with the source class as <code>rdfs:domain</code> and
  the target as <code>rdfs:range</code>. Class IRIs in a result are highlighted in the graph above.</p>
  <div class="kg-toolbar">
    <label>Example
      <select id="kg-examples"></select>
    </label>
    <button id="kg-run" type="button" class="btn btn-primary">Run</button>
    <span id="kg-sparql-status" class="kg-status"></span>
  </div>
  <textarea id="kg-query" spellcheck="false" rows="10" aria-label="SPARQL query"></textarea>
  <div id="kg-results"></div>
</div>

<link rel="stylesheet" href="assets/kg/explorer.css">
<script src="https://cdnjs.cloudflare.com/ajax/libs/cytoscape/3.33.1/cytoscape.min.js"></script>
<script type="module" src="assets/kg/explorer.js"></script>
