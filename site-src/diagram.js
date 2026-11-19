// Pan-and-zoom viewer for the PlantUML diagrams on the schema pages.
//
// Each <div class="kg-diagram" data-src="..svg"> gets the SVG inlined (an <img> cannot be panned)
// and svg-pan-zoom on top, with buttons for zoom in, zoom out, fit, actual size and full screen.
// Without JavaScript the <noscript> image inside the div is what the reader sees.

const ZOOM_STEP = 1.3;

function button(label, title, onClick) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "btn kg-dbtn";
  b.textContent = label;
  b.title = title;
  b.setAttribute("aria-label", title);
  b.addEventListener("click", onClick);
  return b;
}

async function mount(host) {
  const src = host.dataset.src;
  const bar = document.createElement("div");
  bar.className = "kg-dbar";
  const view = document.createElement("div");
  view.className = "kg-dview";
  view.tabIndex = 0;
  view.setAttribute("role", "img");
  view.setAttribute("aria-label", host.dataset.alt || "class diagram");
  const hint = document.createElement("span");
  hint.className = "kg-dhint";
  hint.textContent = "Drag to pan · scroll, +/− or double-click to zoom";
  host.replaceChildren(bar, view);

  let svg;
  try {
    const text = await (await fetch(src)).text();
    view.innerHTML = text.slice(text.indexOf("<svg"));
    svg = view.querySelector("svg");
  } catch (e) {
    view.innerHTML = `<p>Could not load the diagram. <a href="${src}">Open the SVG</a>.</p>`;
    return;
  }
  // PlantUML writes fixed pixel sizes; the viewer needs the SVG to fill its box.
  svg.removeAttribute("width");
  svg.removeAttribute("height");
  svg.removeAttribute("style");
  svg.setAttribute("width", "100%");
  svg.setAttribute("height", "100%");

  const pz = svgPanZoom(svg, {
    zoomEnabled: true, panEnabled: true, controlIconsEnabled: false,
    mouseWheelZoomEnabled: true, dblClickZoomEnabled: true, preventMouseEventsDefault: true,
    zoomScaleSensitivity: 0.25, minZoom: 0.2, maxZoom: 25, fit: true, center: true,
  });
  const fit = () => { pz.resize(); pz.fit(); pz.center(); };
  const actual = () => {
    // 1:1 means one SVG unit per screen pixel, so the text is at the size PlantUML set it.
    pz.resize();
    pz.zoomBy(1 / pz.getSizes().realZoom);
    pz.center();
  };

  // Full screen where the browser allows it; where it refuses (an embedding iframe, some mobile
  // browsers) the viewer fills the window instead. Esc leaves either.
  const setMax = (on) => {
    host.classList.toggle("kg-full", on);
    document.body.classList.toggle("kg-noscroll", on);
    full.title = on ? "Exit full screen" : "Full screen";
    setTimeout(fit, 50);
  };
  const full = button("⛶", "Full screen", async () => {
    if (document.fullscreenElement) return document.exitFullscreen();
    if (host.classList.contains("kg-full")) return setMax(false);
    try { await host.requestFullscreen(); } catch { setMax(true); }
  });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && host.classList.contains("kg-full")) setMax(false); });
  bar.append(
    button("+", "Zoom in", () => pz.zoomBy(ZOOM_STEP)),
    button("−", "Zoom out", () => pz.zoomBy(1 / ZOOM_STEP)),
    button("Fit", "Fit to view", fit),
    button("1:1", "Actual size", actual),
    full,
  );
  const open = document.createElement("a");
  open.className = "btn kg-dbtn";
  open.href = src;
  open.target = "_blank";
  open.rel = "noopener";
  open.textContent = "SVG ↗";
  open.title = "Open the SVG on its own";
  bar.append(open, hint);

  view.addEventListener("keydown", (e) => {
    if (e.key === "+" || e.key === "=") pz.zoomBy(ZOOM_STEP);
    else if (e.key === "-" || e.key === "_") pz.zoomBy(1 / ZOOM_STEP);
    else if (e.key === "0") fit();
    else if (e.key.startsWith("Arrow")) {
      const d = 60, m = { ArrowLeft: [d, 0], ArrowRight: [-d, 0], ArrowUp: [0, d], ArrowDown: [0, -d] }[e.key];
      pz.panBy({ x: m[0], y: m[1] });
    } else return;
    e.preventDefault();
  });
  document.addEventListener("fullscreenchange", () => setMax(document.fullscreenElement === host));
  let t;
  window.addEventListener("resize", () => { clearTimeout(t); t = setTimeout(fit, 150); });
}

document.querySelectorAll(".kg-diagram[data-src]").forEach(mount);
