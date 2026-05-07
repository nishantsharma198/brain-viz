/**
 * brain3d.js  —  Brain-Viz  Three.js 3D Spatial View
 *
 * Changes in this version:
 *  - Dim rendering: filtered-out nodes/edges shown at dimOpacity instead of hidden
 *  - Separate dimNodesMesh + dimEdgesObject for clean per-group opacity
 *  - More realistic brain shell with aggressive lobe displacement
 *  - Lobe vertex colours with labels
 *  - Circular particle texture (no more yellow rectangle)
 *  - region:selected event for info panel
 */
"use strict";

window.Brain3D = (() => {

  const CFG = {
    BRAIN_SCALE:      { x: 1.05, y: 1.18, z: 1.35 },
    NODE_RADIUS:      0.022,
    NODE_HOVER_SCALE: 1.85,
    NODE_SEL_SCALE:   2.3,
    EDGE_OPACITY:     0.35,
    DIM_EDGE_OPACITY: 0.06,
    PATH_COLOR:       0xFFD700,
    PATH_GLOW:        0xFF8C00,
    BG_COLOR:         0xF5F7FC,
    AMBIENT:          1.8,
    FOV:              45,
    DIFF_A:           0x00E676,
    DIFF_B:           0xFF5252,
    DIFF_S:           0xBBBBBB,
    PARTICLE_COUNT:   14,
    PARTICLE_SPEED:   0.20,
  };

  // ── State ──────────────────────────────────────────────────────────────────
  let renderer, scene, camera, controls;
  let nodesMesh, dimNodesMesh;         // active + dim instanced meshes
  let edgesObject, dimEdgesObject;     // active + dim edge line segments
  let diffEdgesObject = null;
  let pathLine, pathGlow;
  let raycaster, pointer;
  let container, resizeObserver;
  let lastFrameTime = 0;

  let nodeData = [], edgeData = [], communityColors = [];
  let nodeColorMap  = new Map();
  let nodeScaleMap  = new Map();
  let visibleNodeIds   = new Set();
  let visibleEdgeIndices = new Set();
  let dimNodeIds    = new Set();
  let dimEdgeIndices = new Set();
  let dimOpacity    = 0.08;
  let hoveredId = null, lastHoverId = -1;
  let selectedIds   = new Set();
  let pathNodeSet   = new Set();
  let pathEdgeSet   = new Set();
  let colorMode     = "community";
  let degreeBounds  = { min:0, max:1 };
  let bcBounds      = { min:0, max:1 };
  let edgePositions, edgeColors;
  let dimEdgePositions, dimEdgeColors;

  // Particle state
  let pathParticles = null, particleT = 0;
  let pathSegments = [], pathTotalLen = 0;
  let particleTex = null;

  // ── MNI → Three.js axis mapping ─────────────────────────────────────────
  const S = 0.92;
  function _wp(n) {
    return new THREE.Vector3(
      n.x * CFG.BRAIN_SCALE.x * S,
      n.z * CFG.BRAIN_SCALE.y * S,
      n.y * CFG.BRAIN_SCALE.z * S
    );
  }
  function _wpa(n) {
    return [
      n.x * CFG.BRAIN_SCALE.x * S,
      n.z * CFG.BRAIN_SCALE.y * S,
      n.y * CFG.BRAIN_SCALE.z * S,
    ];
  }

  // ── Lobe classification (shell-space coords after scale) ─────────────────
  const LOBE_COLORS = {
    frontal:   new THREE.Color(0x3A86FF),
    parietal:  new THREE.Color(0x06D6A0),
    temporal:  new THREE.Color(0xFF6B35),
    occipital: new THREE.Color(0x9B5FE0),
    insula:    new THREE.Color(0xFFD166),
    central:   new THREE.Color(0x2EC4B6),
  };

  function _shellLobeColor(x, y, z) {
    if (z > 0.28)                              return LOBE_COLORS.frontal;
    if (z < -0.42)                             return LOBE_COLORS.occipital;
    if (y > 0.30 && z > -0.42)                return LOBE_COLORS.parietal;
    if (y < -0.06 && Math.abs(x) > 0.34)      return LOBE_COLORS.temporal;
    if (Math.abs(x) > 0.52 && y > -0.18)      return LOBE_COLORS.insula;
    return LOBE_COLORS.central;
  }

  function _getLobeNameForNode(node) {
    const z = node.y * CFG.BRAIN_SCALE.z;
    const y = node.z * CFG.BRAIN_SCALE.y;
    const x = node.x * CFG.BRAIN_SCALE.x;
    if (z > 0.28)                              return 'Frontal';
    if (z < -0.42)                             return 'Occipital';
    if (y > 0.30)                              return 'Parietal';
    if (y < -0.06 && Math.abs(x) > 0.34)      return 'Temporal';
    if (Math.abs(x) > 0.52 && y > -0.18)      return 'Insula';
    return 'Central';
  }

  // ── Brain geometry with realistic lobe displacement ──────────────────────
  function _makeBrainGeo(r, ws, hs, withLobeColors) {
    const geo = new THREE.SphereGeometry(r, ws, hs);
    const pos = geo.attributes.position;

    for (let i = 0; i < pos.count; i++) {
      let x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);

      // ── Superior (upward) bulge — cerebral hemispheres are tall ──────────
      if (y > 0) y *= 1.0 + 0.30 * y;
      else        y *= 1.0 - 0.12 * Math.abs(y);

      // ── Frontal lobe — projects forward (positive z in shell space) ───────
      if (z > 0) {
        x *= 1.0 + 0.12 * z;
        z *= 1.0 + 0.16 * z;
      }

      // ── Occipital — narrower and slightly projecting back ──────────────────
      if (z < -0.35) {
        x *= 1.0 - 0.10 * Math.abs(z);
        z *= 1.0 + 0.06 * Math.abs(z);
      }

      // ── Temporal lobes — hang down laterally ──────────────────────────────
      if (y < -0.10 && Math.abs(x) > 0.30) {
        x *= 1.0 + 0.14 * Math.abs(x);
        y *= 1.0 + 0.18 * Math.abs(y) * (Math.abs(x) - 0.30);
      }

      // ── Parietal — moderate superior-posterior expansion ──────────────────
      if (y > 0.20 && z > -0.40 && z < 0.10) {
        y *= 1.0 + 0.10 * y;
        x *= 1.0 + 0.04 * y;
      }

      pos.setXYZ(i, x, y, z);
    }
    geo.computeVertexNormals();

    if (withLobeColors) {
      const colors = new Float32Array(pos.count * 3);
      for (let i = 0; i < pos.count; i++) {
        const c = _shellLobeColor(pos.getX(i), pos.getY(i), pos.getZ(i));
        colors[i*3] = c.r; colors[i*3+1] = c.g; colors[i*3+2] = c.b;
      }
      geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    }
    return geo;
  }

  // ── Circular glow texture (fixes yellow rectangle) ───────────────────────
  function _makeCircleTex(hexColor) {
    const size = 64, c = size/2;
    const cv = document.createElement('canvas');
    cv.width = cv.height = size;
    const ctx = cv.getContext('2d');
    const col = new THREE.Color(hexColor);
    const r = Math.round(col.r*255), g = Math.round(col.g*255), b = Math.round(col.b*255);
    const grd = ctx.createRadialGradient(c,c,0, c,c,c);
    grd.addColorStop(0,    `rgba(${r},${g},${b},1.0)`);
    grd.addColorStop(0.35, `rgba(${r},${g},${b},0.85)`);
    grd.addColorStop(0.70, `rgba(${r},${g},${b},0.30)`);
    grd.addColorStop(1.0,  `rgba(${r},${g},${b},0.0)`);
    ctx.clearRect(0,0,size,size);
    ctx.fillStyle = grd;
    ctx.beginPath(); ctx.arc(c,c,c,0,Math.PI*2); ctx.fill();
    return new THREE.CanvasTexture(cv);
  }

  // ── Init ─────────────────────────────────────────────────────────────────
  function init(containerId) {
    container = document.getElementById(containerId);
    _setupRenderer(); _setupScene(); _setupCamera(); _setupControls();
    _setupLights(); _setupBrainShell(); _setupRaycaster();
    _bindEvents(); _bindStore(); _startLoop();
  }

  function _setupRenderer() {
    renderer = new THREE.WebGLRenderer({ antialias:true, alpha:false, preserveDrawingBuffer:true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(container.clientWidth, container.clientHeight);
    renderer.setClearColor(CFG.BG_COLOR, 1);
    container.appendChild(renderer.domElement);
    resizeObserver = new ResizeObserver(() => {
      renderer.setSize(container.clientWidth, container.clientHeight);
      camera.aspect = container.clientWidth / container.clientHeight;
      camera.updateProjectionMatrix();
    });
    resizeObserver.observe(container);
  }

  function _setupScene() {
    scene = new THREE.Scene();
    scene.fog = new THREE.FogExp2(CFG.BG_COLOR, 0.09);
  }

  function _setupCamera() {
    camera = new THREE.PerspectiveCamera(CFG.FOV,
      container.clientWidth / container.clientHeight, 0.1, 100);
    camera.position.set(0, 0.15, 3.8);
    camera.lookAt(0, 0, 0);
  }

  function _setupControls() {
    controls = new THREE.OrbitControls(camera, renderer.domElement);
    controls.enableDamping   = true;
    controls.dampingFactor   = 0.06;
    controls.minDistance     = 1.5;
    controls.maxDistance     = 8;
    controls.autoRotate      = false;
    controls.autoRotateSpeed = 0.5;
  }

  function _setupLights() {
    scene.add(new THREE.AmbientLight(0xffffff, CFG.AMBIENT));
    const d = new THREE.DirectionalLight(0xffffff, 0.9); d.position.set(2,4,3); scene.add(d);
    const f = new THREE.DirectionalLight(0xC8E0FF, 0.45); f.position.set(-3,-1,-4); scene.add(f);
    const p = new THREE.PointLight(0xffffff, 0.55, 12); p.position.set(0,3,1); scene.add(p);
  }

  function _setupBrainShell() {
    const grp = new THREE.Group();
    grp.scale.set(CFG.BRAIN_SCALE.x, CFG.BRAIN_SCALE.y, CFG.BRAIN_SCALE.z);

    // Outer lobe-coloured shell
    grp.add(new THREE.Mesh(_makeBrainGeo(1.0, 80, 60, true),
      new THREE.MeshPhongMaterial({
        vertexColors:      true,
        emissive:          new THREE.Color(0x0A1A2A),
        emissiveIntensity: 0.15,
        specular:          new THREE.Color(0xCCDDFF),
        shininess:         50,
        transparent:       true,
        opacity:           0.24,
        side:              THREE.FrontSide,
        depthWrite:        false,
      })));

    // Inner glow (back-face)
    grp.add(new THREE.Mesh(_makeBrainGeo(0.96, 48, 36, false),
      new THREE.MeshPhongMaterial({
        color:             new THREE.Color(0x4488BB),
        emissive:          new THREE.Color(0x001133),
        emissiveIntensity: 0.28,
        transparent:       true,
        opacity:           0.07,
        side:              THREE.BackSide,
        depthWrite:        false,
      })));

    // Wireframe (subtle gyri hint)
    grp.add(new THREE.Mesh(_makeBrainGeo(1.003, 30, 22, false),
      new THREE.MeshBasicMaterial({
        color:      0x7799BB,
        wireframe:  true,
        transparent:true,
        opacity:    0.055,
        depthWrite: false,
      })));

    scene.add(grp);

    // Interhemispheric fissure
    const fissure = new THREE.Mesh(
      new THREE.PlaneGeometry(0.015, 2.2),
      new THREE.MeshBasicMaterial({
        color:0x000B1E, transparent:true, opacity:0.55,
        side:THREE.DoubleSide, depthWrite:false,
      })
    );
    fissure.rotation.y = Math.PI / 2;
    fissure.position.set(0, 0.06, 0);
    fissure.scale.set(CFG.BRAIN_SCALE.z * 1.18, CFG.BRAIN_SCALE.y * 0.97, 1);
    scene.add(fissure);
  }

  function _setupRaycaster() {
    raycaster = new THREE.Raycaster();
    raycaster.params.Points = { threshold: 0.05 };
    pointer = new THREE.Vector2(-999, -999);
  }

  // ── Data loading ─────────────────────────────────────────────────────────
  function loadData(data) {
    nodeData        = data.nodes;
    edgeData        = data.edges;
    communityColors = data.communities.map(c => c.color);
    const degs      = nodeData.map(n => n.degree);
    const bcs       = nodeData.map(n => n.betweenness);
    degreeBounds    = { min:Math.min(...degs), max:Math.max(...degs) };
    bcBounds        = { min:Math.min(...bcs),  max:Math.max(...bcs)  };
    clearDiff();
    _buildNodeColors();
    _buildNodes();
    _buildEdges();
    _buildPathLine();
  }

  function _buildNodeColors() {
    nodeColorMap.clear(); nodeScaleMap.clear();
    nodeData.forEach(n => {
      nodeColorMap.set(n.id, _nodeColor(n));
      nodeScaleMap.set(n.id, _nodeScale(n));
    });
  }

  function _nodeColor(n) {
    if (colorMode === "community")
      return new THREE.Color(communityColors[n.community] || "#888");
    if (colorMode === "degree") {
      const t = (n.degree - degreeBounds.min) / (degreeBounds.max - degreeBounds.min + 1);
      return new THREE.Color().lerpColors(new THREE.Color("#2EC4B6"), new THREE.Color("#E63946"), t);
    }
    const t = (n.betweenness - bcBounds.min) / (bcBounds.max - bcBounds.min + 1);
    return new THREE.Color().lerpColors(new THREE.Color("#118AB2"), new THREE.Color("#FFD166"), t);
  }

  function _nodeScale(n) {
    const r = degreeBounds.max - degreeBounds.min || 1;
    return 0.65 + (n.degree - degreeBounds.min) / r * 1.35;
  }

  // ── Build geometry ────────────────────────────────────────────────────────
  function _buildNodes() {
    if (nodesMesh)    { scene.remove(nodesMesh);    nodesMesh.geometry.dispose();    }
    if (dimNodesMesh) { scene.remove(dimNodesMesh); dimNodesMesh.geometry.dispose(); }

    const nGeo = new THREE.SphereGeometry(CFG.NODE_RADIUS, 12, 10);

    // Active nodes mesh
    nodesMesh = new THREE.InstancedMesh(nGeo,
      new THREE.MeshPhongMaterial({ shininess:90 }), nodeData.length);
    nodesMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    nodesMesh.instanceColor = new THREE.InstancedBufferAttribute(
      new Float32Array(nodeData.length * 3), 3);

    // Dim nodes mesh (same geometry, separate material with lower opacity)
    dimNodesMesh = new THREE.InstancedMesh(nGeo,
      new THREE.MeshPhongMaterial({ shininess:30, transparent:true, opacity: dimOpacity }),
      nodeData.length);
    dimNodesMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    dimNodesMesh.instanceColor = new THREE.InstancedBufferAttribute(
      new Float32Array(nodeData.length * 3), 3);
    dimNodesMesh.renderOrder = 0;

    const dummy = new THREE.Object3D();
    nodeData.forEach((n, i) => {
      const p = _wp(n);
      dummy.position.set(p.x, p.y, p.z);
      dummy.scale.setScalar(nodeScaleMap.get(n.id) || 1);
      dummy.updateMatrix();
      // Initially place all in active mesh
      nodesMesh.setMatrixAt(i, dummy.matrix);
      nodesMesh.setColorAt(i, nodeColorMap.get(n.id) || new THREE.Color(0x888888));
      // Dim mesh starts invisible
      dummy.scale.setScalar(0.001); dummy.updateMatrix();
      dimNodesMesh.setMatrixAt(i, dummy.matrix);
      dimNodesMesh.setColorAt(i, nodeColorMap.get(n.id) || new THREE.Color(0x888888));
    });
    nodesMesh.instanceMatrix.needsUpdate = true;
    nodesMesh.instanceColor.needsUpdate  = true;
    dimNodesMesh.instanceMatrix.needsUpdate = true;
    dimNodesMesh.instanceColor.needsUpdate  = true;
    nodesMesh.userData.isNodes = true;
    scene.add(nodesMesh);
    scene.add(dimNodesMesh);
  }

  function _buildEdges() {
    if (edgesObject)    { scene.remove(edgesObject);    edgesObject.geometry.dispose();    }
    if (dimEdgesObject) { scene.remove(dimEdgesObject); dimEdgesObject.geometry.dispose(); }

    const n = edgeData.length;
    edgePositions    = new Float32Array(n * 6);
    edgeColors       = new Float32Array(n * 6);
    dimEdgePositions = new Float32Array(n * 6);
    dimEdgeColors    = new Float32Array(n * 6);

    edgeData.forEach((e, i) => {
      const sp = _wpa(nodeData[e.source]);
      const tp = _wpa(nodeData[e.target]);
      const b  = i * 6;
      edgePositions[b]   = sp[0]; edgePositions[b+1] = sp[1]; edgePositions[b+2] = sp[2];
      edgePositions[b+3] = tp[0]; edgePositions[b+4] = tp[1]; edgePositions[b+5] = tp[2];
      dimEdgePositions[b]   = sp[0]; dimEdgePositions[b+1] = sp[1]; dimEdgePositions[b+2] = sp[2];
      dimEdgePositions[b+3] = tp[0]; dimEdgePositions[b+4] = tp[1]; dimEdgePositions[b+5] = tp[2];
      const cs = nodeColorMap.get(e.source) || new THREE.Color("#888");
      const ct = nodeColorMap.get(e.target) || new THREE.Color("#888");
      const cm = new THREE.Color().lerpColors(cs, ct, 0.5);
      edgeColors[b]=cm.r; edgeColors[b+1]=cm.g; edgeColors[b+2]=cm.b;
      edgeColors[b+3]=cm.r; edgeColors[b+4]=cm.g; edgeColors[b+5]=cm.b;
      dimEdgeColors[b]=cm.r; dimEdgeColors[b+1]=cm.g; dimEdgeColors[b+2]=cm.b;
      dimEdgeColors[b+3]=cm.r; dimEdgeColors[b+4]=cm.g; dimEdgeColors[b+5]=cm.b;
    });

    const eGeo = new THREE.BufferGeometry();
    eGeo.setAttribute("position", new THREE.BufferAttribute(edgePositions, 3));
    eGeo.setAttribute("color",    new THREE.BufferAttribute(edgeColors, 3));
    edgesObject = new THREE.LineSegments(eGeo, new THREE.LineBasicMaterial({
      vertexColors:true, transparent:true, opacity:CFG.EDGE_OPACITY, depthWrite:false
    }));
    scene.add(edgesObject);

    const dGeo = new THREE.BufferGeometry();
    dGeo.setAttribute("position", new THREE.BufferAttribute(dimEdgePositions, 3));
    dGeo.setAttribute("color",    new THREE.BufferAttribute(dimEdgeColors, 3));
    dimEdgesObject = new THREE.LineSegments(dGeo, new THREE.LineBasicMaterial({
      vertexColors:true, transparent:true, opacity:0, depthWrite:false
    }));
    scene.add(dimEdgesObject);
  }

  function _buildPathLine() {
    if (pathLine) { scene.remove(pathLine); pathLine.geometry.dispose(); }
    if (pathGlow) { scene.remove(pathGlow); pathGlow.geometry.dispose(); }
    const e = () => new THREE.BufferGeometry().setAttribute("position",
      new THREE.BufferAttribute(new Float32Array(0), 3));
    pathLine = new THREE.Line(e(), new THREE.LineBasicMaterial({color:CFG.PATH_COLOR, linewidth:3, depthWrite:true}));
    pathLine.renderOrder = 2; scene.add(pathLine);
    pathGlow = new THREE.Line(e(), new THREE.LineBasicMaterial({color:CFG.PATH_GLOW, linewidth:7, transparent:true, opacity:0.35, depthWrite:false}));
    pathGlow.renderOrder = 1; scene.add(pathGlow);
  }

  // ── Dim rendering update ─────────────────────────────────────────────────
  function _updateVisibility(payload) {
    visibleNodeIds     = payload.visibleNodeIds;
    visibleEdgeIndices = payload.visibleEdgeIndices;
    dimNodeIds         = payload.dimNodeIds || new Set();
    dimEdgeIndices     = payload.dimEdgeIndices || new Set();
    const dop          = payload.dimOpacity !== undefined ? payload.dimOpacity : dimOpacity;
    dimOpacity         = dop;

    // Update dim mesh opacity
    if (dimNodesMesh) dimNodesMesh.material.opacity = dop;
    if (dimEdgesObject) dimEdgesObject.material.opacity = dop * 0.7;

    _refreshNodePositions();
    _refreshEdgePositions();
  }

  function _refreshNodePositions() {
    if (!nodesMesh || !dimNodesMesh) return;
    const dummy = new THREE.Object3D();
    nodeData.forEach((n, i) => {
      const p    = _wp(n);
      const base = nodeScaleMap.get(n.id) || 1;
      dummy.position.set(p.x, p.y, p.z);

      if (visibleNodeIds.has(n.id)) {
        // Active: full size in nodesMesh, hidden in dimNodesMesh
        dummy.scale.setScalar(base); dummy.updateMatrix();
        nodesMesh.setMatrixAt(i, dummy.matrix);
        nodesMesh.setColorAt(i, nodeColorMap.get(n.id) || new THREE.Color("#888"));
        dummy.scale.setScalar(0.001); dummy.updateMatrix();
        dimNodesMesh.setMatrixAt(i, dummy.matrix);
      } else if (dimNodeIds.has(n.id)) {
        // Dim: hidden in nodesMesh, shown in dimNodesMesh
        dummy.scale.setScalar(0.001); dummy.updateMatrix();
        nodesMesh.setMatrixAt(i, dummy.matrix);
        dummy.scale.setScalar(base * 0.75); dummy.updateMatrix();
        dimNodesMesh.setMatrixAt(i, dummy.matrix);
        dimNodesMesh.setColorAt(i, nodeColorMap.get(n.id) || new THREE.Color("#888"));
      } else {
        // Invisible: hide in both
        dummy.scale.setScalar(0.001); dummy.updateMatrix();
        nodesMesh.setMatrixAt(i, dummy.matrix);
        dimNodesMesh.setMatrixAt(i, dummy.matrix);
      }
    });
    nodesMesh.instanceMatrix.needsUpdate    = true;
    nodesMesh.instanceColor.needsUpdate     = true;
    dimNodesMesh.instanceMatrix.needsUpdate = true;
    dimNodesMesh.instanceColor.needsUpdate  = true;
  }

  function _refreshEdgePositions() {
    if (!edgesObject || !dimEdgesObject) return;
    const pa  = edgesObject.geometry.getAttribute("position");
    const ca  = edgesObject.geometry.getAttribute("color");
    const dpa = dimEdgesObject.geometry.getAttribute("position");
    const dca = dimEdgesObject.geometry.getAttribute("color");

    edgeData.forEach((e, i) => {
      const b = i * 6;
      if (visibleEdgeIndices.has(i)) {
        // Active edge
        const sp = _wpa(nodeData[e.source]), tp = _wpa(nodeData[e.target]);
        pa.array[b]=sp[0]; pa.array[b+1]=sp[1]; pa.array[b+2]=sp[2];
        pa.array[b+3]=tp[0]; pa.array[b+4]=tp[1]; pa.array[b+5]=tp[2];
        const cm = new THREE.Color().lerpColors(
          nodeColorMap.get(e.source)||new THREE.Color("#888"),
          nodeColorMap.get(e.target)||new THREE.Color("#888"), 0.5);
        ca.array[b]=cm.r; ca.array[b+1]=cm.g; ca.array[b+2]=cm.b;
        ca.array[b+3]=cm.r; ca.array[b+4]=cm.g; ca.array[b+5]=cm.b;
        // hide in dim
        for(let k=0;k<6;k++) dpa.array[b+k]=0;
      } else if (dimEdgeIndices.has(i)) {
        // Dim edge
        const sp = _wpa(nodeData[e.source]), tp = _wpa(nodeData[e.target]);
        dpa.array[b]=sp[0]; dpa.array[b+1]=sp[1]; dpa.array[b+2]=sp[2];
        dpa.array[b+3]=tp[0]; dpa.array[b+4]=tp[1]; dpa.array[b+5]=tp[2];
        const cm = new THREE.Color().lerpColors(
          nodeColorMap.get(e.source)||new THREE.Color("#888"),
          nodeColorMap.get(e.target)||new THREE.Color("#888"), 0.5);
        dca.array[b]=cm.r; dca.array[b+1]=cm.g; dca.array[b+2]=cm.b;
        dca.array[b+3]=cm.r; dca.array[b+4]=cm.g; dca.array[b+5]=cm.b;
        // hide in active
        for(let k=0;k<6;k++) pa.array[b+k]=0;
      } else {
        // hide in both
        for(let k=0;k<6;k++) { pa.array[b+k]=0; dpa.array[b+k]=0; }
      }
    });
    pa.needsUpdate=true; ca.needsUpdate=true;
    dpa.needsUpdate=true; dca.needsUpdate=true;
  }

  // ── Diff overlay ──────────────────────────────────────────────────────────
  function showDiff(diff, nodesRef) {
    clearDiff();
    const nodeById = new Map(nodesRef.map(n => [n.id, n]));
    const all = [
      ...diff.onlyA.map(e => ({...e, type:"A"})),
      ...diff.onlyB.map(e => ({...e, type:"B"})),
      ...diff.shared.map(e => ({...e, type:"S"})),
    ];
    const pos = new Float32Array(all.length*6), col = new Float32Array(all.length*6);
    const cA=new THREE.Color(CFG.DIFF_A), cB=new THREE.Color(CFG.DIFF_B), cS=new THREE.Color(CFG.DIFF_S);
    all.forEach((e, i) => {
      const [srcId,tgtId] = (e.key||`${e.source}-${e.target}`).split("-").map(Number);
      const sn=nodeById.get(srcId), tn=nodeById.get(tgtId); if(!sn||!tn) return;
      const sp=_wpa(sn), tp=_wpa(tn), b=i*6;
      pos[b]=sp[0];pos[b+1]=sp[1];pos[b+2]=sp[2];
      pos[b+3]=tp[0];pos[b+4]=tp[1];pos[b+5]=tp[2];
      const c = e.type==="A"?cA:e.type==="B"?cB:cS;
      col[b]=c.r;col[b+1]=c.g;col[b+2]=c.b;
      col[b+3]=c.r;col[b+4]=c.g;col[b+5]=c.b;
    });
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(pos,3));
    geo.setAttribute("color",    new THREE.BufferAttribute(col,3));
    diffEdgesObject = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({
      vertexColors:true, transparent:true, opacity:0.75, depthWrite:false
    }));
    diffEdgesObject.renderOrder=3; scene.add(diffEdgesObject);
    if (edgesObject) edgesObject.material.opacity=0.06;
  }

  function clearDiff() {
    if (diffEdgesObject) {
      scene.remove(diffEdgesObject);
      diffEdgesObject.geometry.dispose();
      diffEdgesObject = null;
    }
    if (edgesObject) edgesObject.material.opacity = CFG.EDGE_OPACITY;
  }

  // ── Particles (circular texture) ─────────────────────────────────────────
  function _buildPathParticles(path) {
    _disposeParticles();
    if (!path || path.length < 2) return;
    pathSegments = []; pathTotalLen = 0;
    for (let i=0;i<path.length-1;i++) {
      const a=nodeData[path[i]], b=nodeData[path[i+1]]; if(!a||!b) continue;
      const from=_wp(a), to=_wp(b), len=from.distanceTo(to);
      pathSegments.push({from,to,len}); pathTotalLen+=len;
    }
    if (!pathTotalLen) return;

    if (!particleTex) particleTex = _makeCircleTex(CFG.PATH_COLOR);

    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(CFG.PARTICLE_COUNT*3), 3));
    pathParticles = new THREE.Points(geo, new THREE.PointsMaterial({
      color: CFG.PATH_COLOR, size: 0.07, map: particleTex,
      alphaTest: 0.01, transparent:true, opacity:0.95,
      depthTest:false, sizeAttenuation:true,
    }));
    pathParticles.renderOrder=999; scene.add(pathParticles); particleT=0;
  }

  function _animateParticles(dt) {
    if (!pathParticles || !pathSegments.length || !pathTotalLen) return;
    particleT = (particleT + CFG.PARTICLE_SPEED * dt) % 1.0;
    const pa = pathParticles.geometry.getAttribute("position");
    for (let p=0; p<CFG.PARTICLE_COUNT; p++) {
      const t = (particleT + p/CFG.PARTICLE_COUNT) % 1.0;
      let dist = t * pathTotalLen, pos = pathSegments[0].from.clone();
      for (const seg of pathSegments) {
        if (dist<=seg.len) { pos=seg.from.clone().lerp(seg.to, dist/seg.len); break; }
        dist -= seg.len;
      }
      pa.array[p*3]=pos.x; pa.array[p*3+1]=pos.y; pa.array[p*3+2]=pos.z;
    }
    pa.needsUpdate = true;
  }

  function _disposeParticles() {
    if (pathParticles) {
      scene.remove(pathParticles);
      pathParticles.geometry.dispose();
      pathParticles.material.dispose();
      pathParticles = null;
    }
    pathSegments=[]; pathTotalLen=0;
  }

  // ── Hover highlight ───────────────────────────────────────────────────────
  function _applyHover(hovId) {
    if (!nodesMesh) return;
    const dummy = new THREE.Object3D();
    const nbrs  = hovId !== null
      ? BrainAlgorithms.getNeighbors(hovId, BrainStore.getState().adjacency)
      : new Set();

    nodeData.forEach((n, i) => {
      if (!visibleNodeIds.has(n.id)) return;
      const p    = _wp(n);
      const base = nodeScaleMap.get(n.id) || 1;
      let   sc   = base;
      if (n.id === hovId) sc = base * CFG.NODE_HOVER_SCALE;
      else if (hovId !== null && !nbrs.has(n.id)) sc = base * 0.55;
      dummy.position.set(p.x,p.y,p.z); dummy.scale.setScalar(sc); dummy.updateMatrix();
      nodesMesh.setMatrixAt(i, dummy.matrix);
    });
    nodesMesh.instanceMatrix.needsUpdate = true;

    const ca = edgesObject.geometry.getAttribute("color");
    edgeData.forEach((e, i) => {
      if (!visibleEdgeIndices.has(i)) return;
      const conn = e.source===hovId || e.target===hovId;
      const dim  = hovId!==null && !conn;
      const cs   = nodeColorMap.get(e.source)||new THREE.Color("#888");
      const ct   = nodeColorMap.get(e.target)||new THREE.Color("#888");
      const cm   = new THREE.Color().lerpColors(cs, ct, 0.5);
      const a    = dim ? 0.03 : 1.0, b = i*6;
      ca.array[b]=cm.r*a; ca.array[b+1]=cm.g*a; ca.array[b+2]=cm.b*a;
      ca.array[b+3]=cm.r*a; ca.array[b+4]=cm.g*a; ca.array[b+5]=cm.b*a;
    });
    ca.needsUpdate = true;
    edgesObject.material.opacity = hovId!==null ? 0.95 : CFG.EDGE_OPACITY;
  }

  function _applySelection() {
    if (!nodesMesh) return;
    const dummy = new THREE.Object3D();
    nodeData.forEach((n, i) => {
      if (!visibleNodeIds.has(n.id)) return;
      const p   = _wp(n);
      const sel = selectedIds.has(n.id);
      const base = nodeScaleMap.get(n.id) || 1;
      dummy.position.set(p.x,p.y,p.z);
      dummy.scale.setScalar(sel ? base*CFG.NODE_SEL_SCALE : base);
      dummy.updateMatrix(); nodesMesh.setMatrixAt(i, dummy.matrix);
      nodesMesh.setColorAt(i, sel
        ? new THREE.Color(CFG.PATH_COLOR)
        : (nodeColorMap.get(n.id)||new THREE.Color("#888")));
    });
    nodesMesh.instanceMatrix.needsUpdate=true;
    nodesMesh.instanceColor.needsUpdate=true;
  }

  function _applyPathHL() {
    if (!nodesMesh) return;
    const dummy = new THREE.Object3D();
    nodeData.forEach((n, i) => {
      if (!visibleNodeIds.has(n.id)) return;
      const p      = _wp(n);
      const onPath = pathNodeSet.has(n.id);
      const isSel  = selectedIds.has(n.id);
      const base   = nodeScaleMap.get(n.id) || 1;
      const sc     = isSel ? base*CFG.NODE_SEL_SCALE : onPath ? base*CFG.NODE_HOVER_SCALE : base*0.65;
      dummy.position.set(p.x,p.y,p.z); dummy.scale.setScalar(sc); dummy.updateMatrix();
      nodesMesh.setMatrixAt(i, dummy.matrix);
      nodesMesh.setColorAt(i, (onPath||isSel)
        ? new THREE.Color(CFG.PATH_COLOR)
        : (nodeColorMap.get(n.id)||new THREE.Color("#888")));
    });
    nodesMesh.instanceMatrix.needsUpdate=true;
    nodesMesh.instanceColor.needsUpdate=true;
  }

  function _drawPath(path) {
    if (!path||path.length<2) return;
    const pts = path.map(id => _wp(nodeData[id]));
    const g   = new THREE.BufferGeometry().setFromPoints(pts);
    pathLine.geometry.dispose(); pathLine.geometry=g;
    const g2 = new THREE.BufferGeometry().setFromPoints(pts);
    pathGlow.geometry.dispose(); pathGlow.geometry=g2;
  }

  function _clearPath() {
    const e = () => new THREE.BufferGeometry().setAttribute("position",
      new THREE.BufferAttribute(new Float32Array(0), 3));
    if(pathLine){pathLine.geometry.dispose();pathLine.geometry=e();}
    if(pathGlow){pathGlow.geometry.dispose();pathGlow.geometry=e();}
    _disposeParticles();
    _buildNodeColors();
    nodeData.forEach((n,i) => {
      nodesMesh.setColorAt(i, nodeColorMap.get(n.id)||new THREE.Color("#888"));
    });
    nodesMesh.instanceColor.needsUpdate=true;
    _refreshNodePositions();
  }

  // ── 3D tooltip ────────────────────────────────────────────────────────────
  function _updateTooltip(nodeId) {
    const tip = document.getElementById("node-tooltip");
    if (!tip) return;
    if (nodeId===null) { tip.style.display="none"; return; }
    const node = nodeData.find(n => n.id===nodeId); if (!node) return;
    const wp   = _wp(node); wp.project(camera);
    const rect = container.getBoundingClientRect();
    const sx   = ((wp.x+1)/2)*rect.width  + rect.left;
    const sy   = ((-wp.y+1)/2)*rect.height + rect.top;
    const st   = BrainStore.getState();
    const comm = st.data?.communities.find(c=>c.id===node.community);
    tip.innerHTML = `<strong>${node.label.replace(/^7Networks_[LR]H_/,"").replace(/_/g," ")}</strong><br>
      Network: <span style="color:${comm?.color||'#888'}">${comm?.name||'?'}</span><br>
      MNI: (${(node.mni_x||0).toFixed(0)}, ${(node.mni_y||0).toFixed(0)}, ${(node.mni_z||0).toFixed(0)})<br>
      Degree: ${node.degree} | Betweenness: ${((node.betweenness||0)*100).toFixed(1)}%`;
    tip.style.left=(sx+16)+"px"; tip.style.top=(sy-10)+"px"; tip.style.display="block";
  }

  function _emitRegionInfo(node) {
    const lobe = _getLobeNameForNode(node);
    const st   = BrainStore.getState();
    const comm = st.data?.communities.find(c=>c.id===node.community);
    BrainStore.emit("region:selected", { node, lobe, community: comm||null,
      totalNodes:nodeData.length, totalEdges:edgeData.length });
  }

  // ── Store listeners ───────────────────────────────────────────────────────
  function _bindStore() {
    BrainStore.on("data:loaded",       data   => loadData(data));
    BrainStore.on("filter:changed",    payload => { _updateVisibility(payload); });
    BrainStore.on("node:hover",        id      => { hoveredId=id; _applyHover(id); _updateTooltip(id); });
    BrainStore.on("node:selected",     ({nodes}) => { selectedIds=new Set(nodes); _applySelection(); });
    BrainStore.on("path:found",        ({path}) => {
      pathNodeSet=new Set(path);
      pathEdgeSet=BrainStore.getState().pathEdgeSet;
      _drawPath(path); _applyPathHL(); _buildPathParticles(path);
    });
    BrainStore.on("path:reset",        () => {
      pathNodeSet.clear(); pathEdgeSet.clear(); selectedIds.clear();
      _clearPath();
    });
    BrainStore.on("colorMode:changed", mode => {
      colorMode=mode; _buildNodeColors(); _buildNodes(); _buildEdges();
    });
    BrainStore.on("dimOpacity:changed", val => {
      dimOpacity = val;
      if (dimNodesMesh) dimNodesMesh.material.opacity = val;
      if (dimEdgesObject) dimEdgesObject.material.opacity = val * 0.7;
    });
  }

  // ── Events ────────────────────────────────────────────────────────────────
  function _bindEvents() {
    const c = renderer.domElement;
    c.addEventListener("pointermove", e => {
      const r = c.getBoundingClientRect();
      pointer.x =  (e.clientX-r.left)/r.width  * 2 - 1;
      pointer.y = -(e.clientY-r.top) /r.height * 2 + 1;
    });
    c.addEventListener("pointerleave", () => {
      pointer.set(-999,-999);
      if (hoveredId!==null) { BrainStore.hoverNode(null); hoveredId=null; }
    });
    c.addEventListener("click", e => {
      if (!nodesMesh) return;
      const r = c.getBoundingClientRect();
      raycaster.setFromCamera(new THREE.Vector2(
        (e.clientX-r.left)/r.width*2-1,
        -(e.clientY-r.top)/r.height*2+1
      ), camera);
      const hits = raycaster.intersectObject(nodesMesh);
      if (hits.length>0 && hits[0].instanceId!==undefined) {
        const node = nodeData[hits[0].instanceId];
        if (node && visibleNodeIds.has(node.id)) {
          BrainStore.clickNode(node.id);
          _emitRegionInfo(node);
        }
      }
    });
  }

  // ── Render loop ───────────────────────────────────────────────────────────
  let lastHovId2 = -1;

  function _startLoop() {
    lastFrameTime = performance.now();
    function loop() {
      requestAnimationFrame(loop);
      const now = performance.now(), dt = Math.min((now-lastFrameTime)/1000, 0.05);
      lastFrameTime = now;
      _checkHover(); _animateParticles(dt); controls.update(); renderer.render(scene,camera);
    }
    loop();
  }

  function _checkHover() {
    if (!nodesMesh) return;
    raycaster.setFromCamera(pointer, camera);
    const hits = raycaster.intersectObject(nodesMesh);
    const newId = (hits.length>0 && hits[0].instanceId!==undefined &&
                   visibleNodeIds.has(nodeData[hits[0].instanceId]?.id))
      ? nodeData[hits[0].instanceId].id : null;
    if (newId!==lastHovId2) {
      lastHovId2=newId;
      BrainStore.hoverNode(newId);
      renderer.domElement.style.cursor = newId!==null ? "pointer":"default";
    }
  }

  // ── Public API ────────────────────────────────────────────────────────────
  function toggleAutoRotate(on)  { controls.autoRotate=on; }
  function resetCamera() {
    camera.position.set(0,0.15,3.8); camera.lookAt(0,0,0);
    controls.target.set(0,0,0); controls.update();
  }
  function setView(axis) {
    const d=3.8;
    if(axis==="front") camera.position.set(0,0.15,d);
    if(axis==="top")   camera.position.set(0,d,0.1);
    if(axis==="side")  camera.position.set(d,0.15,0);
    camera.lookAt(0,0,0); controls.target.set(0,0,0); controls.update();
  }
  function setBackground(hex) {
    renderer.setClearColor(hex,1);
    if(scene.fog) scene.fog.color.setHex(hex);
  }
  function exportPNG() {
    renderer.render(scene,camera);
    const a=document.createElement("a");
    a.href=renderer.domElement.toDataURL("image/png");
    a.download=`brainviz_${Date.now()}.png`; a.click();
  }

  return { init,loadData,showDiff,clearDiff,toggleAutoRotate,resetCamera,setView,setBackground,exportPNG };
})();