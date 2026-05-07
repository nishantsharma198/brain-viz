/**
 * graph2d.js — Brain-Viz D3.js 2D Topological View
 *
 * Upgrades integrated:
 *  - Upgrade 7: Chord diagram mode (toggle with btn-2d-layout)
 *  - Upgrade 8: Shared tooltip (tooltip also driven from brain3d screen-space,
 *               but 2D keeps its own mouseover logic for when 3D is hidden)
 *  - General: dark-mode-aware SVG background reacts to CSS variable changes
 */

"use strict";

window.Graph2D = (() => {

  // ── Config ──────────────────────────────────────────────────────────────────
  const CFG = {
    MARGIN:        { top: 18, right: 18, bottom: 18, left: 18 },
    NODE_RADIUS:   6,
    NODE_HOVER_R:  10,
    NODE_SELECT_R: 12,
    EDGE_OPACITY:  0.30,
    EDGE_HOVER_OP: 0.90,
    EDGE_DIM_OP:   0.04,
    EDGE_WIDTH:    1.2,
    EDGE_HOVER_W:  2.5,
    PATH_COLOR:    "#FFB703",
    PATH_WIDTH:    3.5,
    LABEL_SIZE:    10,
    BUNDLE_BETA:   0.82,
    ANIM_DURATION: 250,
  };

  // ── Module state ─────────────────────────────────────────────────────────────
  let svg, g, edgeLayer, nodeLayer, labelLayer;
  let width = 0, height = 0, radius = 0;
  let nodeData         = [];
  let edgeData         = [];
  let communities      = [];
  let communityColorMap = {};
  let angleMap         = new Map();
  let posMap           = new Map();
  let visibleEdgeIndices = new Set();
  let visibleNodeIds     = new Set();
  let hoveredId    = null;
  let selectedIds  = new Set();
  let pathNodeSet  = new Set();
  let pathEdgeKeySet = new Set();
  let colorMode    = "community";
  let degreeBounds = { min: 0, max: 1 };
  let bcBounds     = { min: 0, max: 1 };
  let container;
  let resizeObserver;

  // Upgrade 7 — layout toggle
  let currentLayout = "circular";   // "circular" | "chord"

  // ── Init ──────────────────────────────────────────────────────────────────────
  function init(containerId) {
    container = document.getElementById(containerId);
    _createSVG();
    _bindStore();
    resizeObserver = new ResizeObserver(() => _resize());
    resizeObserver.observe(container);
  }

  function _createSVG() {
    container.innerHTML = "";
    const rect = container.getBoundingClientRect();
    width  = rect.width  || 400;
    height = rect.height || 400;
    radius = (Math.min(width, height) / 2) - Math.max(CFG.MARGIN.top, 48);

    svg = d3.select(container)
      .append("svg")
      .attr("width",   "100%")
      .attr("height",  "100%")
      .attr("viewBox", `0 0 ${width} ${height}`);

    // Gradient background (reacts to dark mode via CSS opacity trick)
    const defs = svg.append("defs");
    const rg = defs.append("radialGradient").attr("id", "bg-grad-2d")
      .attr("cx","50%").attr("cy","50%").attr("r","50%");
    rg.append("stop").attr("offset","0%").attr("stop-color","#FFFFFF").attr("stop-opacity","0.05");
    rg.append("stop").attr("offset","100%").attr("stop-color","#8899CC").attr("stop-opacity","0.06");

    svg.append("rect").attr("class","svg-bg")
      .attr("width","100%").attr("height","100%").attr("fill","transparent");

    g = svg.append("g").attr("transform", `translate(${width / 2},${height / 2})`);
    edgeLayer  = g.append("g").attr("class","edge-layer");
    nodeLayer  = g.append("g").attr("class","node-layer");
    labelLayer = g.append("g").attr("class","label-layer");

    // Click on blank SVG → reset path
    svg.on("click", () => BrainStore.resetPath());
  }

  function _resize() {
    if (!nodeData.length) return;
    const rect = container.getBoundingClientRect();
    if (Math.abs(rect.width - width) < 10 && Math.abs(rect.height - height) < 10) return;
    width  = rect.width;
    height = rect.height;
    radius = (Math.min(width, height) / 2) - Math.max(CFG.MARGIN.top, 48);
    svg.attr("viewBox", `0 0 ${width} ${height}`);
    g.attr("transform", `translate(${width / 2},${height / 2})`);
    _redraw();
  }

  // ── Public layout toggle (Upgrade 7) ────────────────────────────────────────
  function toggleLayout() {
    currentLayout = currentLayout === "circular" ? "chord" : "circular";
    _redraw();
  }

  // ── Master redraw router ─────────────────────────────────────────────────────
  function _redraw() {
    // ← KEY FIX: wipe everything inside g before redrawing so chord and
    //   circular elements never stack on top of each other.
    g.selectAll("*").remove();
    edgeLayer  = g.append("g").attr("class","edge-layer");
    nodeLayer  = g.append("g").attr("class","node-layer");
    labelLayer = g.append("g").attr("class","label-layer");

    _computeLayout();
    if (currentLayout === "chord") {
      _renderChord();
    } else {
      _renderEdges();
      _renderNodes();
      _renderLabels();
      _renderCommunityArcs();
    }
  }

  // ── Circular Layout ──────────────────────────────────────────────────────────
  function _computeLayout() {
    angleMap.clear(); posMap.clear();
    const groups = {};
    for (const n of nodeData) {
      (groups[n.community] = groups[n.community] || []).push(n);
    }
    const communityIds = Object.keys(groups).map(Number).sort((a, b) => a - b);
    const total    = nodeData.length;
    const gapFrac  = 0.03;
    const totalGap = gapFrac * communityIds.length;
    let   angle    = -Math.PI / 2;

    for (const cid of communityIds) {
      const members = groups[cid];
      const arcFrac = (members.length / total) * (1 - totalGap);
      const arcLen  = arcFrac * 2 * Math.PI;
      const step    = arcLen / (members.length || 1);
      for (let i = 0; i < members.length; i++) {
        const a = angle + i * step;
        angleMap.set(members[i].id, a);
        posMap.set(members[i].id, {
          x: Math.cos(a) * radius,
          y: Math.sin(a) * radius,
        });
      }
      angle += arcLen + gapFrac * 2 * Math.PI;
    }
  }

  // ── Bundled Bezier path ──────────────────────────────────────────────────────
  function _bundledPath(src, tgt) {
    const ps = posMap.get(src), pt = posMap.get(tgt);
    if (!ps || !pt) return "";
    const b   = CFG.BUNDLE_BETA;
    const cx1 = ps.x * (1 - b), cy1 = ps.y * (1 - b);
    const cx2 = pt.x * (1 - b), cy2 = pt.y * (1 - b);
    return `M ${ps.x} ${ps.y} C ${cx1} ${cy1}, ${cx2} ${cy2}, ${pt.x} ${pt.y}`;
  }

  // ── Circular render functions ────────────────────────────────────────────────
  function _renderEdges() {
    const visEdges = Array.from(visibleEdgeIndices).map(i => ({ ...edgeData[i], _idx: i }));

    const sel = edgeLayer.selectAll("path.brain-edge")
      .data(visEdges, d => `${d.source}-${d.target}`);

    sel.exit().remove();

    sel.enter()
      .append("path")
      .attr("class","brain-edge")
      .attr("fill","none")
      .attr("stroke-linecap","round")
      .merge(sel)
      .attr("d",              d => _bundledPath(d.source, d.target))
      .attr("stroke",         d => _edgeColor(d))
      .attr("stroke-width",   CFG.EDGE_WIDTH)
      .attr("stroke-opacity", CFG.EDGE_OPACITY)
      .attr("data-src",       d => d.source)
      .attr("data-tgt",       d => d.target);
  }

  function _renderNodes() {
    const visNodes = nodeData.filter(n => visibleNodeIds.has(n.id));

    const sel = nodeLayer.selectAll("circle.brain-node")
      .data(visNodes, d => d.id);

    sel.exit().remove();

    sel.enter()
      .append("circle")
      .attr("class","brain-node")
      .attr("cursor","pointer")
      .on("mouseenter", (evt, d) => BrainStore.hoverNode(d.id))
      .on("mouseleave", ()       => BrainStore.hoverNode(null))
      .on("click", (evt, d) => { evt.stopPropagation(); BrainStore.clickNode(d.id); })
      .merge(sel)
      .attr("cx",           d => posMap.get(d.id)?.x ?? 0)
      .attr("cy",           d => posMap.get(d.id)?.y ?? 0)
      .attr("r",            CFG.NODE_RADIUS)
      .attr("fill",         d => _nodeColor(d))
      .attr("stroke",       "white")
      .attr("stroke-width", 1.5);
  }

  function _renderLabels() {
    labelLayer.selectAll("*").remove();
    const visNodes = nodeData.filter(n => visibleNodeIds.has(n.id));
    if (visNodes.length > 60) return;

    labelLayer.selectAll("text.brain-label")
      .data(visNodes, d => d.id)
      .enter()
      .append("text")
      .attr("class","brain-label")
      .attr("x", d => (posMap.get(d.id) || { x: 0 }).x * 1.1)
      .attr("y", d => (posMap.get(d.id) || { y: 0 }).y * 1.1 + 3)
      .attr("text-anchor", d => {
        const p = posMap.get(d.id) || { x: 0 };
        return p.x > 5 ? "start" : p.x < -5 ? "end" : "middle";
      })
      .attr("font-size",   CFG.LABEL_SIZE)
      .attr("font-family", "'IBM Plex Mono',monospace")
      .attr("fill",        "#888")
      .attr("pointer-events","none")
      .text(d => d.label.replace(/^[LR]-/,"").slice(0, 14));
  }

  function _renderCommunityArcs() {
    g.selectAll(".comm-arc,.comm-arc-label").remove();
    const arcR = radius + 16;
    const groups = {};
    for (const n of nodeData) {
      if (!visibleNodeIds.has(n.id)) continue;
      (groups[n.community] = groups[n.community] || []).push(n.id);
    }
    for (const [cid, ids] of Object.entries(groups)) {
      const angles = ids.map(id => angleMap.get(id)).filter(a => a !== undefined).sort((a, b) => a - b);
      if (!angles.length) continue;
      const startA = angles[0] - 0.04;
      const endA   = angles[angles.length - 1] + 0.04;
      const midA   = (startA + endA) / 2;
      const color  = communityColorMap[parseInt(cid)] || "#888";

      g.append("path").attr("class","comm-arc")
        .attr("d", d3.arc()({ innerRadius: arcR, outerRadius: arcR + 5,
          startAngle: startA + Math.PI / 2, endAngle: endA + Math.PI / 2 }))
        .attr("fill", color).attr("opacity", 0.75);

      g.append("text").attr("class","comm-arc-label")
        .attr("x", Math.cos(midA) * (arcR + 14))
        .attr("y", Math.sin(midA) * (arcR + 14))
        .attr("text-anchor","middle").attr("dominant-baseline","middle")
        .attr("font-size", 9).attr("font-family","'IBM Plex Mono',monospace")
        .attr("fill", color).attr("font-weight","600")
        .text((communities.find(c => c.id === parseInt(cid))?.name || `Net-${cid}`).slice(0, 10));
    }
  }

  // ── Upgrade 7: Chord Diagram ─────────────────────────────────────────────────
  /**
   * Aggregates edge weights into a community × community flow matrix and renders
   * a D3 chord diagram. Hovering an arc highlights all ribbons for that network.
   */
  function _renderChord() {
    // Clear circular elements
    edgeLayer.selectAll("*").remove();
    nodeLayer.selectAll("*").remove();
    labelLayer.selectAll("*").remove();
    g.selectAll(".comm-arc,.comm-arc-label,.chord-group,.chord-ribbon,.chord-label").remove();

    const nc   = communities.length;
    const flow = Array.from({ length: nc }, () => new Array(nc).fill(0));

    // Build community-level symmetric flow matrix
    for (const i of visibleEdgeIndices) {
      const e  = edgeData[i];
      if (!e) continue;
      const cs = nodeData[e.source]?.community;
      const ct = nodeData[e.target]?.community;
      if (cs === undefined || ct === undefined) continue;
      flow[cs][ct] += e.weight;
      if (cs !== ct) flow[ct][cs] += e.weight;
    }

    const chordLayout = d3.chord().padAngle(0.04).sortSubgroups(d3.descending)(flow);
    const innerR = radius * 0.72;
    const outerR = radius * 0.80;
    const arc    = d3.arc().innerRadius(innerR).outerRadius(outerR);
    const ribbon = d3.ribbon().radius(innerR - 1);

    // ── Ribbons (behind arcs) ─────────────────────────────────────────────────
    const ribbonG = g.append("g").attr("class","chord-ribbon");
    ribbonG.selectAll("path")
      .data(chordLayout)
      .enter()
      .append("path")
      .attr("d",       ribbon)
      .attr("fill",    d => communityColorMap[d.source.index] || "#aaa")
      .attr("opacity", 0.45)
      .attr("stroke",  "none")
      .attr("data-src", d => d.source.index)
      .attr("data-tgt", d => d.target.index);

    // ── Arcs ─────────────────────────────────────────────────────────────────
    const arcG = g.append("g").attr("class","chord-group");
    const arcPaths = arcG.selectAll("g")
      .data(chordLayout.groups)
      .enter()
      .append("g");

    arcPaths.append("path")
      .attr("d",            arc)
      .attr("fill",         d => communityColorMap[d.index] || "#888")
      .attr("opacity",      0.88)
      .attr("stroke",       "white")
      .attr("stroke-width", 0.8)
      .style("cursor","pointer")
      .on("mouseenter", (evt, d) => {
        // Dim ribbons not connected to this arc
        ribbonG.selectAll("path")
          .attr("opacity", r =>
            (r.source.index === d.index || r.target.index === d.index) ? 0.80 : 0.06);
      })
      .on("mouseleave", () => {
        ribbonG.selectAll("path").attr("opacity", 0.45);
      });

    // ── Arc labels ───────────────────────────────────────────────────────────
    arcPaths.append("text")
      .attr("class","chord-label")
      .each(function(d) {
        d.angle = (d.startAngle + d.endAngle) / 2;
      })
      .attr("dy", "0.35em")
      .attr("transform", d => {
        const a   = (d.startAngle + d.endAngle) / 2 - Math.PI / 2;
        const r   = outerR + 14;
        const flip = a > 0;
        return `rotate(${a * 180 / Math.PI}) translate(${r},0) ${flip ? "rotate(180)" : ""}`;
      })
      .attr("text-anchor", d => {
        const a = (d.startAngle + d.endAngle) / 2 - Math.PI / 2;
        return a > 0 ? "end" : "start";
      })
      .attr("font-size",   9.5)
      .attr("font-family", "'IBM Plex Mono',monospace")
      .attr("fill",        d => communityColorMap[d.index] || "#888")
      .attr("font-weight", "600")
      .attr("pointer-events","none")
      .text(d => (communities[d.index]?.name || `Net-${d.index}`).slice(0, 10));

    // ── Center label ─────────────────────────────────────────────────────────
    g.selectAll(".chord-center-label").remove();
    g.append("text").attr("class","chord-center-label")
      .attr("text-anchor","middle").attr("dominant-baseline","middle")
      .attr("font-size", 10).attr("font-family","'IBM Plex Mono',monospace")
      .attr("fill","#8899CC").attr("y", -8)
      .text("Network");
    g.append("text").attr("class","chord-center-label")
      .attr("text-anchor","middle").attr("dominant-baseline","middle")
      .attr("font-size", 10).attr("font-family","'IBM Plex Mono',monospace")
      .attr("fill","#8899CC").attr("y", 8)
      .text("Connectivity");
  }

  // ── Color helpers ────────────────────────────────────────────────────────────
  function _edgeColor(d) {
    const sc = communityColorMap[nodeData[d.source]?.community] || "#aaa";
    const tc = communityColorMap[nodeData[d.target]?.community] || "#aaa";
    return sc === tc ? sc : d3.interpolateRgb(sc, tc)(0.5);
  }

  function _nodeColor(n) {
    if (colorMode === "community")  return communityColorMap[n.community] || "#888";
    if (colorMode === "degree") {
      const t = (n.degree - degreeBounds.min) / (degreeBounds.max - degreeBounds.min + 1);
      return d3.interpolateRgb("#2EC4B6","#E63946")(t);
    }
    if (colorMode === "betweenness") {
      const t = (n.betweenness - bcBounds.min) / (bcBounds.max - bcBounds.min + 1);
      return d3.interpolateRgb("#118AB2","#FFD166")(t);
    }
    return "#888";
  }

  // ── Tooltip helper ──────────────────────────────────────────────────────────
  function _updateTooltip(nodeId) {
    const tip = document.getElementById("node-tooltip");
    if (!tip) return;
    if (nodeId === null) { tip.style.display = "none"; return; }
    const node = nodeData.find(n => n.id === nodeId);
    if (!node) return;
    const comm = communities.find(c => c.id === node.community);
    tip.innerHTML = `
      <strong>${node.label}</strong><br>
      Network: <span style="color:${comm?.color || '#888'}">${comm?.name || '?'}</span><br>
      Degree: ${node.degree}&nbsp;|&nbsp;Strength: ${node.strength.toFixed(2)}<br>
      Betweenness: ${(node.betweenness * 100).toFixed(1)}%
    `;
    tip.style.display = "block";
  }

  // ── Highlight helpers ────────────────────────────────────────────────────────
  function _applyHoverHighlight(nodeId) {
    if (currentLayout === "chord") return;   // chord handles its own hover
    const nbrs = nodeId !== null
      ? BrainAlgorithms.getNeighbors(nodeId, BrainStore.getState().adjacency)
      : new Set();

    nodeLayer.selectAll("circle.brain-node")
      .attr("r", d => d.id === nodeId ? CFG.NODE_HOVER_R : CFG.NODE_RADIUS)
      .attr("opacity", d => {
        if (nodeId === null) return 1;
        return (d.id === nodeId || nbrs.has(d.id)) ? 1 : 0.25;
      });

    edgeLayer.selectAll("path.brain-edge")
      .attr("stroke-opacity", d => {
        if (nodeId === null) return CFG.EDGE_OPACITY;
        return (d.source === nodeId || d.target === nodeId) ? CFG.EDGE_HOVER_OP : CFG.EDGE_DIM_OP;
      })
      .attr("stroke-width", d => {
        if (nodeId === null) return CFG.EDGE_WIDTH;
        return (d.source === nodeId || d.target === nodeId) ? CFG.EDGE_HOVER_W : CFG.EDGE_WIDTH;
      });

    _updateTooltip(nodeId);
  }

  function _applySelectionHighlight() {
    if (currentLayout === "chord") return;
    nodeLayer.selectAll("circle.brain-node")
      .attr("r",            d => selectedIds.has(d.id) ? CFG.NODE_SELECT_R : CFG.NODE_RADIUS)
      .attr("stroke",       d => selectedIds.has(d.id) ? CFG.PATH_COLOR : "white")
      .attr("stroke-width", d => selectedIds.has(d.id) ? 2.5 : 1.5);
  }

  function _applyPathHighlight() {
    if (currentLayout === "chord") return;
    nodeLayer.selectAll("circle.brain-node")
      .attr("r", d => {
        if (selectedIds.has(d.id)) return CFG.NODE_SELECT_R;
        if (pathNodeSet.has(d.id)) return CFG.NODE_HOVER_R;
        return CFG.NODE_RADIUS * 0.75;
      })
      .attr("fill", d =>
        (pathNodeSet.has(d.id) || selectedIds.has(d.id)) ? CFG.PATH_COLOR : _nodeColor(d))
      .attr("opacity", d =>
        (pathNodeSet.has(d.id) || selectedIds.has(d.id)) ? 1 : 0.25);

    edgeLayer.selectAll("path.brain-edge")
      .attr("stroke", d => {
        const lo = Math.min(d.source, d.target), hi = Math.max(d.source, d.target);
        return pathEdgeKeySet.has(`${lo}-${hi}`) ? CFG.PATH_COLOR : _edgeColor(d);
      })
      .attr("stroke-opacity", d => {
        const lo = Math.min(d.source, d.target), hi = Math.max(d.source, d.target);
        return pathEdgeKeySet.has(`${lo}-${hi}`) ? 0.95 : CFG.EDGE_DIM_OP;
      })
      .attr("stroke-width", d => {
        const lo = Math.min(d.source, d.target), hi = Math.max(d.source, d.target);
        return pathEdgeKeySet.has(`${lo}-${hi}`) ? CFG.PATH_WIDTH : CFG.EDGE_WIDTH;
      });
  }

  function _resetHighlight() {
    if (currentLayout === "chord") return;
    nodeLayer.selectAll("circle.brain-node")
      .attr("r", CFG.NODE_RADIUS).attr("fill", d => _nodeColor(d))
      .attr("stroke","white").attr("stroke-width",1.5).attr("opacity",1);
    edgeLayer.selectAll("path.brain-edge")
      .attr("stroke",         d => _edgeColor(d))
      .attr("stroke-opacity", CFG.EDGE_OPACITY)
      .attr("stroke-width",   CFG.EDGE_WIDTH);
  }

  // ── Store Bindings ───────────────────────────────────────────────────────────
  function _bindStore() {
    BrainStore.on("data:loaded", data => _loadData(data));

    BrainStore.on("filter:changed", ({ visibleEdgeIndices: ve, visibleNodeIds: vn }) => {
      visibleEdgeIndices = ve;
      visibleNodeIds     = vn;
      _redraw();
    });

    BrainStore.on("node:hover", nodeId => {
      hoveredId = nodeId;
      _applyHoverHighlight(nodeId);
    });

    BrainStore.on("node:selected", ({ nodes }) => {
      selectedIds = new Set(nodes);
      _applySelectionHighlight();
    });

    BrainStore.on("path:found", ({ path }) => {
      pathNodeSet    = new Set(path);
      const st       = BrainStore.getState();
      pathEdgeKeySet = st.pathEdgeSet;
      selectedIds    = new Set(st.selectedNodes);
      _applyPathHighlight();
    });

    BrainStore.on("path:reset", () => {
      pathNodeSet.clear(); pathEdgeKeySet.clear(); selectedIds.clear();
      _resetHighlight();
      _renderEdges(); _renderNodes();
    });

    BrainStore.on("colorMode:changed", mode => {
      colorMode = mode;
      if (currentLayout === "chord") _renderChord();
      else { _renderEdges(); _renderNodes(); }
    });
  }

  function _loadData(data) {
    nodeData          = data.nodes;
    edgeData          = data.edges;
    communities       = data.communities;
    communityColorMap = Object.fromEntries(data.communities.map(c => [c.id, c.color]));

    const degrees = nodeData.map(n => n.degree);
    const bcs     = nodeData.map(n => n.betweenness);
    degreeBounds  = { min: Math.min(...degrees), max: Math.max(...degrees) };
    bcBounds      = { min: Math.min(...bcs),     max: Math.max(...bcs) };

    visibleEdgeIndices = BrainStore.getState().visibleEdgeIndices;
    visibleNodeIds     = BrainStore.getState().visibleNodeIds;

    _resize();
    _computeLayout();
    _redraw();
  }

  // ── Public API ───────────────────────────────────────────────────────────────
  return { init, toggleLayout, getLayout: () => currentLayout };

})();