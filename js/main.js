/**
 * main.js — Brain-Viz Orchestrator  (full rewrite)
 *
 * New in this version:
 *  1. Clear all filters button (resets weight, hemisphere, all communities)
 *  2. Dim opacity slider — filtered-out nodes shown at user-controlled opacity
 *  3. Community items get .inactive class when deselected (not just opacity)
 *  4. Region info panel rendered INSIDE sidebar (never covers 2D view)
 *  5. Compare page: brushing & linking — hovering node in A highlights same ID in B
 *  6. Compare page: insights panel with per-disease clinical commentary
 *  7. Compare renderers share same shell geometry as main brain3d.js
 */
"use strict";

(function () {

  /* ══════════════════════════════════════════════════════════════════════
     HELPERS  (defined first — no TDZ issues)
  ═══════════════════════════════════════════════════════════════════════ */
  function _el(id)     { return document.getElementById(id); }
  function _set(id, v) { var e=_el(id); if(e) e.textContent=v; }
  function _tick()     { return new Promise(function(r){setTimeout(r,16);}); }

  function _showHint(msg) {
    var h=_el("hint-bar"); if(!h) return;
    h.textContent=msg; h.style.opacity="1";
    setTimeout(function(){h.style.opacity="0";},5000);
  }

  async function _readJSON(file) {
    try {
      var text=await file.text(), data=JSON.parse(text);
      if(!data.nodes||!data.edges) throw new Error("Missing nodes/edges");
      return data;
    } catch(e) { alert("Could not read \""+file.name+"\":\n"+e.message); return null; }
  }

  /* ══════════════════════════════════════════════════════════════════════
     PAGE TRANSITIONS
  ═══════════════════════════════════════════════════════════════════════ */
  function _showLanding() {
    _el("landing").style.display      = "flex";
    _el("app").style.display          = "none";
    _el("compare-page").style.display = "none";
  }
  function _showApp() {
    _el("landing").style.display      = "none";
    _el("app").style.display          = "flex";
    _el("compare-page").style.display = "none";
    var l=_el("loader"); if(l) l.style.display="none";
  }
  function _showLoader(msg) {
    _el("landing").style.display      = "none";
    _el("compare-page").style.display = "none";
    _el("app").style.display          = "flex";
    var l=_el("loader"),m=_el("loader-msg");
    if(l) l.style.display="flex";
    if(m) m.textContent=msg||"Loading…";
  }
  function _showComparePage() {
    _el("landing").style.display      = "none";
    _el("app").style.display          = "none";
    _el("compare-page").style.display = "flex";
  }

  /* ══════════════════════════════════════════════════════════════════════
     DATASET MANAGER
  ═══════════════════════════════════════════════════════════════════════ */
  var DatasetManager = (function(){
    var datasets=[], activeIdx=-1;
    return {
      add: function(name,data){ datasets.push({name:name,data:data}); return datasets.length-1; },
      remove: function(idx){ datasets.splice(idx,1); if(activeIdx>=datasets.length) activeIdx=datasets.length-1; },
      setActive:    function(idx){ activeIdx=idx; },
      getActive:    function(){ return datasets[activeIdx]||null; },
      get:          function(idx){ return datasets[idx]||null; },
      getAll:       function(){ return datasets; },
      count:        function(){ return datasets.length; },
      getActiveIdx: function(){ return activeIdx; },
      getDiff: function(idxA,idxB){
        var dA=datasets[idxA]&&datasets[idxA].data;
        var dB=datasets[idxB]&&datasets[idxB].data;
        if(!dA||!dB) return {onlyA:[],onlyB:[],shared:[]};
        function toMap(edges){
          var m={};
          edges.forEach(function(e){
            var k=Math.min(e.source,e.target)+"-"+Math.max(e.source,e.target);
            m[k]=e;
          });
          return m;
        }
        var mA=toMap(dA.edges), mB=toMap(dB.edges);
        var onlyA=[],onlyB=[],shared=[];
        Object.keys(mA).forEach(function(k){ (mB[k]?shared:onlyA).push(Object.assign({key:k},mA[k])); });
        Object.keys(mB).forEach(function(k){ if(!mA[k]) onlyB.push(Object.assign({key:k},mB[k])); });
        return {onlyA:onlyA,onlyB:onlyB,shared:shared};
      }
    };
  })();

  /* ══════════════════════════════════════════════════════════════════════
     REGION INFO KNOWLEDGE BASE
  ═══════════════════════════════════════════════════════════════════════ */
  var LOBE_INFO = {
    Frontal:  { color:"#3A86FF", fn:"Executive control, planning, voluntary movement, language production (Broca's area), working memory, personality, and decision-making.", clinical:"Damage causes personality changes, impaired planning, speech difficulties, and loss of fine motor control.", networks:"Frontoparietal Control, Default Mode (medial), Salience." },
    Parietal: { color:"#06D6A0", fn:"Spatial awareness, sensory integration, attention, numerical cognition, and visuospatial processing.", clinical:"Lesions cause neglect syndrome, dyscalculia, and difficulties with object recognition.", networks:"Dorsal Attention, Frontoparietal, Default Mode (precuneus)." },
    Temporal: { color:"#FF6B35", fn:"Auditory processing, memory encoding (hippocampus), object recognition, language comprehension (Wernicke's area), face recognition.", clinical:"Damage causes amnesia, auditory hallucinations, language comprehension deficits, and prosopagnosia.", networks:"Default Mode, Limbic, Ventral Attention." },
    Occipital:{ color:"#9B5FE0", fn:"Primary visual processing — edges, motion, colour, depth. Feeds the 'where' and 'what' visual streams.", clinical:"Damage causes cortical blindness, visual hallucinations, or inability to perceive motion.", networks:"Visual Network (primary and extrastriate cortex)." },
    Insula:   { color:"#FFD166", fn:"Interoception, pain, emotion integration, self-awareness, taste, and autonomic regulation.", clinical:"Involved in addiction, chronic pain, schizophrenia, and loss of empathy in frontotemporal dementia.", networks:"Salience/Ventral Attention, Limbic." },
    Central:  { color:"#2EC4B6", fn:"Central sulcus region: separates frontal motor cortex from parietal somatosensory cortex. Coordinates sensation and movement.", clinical:"Strokes here cause contralateral weakness and sensory loss.", networks:"Somatomotor Network." }
  };
  var NET_INFO = {
    "Default Mode":"Active during rest, self-referential thought, and episodic memory. Deactivates during focused tasks.",
    "Visual":"Processes visual information from primary cortex through higher-order areas for colour, form, and motion.",
    "Somatomotor":"Controls voluntary body movement and processes touch, proprioception, and body awareness.",
    "Frontoparietal":"Top-down executive control, goal-directed behaviour, and cognitive flexibility.",
    "Limbic":"Emotion regulation, memory consolidation, motivation, and reward. Includes hippocampus and amygdala.",
    "Dorsal Attention":"Voluntary, top-down control of spatial attention.",
    "Ventral Attention":"Involuntary, bottom-up attention to unexpected stimuli.",
    "Salience":"Detects biologically relevant stimuli; switches between Default Mode and Control networks.",
    "Subcortical":"Deep structures (thalamus, basal ganglia) that relay sensory signals and regulate movement."
  };

  /* ══════════════════════════════════════════════════════════════════════
     APP BOOT
  ═══════════════════════════════════════════════════════════════════════ */
  var appBooted=false;

  async function bootApp(data, name) {
    try {
      _showLoader("Initialising 3D engine…");
      await _tick();
      if(!appBooted){ Brain3D.init("view-3d"); Graph2D.init("view-2d"); appBooted=true; }
      _showLoader("Building graph…");
      await _tick();
      var idx=DatasetManager.add(name,data);
      DatasetManager.setActive(idx);
      BrainStore.init(data);
      await _tick();
      _buildCommunityPanel(data.communities);
      _updateStatsPanel(data.metadata);
      _renderDatasetBar();
      _showApp();
      _bindMetricsPanel(data);
      _showHint("Click a node for region info · Click two nodes for shortest pathway");
    } catch(e) {
      console.error("bootApp:",e);
      alert("Failed to start: "+e.message);
      _showLanding();
    }
  }

  /* ══════════════════════════════════════════════════════════════════════
     COMPARE PAGE  — two independent Three.js renderers + brushing
  ═══════════════════════════════════════════════════════════════════════ */
  var cmpRA=null, cmpRB=null;
  var cmpHoveredId=null;  // currently hovered node ID (shared across both views)

  function _buildMiniRenderer(containerId, data, side) {
    var el=_el(containerId); if(!el) return null;
    el.innerHTML="";
    var w=Math.max(el.clientWidth,300), h=Math.max(el.clientHeight,300);

    var renderer=new THREE.WebGLRenderer({antialias:true});
    renderer.setPixelRatio(Math.min(window.devicePixelRatio,2));
    renderer.setSize(w,h);
    renderer.setClearColor(0x080C18,1);
    el.appendChild(renderer.domElement);

    var scene=new THREE.Scene();
    scene.add(new THREE.AmbientLight(0xffffff,1.8));
    var dl=new THREE.DirectionalLight(0xffffff,0.9); dl.position.set(2,4,3); scene.add(dl);

    var camera=new THREE.PerspectiveCamera(45,w/h,0.1,100);
    camera.position.set(0,0.15,3.8); camera.lookAt(0,0,0);

    var ctrl=new THREE.OrbitControls(camera,renderer.domElement);
    ctrl.enableDamping=true; ctrl.dampingFactor=0.06;
    ctrl.minDistance=1.5; ctrl.maxDistance=8;

    // Brain shell (same displaced geometry)
    var SC={x:1.05,y:1.18,z:1.35};
    function mkGeo(r,ws,hs){
      var geo=new THREE.SphereGeometry(r,ws,hs), pos=geo.attributes.position;
      for(var i=0;i<pos.count;i++){
        var x=pos.getX(i),y=pos.getY(i),z=pos.getZ(i);
        if(y>0) y*=1+0.30*y; else y*=1-0.12*Math.abs(y);
        if(z>0){x*=1+0.12*z; z*=1+0.16*z;}
        if(z<-0.35){x*=1-0.10*Math.abs(z); z*=1+0.06*Math.abs(z);}
        if(y<-0.10&&Math.abs(x)>0.30){x*=1+0.14*Math.abs(x); y*=1+0.18*Math.abs(y)*(Math.abs(x)-0.30);}
        pos.setXYZ(i,x,y,z);
      }
      geo.computeVertexNormals(); return geo;
    }
    var grp=new THREE.Group(); grp.scale.set(SC.x,SC.y,SC.z);
    grp.add(new THREE.Mesh(mkGeo(1.0,60,44),new THREE.MeshPhongMaterial({
      color:0x88BBFF,emissive:0x0A1A2A,emissiveIntensity:0.15,
      specular:0xCCDDFF,shininess:50,transparent:true,opacity:0.20,depthWrite:false
    })));
    grp.add(new THREE.Mesh(mkGeo(1.003,22,16),new THREE.MeshBasicMaterial({
      color:0x7799BB,wireframe:true,transparent:true,opacity:0.045,depthWrite:false
    })));
    scene.add(grp);
    // Fissure
    var fiss=new THREE.Mesh(new THREE.PlaneGeometry(0.015,2.2),
      new THREE.MeshBasicMaterial({color:0x000B1E,transparent:true,opacity:0.50,
        side:THREE.DoubleSide,depthWrite:false}));
    fiss.rotation.y=Math.PI/2; fiss.position.set(0,0.06,0);
    fiss.scale.set(SC.z*1.18,SC.y*0.97,1); scene.add(fiss);

    // Nodes with instanced mesh
    var S=0.92;
    function wp(n){return new THREE.Vector3(n.x*SC.x*S,n.z*SC.y*S,n.y*SC.z*S);}
    var maxD=Math.max.apply(null,data.nodes.map(function(n){return n.degree||0;}))||1;
    var cMap={}; data.communities.forEach(function(c){cMap[c.id]=c.color;});
    function nc(n){return new THREE.Color(cMap[n.community]||"#888888");}

    var nGeo=new THREE.SphereGeometry(0.022,10,8);
    var nMat=new THREE.MeshPhongMaterial({shininess:90});
    var mesh=new THREE.InstancedMesh(nGeo,nMat,data.nodes.length);
    mesh.instanceColor=new THREE.InstancedBufferAttribute(new Float32Array(data.nodes.length*3),3);
    var dummy=new THREE.Object3D();
    data.nodes.forEach(function(n,i){
      var p=wp(n);
      dummy.position.set(p.x,p.y,p.z);
      dummy.scale.setScalar(0.65+(n.degree||0)/maxD*1.35);
      dummy.updateMatrix(); mesh.setMatrixAt(i,dummy.matrix);
      mesh.setColorAt(i,nc(n));
    });
    mesh.instanceMatrix.needsUpdate=true; mesh.instanceColor.needsUpdate=true;
    mesh.userData.nodeData=data.nodes;
    scene.add(mesh);

    // Edges
    var ep=new Float32Array(data.edges.length*6),ec=new Float32Array(data.edges.length*6);
    data.edges.forEach(function(e,i){
      var sp=wp(data.nodes[e.source]),tp=wp(data.nodes[e.target]),b=i*6;
      ep[b]=sp.x;ep[b+1]=sp.y;ep[b+2]=sp.z;ep[b+3]=tp.x;ep[b+4]=tp.y;ep[b+5]=tp.z;
      var c=nc(data.nodes[e.source]);
      ec[b]=c.r;ec[b+1]=c.g;ec[b+2]=c.b;ec[b+3]=c.r;ec[b+4]=c.g;ec[b+5]=c.b;
    });
    var eGeo=new THREE.BufferGeometry();
    eGeo.setAttribute("position",new THREE.BufferAttribute(ep,3));
    eGeo.setAttribute("color",   new THREE.BufferAttribute(ec,3));
    var eLine=new THREE.LineSegments(eGeo,new THREE.LineBasicMaterial({
      vertexColors:true,transparent:true,opacity:0.28,depthWrite:false}));
    scene.add(eLine);

    // Raycasting for brushing
    var ray=new THREE.Raycaster(), ptr=new THREE.Vector2(-999,-999);
    renderer.domElement.addEventListener("pointermove",function(e){
      var r=renderer.domElement.getBoundingClientRect();
      ptr.x=(e.clientX-r.left)/r.width*2-1;
      ptr.y=-(e.clientY-r.top)/r.height*2+1;
    });
    renderer.domElement.addEventListener("pointerleave",function(){
      ptr.set(-999,-999);
      _onCmpHover(null, side);
    });

    var lastHovId=-1;
    function checkHover(){
      ray.setFromCamera(ptr,camera);
      var hits=ray.intersectObject(mesh);
      var newId=(hits.length>0&&hits[0].instanceId!==undefined)
        ? hits[0].instanceId : null;
      if(newId!==lastHovId){ lastHovId=newId; _onCmpHover(newId,side); }
    }

    // Brush highlight function (called externally)
    var highlightFn=function(hovId){
      var colorAttr=mesh.instanceColor;
      var matAttr=mesh.instanceMatrix;
      data.nodes.forEach(function(n,i){
        var p=wp(n), base=0.65+(n.degree||0)/maxD*1.35;
        dummy.position.set(p.x,p.y,p.z);
        if(hovId===null){
          dummy.scale.setScalar(base); dummy.updateMatrix();
          matAttr.array.set(dummy.matrix.elements,i*16);
          colorAttr.array[i*3]=nc(n).r; colorAttr.array[i*3+1]=nc(n).g; colorAttr.array[i*3+2]=nc(n).b;
        } else if(n.id===hovId){
          dummy.scale.setScalar(base*1.85); dummy.updateMatrix();
          matAttr.array.set(dummy.matrix.elements,i*16);
          colorAttr.array[i*3]=1; colorAttr.array[i*3+1]=0.84; colorAttr.array[i*3+2]=0;
        } else {
          dummy.scale.setScalar(base*0.55); dummy.updateMatrix();
          matAttr.array.set(dummy.matrix.elements,i*16);
          var c=nc(n), dim=0.25;
          colorAttr.array[i*3]=c.r*dim; colorAttr.array[i*3+1]=c.g*dim; colorAttr.array[i*3+2]=c.b*dim;
        }
      });
      mesh.instanceMatrix.needsUpdate=true; mesh.instanceColor.needsUpdate=true;
    };

    // Resize
    var ro=new ResizeObserver(function(){
      var nw=el.clientWidth,nh=el.clientHeight; if(!nw||!nh) return;
      renderer.setSize(nw,nh); camera.aspect=nw/nh; camera.updateProjectionMatrix();
    });
    ro.observe(el);

    var alive=true;
    (function loop(){
      if(!alive) return; requestAnimationFrame(loop);
      checkHover(); ctrl.update(); renderer.render(scene,camera);
    })();

    return {
      stop:function(){alive=false;ro.disconnect();renderer.dispose();},
      highlight:highlightFn,
      getNodeById:function(id){ return data.nodes.find(function(n){return n.id===id;}); }
    };
  }

  // Brushing: hover in one view -> highlight matching node in both
  function _onCmpHover(instanceId, side) {
    var dsA=DatasetManager.get(0), dsB=DatasetManager.get(1);
    if(!dsA||!dsB) return;
    var nodeA=null, nodeB=null;

    if(instanceId!==null){
      if(side==="A"){ nodeA=dsA.data.nodes[instanceId]; }
      else          { nodeB=dsB.data.nodes[instanceId]; }
    }

    // Try to find same label in the other dataset for linking
    var hovLabelA= nodeA ? nodeA.label : null;
    var hovLabelB= nodeB ? nodeB.label : null;

    if(hovLabelA&&!hovLabelB){
      var match=dsB.data.nodes.find(function(n){return n.label===hovLabelA;});
      hovLabelB=match?match.label:null;
    }
    if(hovLabelB&&!hovLabelA){
      var match2=dsA.data.nodes.find(function(n){return n.label===hovLabelB;});
      hovLabelA=match2?match2.label:null;
    }

    // Find IDs in each dataset by label
    var idInA= hovLabelA ? (dsA.data.nodes.findIndex(function(n){return n.label===hovLabelA;})) : null;
    var idInB= hovLabelB ? (dsB.data.nodes.findIndex(function(n){return n.label===hovLabelB;})) : null;

    if(cmpRA) cmpRA.highlight(idInA===null|idInA===-1 ? null : idInA);
    if(cmpRB) cmpRB.highlight(idInB===null|idInB===-1 ? null : idInB);

    // Update hover bar
    var chipA=_el("cmp-hover-a"), chipB=_el("cmp-hover-b");
    if(chipA) chipA.textContent = hovLabelA ? hovLabelA.replace(/^7Networks_[LR]H_/,"").replace(/_/g," ") : "—";
    if(chipB) chipB.textContent = hovLabelB ? hovLabelB.replace(/^7Networks_[LR]H_/,"").replace(/_/g," ") : "—";
  }

  function _openComparePage(idxA,idxB){
    var dsA=DatasetManager.get(idxA), dsB=DatasetManager.get(idxB);
    if(!dsA||!dsB){alert("Need two loaded datasets.");return;}

    _set("cmp-label-a",dsA.name); _set("cmp-label-b",dsB.name);
    _set("cmp-name-a",dsA.name);  _set("cmp-name-b",dsB.name);
    function ms(m){return m.n_nodes+" nodes · "+m.n_edges+" edges · density "+m.density;}
    _set("cmp-meta-a",ms(dsA.data.metadata)); _set("cmp-meta-b",ms(dsB.data.metadata));

    var diff=DatasetManager.getDiff(idxA,idxB);
    var total=(diff.onlyA.length+diff.onlyB.length+diff.shared.length)||1;
    _set("cmp-count-a",diff.onlyA.length); _set("cmp-count-b",diff.onlyB.length); _set("cmp-count-s",diff.shared.length);
    function pct(n){return n+" ("+(n/total*100).toFixed(1)+"%)"; }
    _set("cmp-pct-a",pct(diff.onlyA.length)); _set("cmp-pct-b",pct(diff.onlyB.length)); _set("cmp-pct-s",pct(diff.shared.length));

    _showComparePage();
    if(cmpRA){cmpRA.stop();cmpRA=null;} if(cmpRB){cmpRB.stop();cmpRB=null;}
    setTimeout(function(){
      cmpRA=_buildMiniRenderer("compare-view-a",dsA.data,"A");
      cmpRB=_buildMiniRenderer("compare-view-b",dsB.data,"B");
    },80);
  }

  /* ══════════════════════════════════════════════════════════════════════
     INSIGHTS PANEL
  ═══════════════════════════════════════════════════════════════════════ */
  var DISEASE_INSIGHTS = {
    default: {
      title: "Structural Connectivity Differences",
      body: [
        { heading:"Connectivity Density", text:"Dataset A has {edgesA} edges vs {edgesB} in B. A {direction} in density ({densA} vs {densB}) suggests {densMsg}." },
        { heading:"Unique Connections",   text:"{onlyA} connections exist only in A ({pctA}%) and {onlyB} only in B ({pctB}%). Shared: {shared} ({pctS}%)." },
        { heading:"Hub Regions",          text:"Regions with high betweenness centrality act as critical relay nodes. Disruption of these hubs is associated with major cognitive decline." },
        { heading:"Clinical Relevance",   text:"Reduced connectivity density is observed in neurodegenerative disorders (Alzheimer's, Parkinson's). Increased isolated clusters may indicate stroke or traumatic brain injury." },
        { heading:"What This Means",      text:"The brain with more edges is likely more densely connected — this may represent a healthy baseline. The sparser network may reflect disconnection due to disease, ageing, or lesion." }
      ]
    }
  };

  function _buildInsights(idxA, idxB) {
    var body=_el("insights-body"); if(!body) return;
    var dsA=DatasetManager.get(idxA), dsB=DatasetManager.get(idxB);
    if(!dsA||!dsB) return;
    var diff=DatasetManager.getDiff(idxA,idxB);
    var total=(diff.onlyA.length+diff.onlyB.length+diff.shared.length)||1;
    var mA=dsA.data.metadata, mB=dsB.data.metadata;
    var direction=mA.density>mB.density?"higher":"lower";
    var densMsg=mA.density>mB.density
      ? "denser connectivity, associated with healthier or younger brains"
      : "sparser connectivity, common in neurodegeneration or disease";

    var items=DISEASE_INSIGHTS.default.body;
    var html="";
    items.forEach(function(item){
      var text=item.text
        .replace("{edgesA}",mA.n_edges).replace("{edgesB}",mB.n_edges)
        .replace("{direction}",direction).replace("{densA}",mA.density).replace("{densB}",mB.density)
        .replace("{densMsg}",densMsg)
        .replace("{onlyA}",diff.onlyA.length).replace("{pctA}",(diff.onlyA.length/total*100).toFixed(1))
        .replace("{onlyB}",diff.onlyB.length).replace("{pctB}",(diff.onlyB.length/total*100).toFixed(1))
        .replace("{shared}",diff.shared.length).replace("{pctS}",(diff.shared.length/total*100).toFixed(1));
      html+='<div class="insight-block">'
        +'<div class="insight-heading">'+item.heading+'</div>'
        +'<div class="insight-text">'+text+'</div>'
        +'</div>';
    });

    // Top hub regions in A
    var topHubsA=dsA.data.nodes.slice().sort(function(a,b){return b.betweenness-a.betweenness;}).slice(0,5);
    html+='<div class="insight-block"><div class="insight-heading">Top Hub Regions (A)</div><div class="insight-text">'
      +topHubsA.map(function(n){return n.label.replace(/^7Networks_[LR]H_/,"").replace(/_/g," ")
        +" (bc:"+((n.betweenness||0)*100).toFixed(0)+"%)";}).join(" · ")
      +'</div></div>';
    var topHubsB=dsB.data.nodes.slice().sort(function(a,b){return b.betweenness-a.betweenness;}).slice(0,5);
    html+='<div class="insight-block"><div class="insight-heading">Top Hub Regions (B)</div><div class="insight-text">'
      +topHubsB.map(function(n){return n.label.replace(/^7Networks_[LR]H_/,"").replace(/_/g," ")
        +" (bc:"+((n.betweenness||0)*100).toFixed(0)+"%)";}).join(" · ")
      +'</div></div>';

    html+='<div class="insight-disclaimer">ℹ️ These insights are for educational/research purposes only. Not for clinical use.</div>';
    body.innerHTML=html;
  }

  /* ══════════════════════════════════════════════════════════════════════
     LANDING BINDINGS
  ═══════════════════════════════════════════════════════════════════════ */
  function _bindLanding() {
    var btnS=_el("landing-btn-single"), inpS=_el("file-single");
    if(btnS&&inpS){
      btnS.addEventListener("click",function(){inpS.click();});
      inpS.addEventListener("change",async function(){
        var f=inpS.files[0]; inpS.value="";
        if(!f) return;
        var d=await _readJSON(f);
        if(d) bootApp(d,f.name.replace(/\.json$/i,""));
      });
    }

    var btnC=_el("landing-btn-compare"), inpC=_el("file-compare");
    if(btnC&&inpC){
      btnC.addEventListener("click",function(){inpC.click();});
      inpC.addEventListener("change",async function(){
        var files=Array.from(inpC.files).filter(function(f){return /\.json$/i.test(f.name);}).slice(0,2);
        inpC.value="";
        if(files.length<2){alert("Please select exactly 2 .json files.");return;}
        var res=await Promise.all(files.map(_readJSON));
        if(!res[0]||!res[1]) return;
        _showLoader("Loading comparison…");
        await _tick();
        if(!appBooted){Brain3D.init("view-3d");Graph2D.init("view-2d");appBooted=true;}
        var idxA=DatasetManager.add(files[0].name.replace(/\.json$/i,""),res[0]);
        var idxB=DatasetManager.add(files[1].name.replace(/\.json$/i,""),res[1]);
        DatasetManager.setActive(idxA);
        BrainStore.init(res[0]);
        _buildCommunityPanel(res[0].communities);
        _updateStatsPanel(res[0].metadata);
        _renderDatasetBar();
        _openComparePage(idxA,idxB);
      });
    }
  }

  /* ══════════════════════════════════════════════════════════════════════
     APP UI CONTROLS
  ═══════════════════════════════════════════════════════════════════════ */
  function _bindAppControls() {

    // Weight slider
    var slider=_el("weight-slider"), sliderVal=_el("weight-val");
    if(slider){
      slider.addEventListener("input",function(){
        var v=parseFloat(slider.value);
        if(sliderVal) sliderVal.textContent=v.toFixed(2);
        BrainStore.setWeightThreshold(v);
      });
    }

    // Dim opacity slider
    var dimSlider=_el("dim-slider"), dimVal=_el("dim-val");
    if(dimSlider){
      dimSlider.addEventListener("input",function(){
        var v=parseInt(dimSlider.value);
        if(dimVal) dimVal.textContent=v+"%";
        BrainStore.setDimOpacity(v/100);
      });
    }

    // Clear all filters button
    var clearBtn=_el("btn-clear-filters");
    if(clearBtn){
      clearBtn.addEventListener("click",function(){
        // Reset weight
        if(slider){slider.value=0; if(sliderVal) sliderVal.textContent="0.00";}
        BrainStore.setWeightThreshold(0);
        // Reset hemisphere
        document.querySelectorAll("[data-hemi]").forEach(function(b){b.classList.remove("active");});
        var both=document.querySelector("[data-hemi='both']");
        if(both) both.classList.add("active");
        BrainStore.setHemisphere("both");
        // Re-enable all communities
        BrainStore.setAllCommunities(true);
        document.querySelectorAll(".comm-item").forEach(function(el){
          el.classList.add("active"); el.classList.remove("inactive");
        });
      });
    }

    // Hemisphere
    document.querySelectorAll("[data-hemi]").forEach(function(b){
      b.addEventListener("click",function(){
        document.querySelectorAll("[data-hemi]").forEach(function(x){x.classList.remove("active");});
        b.classList.add("active"); BrainStore.setHemisphere(b.dataset.hemi);
      });
    });

    // Color mode
    document.querySelectorAll("[data-color-mode]").forEach(function(b){
      b.addEventListener("click",function(){
        document.querySelectorAll("[data-color-mode]").forEach(function(x){x.classList.remove("active");});
        b.classList.add("active"); BrainStore.setColorMode(b.dataset.colorMode);
      });
    });

    // Camera
    var bf=_el("btn-view-front"),bt=_el("btn-view-top"),bs=_el("btn-view-side"),br=_el("btn-view-reset");
    if(bf) bf.addEventListener("click",function(){Brain3D.setView("front");});
    if(bt) bt.addEventListener("click",function(){Brain3D.setView("top");});
    if(bs) bs.addEventListener("click",function(){Brain3D.setView("side");});
    if(br) br.addEventListener("click",function(){Brain3D.resetCamera();});

    // Auto-rotate
    var rotating=false, rotBtn=_el("btn-autorotate");
    if(rotBtn){
      rotBtn.addEventListener("click",function(){
        rotating=!rotating; Brain3D.toggleAutoRotate(rotating);
        rotBtn.classList.toggle("active",rotating);
      });
    }

    // Reset path
    var rpBtn=_el("btn-reset-path");
    if(rpBtn){
      rpBtn.addEventListener("click",function(){
        BrainStore.resetPath(); _el("path-info").style.display="none";
      });
    }

    // Dark mode
    var dmBtn=_el("btn-darkmode");
    if(dmBtn){
      dmBtn.addEventListener("click",function(){
        var dark=document.body.classList.toggle("dark-mode");
        Brain3D.setBackground(dark?0x080C18:0xF5F7FC);
      });
    }

    // PNG export
    var expBtn=_el("btn-export");
    if(expBtn) expBtn.addEventListener("click",function(){Brain3D.exportPNG();});

    // 2D layout toggle
    var layoutBtn=_el("btn-2d-layout");
    if(layoutBtn){
      layoutBtn.addEventListener("click",function(){
        Graph2D.toggleLayout();
        layoutBtn.textContent=Graph2D.getLayout()==="chord"?"Circular":"Chord";
      });
    }

    // Tabs: 3D | Split | 2D
    document.querySelectorAll(".tab-btn").forEach(function(btn){
      btn.addEventListener("click",function(){
        document.querySelectorAll(".tab-btn").forEach(function(b){b.classList.remove("active");});
        btn.classList.add("active");
        var v=btn.dataset.view, p3=_el("panel-3d"), p2=_el("panel-2d");
        if(v==="both")    {p3.style.display=""; p2.style.display="";}
        else if(v==="panel-3d"){p3.style.display=""; p2.style.display="none";}
        else              {p3.style.display="none"; p2.style.display="";}
      });
    });

    // Community "All" — also clears inactive class
    var commAll=_el("btn-comm-all");
    if(commAll){
      commAll.addEventListener("click",function(){
        BrainStore.setAllCommunities(true);
        document.querySelectorAll(".comm-item").forEach(function(el){
          el.classList.add("active"); el.classList.remove("inactive");
        });
      });
    }

    // Header "Load Dataset"
    var fileInput=_el("file-input"), btnUpl=_el("btn-upload");
    if(btnUpl&&fileInput){
      btnUpl.addEventListener("click",function(){fileInput.click();});
      fileInput.addEventListener("change",async function(){
        await _handleFiles(fileInput.files); fileInput.value="";
      });
    }

    // Drag-drop
    var views=_el("views-container"), dropOv=_el("drop-overlay");
    if(views){
      views.addEventListener("dragenter",function(e){e.preventDefault();if(dropOv) dropOv.classList.add("active");});
      views.addEventListener("dragover",function(e){e.preventDefault();});
      views.addEventListener("dragleave",function(e){if(dropOv&&!views.contains(e.relatedTarget)) dropOv.classList.remove("active");});
      views.addEventListener("drop",async function(e){
        e.preventDefault(); if(dropOv) dropOv.classList.remove("active");
        await _handleFiles(e.dataTransfer.files);
      });
    }

    // Open full compare
    var cmpBtn=_el("btn-open-compare");
    if(cmpBtn){
      cmpBtn.addEventListener("click",function(){
        if(DatasetManager.count()<2){alert("Load at least 2 datasets first.");return;}
        _openComparePage(0,1);
      });
    }

    // Back from compare
    var backBtn=_el("btn-back-to-app");
    if(backBtn){
      backBtn.addEventListener("click",function(){
        if(cmpRA){cmpRA.stop();cmpRA=null;} if(cmpRB){cmpRB.stop();cmpRB=null;}
        _el("compare-page").style.display="none"; _el("app").style.display="flex";
      });
    }

    // Swap A/B
    var swapBtn=_el("btn-swap-compare");
    if(swapBtn){
      swapBtn.addEventListener("click",function(){
        if(DatasetManager.count()>=2) _openComparePage(1,0);
      });
    }

    // Insights panel toggle
    var insBtn=_el("btn-show-insights"), insPanel=_el("insights-panel");
    if(insBtn&&insPanel){
      insBtn.addEventListener("click",function(){
        var visible=insPanel.style.display!=="none"&&insPanel.style.display!=="";
        if(visible){ insPanel.style.display="none"; return; }
        _buildInsights(0,1);
        insPanel.style.display="flex";
      });
    }
    var closeIns=_el("btn-close-insights");
    if(closeIns) closeIns.addEventListener("click",function(){
      if(insPanel) insPanel.style.display="none";
    });
  }

  /* ══════════════════════════════════════════════════════════════════════
     STORE LISTENERS
  ═══════════════════════════════════════════════════════════════════════ */
  function _bindStoreListeners() {
    BrainStore.on("path:found",function(payload){
      var pi=_el("path-info"); if(!pi) return;
      var path=payload.path, totalWeight=payload.totalWeight, sel=payload.nodes;
      var st=BrainStore.getData();
      function lbl(id){ var n=st.nodes.find(function(n){return n.id===id;}); return n?n.label:id; }
      _set("path-text",lbl(sel[0])+" → "+lbl(sel[1]));
      _set("path-length","Hops: "+(path.length-1));
      _set("path-weight","Avg weight: "+totalWeight.toFixed(3));
      pi.style.display="block";
    });
    BrainStore.on("path:notfound",function(){
      var pi=_el("path-info"); if(pi) pi.style.display="block";
      _set("path-text","No structural path found.");
    });
    BrainStore.on("filter:changed",function(payload){
      var ve=payload.visibleEdgeIndices, vn=payload.visibleNodeIds;
      _set("stat-visible",vn.size+" nodes · "+ve.size+" edges");
    });
    BrainStore.on("data:loaded",function(data){ _bindMetricsPanel(data); });

    // Region info — render INSIDE sidebar (not floating)
    BrainStore.on("region:selected",function(payload){
      _renderRegionInfoPanel(payload);
    });
  }

  /* ══════════════════════════════════════════════════════════════════════
     REGION INFO PANEL  (inside sidebar)
  ═══════════════════════════════════════════════════════════════════════ */
  function _renderRegionInfoPanel(payload) {
    var panel=_el("region-info-panel"); if(!panel) return;
    var inner=panel.querySelector(".rip-panel-inner"); if(!inner) return;

    var node=payload.node, lobe=payload.lobe, community=payload.community;
    var lobeData=LOBE_INFO[lobe]||LOBE_INFO["Central"];
    var netName=community?community.name:"Unknown";
    var netColor=community?community.color:"#888";
    var netDesc=NET_INFO[netName]||"A functional subnetwork of structurally connected brain regions.";
    var data=BrainStore.getData();
    var nodeEdgeCount=data?data.edges.filter(function(e){return e.source===node.id||e.target===node.id;}).length:0;
    var pctConn=data?((nodeEdgeCount/(data.nodes.length-1))*100).toFixed(1):0;
    var hubClass=node.betweenness>0.5?"Major Hub":node.betweenness>0.25?"Secondary Hub":"Local Node";
    var dispLabel=node.label.replace(/^7Networks_[LR]H_/,"").replace(/_/g," ");
    var mni="("+((node.mni_x||0).toFixed(0))+", "+((node.mni_y||0).toFixed(0))+", "+((node.mni_z||0).toFixed(0))+") mm";

    inner.innerHTML=
      '<div class="rip-header">'
        +'<span class="rip-lobe-badge" style="background:'+lobeData.color+'22;border-color:'+lobeData.color+'66;color:'+lobeData.color+'">'+lobe+' Lobe</span>'
        +'<span class="rip-net-badge" style="background:'+netColor+'22;border-color:'+netColor+'66;color:'+netColor+'">'+netName+'</span>'
        +'<button class="rip-close" id="rip-close-btn">✕</button>'
      +'</div>'
      +'<div class="rip-region-name">'+dispLabel+'</div>'
      +'<div class="rip-mni">MNI '+mni+' · '+(node.hemisphere==="L"?"Left":"Right")+' hemisphere</div>'
      +'<div class="rip-section-title">🧠 What does this region do?</div>'
      +'<div class="rip-text">'+lobeData.fn+'</div>'
      +'<div class="rip-section-title">🔗 Network role</div>'
      +'<div class="rip-text">'+netDesc+'</div>'
      +'<div class="rip-section-title">🏥 Clinical relevance</div>'
      +'<div class="rip-text">'+lobeData.clinical+'</div>'
      +'<div class="rip-divider"></div>'
      +'<div class="rip-section-title">📊 Connectivity metrics</div>'
      +'<div class="rip-metrics">'
        +'<div class="rip-metric"><span class="rip-metric-val">'+node.degree+'</span><span class="rip-metric-lbl">Connections</span></div>'
        +'<div class="rip-metric"><span class="rip-metric-val">'+pctConn+'%</span><span class="rip-metric-lbl">of regions</span></div>'
        +'<div class="rip-metric"><span class="rip-metric-val">'+((node.betweenness||0)*100).toFixed(0)+'%</span><span class="rip-metric-lbl">Centrality</span></div>'
        +'<div class="rip-metric"><span class="rip-metric-val rip-hub">'+hubClass+'</span><span class="rip-metric-lbl">Role</span></div>'
      +'</div>'
      +'<div class="rip-layman-box"><strong>In plain English:</strong> This region acts like a '
        +(hubClass==="Major Hub"?"<strong>major airport</strong> — a critical relay point many neural pathways pass through"
         :hubClass==="Secondary Hub"?"<strong>regional hub</strong> — fairly well-connected and important locally"
         :"<strong>local station</strong> — specialised, connecting mainly within its neighbourhood")
        +'. It connects to <strong>'+node.degree+' other regions</strong> in the <strong>'+lobe+' lobe</strong>.'
      +'</div>';

    panel.style.display="block";

    // Scroll sidebar to show panel
    var sidebar=_el("sidebar");
    if(sidebar) setTimeout(function(){panel.scrollIntoView({behavior:"smooth",block:"nearest"});},50);

    _el("rip-close-btn").addEventListener("click",function(){panel.style.display="none";});
  }

  /* ══════════════════════════════════════════════════════════════════════
     COMMUNITY PANEL  (with dim toggle on click)
  ═══════════════════════════════════════════════════════════════════════ */
  function _buildCommunityPanel(communities) {
    var panel=_el("community-list"); if(!panel) return;
    panel.innerHTML="";
    communities.forEach(function(comm){
      var item=document.createElement("div");
      item.className="comm-item active";
      item.innerHTML='<span class="comm-dot" style="background:'+comm.color+'"></span>'
        +'<span class="comm-name">'+comm.name+'</span>'
        +'<span class="comm-size">'+comm.size+'</span>';
      item.addEventListener("click",function(e){
        if(e.shiftKey){
          // Shift-click = isolate
          BrainStore.isolateCommunity(comm.id);
          document.querySelectorAll(".comm-item").forEach(function(el){
            el.classList.remove("active"); el.classList.add("inactive");
          });
          item.classList.add("active"); item.classList.remove("inactive");
        } else {
          BrainStore.toggleCommunity(comm.id);
          var isActive=item.classList.toggle("active");
          item.classList.toggle("inactive",!isActive);
        }
      });
      panel.appendChild(item);
    });
  }

  function _updateStatsPanel(meta){
    _set("stat-nodes",meta.n_nodes); _set("stat-edges",meta.n_edges);
    _set("stat-comms",meta.n_communities); _set("stat-density",meta.density);
  }

  function _bindMetricsPanel(data){
    setTimeout(function(){
      var st=BrainStore.getState(); if(!st.adjacency) return;
      var eff=BrainAlgorithms.globalEfficiency(st.adjacency,data.nodes.length,40);
      _setMetric("efficiency",eff.toFixed(3),Math.min(eff/0.40,1)*100);
      _setMetric("avgdeg",data.metadata.avg_degree.toFixed(1),Math.min(data.metadata.avg_degree/30,1)*100);
      _setMetric("density",data.metadata.density.toFixed(4),Math.min(data.metadata.density*20,1)*100);
    },400);
  }

  function _setMetric(key,label,pct){
    var b=_el("bar-"+key),v=_el("val-"+key);
    if(b) b.style.width=Math.min(Math.max(pct,2),100)+"%";
    if(v) v.textContent=label;
  }

  /* ══════════════════════════════════════════════════════════════════════
     DATASET SWITCHING / FILE HANDLING
  ═══════════════════════════════════════════════════════════════════════ */
  async function _handleFiles(fileList){
    var files=Array.from(fileList||[]).filter(function(f){return /\.json$/i.test(f.name);});
    if(!files.length) return;
    var lastIdx=-1;
    for(var i=0;i<files.length;i++){
      var d=await _readJSON(files[i]); if(!d) continue;
      lastIdx=DatasetManager.add(files[i].name.replace(/\.json$/i,""),d);
    }
    if(lastIdx>=0) _activateDataset(lastIdx);
    _renderDatasetBar();
  }

  function _activateDataset(idx){
    DatasetManager.setActive(idx);
    var ds=DatasetManager.getActive(); if(!ds) return;
    if(Brain3D.clearDiff) Brain3D.clearDiff();
    BrainStore.init(ds.data);
    _buildCommunityPanel(ds.data.communities);
    _updateStatsPanel(ds.data.metadata);
    _bindMetricsPanel(ds.data);
    _renderDatasetBar();
    var pi=_el("path-info"); if(pi) pi.style.display="none";
    var sl=_el("weight-slider"); if(sl) sl.value=0;
    var sv=_el("weight-val"); if(sv) sv.textContent="0.00";
    var rip=_el("region-info-panel"); if(rip) rip.style.display="none";
  }

  function _renderDatasetBar(){
    var bar=_el("dataset-bar"), tabs=_el("dataset-tabs"), cmpBtn=_el("btn-open-compare");
    var all=DatasetManager.getAll(); if(!bar||!tabs) return;
    bar.style.display=all.length?"flex":"none";
    tabs.innerHTML="";
    all.forEach(function(ds,idx){
      var isActive=(idx===DatasetManager.getActiveIdx());
      var tab=document.createElement("div");
      tab.className="dataset-tab"+(isActive?" active":"");
      tab.innerHTML='<span class="dataset-tab-name" title="'+ds.name+'">'+ds.name+'</span>'
        +'<span class="dataset-tab-close" data-idx="'+idx+'">×</span>';
      tab.addEventListener("click",function(e){
        if(e.target.classList.contains("dataset-tab-close")) return;
        _activateDataset(idx);
      });
      tab.querySelector(".dataset-tab-close").addEventListener("click",function(e){
        e.stopPropagation(); DatasetManager.remove(idx);
        if(DatasetManager.count()) _activateDataset(Math.max(0,idx-1));
        _renderDatasetBar();
      });
      tabs.appendChild(tab);
    });
    if(cmpBtn) cmpBtn.style.display=(all.length>=2)?"":"none";
  }

  /* ══════════════════════════════════════════════════════════════════════
     SEARCH BOX
  ═══════════════════════════════════════════════════════════════════════ */
  function _bindSearchBox(){
    var input=_el("region-search"), results=_el("search-results");
    if(!input||!results) return;
    input.addEventListener("input",function(){
      var q=input.value.trim().toLowerCase(); results.innerHTML="";
      if(!q){results.style.display="none";return;}
      var data=BrainStore.getData(); if(!data) return;
      var matches=data.nodes.filter(function(n){return n.label.toLowerCase().indexOf(q)!==-1;}).slice(0,12);
      if(!matches.length){results.style.display="none";return;}
      matches.forEach(function(node){
        var comm=data.communities.find(function(c){return c.id===node.community;});
        var item=document.createElement("div"); item.className="search-result-item";
        item.innerHTML='<span>'+node.label.replace(/^7Networks_[LR]H_/,"").replace(/_/g," ")+'</span>'
          +'<span class="search-result-net" style="color:'+(comm?comm.color:"#888")+'">'+(comm?comm.name:"")+'</span>';
        item.addEventListener("click",function(){BrainStore.hoverNode(node.id);results.style.display="none";input.value=node.label;});
        item.addEventListener("dblclick",function(){BrainStore.clickNode(node.id);results.style.display="none";});
        results.appendChild(item);
      });
      results.style.display="block";
    });
    document.addEventListener("click",function(e){
      if(!input.contains(e.target)&&!results.contains(e.target)) results.style.display="none";
    });
    input.addEventListener("keydown",function(e){ if(e.key==="Escape"){results.style.display="none";input.blur();}});
  }

  /* Tooltip mouse tracking */
  document.addEventListener("mousemove",function(e){
    var tip=_el("node-tooltip");
    if(tip&&tip.style.display!=="none"){tip.style.left=(e.clientX+16)+"px";tip.style.top=(e.clientY-10)+"px";}
  });

  /* ══════════════════════════════════════════════════════════════════════
     ENTRY POINT
  ═══════════════════════════════════════════════════════════════════════ */
  document.addEventListener("DOMContentLoaded",function(){
    _bindLanding();
    _bindAppControls();
    _bindStoreListeners();
    _bindSearchBox();
    _showLanding();
  });

})();