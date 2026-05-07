/**
 * store.js — Brain-Viz Global State & Event Bus
 * Extended: dimOpacity for filtered networks, dimNodeIds/dimEdgeIndices sets.
 */
"use strict";

window.BrainStore = (() => {

  const state = {
    data: null,
    adjacency: null,
    weightThreshold: 0.0,
    activeCommunities: new Set(),
    hemisphereFilter: "both",
    showCrossHemisphere: true,
    hoveredNode: null,
    selectedNodes: [],
    pathNodes: [],
    pathEdgeSet: new Set(),
    visibleEdgeIndices: new Set(),
    visibleNodeIds: new Set(),
    dimNodeIds: new Set(),       // nodes NOT in active filter (shown at dim opacity)
    dimEdgeIndices: new Set(),   // edges for dim nodes (shown at dim opacity)
    dimOpacity: 0.08,            // [0, 0.5] — opacity of filtered-out elements
    colorMode: "community",
    edgeSizeMode: "weight",
    layout2D: "circular",
  };

  const subs = {};
  function on(event, fn) {
    (subs[event] = subs[event] || []).push(fn);
    return () => { subs[event] = subs[event].filter(f => f !== fn); };
  }
  function emit(event, payload) {
    (subs[event] || []).forEach(fn => fn(payload));
  }

  function recompute() {
    const { data, weightThreshold, activeCommunities, hemisphereFilter } = state;
    if (!data) return;

    const { nodes, edges } = data;
    const nodeComm = new Map(nodes.map(n => [n.id, n.community]));
    const nodeHemi = new Map(nodes.map(n => [n.id, n.hemisphere]));

    const nodeActive = id => {
      if (activeCommunities.size > 0 && !activeCommunities.has(nodeComm.get(id))) return false;
      if (hemisphereFilter !== "both" && nodeHemi.get(id) !== hemisphereFilter) return false;
      return true;
    };

    // Active (fully visible) sets
    const visEdges = new Set();
    for (let i = 0; i < edges.length; i++) {
      const { source, target, weight } = edges[i];
      if (weight < weightThreshold) continue;
      if (!nodeActive(source) || !nodeActive(target)) continue;
      visEdges.add(i);
    }
    state.visibleEdgeIndices = visEdges;

    const visNodes = new Set();
    for (let i = 0; i < nodes.length; i++) {
      if (nodeActive(nodes[i].id)) visNodes.add(nodes[i].id);
    }
    state.visibleNodeIds = visNodes;

    // Dim (filtered-out) sets — shown at dimOpacity
    const dimNodes = new Set();
    for (let i = 0; i < nodes.length; i++) {
      if (!nodeActive(nodes[i].id)) dimNodes.add(nodes[i].id);
    }
    state.dimNodeIds = dimNodes;

    const dimEdges = new Set();
    for (let i = 0; i < edges.length; i++) {
      if (visEdges.has(i)) continue;
      const { source, target, weight } = edges[i];
      if (weight < weightThreshold) continue;
      dimEdges.add(i);
    }
    state.dimEdgeIndices = dimEdges;

    emit("filter:changed", {
      visibleEdgeIndices: visEdges,
      visibleNodeIds:     visNodes,
      dimNodeIds:         dimNodes,
      dimEdgeIndices:     dimEdges,
      dimOpacity:         state.dimOpacity,
    });
  }

  function init(data) {
    state.data       = data;
    state.adjacency  = BrainAlgorithms.buildAdjacency(data.edges, data.nodes.length);
    state.activeCommunities = new Set(data.communities.map(c => c.id));
    state.weightThreshold   = 0;
    state.hemisphereFilter  = "both";
    recompute();
    emit("data:loaded", data);
  }

  function setWeightThreshold(val) { state.weightThreshold = Math.max(0, Math.min(1, val)); recompute(); }

  function toggleCommunity(communityId) {
    if (state.activeCommunities.has(communityId)) {
      state.activeCommunities.delete(communityId);
      // Allow all to be deselected — dim shows them
    } else {
      state.activeCommunities.add(communityId);
    }
    recompute();
  }

  function setAllCommunities(active) {
    if (active) {
      state.activeCommunities = new Set(state.data.communities.map(c => c.id));
    } else {
      state.activeCommunities = new Set();
    }
    recompute();
  }

  function isolateCommunity(communityId) {
    state.activeCommunities = new Set([communityId]);
    recompute();
  }

  function setHemisphere(hemi) { state.hemisphereFilter = hemi; recompute(); }

  function setColorMode(mode) { state.colorMode = mode; emit("colorMode:changed", mode); }

  function setDimOpacity(val) {
    state.dimOpacity = Math.max(0, Math.min(0.5, val));
    emit("dimOpacity:changed", state.dimOpacity);
    recompute(); // re-emit filter:changed with updated dimOpacity
  }

  function hoverNode(nodeId) {
    if (state.hoveredNode === nodeId) return;
    state.hoveredNode = nodeId;
    emit("node:hover", nodeId);
  }

  function clickNode(nodeId) {
    if (state.selectedNodes.length === 0) {
      state.selectedNodes  = [nodeId];
      state.pathNodes      = [];
      state.pathEdgeSet    = new Set();
      emit("node:selected", { nodes: [nodeId], phase: "source" });
    } else if (state.selectedNodes.length === 1) {
      if (state.selectedNodes[0] === nodeId) { resetPath(); return; }
      state.selectedNodes = [state.selectedNodes[0], nodeId];
      const result = BrainAlgorithms.dijkstra(
        state.selectedNodes[0], state.selectedNodes[1],
        state.adjacency, state.data.nodes.length
      );
      if (result.found) {
        state.pathNodes  = result.path;
        const edgeSet    = new Set();
        for (let i = 0; i < result.path.length - 1; i++) {
          const a = Math.min(result.path[i], result.path[i+1]);
          const b = Math.max(result.path[i], result.path[i+1]);
          edgeSet.add(`${a}-${b}`);
        }
        state.pathEdgeSet = edgeSet;
        emit("path:found", { ...result, nodes: state.selectedNodes });
      } else {
        emit("path:notfound", { nodes: state.selectedNodes });
      }
      emit("node:selected", { nodes: state.selectedNodes, phase: "destination" });
    } else {
      resetPath();
    }
  }

  function resetPath() {
    state.selectedNodes = [];
    state.pathNodes     = [];
    state.pathEdgeSet   = new Set();
    emit("path:reset", null);
  }

  function isPathEdge(a, b) {
    const lo = Math.min(a, b), hi = Math.max(a, b);
    return state.pathEdgeSet.has(`${lo}-${hi}`);
  }

  function getState() { return state; }
  function getData()  { return state.data; }

  return {
    on, emit, init, getState, getData,
    setWeightThreshold, toggleCommunity, setAllCommunities, isolateCommunity,
    setHemisphere, setColorMode, setDimOpacity,
    hoverNode, clickNode, resetPath, isPathEdge,
  };
})();